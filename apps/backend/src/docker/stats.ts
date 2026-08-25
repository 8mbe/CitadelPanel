/**
 * Container resource statistics (plan.md section 8/9).
 *
 * Docker's raw stats payload is awkward: CPU is expressed as cumulative
 * nanosecond counters that must be differenced against the system counter to
 * yield a percentage. This module normalises it into a flat shape the abuse
 * heuristics and the dashboard can both consume.
 *
 * Normalisation happens here, on the node, so the panel receives a stable shape
 * and never has to parse a Docker payload itself.
 */

import type Docker from "dockerode";

import { daemonRead } from "./client";

/** Normalised, point-in-time view of one container's resource usage. */
export interface ContainerStats {
  containerId: string;
  /** Percentage of a single CPU core; 100 = one core fully saturated. */
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  /**
   * Bytes used on disk by the server's data directory, in MB.
   *
   * Docker's stats payload does not report filesystem usage, so this is filled
   * in by the caller (`getServerStats`), which knows the server id and can stat
   * the data directory. `normalizeStats` leaves it at 0; the merge in
   * `getServerStats` overwrites it.
   */
  diskUsageMb: number;
  sampledAt: Date;
}

/** The subset of Docker's stats payload we rely on. */
interface RawDockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: { op?: string; value?: number }[] | null;
  };
  pids_stats?: { current?: number };
}

const BYTES_PER_MB = 1024 * 1024;

/** The cumulative CPU counters from one payload. */
export interface CpuCounters {
  /** Nanoseconds of CPU time the container has consumed, since it started. */
  total: number;
  /** Nanoseconds of CPU time the whole host has consumed, since it booted. */
  system: number;
  /** Cores the container can spread that time across. */
  cpuCount: number;
}

/** Pull the cumulative CPU counters out of a raw stats payload. */
export function readCpuCounters(raw: RawDockerStats): CpuCounters {
  return {
    total: raw.cpu_stats?.cpu_usage?.total_usage ?? 0,
    system: raw.cpu_stats?.system_cpu_usage ?? 0,
    cpuCount:
      raw.cpu_stats?.online_cpus ??
      raw.cpu_stats?.cpu_usage?.percpu_usage?.length ??
      1,
  };
}

/**
 * Convert two readings of Docker's cumulative CPU counters into a percentage.
 *
 * CPU usage is a rate, so it only exists between two readings. Docker reports
 * counters, not a percentage. Returns 0 when the pair cannot yield one: no time
 * passed on the host clock, or the container's counter went *backwards*, which
 * means it restarted and the two readings belong to different processes.
 */
export function cpuPercentBetween(
  previous: CpuCounters,
  current: CpuCounters,
): number {
  const cpuDelta = current.total - previous.total;
  const systemDelta = current.system - previous.system;

  if (systemDelta <= 0 || cpuDelta < 0) return 0;

  return (cpuDelta / systemDelta) * current.cpuCount * 100;
}

/**
 * Memory actually in use by the workload.
 *
 * Docker's `usage` includes page cache, which inflates the number and makes
 * every container look near its limit. Subtracting cache/inactive_file matches
 * what `docker stats` reports.
 */
export function computeMemoryUsageMb(raw: RawDockerStats): number {
  const usage = raw.memory_stats?.usage ?? 0;
  const cache =
    raw.memory_stats?.stats?.inactive_file ?? raw.memory_stats?.stats?.cache ?? 0;

  return Math.max(0, usage - cache) / BYTES_PER_MB;
}

/** Sum receive/transmit bytes across every interface in the container. */
export function computeNetworkBytes(raw: RawDockerStats): {
  rx: number;
  tx: number;
} {
  let rx = 0;
  let tx = 0;

  for (const iface of Object.values(raw.networks ?? {})) {
    rx += iface.rx_bytes ?? 0;
    tx += iface.tx_bytes ?? 0;
  }
  return { rx, tx };
}

/** Sum block I/O bytes by operation type. */
export function computeBlockIoBytes(raw: RawDockerStats): {
  read: number;
  write: number;
} {
  let read = 0;
  let write = 0;

  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = entry.op?.toLowerCase();
    if (op === "read") read += entry.value ?? 0;
    if (op === "write") write += entry.value ?? 0;
  }
  return { read, write };
}

/**
 * Normalise a raw Docker stats payload.
 *
 * `cpuPercent` is passed in rather than derived here: every other figure is a
 * point-in-time reading of this one payload, but CPU is a rate between two of
 * them, and the pairing is the caller's business (see {@link sampleContainerStats}).
 */
export function normalizeStats(
  containerId: string,
  raw: RawDockerStats,
  cpuPercent: number,
): ContainerStats {
  const memoryUsageMb = computeMemoryUsageMb(raw);
  const memoryLimitMb = (raw.memory_stats?.limit ?? 0) / BYTES_PER_MB;
  const network = computeNetworkBytes(raw);
  const block = computeBlockIoBytes(raw);

  return {
    containerId,
    cpuPercent,
    memoryUsageMb,
    memoryLimitMb,
    memoryPercent: memoryLimitMb > 0 ? (memoryUsageMb / memoryLimitMb) * 100 : 0,
    networkRxBytes: network.rx,
    networkTxBytes: network.tx,
    blockReadBytes: block.read,
    blockWriteBytes: block.write,
    pids: raw.pids_stats?.current ?? 0,
    diskUsageMb: 0, // filled in by the caller, which knows the data dir
    sampledAt: new Date(),
  };
}

