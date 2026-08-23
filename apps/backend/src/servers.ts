/**
 * Server-level operations: the agent's actual job.
 *
 * The panel addresses servers by **id**, never by container id or host path.
 * This module is where a server id becomes a concrete container and a concrete
 * directory on this node's disk.
 *
 * That indirection is the point. The panel cannot name a container it did not
 * create (names are derived, not supplied) and cannot name a path at all, so
 * the bind mount handed to Docker is always one the agent chose.
 */

import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { docker } from "./docker/client";
import {
  attachToContainer,
  type AttachHandlers,
  type Attachment,
} from "./docker/attach";
import {
  attachToNetwork,
  createContainer,
  containerIsTty,
  demuxDockerLogStream,
  detachFromNetwork,
  ensureNetwork,
  getContainerLogs,
  inspectContainerState,
  killContainer,
  removeContainer,
  removeNetwork,
  removeNetworkIfEmpty,
  restartContainer,
  runContainerToCompletion,
  startContainer,
  stopContainer,
  type ContainerState,
} from "./docker/container";
import {
  buildLinkNetworkConfig,
  linkNetworkName,
  serverContainerName,
  serverInstallContainerName,
  serverNetworkName,
  type PortBinding,
} from "./docker/hardening";
import { sampleContainerStats, type ContainerStats } from "./docker/stats";
import { directoryOwner, ensureServerDataDir } from "./dataRoot";
import { conflict, notFound } from "./http";
import { serverDataPath } from "./paths";

/**
 * What the panel may specify about a container.
 *
 * Deliberately missing: `hostDataPath` and `name`. Both are derived from the
 * server id here — see the module comment.
 */
export interface CreateContainerRequest {
  image: string;
  containerDataPath: string;
  env: Record<string, string>;
  ports: PortBinding[];
  cpuLimit: number;
  memoryLimitMb: number;
  readOnlyRootFilesystem?: boolean;
  command?: string[];
  /** `uid` or `uid:gid` to run as; see HardenedContainerSpec.user. */
  user?: string;
  /** Extra networks to attach (e.g. node_db_net when the server has a DB). */
  extraNetworks?: string[];
  /** Allocate a pseudo-TTY; see HardenedContainerSpec.tty. */
  tty?: boolean;
}

/**
 * Resolve a container id from an exact name.
 *
 * Returns null when no such container exists, which is a normal state (never
 * created, or already removed) rather than an error.
 */
async function findContainerIdByName(name: string): Promise<string | null> {
  // Docker's name filter is a substring match, so the exact name is re-checked
  // below; `/name` is how the daemon reports it.
  const matches = await docker.listContainers({
    all: true,
    filters: { name: [name] },
  });

  const exact = matches.find((container) =>
    (container.Names ?? []).some((candidate) => candidate === `/${name}`),
  );
  return exact?.Id ?? null;
}

/**
 * Resolve a server's container id from its deterministic name.
 *
 * Returns null when the container does not exist, which is a normal state
 * (never created, or already removed) rather than an error.
 */
export async function findContainerId(serverId: string): Promise<string | null> {
  return findContainerIdByName(serverContainerName(serverId));
}

/**
 * Resolve a container id, throwing 404 when the server has no container.
 *
 * Tagged `no_container` because this 404 is the one callers act on rather than
 * just show: the panel rebuilds the container from its stored spec, and the
 * console tells the viewer a rebuild is coming instead of printing a Docker
 * fact at them.
 */
async function requireContainerId(serverId: string): Promise<string> {
  const containerId = await findContainerId(serverId);
  if (!containerId) {
    throw notFound(
      `No container exists on this node for server ${serverId}.`,
      "no_container",
    );
  }
  return containerId;
}

/**
 * Create a server's container.
 *
 * The data directory is created **here**, on the node that will actually run
 * the container. This is the correctness fix the agent exists for: the panel
 * used to mkdir on its own disk and hand that path to a remote daemon, which
 * silently produced an empty root-owned directory on the node instead.
 *
 * A root the agent cannot write to comes back as a 503 carrying the fix (see
 * `dataRoot.ts`), because that failure is a node misconfiguration the admin who
 * requested the server needs to read, not an internal error.
 */
