/**
 * Typed wrappers over the node agent's server endpoints.
 *
 * Call sites in `serverManager.ts` and the routes talk to this module rather
 * than building request paths by hand, so the agent's wire format lives in one
 * place. Every function is addressed by **server id** — the panel does not know
 * or send container ids or host paths (see `apps/backend/src/servers.ts`).
 */

import { nodeRequest } from "./nodeApi";

/** A port the game needs published on the host. */
export interface PortBinding {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

/**
 * The container spec the panel is allowed to specify.
 *
 * Deliberately missing `hostDataPath`: the agent derives it from its own data
 * root, which is what prevents a compromised panel from bind-mounting an
 * arbitrary host path into a container.
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
  /** `uid` or `uid:gid` to run the container as; null = image default USER. */
  user?: string;
}

/**
 * A one-time install run: a provisioning script executed in a throwaway
 * container with the server's data volume mounted, before its first start.
 *
 * As with {@link CreateContainerRequest}, `hostDataPath` is derived agent-side.
 */
export interface InstallContainerRequest {
  image: string;
  script: string;
  entrypoint?: string[];
  containerDataPath: string;
  env: Record<string, string>;
  cpuLimit: number;
  memoryLimitMb: number;
}

export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead"
  | "missing";

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
  /** Disk used by the server's data directory, in MB (sampled by the agent). */
  diskUsageMb: number;
  sampledAt: string;
}

export interface ServerStatsSample extends ContainerStats {
  serverId: string;
}

/**
 * Create a server's container on its node.
 *
 * Image pulls happen agent-side and can take minutes on a cold node, so this
 * gets a much longer timeout than a normal control call.
 */
export async function createServerContainer(
  nodeId: string,
  serverId: string,
  request: CreateContainerRequest,
): Promise<{ containerId: string; hostDataPath: string }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/container`, {
    method: "POST",
    body: request,
    timeoutMs: 10 * 60_000,
  });
}

export async function startServerContainer(
  nodeId: string,
  serverId: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/start`, { method: "POST" });
}

/**
 * Run a blueprint's install script on the node, before first start.
 *
 * Blocks until the script exits; a slow download can take minutes, so it shares
 * the long create timeout. The agent throws (surfaced here as a node error) when
 * the script exits non-zero, so the caller can leave the server in `error`.
 */
export async function runServerInstall(
  nodeId: string,
  serverId: string,
  request: InstallContainerRequest,
): Promise<{ exitCode: number; logs: string }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/install`, {
    method: "POST",
    body: request,
    timeoutMs: 15 * 60_000,
  });
}

/** Stop a container, giving the game time to save before Docker sends SIGKILL. */
export async function stopServerContainer(
  nodeId: string,
  serverId: string,
  timeoutSeconds = 30,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/stop`, {
    method: "POST",
    body: { timeoutSeconds },
    // Must outlast the grace period the agent is waiting out, plus slack.
    timeoutMs: (timeoutSeconds + 30) * 1000,
  });
}

export async function restartServerContainer(
  nodeId: string,
  serverId: string,
  timeoutSeconds = 30,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/restart`, {
    method: "POST",
    body: { timeoutSeconds },
    timeoutMs: (timeoutSeconds + 60) * 1000,
  });
}

/**
 * Force-stop a container with SIGKILL, bypassing the graceful stop.
 *
 * The escape hatch for a container stuck in a graceful stop/restart. SIGKILL is
 * immediate (no grace period to outlast), so a short timeout suffices.
 */
export async function killServerContainer(
  nodeId: string,
  serverId: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/kill`, {
    method: "POST",
    timeoutMs: 30_000,
  });
}

/** Remove a container, its network, and optionally its data directory. */
export async function deleteServerContainer(
  nodeId: string,
  serverId: string,
  deleteData: boolean,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/container`, {
    method: "DELETE",
    query: { deleteData },
    timeoutMs: 120_000,
  });
}

export async function getServerState(
  nodeId: string,
  serverId: string,
): Promise<ContainerState> {
  const result = await nodeRequest<{ state: ContainerState }>(
    nodeId,
    `/v1/servers/${serverId}/state`,
  );
  return result.state;
}

export async function getServerLogs(
  nodeId: string,
  serverId: string,
  tail = 200,
): Promise<string> {
  const result = await nodeRequest<{ logs: string }>(
    nodeId,
    `/v1/servers/${serverId}/logs`,
    { query: { tail } },
  );
  return result.logs;
}

export async function getServerStats(
  nodeId: string,
  serverId: string,
): Promise<ContainerStats | null> {
  const result = await nodeRequest<{ stats: ContainerStats | null }>(
    nodeId,
    `/v1/servers/${serverId}/stats`,
  );
  return result.stats;
}

/**
 * Sample many servers on one node in a single request.
 *
 * The abuse watcher sweeps the whole fleet on a timer; one request per
 * container would make sweep cost scale with fleet size.
 */
export async function sendServerCommand(
  nodeId: string,
  serverId: string,
  command: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/command`, {
    method: "POST",
    body: { command },
  });
}

/**
 * @param timeoutMs The watcher's fleet sweep can legitimately take a while on a
 *   busy node, so it keeps the long default. The admin node detail page passes
 *   a shorter value so a dead node cannot hold the page open for a full minute.
 */
export async function sampleNodeServers(
  nodeId: string,
  serverIds: string[],
  timeoutMs = 60_000,
): Promise<ServerStatsSample[]> {
  const result = await nodeRequest<{ samples: ServerStatsSample[] }>(
    nodeId,
    "/v1/stats",
    { method: "POST", body: { serverIds }, timeoutMs },
  );
  return result.samples;
}

// --- File manager -------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  sizeBytes: number;
  modifiedAt: string;
}

export async function listServerFiles(
  nodeId: string,
  serverId: string,
  path = "/",
): Promise<{ path: string; entries: FileEntry[] }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/files`, { query: { path } });
}

export async function readServerFile(
  nodeId: string,
  serverId: string,
  path: string,
): Promise<string> {
  const result = await nodeRequest<{ contents: string }>(
    nodeId,
    `/v1/servers/${serverId}/files/content`,
    { query: { path } },
  );
  return result.contents;
}

export async function writeServerFile(
  nodeId: string,
  serverId: string,
  path: string,
  contents: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/files/content`, {
    method: "PUT",
    body: { path, contents },
  });
}

export async function deleteServerFile(
  nodeId: string,
  serverId: string,
  path: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/files`, {
    method: "DELETE",
    query: { path },
  });
}

export async function createServerDirectory(
  nodeId: string,
  serverId: string,
  path: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/files/directory`, {
    method: "POST",
    body: { path },
  });
}
