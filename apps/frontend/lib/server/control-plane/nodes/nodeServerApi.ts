/**
 * Typed wrappers over the node agent's server endpoints.
 *
 * Call sites in `serverManager.ts` and the routes talk to this module rather
 * than building request paths by hand, so the agent's wire format lives in one
 * place. Every function is addressed by **server id** — the panel does not know
 * or send container ids or host paths (see `apps/backend/src/servers.ts`).
 */

import { nodeRequest, nodeRequestRaw } from "./nodeApi";

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
  /** Extra networks to attach (e.g. node_db_net when the server has a DB). */
  extraNetworks?: string[];
  /** Allocate a pseudo-TTY — see Blueprint.tty. */
  tty?: boolean;
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

// --- Server links --------------------------------------------------------------

/**
 * POST /v1/servers/:id/links — put two linked servers on their pairwise
 * network so each reaches the other by container name.
 *
 * Only called for same-node links: servers on different nodes share no Docker
 * daemon, so there is no network to attach — those links ride the target's
 * public `nodeHostname:port` and never touch the agent.
 */
export async function linkServerContainers(
  nodeId: string,
  serverId: string,
  targetId: string,
): Promise<{ networkName: string }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/links`, {
    method: "POST",
    body: { targetId },
  });
}

/**
 * DELETE /v1/servers/:id/links/:targetId — detach both containers from the
 * pair's network and remove it. Idempotent agent-side.
 */
export async function unlinkServerContainers(
  nodeId: string,
  serverId: string,
  targetId: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/links/${targetId}`, {
    method: "DELETE",
  });
}

// --- Database provisioning ----------------------------------------------------

/** The node DB container's reachability info, as the agent reports it. */
export interface NodeDbInfo {
  /** The MariaDB container's IP on node_db_net, or null when not set up. */
  host: string | null;
  port: number;
  networkName: string;
  containerName: string;
}

/**
 * GET /v1/database/info — the node DB container's address.
 *
 * The panel calls this to show the database host when a server owner creates a
 * database, and to check the node has a DB before offering the option. `host`
 * is null when the node has not run `setup-db`.
 */
export async function getNodeDbInfo(nodeId: string): Promise<NodeDbInfo> {
  return nodeRequest(nodeId, "/v1/database/info");
}

/** The connection details returned when a database is provisioned. */
export interface ProvisionedDatabase {
  name: string;
  user: string;
  /** The host address server containers connect to (the DB container's IP). */
  host: string;
  port: number;
}

/**
 * POST /v1/servers/:id/database — create a database + scoped user on the node.
 *
 * The admin credentials are decrypted from the node row and passed through; the
 * agent execs SQL inside the MariaDB container. The `dbPassword` is generated
 * panel-side (and stored encrypted) — the agent never persists it.
 *
 * `dbName` and `dbUser` are generated panel-side (server-id prefix + random
 * suffix) so each database on a server gets a distinct name. The agent
 * validates them before interpolating into SQL.
 */
export async function provisionServerDatabase(
  nodeId: string,
  serverId: string,
  dbName: string,
  dbUser: string,
  adminUser: string,
  adminPassword: string,
  dbPassword: string,
): Promise<ProvisionedDatabase> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/database`, {
    method: "POST",
    body: { adminUser, adminPassword, dbPassword, dbName, dbUser },
    // MariaDB first-boot init or a slow exec can take a few seconds.
    timeoutMs: 60_000,
  });
}

/**
 * DELETE /v1/servers/:id/database — drop the database and user.
 *
 * The admin credentials and the stored `dbName`/`dbUser` are passed in the body
 * (the agent needs them to exec the DROP). Idempotent: a missing database or
 * user is not an error.
 */
export async function dropServerDatabase(
  nodeId: string,
  serverId: string,
  dbName: string,
  dbUser: string,
  adminUser: string,
  adminPassword: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/database`, {
    method: "DELETE",
    body: { adminUser, adminPassword, dbName, dbUser },
    timeoutMs: 60_000,
  });
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