export async function createServerContainer(
  serverId: string,
  request: CreateContainerRequest,
): Promise<{ containerId: string; hostDataPath: string }> {
  const existing = await findContainerId(serverId);
  if (existing) {
    throw conflict(`Server ${serverId} already has a container on this node.`);
  }

  const hostDataPath = await ensureServerDataDir(serverId);

  const containerId = await createContainer(docker, {
    name: serverContainerName(serverId),
    image: request.image,
    hostDataPath,
    containerDataPath: request.containerDataPath,
    env: request.env,
    ports: request.ports,
    cpuLimit: request.cpuLimit,
    memoryLimitMb: request.memoryLimitMb,
    networkName: serverNetworkName(serverId),
    readOnlyRootFilesystem: request.readOnlyRootFilesystem,
    command: request.command,
    user: request.user,
    extraNetworks: request.extraNetworks,
    tty: request.tty === true,
  });

  return { containerId, hostDataPath };
}

/**
 * What the panel may specify for a one-time install run.
 *
 * As with {@link CreateContainerRequest}, `hostDataPath` and `name` are absent
 * — the agent derives both from the server id, so the install script can only
 * ever touch this server's own data directory.
 */
export interface InstallRequest {
  image: string;
  script: string;
  entrypoint?: string[];
  containerDataPath: string;
  env: Record<string, string>;
  cpuLimit: number;
  memoryLimitMb: number;
}

/**
 * Run a blueprint's install script once, before the server first starts.
 *
 * The script runs in a throwaway, hardened container with this server's data
 * volume mounted at `containerDataPath` and its working directory, so a script
 * like `curl ... | tar x` populates exactly the directory the runtime container
 * will later use. A non-zero exit is surfaced as a 409 with the tail of the
 * install log, so a failed provision is visible rather than a silently empty
 * data directory.
 *
 * It runs as the data directory's *owner*, not as root. Under `CapDrop: ALL`
 * uid 0 has no `CAP_DAC_OVERRIDE`, so a root install container is denied its
 * first write into a directory the agent created as itself — and it has no
 * `CAP_CHOWN` to hand what it does write to the uid the runtime container is
 * pinned to. Running as the owner from the start solves both: the writes are
 * permitted, and the files come out owned by the account that has to keep
 * using them (the game container, the file editor, SFTP).
 */
export async function installServer(
  serverId: string,
  request: InstallRequest,
): Promise<{ exitCode: number; logs: string }> {
  // The data directory the install writes into is the same one the runtime
  // container binds; create it here so install can run before the container.
  const hostDataPath = await ensureServerDataDir(serverId);

  const { exitCode, logs } = await runContainerToCompletion(docker, {
    user: await directoryOwner(hostDataPath),
    name: serverInstallContainerName(serverId),
    image: request.image,
    hostDataPath,
    containerDataPath: request.containerDataPath,
    env: request.env,
    ports: [],
    cpuLimit: request.cpuLimit,
    memoryLimitMb: request.memoryLimitMb,
    networkName: serverNetworkName(serverId),
    // Default to a login shell so `set -e`-style scripts and PATH work as
    // authors expect; the script itself is the single command argument.
    entrypoint: request.entrypoint ?? ["/bin/sh", "-c"],
    command: [request.script],
    readOnlyRootFilesystem: false,
  });

  if (exitCode !== 0) {
    throw conflict(
      `Install script for server ${serverId} exited with code ${exitCode}.\n` +
        logs.slice(-2000),
    );
  }

  return { exitCode, logs };
}

/**
 * Read the install container's output while the script is still running.
 *
 * {@link installServer} only returns once the script has exited, and it removes
 * the container afterwards — so its return value is the *post-mortem*. This is
 * the live view: the panel polls it while a provision is in flight so an admin
 * can watch a slow download instead of staring at a spinner.
 *
 * `running: false` with empty logs is the normal answer both before the
 * container exists (the install image is still being pulled) and after it has
 * been cleaned up. Neither is an error — the panel holds the durable copy of
 * the output, and this endpoint only ever adds the tail that has not been
 * captured yet.
 */