/**
 * The last CPU reading taken for a container, and the percentage it produced.
 *
 * This map is what lets a stats sample be cheap. `stats?stream=false` looks like
 * a one-shot call but is not: the daemon takes a reading, waits out its own
 * collection interval, takes a second, and only then answers, taking **one to
 * two seconds** every time. The panel polls stats per open server page and
 * sweeps every server for the admin list, so that delay was the single largest
 * source of latency in the product.
 *
 * `one-shot=true` returns immediately (~5ms) but zeroes `precpu_stats`, so the
 * daemon-supplied delta is gone. Keeping the previous reading here restores it:
 * we difference against our own last sample instead of against one Docker
 * blocked a request to collect. The pairing is strictly better for a poller,
 * too, because the percentage covers the interval between polls rather than an
 * arbitrary one-second window inside the request.
 */
interface CpuBaseline extends CpuCounters {
  /** `performance.now()` when this reading was taken. */
  at: number;
  /** The percentage this reading produced, reused when re-asked too soon. */
  percent: number;
}

const cpuBaselines = new Map<string, CpuBaseline>();

/**
 * How far apart two readings must be for their delta to mean anything.
 *
 * Below this, the host's CPU counter has barely advanced and the quotient is
 * mostly quantisation noise, so a baseline younger than this is kept and its
 * percentage reused, rather than replaced with a number derived from a few
 * milliseconds. This is what makes two viewers polling the same server (or the
 * admin sweep landing on top of a page poll) cheap instead of destructive.
 */
const MIN_CPU_INTERVAL_MS = 200;

/**
 * How long a baseline stays usable.
 *
 * A percentage is an average over the gap between the two readings, so a very
 * old baseline reports "average CPU since some point minutes ago", which is not
 * what a live meter means. Past this the baseline is discarded and a fresh pair
 * is taken.
 */
const MAX_CPU_BASELINE_AGE_MS = 60_000;

/** Baselines for containers nobody has asked about in a while. */
const BASELINE_EVICT_AFTER_MS = 5 * 60_000;

function evictStaleBaselines(now: number): void {
  for (const [id, baseline] of cpuBaselines) {
    if (now - baseline.at > BASELINE_EVICT_AFTER_MS) cpuBaselines.delete(id);
  }
}

/** Drop a container's CPU baseline. It is gone, or about to be replaced. */
export function forgetCpuBaseline(containerId: string): void {
  cpuBaselines.delete(containerId);
}

/** One immediate, non-blocking reading. See {@link cpuBaselines} for why. */
async function readRawStats(
  client: Docker,
  containerId: string,
): Promise<RawDockerStats> {
  // Bounded: a stalled daemon must surface as an error the caller can report,
  // not as a request that never ends. See `daemonRead`.
  return (await daemonRead(`stats for container ${containerId.slice(0, 12)}`, (abortSignal) =>
    client.getContainer(containerId).stats({
      stream: false,
      "one-shot": true,
      // Accepted at runtime and typed on other calls, just not on this one.
      abortSignal,
    } as { stream?: false; "one-shot"?: boolean }),
  )) as unknown as RawDockerStats;
}

/**
 * Take a single stats sample for one container.
 *
 * Returns null when the container stopped or vanished between being listed and
 * being sampled, which is a normal race rather than an error.
 */
export async function sampleContainerStats(
  client: Docker,
  containerId: string,
): Promise<ContainerStats | null> {
  try {
    const raw = await readRawStats(client, containerId);
    const now = performance.now();
    const counters = readCpuCounters(raw);
    const baseline = cpuBaselines.get(containerId);
    const age = baseline ? now - baseline.at : Infinity;
    evictStaleBaselines(now);

    // Asked again before the counters could move: answer with the last
    // percentage and keep the older baseline, so the next caller still has a
    // wide enough interval to measure over.
    if (baseline && age < MIN_CPU_INTERVAL_MS) {
      return normalizeStats(containerId, raw, baseline.percent);
    }

    // A counter that went backwards means the container restarted between the
    // two readings, so the baseline belongs to a process that no longer exists.
    const usable =
      baseline !== undefined &&
      age <= MAX_CPU_BASELINE_AGE_MS &&
      counters.total >= baseline.total;

    if (baseline && usable) {
      const percent = cpuPercentBetween(baseline, counters);
      cpuBaselines.set(containerId, { ...counters, at: now, percent });
      return normalizeStats(containerId, raw, percent);
    }

    // No usable baseline (first sample for this container, a long gap, or a
    // restart that reset the counters). Take a second reading rather than
    // reporting 0: a brief wait is still an order of magnitude below what the
    // daemon's own blocking sample costs, and it only happens once.
    await Bun.sleep(MIN_CPU_INTERVAL_MS);
    const second = await readRawStats(client, containerId);
    const secondCounters = readCpuCounters(second);
    const percent = cpuPercentBetween(counters, secondCounters);
    cpuBaselines.set(containerId, {
      ...secondCounters,
      at: performance.now(),
      percent,
    });
    return normalizeStats(containerId, second, percent);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    // A container that stopped between listing and sampling is not an error.
    if (status === 404 || status === 409) {
      cpuBaselines.delete(containerId);
      return null;
    }
    throw error;
  }
}

/** List all panel-managed containers on a node, running or not. */
export async function listManagedContainers(
  client: Docker,
): Promise<{ id: string; names: string[]; state: string }[]> {
  const containers = await daemonRead("the container list", (abortSignal) =>
    client.listContainers({
      all: true,
      filters: { label: ["citadel.managed=true"] },
      abortSignal,
    }),
  );

  return containers.map((container) => ({
    id: container.Id,
    names: container.Names ?? [],
    state: container.State ?? "unknown",
  }));
}
