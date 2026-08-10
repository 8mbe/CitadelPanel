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

/**
 * Convert Docker's cumulative CPU counters into a percentage.
 *
 * Returns 0 when the system delta is non-positive, which happens on the very
 * first sample (no previous reading to difference against).
 */
export function computeCpuPercent(raw: RawDockerStats): number {
  const cpuDelta =
    (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (raw.cpu_stats?.system_cpu_usage ?? 0) -
    (raw.precpu_stats?.system_cpu_usage ?? 0);

  if (systemDelta <= 0 || cpuDelta < 0) return 0;

  const cpuCount =
    raw.cpu_stats?.online_cpus ??
    raw.cpu_stats?.cpu_usage?.percpu_usage?.length ??
    1;

  return (cpuDelta / systemDelta) * cpuCount * 100;
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

/** Normalise a raw Docker stats payload. */
export function normalizeStats(
  containerId: string,
  raw: RawDockerStats,
): ContainerStats {
  const memoryUsageMb = computeMemoryUsageMb(raw);
  const memoryLimitMb = (raw.memory_stats?.limit ?? 0) / BYTES_PER_MB;
  const network = computeNetworkBytes(raw);
  const block = computeBlockIoBytes(raw);

  return {
    containerId,
    cpuPercent: computeCpuPercent(raw),
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
 * Take a single stats sample for one container.
 *
 * `stream: false` makes Docker return one snapshot that already includes
 * `precpu_stats`, so a usable CPU percentage comes from a single call.
 */
export async function sampleContainerStats(
  client: Docker,
  containerId: string,
): Promise<ContainerStats | null> {
  try {
    const raw = (await client
      .getContainer(containerId)
      .stats({ stream: false })) as unknown as RawDockerStats;

    return normalizeStats(containerId, raw);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    // A container that stopped between listing and sampling is not an error.
    if (status === 404 || status === 409) return null;
    throw error;
  }
}

/** List all panel-managed containers on a node, running or not. */
export async function listManagedContainers(
  client: Docker,
): Promise<{ id: string; names: string[]; state: string }[]> {
  const containers = await client.listContainers({
    all: true,
    filters: { label: ["citadel.managed=true"] },
  });

  return containers.map((container) => ({
    id: container.Id,
    names: container.Names ?? [],
    state: container.State ?? "unknown",
  }));
}