export async function getServerInstallLogs(
  serverId: string,
  tail = 200,
): Promise<{ logs: string; running: boolean }> {
  const containerId = await findContainerIdByName(
    serverInstallContainerName(serverId),
  );
  if (!containerId) return { logs: "", running: false };

  const state = await inspectContainerState(docker, containerId);
  if (state === "missing") return { logs: "", running: false };

  try {
    return {
      logs: await getContainerLogs(docker, containerId, tail),
      running: state === "running",
    };
  } catch (error) {
    // The install finished and the container was removed between the inspect
    // and the log read. An empty tail is the honest answer: the panel already
    // holds every line the finished run produced.
    if ((error as { statusCode?: number }).statusCode === 404) {
      return { logs: "", running: false };
    }
    throw error;
  }
}

export async function startServerContainer(serverId: string): Promise<void> {
  await startContainer(docker, await requireContainerId(serverId));
}

export async function stopServerContainer(
  serverId: string,
  timeoutSeconds?: number,
): Promise<void> {
  await stopContainer(docker, await requireContainerId(serverId), timeoutSeconds);
}

export async function restartServerContainer(
  serverId: string,
  timeoutSeconds?: number,
): Promise<void> {
  await restartContainer(docker, await requireContainerId(serverId), timeoutSeconds);
}

/**
 * Force-stop a server's container with SIGKILL, bypassing the graceful stop.
 *
 * The escape hatch for a container stuck in a graceful shutdown: no grace
 * period, no chance to save. The container must exist (requireContainerId
 * throws otherwise), since kill is only offered while a stop/restart is in
 * flight against a known container.
 */
export async function killServerContainer(serverId: string): Promise<void> {
  await killContainer(docker, await requireContainerId(serverId));
}

/**
 * Remove a server's container, its network and optionally its data.
 *
 * Idempotent throughout: a missing container or network is treated as already
 * removed, so the panel can safely retry a delete that failed partway.
 */
export async function deleteServerContainer(
  serverId: string,
  deleteData: boolean,
): Promise<void> {
  const containerId = await findContainerId(serverId);
  if (containerId) {
    await removeContainer(docker, containerId);
  }

  await removeNetwork(docker, serverNetworkName(serverId));

  // Data is retained by default: an accidental delete should be recoverable
  // (plan.md section 11 step 8).
  if (deleteData) {
    await rm(serverDataPath(serverId), { recursive: true, force: true });
    invalidateDiskUsage(serverId);
  }
}

/** A server's container state, or "missing" when it has no container here. */
export async function getServerState(serverId: string): Promise<ContainerState> {
  const containerId = await findContainerId(serverId);
  if (!containerId) return "missing";
  return inspectContainerState(docker, containerId);
}

/**
 * Put two linked servers' containers on their pairwise network, so each can
 * reach the other by container name (`citadel-<id12>`) over Docker's embedded
 * DNS.
 *
 * This is the one sanctioned exception to "a server can reach no other
 * tenant's container": the panel only calls it after an owner explicitly
 * connected the two servers. The network is created with ICC enabled — that
 * is the point of a link — and holds exactly the two linked containers, so a
 * compromised server can only ever reach servers it was explicitly linked to.
 *
 * Both containers must already exist (409 otherwise): there is nothing to
 * attach to before that. Containers recreated later re-attach automatically
 * because the panel passes the link network via `extraNetworks`; this route
 * exists to link two already-created servers without a recreate.
 *
 * Idempotent: re-linking reuses the existing network, and an already-attached
 * container is treated as success.
 */
export async function linkServerContainers(
  serverId: string,
  targetId: string,
): Promise<{ networkName: string }> {
  const networkName = linkNetworkName(serverId, targetId);
  const [containerId, targetContainerId] = await Promise.all([
    requireContainerId(serverId),
    requireContainerId(targetId),
  ]);

  await ensureNetwork(docker, networkName, buildLinkNetworkConfig(networkName));
  await attachToNetwork(docker, networkName, containerId);
  await attachToNetwork(docker, networkName, targetContainerId);
  return { networkName };
}