/**
 * Delete multiple files/directories in one request.
 *
 * The agent resolves every path through containment before removing anything,
 * so one bad entry fails the whole batch rather than half-deleting a selection.
 */
export async function deleteServerFiles(
  nodeId: string,
  serverId: string,
  paths: string[],
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/files/delete`, {
    method: "POST",
    body: { paths },
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

/**
 * Rename/move a file or directory within a server's data directory.
 *
 * The agent enforces containment and rejects moves into a path's own
 * descendant. `to` is the full destination path (not a directory to move into).
 */
export async function renameServerFile(
  nodeId: string,
  serverId: string,
  from: string,
  to: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/files/rename`, {
    method: "POST",
    body: { from, to },
  });
}

/**
 * Copy a file or directory tree within a server's data directory.
 *
 * Directories are copied recursively. `to` is the full destination path.
 */
export async function copyServerFile(
  nodeId: string,
  serverId: string,
  from: string,
  to: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/files/copy`, {
    method: "POST",
    body: { from, to },
  });
}

/**
 * Download one or more files/directories as a streamed response.
 *
 * A single file streams raw bytes; multiple paths (or a directory) stream a zip
 * archive built on the fly. Returns the live agent `Response` so the BFF can
 * pipe the body straight to the browser without buffering.
 *
 * @param paths  POSIX paths relative to the server's data root.
 * @param download Suggested filename for the Content-Disposition header.
 */
export async function downloadServerFile(
  nodeId: string,
  serverId: string,
  paths: string[],
  download?: string,
): Promise<Response> {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (paths.length === 1) {
    query.path = paths[0];
  } else {
    query.paths = paths.join("\n");
  }
  if (download) query.download = download;
  return nodeRequestRaw(nodeId, `/v1/servers/${serverId}/files/download`, {
    query,
    // Large files can take a while; let the caller override if needed.
    timeoutMs: 10 * 60_000,
  });
}

/**
 * Upload a single file's raw bytes to the server's data directory.
 *
 * The body is streamed straight through to the agent (`rawBody`), so a large
 * upload is never buffered in the panel's memory. Returns the agent's `{ path,
 * sizeBytes }` result. The caller is responsible for enforcing the panel-side
 * size cap *before* calling this — once the stream is forwarded, the cap is the
 * agent's job.
 *
 * @param path POSIX destination path relative to the server's data root.
 * @param body The raw upload body (the incoming `Request.body`).
 * @param contentLength The Content-Length to forward, for the agent's up-front cap.
 */
export async function uploadServerFile(
  nodeId: string,
  serverId: string,
  path: string,
  body: ReadableStream<Uint8Array> | BodyInit,
  contentLength?: number,
): Promise<{ path: string; sizeBytes: number }> {
  const response = await nodeRequestRaw(
    nodeId,
    `/v1/servers/${serverId}/files/upload`,
    {
      method: "POST",
      query: { path },
      rawBody: body,
      headers: contentLength ? { "content-length": String(contentLength) } : undefined,
      // A large upload can take minutes; match the download window.
      timeoutMs: 10 * 60_000,
    },
  );
  return (await response.json()) as { path: string; sizeBytes: number };
}

/**
 * Pull a remote URL into the server's data directory.
 *
 * The agent performs the fetch (so the bytes travel once, to disk); the panel
 * has already validated the URL against its SSRF guardrail. Returns the agent's
 * `{ path, sizeBytes }` result.
 */
export async function pullServerFileFromUrl(
  nodeId: string,
  serverId: string,
  path: string,
  url: string,
): Promise<{ path: string; sizeBytes: number }> {
  const response = await nodeRequestRaw(
    nodeId,
    `/v1/servers/${serverId}/files/pull`,
    {
      method: "POST",
      body: { path, url },
      // The remote fetch can take a while; match the download window.
      timeoutMs: 10 * 60_000,
    },
  );
  return (await response.json()) as { path: string; sizeBytes: number };
}
