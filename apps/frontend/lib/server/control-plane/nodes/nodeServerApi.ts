/**
 * Typed wrappers over the node agent's server endpoints.
 *
 * Call sites in `serverManager.ts` and the routes talk to this module rather
 * than building request paths by hand, so the agent's wire format lives in one
 * place. Every function is addressed by **server id**. The panel does not know
 * or send container ids or host paths (see `apps/backend/src/servers.ts`).
 */

import {
  nodeRequest,
  nodeRequestFor,
  nodeRequestRaw,
  unregisteredNode,
} from "./nodeApi";

/** A port the game needs published on the host. */
export interface PortBinding {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

/**
 * Expand one published port number into the bindings the agent expects.
 *
 * The panel stores a port as a number and claims it on both protocols (see
 * migration `023_ports_dual_protocol.sql`); the agent's container spec is still
 * per-protocol, so the pair is produced here rather than stored twice. Keeping
 * the wire format protocol-aware means no node has to be upgraded in lockstep
 * with the panel.
 */
export function portBindingsFor(port: number): PortBinding[] {
  return [
    { hostPort: port, containerPort: port, protocol: "tcp" },
    { hostPort: port, containerPort: port, protocol: "udp" },
  ];
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
  /** Allocate a pseudo-TTY. See Blueprint.tty. */
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

/**
 * The install container's output while its script is still running.
 *
 * {@link runServerInstall} returns the whole log, but only once the script has
 * exited, which is the wrong shape for a console watching a provision happen.
 * Short timeout: this is polled, and a slow node must not hold the poll open
 * longer than the interval between polls.
 *
 * `running: false` with an empty log is normal, not an error: before the
 * container exists the node is still pulling the install image, and after the
 * script exits the container has already been removed.
 */
export async function getServerInstallLogs(
  nodeId: string,
  serverId: string,
  tail = 500,
): Promise<{ logs: string; running: boolean }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/install/logs`, {
    query: { tail },
    timeoutMs: 5000,
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
 * Sample many servers on one node in a single request.
 *
 * The abuse watcher sweeps the whole fleet on a timer; one request per
 * container would make sweep cost scale with fleet size.
 *
 * @param timeoutMs How long to wait. Every caller passes its own, because the
 *   number that matters is not how slow a busy node can be but how long the
 *   *caller* can afford to wait for a node that will never answer: the watcher
 *   derives it from its sweep interval, and the admin node detail page keeps it
 *   short so a dead node cannot hold the page open. The default is the
 *   generous one, for a caller with nothing better to do than wait.
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

/**
 * Ask one node what many of its containers are actually doing, in one request.
 *
 * The cheap counterpart to {@link sampleNodeServers}: no stats, no disk walk,
 * one Docker list call on the node. Used by the status sweeper, which asks
 * about every server on every node on a timer, so it must not cost a request
 * (or a daemon call) per server. The timeout is short by default because the
 * sweeper runs unattended and a dead node is a normal thing to skip.
 *
 * Every requested id is answered; a server the node has no container for comes
 * back as `missing`.
 */
export async function getNodeServerStates(
  nodeId: string,
  serverIds: string[],
  timeoutMs = 15_000,
): Promise<Record<string, ContainerState>> {
  const result = await nodeRequest<{ states: Record<string, ContainerState> }>(
    nodeId,
    "/v1/states",
    { method: "POST", body: { serverIds }, timeoutMs },
  );
  return result.states;
}

// --- Server links --------------------------------------------------------------

/**
 * POST /v1/servers/:id/links. Puts two linked servers on their pairwise
 * network so each reaches the other by container name.
 *
 * Only called for same-node links: servers on different nodes share no Docker
 * daemon, so there is no network to attach. Those links ride the target's
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
 * DELETE /v1/servers/:id/links/:targetId. Detaches both containers from the
 * pair's network and removes it. Idempotent agent-side.
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
 * GET /v1/database/info. Returns the node DB container's address.
 *
 * The panel calls this to show the database host when a server owner creates a
 * database, and to check the node has a DB before offering the option. `host`
 * is null when the node has not run `setup-db`.
 */
export async function getNodeDbInfo(nodeId: string): Promise<NodeDbInfo> {
  return nodeRequest(nodeId, "/v1/database/info");
}

/**
 * The node DB container's lifecycle state, as the agent reports it.
 *
 * The richer sibling of {@link NodeDbInfo}: it says whether the container
 * exists at all, so the admin card can offer "Set up" rather than a broken
 * "Start".
 */
/** How much of an existing database to throw away first. See the agent's docs. */
export type NodeDbRecreate = "container" | "all";

export interface NodeDbStatus {
  exists: boolean;
  /** Docker's status string ("running", "exited", …); null when absent. */
  state: string | null;
  /** True once MariaDB answered a ping, so "running" means "usable". */
  ready: boolean;
  /**
   * Why `ready` is false. `"denied"` is the actionable one: the database is up
   * and refusing the panel's account, which waiting never fixes.
   */
  probe: "alive" | "unreachable" | "denied" | null;
  host: string | null;
  port: number;
  containerName: string;
  networkName: string;
  volumeName: string;
  image: string;
}

/**
 * The credential the panel holds for a node's database.
 *
 * `root` on nodes set up before the panel minted its own account; a generated
 * `citadel_<hex>` since. See `apps/backend/src/docker/nodeDb.ts`.
 */
export interface NodeDbAdmin {
  user: string;
  password: string;
}

/**
 * GET /v1/database/status. The node DB container's state.
 *
 * The credential (when the panel has one) is sent so the agent can also ping
 * MariaDB as that account and report `ready`. It travels in headers, not the
 * query string, because query strings end up in access logs.
 */
export async function getNodeDbStatus(
  nodeId: string,
  admin?: NodeDbAdmin,
): Promise<NodeDbStatus> {
  return nodeRequest(
    nodeId,
    admin ? "/v1/database/status?probe=1" : "/v1/database/status",
    admin ? { headers: adminHeaders(admin) } : undefined,
  );
}

/** The status route reads the credential from headers; this builds them. */
function adminHeaders(admin: NodeDbAdmin): Record<string, string> {
  return { "X-Db-User": admin.user, "X-Db-Password": admin.password };
}

/**
 * POST /v1/database/setup. Creates the node's MariaDB and the panel's account.
 *
 * The panel generates and stores the credential before calling, so a retry
 * after a timeout presents the same one and is recognised rather than creating a
 * second, orphaned database (see `setUpNodeDb` on the agent).
 *
 * The timeout is generous because a cold node pulls the MariaDB image and then
 * runs its first-boot initialisation. The agent's own readiness wait is 120s,
 * so this stays above it: whichever side gives up first owns the error message,
 * and the agent's is the specific one.
 */
export async function setUpNodeDb(
  nodeId: string,
  admin: NodeDbAdmin,
  recreate?: NodeDbRecreate,
): Promise<NodeDbStatus> {
  return nodeRequest(nodeId, "/v1/database/setup", {
    method: "POST",
    body: { adminUser: admin.user, adminPassword: admin.password, recreate },
    timeoutMs: 300_000,
  });
}

/**
 * GET /v1/database/status on an agent with no node row yet.
 *
 * Two jobs, both in the register-node form: check whether the machine already
 * has a database *before* offering to create one, and report progress while a
 * creation is in flight. No credential is sent, so `ready` is always false; the
 * caller only needs existence and container state.
 */
export async function getNodeDbStatusUnregistered(
  apiUrl: string,
  apiToken: string,
): Promise<NodeDbStatus> {
  return nodeRequestFor(unregisteredNode(apiUrl, apiToken), "/v1/database/status", {
    // Short: this is polled every few seconds during setup, so a slow answer
    // must not queue up behind the previous one.
    timeoutMs: 10_000,
  });
}

/**
 * Same, for an agent with no node row yet.
 *
 * The register-node form offers "set it up for me", which has to reach the agent
 * before anything is persisted. The connection details come straight from the
 * form, exactly as the pre-registration health probe works.
 */
export async function setUpNodeDbUnregistered(
  apiUrl: string,
  apiToken: string,
  admin: NodeDbAdmin,
  recreate?: NodeDbRecreate,
): Promise<NodeDbStatus> {
  return nodeRequestFor(unregisteredNode(apiUrl, apiToken), "/v1/database/setup", {
    method: "POST",
    body: { adminUser: admin.user, adminPassword: admin.password, recreate },
    timeoutMs: 300_000,
  });
}

/**
 * POST /v1/database/start. Starts the container and waits until it answers.
 *
 * Passing the credential makes a 200 mean "accepting connections as the panel's
 * account" rather than "container started", which is the distinction an admin
 * who just clicked Start actually cares about.
 */
export async function startNodeDb(
  nodeId: string,
  admin?: NodeDbAdmin,
): Promise<NodeDbStatus> {
  return nodeRequest(nodeId, "/v1/database/start", {
    method: "POST",
    body: admin ? { adminUser: admin.user, adminPassword: admin.password } : {},
    timeoutMs: 180_000,
  });
}

/** POST /v1/database/stop. Stops the container (30s graceful shutdown). */
export async function stopNodeDb(nodeId: string): Promise<NodeDbStatus> {
  return nodeRequest(nodeId, "/v1/database/stop", {
    method: "POST",
    body: {},
    timeoutMs: 90_000,
  });
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
 * POST /v1/servers/:id/database. Creates a database + scoped user on the node.
 *
 * The admin credentials are decrypted from the node row and passed through; the
 * agent execs SQL inside the MariaDB container. The `dbPassword` is generated
 * panel-side (and stored encrypted). The agent never persists it.
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
 * DELETE /v1/servers/:id/database. Drops the database and user.
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

/**
 * One statement's result from the agent's explorer query endpoint: column names
 * (empty when the statement returned no rows) and rows of nullable strings.
 * Values stay strings end-to-end, because BIGINT ids must not round-trip
 * through JavaScript numbers.
 */
export interface DbQueryResult {
  columns: string[];
  rows: (string | null)[][];
}

/**
 * POST /v1/servers/:id/database/query. Runs explorer SQL as the scoped user.
 *
 * The database user's password is decrypted from the `server_databases` row and
 * passed through; the agent execs it inside the DB container with the database
 * preselected, so the scoped user's grants are the containment. Statements are
 * composed by the panel from structured explorer operations in
 * `services/dbExplorerSql.ts`, never forwarded from the browser.
 */
export async function queryServerDatabase(
  nodeId: string,
  serverId: string,
  dbName: string,
  dbUser: string,
  dbPassword: string,
  sqlText: string,
): Promise<{ results: DbQueryResult[] }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/database/query`, {
    method: "POST",
    body: { dbName, dbUser, dbPassword, sql: sqlText },
    // A slow COUNT(*) or a big page scan can take a few seconds on a busy node.
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
 * size cap *before* calling this. Once the stream is forwarded, the cap is the
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