/**
 * Tear a link down: detach both containers and remove the pair's network.
 *
 * Idempotent throughout — a missing container or network means the link is
 * already gone, which is success. Removal is "if empty": if some endpoint is
 * still attached (a container recreated mid-unlink), the empty-or-not network
 * is left for the next unlink rather than failing the call.
 */
export async function unlinkServerContainers(
  serverId: string,
  targetId: string,
): Promise<void> {
  const networkName = linkNetworkName(serverId, targetId);
  const [containerId, targetContainerId] = await Promise.all([
    findContainerId(serverId),
    findContainerId(targetId),
  ]);

  if (containerId) {
    await detachFromNetwork(docker, networkName, containerId);
  }
  if (targetContainerId) {
    await detachFromNetwork(docker, networkName, targetContainerId);
  }
  await removeNetworkIfEmpty(docker, networkName);
}

export async function getServerLogs(serverId: string, tail: number): Promise<string> {
  return getContainerLogs(docker, await requireContainerId(serverId), tail);
}

/**
 * A live, follow-mode stream of a server's log output.
 *
 * Unlike {@link getServerLogs} (a one-shot tail), this stays open and emits new
 * output as the container writes it — the live console's SSE feed. The
 * `signal` is forwarded to dockerode so cancelling it (when the browser
 * disconnects) releases the daemon's log stream.
 *
 * Returns Docker's 8-byte framing already stripped, as a stream of payload
 * bytes. Throws 404 when the server has no container here, so the caller can
 * turn that into a clean terminal event rather than an empty live stream.
 */
export async function streamServerLogs(
  serverId: string,
  tail: number,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const containerId = await requireContainerId(serverId);

  const nodeStream = await docker.getContainer(containerId).logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail,
    abortSignal: signal,
  });

  // A TTY container's log stream is raw bytes (no 8-byte multiplexing), so the
  // demuxer must forward as-is rather than misparsing payload as frame headers.
  const tty = await containerIsTty(docker, containerId);
  return demuxDockerLogStream(nodeStream, tty);
}

/**
 * Total size of a server's data directory in MB.
 *
 * Docker's stats payload does not report filesystem usage, so the live disk
 * figure comes from walking the data dir the agent owns. A missing directory
 * (server never provisioned, or data removed) reads as 0 rather than throwing,
 * since a stats sweep over a partially-deprovisioned server is normal.
 *
 * Recursive but bounded by `concurrency` so a wide directory tree does not hold
 * the event loop open one entry at a time — game data is often thousands of
 * small region/chunk files.
 */
async function computeDiskUsageMb(serverId: string): Promise<number> {
  const root = serverDataPath(serverId);
  const BYTES_PER_MB = 1024 * 1024;

  async function dirSize(path: string): Promise<number> {
    let total = 0;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return 0; // not present or unreadable — nothing to count
    }

    // Walk subdirectories in parallel batches to keep a deep tree moving.
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
          // a file removed mid-walk is not an error
        }
      }
    }
    if (dirs.length > 0) {
      const subtotals = await Promise.all(dirs.map(dirSize));
      for (const s of subtotals) total += s;
    }
    return total;
  }

  return (await dirSize(root)) / BYTES_PER_MB;
}

/**
 * Cached disk-usage figures, keyed by server id.
 *
 * Walking a server's whole data directory is the expensive half of a stats
 * sample — a populated game world is thousands of small files — and the panel
 * polls stats every few seconds per open page. Disk usage changes slowly
 * relative to that, so a short TTL keeps the figure fresh enough for a usage
 * meter while collapsing a burst of samples (and every viewer of the same
 * server) onto one walk. CPU/memory are not cached: they come straight from the
 * daemon and are cheap and genuinely live.
 */
const diskUsageCache = new Map<string, { mb: number; at: number }>();
const DISK_USAGE_TTL_MS = 30_000;

async function cachedDiskUsageMb(serverId: string): Promise<number> {
  const now = Date.now();
  const cached = diskUsageCache.get(serverId);
  if (cached && now - cached.at < DISK_USAGE_TTL_MS) return cached.mb;

  const mb = await computeDiskUsageMb(serverId);
  diskUsageCache.set(serverId, { mb, at: now });
  return mb;
}

/** Drop a server's cached disk figure, e.g. when its data directory is removed. */
function invalidateDiskUsage(serverId: string): void {
  diskUsageCache.delete(serverId);
}

export async function getServerStats(
  serverId: string,
): Promise<ContainerStats | null> {
  const containerId = await findContainerId(serverId);
  if (!containerId) return null;

  // Sample docker stats and disk usage in parallel: the two are independent
  // (one hits the daemon, the other walks the data dir — the latter behind a
  // short-lived cache, see cachedDiskUsageMb).
  const [stats, diskUsageMb] = await Promise.all([
    sampleContainerStats(docker, containerId),
    cachedDiskUsageMb(serverId),
  ]);

  if (stats) return { ...stats, diskUsageMb };

  // The container exists but isn't running (sampleContainerStats returned null
  // on a 404/409 from `docker stats`). Disk usage is a property of the data
  // directory, not the running container, so it stays meaningful while stopped.
  // Report a zeroed live sample with the real disk figure so the dashboard
  // keeps showing disk usage offline instead of dropping to 0/stale.
  return {
    containerId,
    cpuPercent: 0,
    memoryUsageMb: 0,
    memoryLimitMb: 0,
    memoryPercent: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    pids: 0,
    diskUsageMb,
    sampledAt: new Date(),
  };
}

/** A stats sample tagged with the server it belongs to. */
export interface ServerStatsSample extends ContainerStats {
  serverId: string;
}

/**
 * Sample several servers in one pass.
 *
 * The panel's abuse watcher sweeps every server on every node on a timer. Doing
 * that as one HTTP request per container would make sweep cost scale with fleet
 * size; batching keeps it at one request per node.
 *
 * Individual failures are dropped rather than thrown: a container that stopped
 * mid-sweep must not cost the panel the rest of the node's samples.
 */
export async function sampleServers(
  serverIds: string[],
): Promise<ServerStatsSample[]> {
  const samples = await Promise.all(
    serverIds.map(async (serverId) => {
      try {
        const stats = await getServerStats(serverId);
        return stats ? { ...stats, serverId } : null;
      } catch (error) {
        // Message only, no stack: this runs on the panel's sweep timer for
        // every server on the node, so a node-wide fault (an unreachable
        // Docker socket, say) would otherwise bury the boot-time diagnosis
        // under one dockerode stack trace per container per tick.
        console.error(
          `[agent] failed to sample server ${serverId}:`,
          error instanceof Error ? error.message : error,
        );
        return null;
      }
    }),
  );

  return samples.filter((sample): sample is ServerStatsSample => sample !== null);
}

/**
 * Attach to a container's stdin/stdout for the interactive console.
 *
 * Delegates to the raw-socket implementation rather than dockerode, whose
 * `hijack` mode does not work under Bun — see `docker/attach.ts`.
 */
export async function attachToServer(
  serverId: string,
  handlers: AttachHandlers,
): Promise<Attachment> {
  const containerId = await requireContainerId(serverId);
  // A TTY container's attach stream is raw bytes (no 8-byte framing), so the
  // attach layer reads it differently — see docker/attach.ts. This is what lets
  // a Minecraft server's JLine3 color codes reach the console.
  const tty = await containerIsTty(docker, containerId);
  return attachToContainer(containerId, handlers, tty);
}

/**
 * Send one command without requiring a browser-facing WebSocket proxy.
 *
 * Awaits the attach handshake before writing: stdin written before Docker
 * acknowledges the upgrade loses its first byte, which silently corrupts every
 * command (e.g. "help" arrives as "elp"). The socket is held briefly after the
 * write so the bytes flush before close.
 */
export async function sendServerCommand(
  serverId: string,
  command: string,
): Promise<void> {
  const attachment = await attachToServer(serverId, {
    onData: () => undefined,
    onClose: () => undefined,
    onError: () => undefined,
  });
  await attachment.ready;
  attachment.write(`${command.replace(/[\r\n]+$/g, "")}\n`);
  setTimeout(() => attachment.close(), 100);
}
