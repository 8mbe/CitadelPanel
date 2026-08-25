/**
 * Server orchestration (plan.md section 11).
 *
 * This is the only module that coordinates database state, node scheduling and
 * container operations. Routes call into it; it never talks HTTP itself.
 *
 * Ordering principle throughout: **write the database record first, then act on
 * the node.** A DB row with no container is recoverable (retry or delete); a
 * container with no DB row is an orphan nobody can see or clean up.
 *
 * Container work is delegated to the target node's agent over HTTP. The panel
 * does not create directories or bind mounts: the agent owns its own disk, so
 * data lands on the machine that actually runs the container.
 */

import { randomBytes } from "node:crypto";
import { sql } from "../db/client";
import { badRequest, conflict, notFound, HttpError } from "../lib/http";
import { decryptSecret, encryptSecret, generateStrongPassword } from "../lib/crypto";
import {
  getBlueprintByKey,
  getBlueprintIdByKey,
  getBlueprintKeyById,
} from "../blueprints/registry";
import {
  interpolateCommand,
  primaryPort,
  resolveEnv,
  type Blueprint,
} from "../blueprints/types";
import {
  allocateHostPort,
  scheduleServer,
  scheduleServerOnNode,
  type ResourceRequest,
} from "../nodes/scheduler";
import {
  createServerContainer,
  deleteServerContainer,
  getServerInstallLogs,
  getServerState,
  killServerContainer,
  restartServerContainer,
  runServerInstall,
  startServerContainer,
  stopServerContainer,
  provisionServerDatabase,
  dropServerDatabase,
  portBindingsFor,
  type PortBinding,
} from "../nodes/nodeServerApi";
import { assertNodeReadyToProvision } from "../nodes/nodeApi";
import { getNodeWithSecrets } from "../nodes/nodeRegistry";
import { recordAudit } from "./auditLog";
import { getServerLimits } from "./settings";
import { listServerLinkNetworks, detachAllServerLinks } from "./serverLinks";
import {
  autoUpdateServerPlugins,
  getServerPluginSupportSummary,
} from "./pluginManager";
import { reconcileStatus } from "./statusReconcile";

export type ServerStatus =
  | "creating"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "suspended"
  | "error"
  | "deleting";

interface ServerRow {
  id: string;
  name: string;
  owner_id: string;
  node_id: string;
  blueprint_id: string;
  container_id: string | null;
  status: ServerStatus;
  cpu_limit: string | number;
  memory_limit_mb: number;
  disk_limit_mb: number;
  plugin_auto_update: boolean;
  created_at: Date;
  updated_at: Date;
  /** Joined from `nodes.hostname`: the address players connect to. */
  node_hostname?: string;
  /** Why the server was suspended, shown to the owner. Null when not suspended. */
  suspension_reason?: string | null;
  /** When the server was last suspended. Null when not suspended. */
  suspended_at?: Date | null;
  /**
   * Joined from `blueprints.key`, so the blueprint key is resolved in the same
   * round trip as the server row(s). Optional only because a few internal reads
   * select the bare `servers` row; {@link toSummary} falls back to the registry
   * when it is absent.
   */
  blueprint_key?: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  ownerId: string;
  nodeId: string;
  /** The node's hostname: the address players use to connect (node, not agent). */
  nodeHostname: string | null;
  blueprintKey: string | null;
  status: ServerStatus;
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
  ports: {
    /** The published port: identity-mapped host↔container, on TCP and UDP both. */
    port: number;
    isPrimary: boolean;
    isAdditional: boolean;
    label: string | null;
  }[];
  createdAt: Date;
  /** Why the server was suspended, shown to the owner. Null when not suspended. */
  suspensionReason: string | null;
  /** When the server was last suspended. Null when not suspended. */
  suspendedAt: Date | null;
  /**
   * Plugin/mod support resolved against the server's env, when the blueprint
   * declares it: what the tab is called and which provider serves it. Only
   * set on the detail read (`getServer`), never on list reads. List callers
   * don't need it and it costs a blueprint + env lookup.
   */
  pluginSupport?: {
    label: string;
    providerId: string;
    directory: string;
  } | null;
}

// --- Reads --------------------------------------------------------------------

/** Ports for one server, ordered as the API surfaces them. */
async function loadPorts(serverId: string) {
  return loadPortsForMany([serverId]).then((m) => m.get(serverId) ?? []);
}

/**
 * Ports for many servers in one query.
 *
 * The list endpoints fan out over every server a caller can see, and resolving
 * ports per-server turned each list read into N+1 queries. Batching collapses
 * that to one round trip regardless of fleet size. The `IN (...)` list is the
 * server ids the caller already holds.
 *
 * Returns a Map keyed by server id so the caller can spread each row's ports
 * without a second lookup. Ordering matches {@link loadPorts}: primary first,
 * then additional, then by port number.
 */
async function loadPortsForMany(
  serverIds: string[],
): Promise<Map<string, ServerSummary["ports"]>> {
  const byServer = new Map<string, ServerSummary["ports"]>();
  if (serverIds.length === 0) return byServer;

  const rows = (await sql`
    SELECT server_id, host_port, is_primary, is_additional, label
    FROM server_ports
    WHERE server_id = ANY(${sql.array(serverIds, 2950)})
    ORDER BY server_id, is_primary DESC, is_additional ASC, host_port ASC
  `) as {
    server_id: string;
    host_port: number;
    is_primary: boolean;
    is_additional: boolean;
    label: string | null;
  }[];

  for (const row of rows) {
    let list = byServer.get(row.server_id);
    if (!list) {
      list = [];
      byServer.set(row.server_id, list);
    }
    // host_port IS the port: bindings are identity mappings (host N → container
    // N), so container_port is not part of the API surface. It is still stored
    // for the table's primary key.
    list.push({
      port: row.host_port,
      isPrimary: row.is_primary,
      isAdditional: row.is_additional,
      label: row.label,
    });
  }
  return byServer;
}

/**
 * Build a summary from a row whose blueprint key and ports are already
 * resolved. That is the list path, which JOINs the key and batches the ports.
 */
function toSummaryFromRow(
  row: ServerRow,
  ports: ServerSummary["ports"],
): ServerSummary {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    nodeId: row.node_id,
    nodeHostname: row.node_hostname ?? null,
    blueprintKey: row.blueprint_key ?? null,
    status: row.status,
    cpuLimit: Number(row.cpu_limit),
    memoryLimitMb: row.memory_limit_mb,
    diskLimitMb: row.disk_limit_mb,
    ports,
    createdAt: row.created_at,
    suspensionReason: row.suspension_reason ?? null,
    suspendedAt: row.suspended_at ?? null,
  };
}

/**
 * Build a summary from a bare row, resolving the blueprint key and ports.
 *
 * Used by the single-server reads ({@link getServer}, {@link loadServerRow}
 * callers) where the per-server cost is one key lookup and one port query, not
 * worth batching, and the key is not always JOINed in those paths. The
 * list endpoints JOIN the key and batch the ports instead ({@link summariesFromRows}).
 */
async function toSummary(row: ServerRow): Promise<ServerSummary> {
  // The list queries JOIN `blueprint_key`; the single-server read does not, so
  // resolve it here when absent. `getBlueprintKeyById` is a one-row indexed lookup.
  const blueprintKey =
    row.blueprint_key ?? (await getBlueprintKeyById(row.blueprint_id));
  return toSummaryFromRow(
    { ...row, blueprint_key: blueprintKey ?? undefined },
    await loadPorts(row.id),
  );
}

/**
 * Count servers hosted on a node, for the node-deletion gate.
 *
 * Cheaper than {@link listServersForNode} (no ports, no owner lookups). It
 * exists only to answer "is this node safe to delete?".
 */
export async function countServersOnNode(nodeId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM servers WHERE node_id = ${nodeId}
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/** Servers the user owns. Admins use {@link listAllServers} instead. */
export async function listServersForOwner(ownerId: string): Promise<ServerSummary[]> {
  const rows = (await sql`
    SELECT s.*, n.hostname AS node_hostname, b.key AS blueprint_key
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    JOIN blueprints b ON b.id = s.blueprint_id
    WHERE s.owner_id = ${ownerId} ORDER BY s.created_at DESC
  `) as ServerRow[];
  return summariesFromRows(rows);
}

/**
 * Servers hosted on a single node, for the node detail page.
 *
 * Scoped to the node rather than going through {@link listAllServers} + a
 * client filter: the fleet-wide path loads every server and every server's
 * ports/preset, which is wasteful when only one node's servers are needed.
 */
export async function listServersForNode(
  nodeId: string,
): Promise<ServerSummary[]> {
  const rows = (await sql`
    SELECT s.*, n.hostname AS node_hostname, b.key AS blueprint_key
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    JOIN blueprints b ON b.id = s.blueprint_id
    WHERE s.node_id = ${nodeId} ORDER BY s.created_at DESC
  `) as ServerRow[];
  return summariesFromRows(rows);
}

/** Servers the user can see: owned plus any they are a subuser on. */
export async function listAccessibleServers(userId: string): Promise<ServerSummary[]> {
  const rows = (await sql`
    SELECT DISTINCT s.*, n.hostname AS node_hostname, b.key AS blueprint_key
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    JOIN blueprints b ON b.id = s.blueprint_id
    LEFT JOIN server_subusers su ON su.server_id = s.id
    WHERE s.owner_id = ${userId} OR su.user_id = ${userId}
    ORDER BY s.created_at DESC
  `) as ServerRow[];
  return summariesFromRows(rows);
}

export async function listAllServers(): Promise<ServerSummary[]> {
  const rows = (await sql`
    SELECT s.*, n.hostname AS node_hostname, b.key AS blueprint_key
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    JOIN blueprints b ON b.id = s.blueprint_id
    ORDER BY s.created_at DESC
  `) as ServerRow[];
  return summariesFromRows(rows);
}

/**
 * Resolve ports for a set of server rows in one batched query, then map to
 * summaries. This is the shared fast path for the list endpoints: one query for
 * the rows (with the blueprint key JOINed in) and one for every row's ports.
 */
async function summariesFromRows(
  rows: ServerRow[],
): Promise<ServerSummary[]> {
  const portsByServer = await loadPortsForMany(rows.map((r) => r.id));
  return rows.map((row) =>
    toSummaryFromRow(row, portsByServer.get(row.id) ?? []),
  );
}

async function loadServerRow(serverId: string): Promise<ServerRow> {
  const rows = (await sql`
    SELECT s.*, n.hostname AS node_hostname, b.key AS blueprint_key
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    JOIN blueprints b ON b.id = s.blueprint_id
    WHERE s.id = ${serverId}
  `) as ServerRow[];
  const row = rows[0];
  if (!row) throw notFound("Server not found");
  return row;
}

/**
 * The detail view of one server.
 *
 * Shaped around round trips rather than readability of the call graph, because
 * this runs on every server page load and every status poll and the database is
 * frequently not on the same machine as the panel. The row is read once and
 * then *shared*: the ports and the plugin-support probe both descend from it and
 * run against the database concurrently, so the whole read costs two round
 * trips instead of the one-per-lookup chain it used to be.
 */
export async function getServer(serverId: string): Promise<ServerSummary> {
  const row = await loadServerRow(serverId);
  const [summary, pluginSupport] = await Promise.all([
    toSummary(row),
    getServerPluginSupportSummary(serverId, row),
  ]);
  return { ...summary, pluginSupport };
}

async function setStatus(serverId: string, status: ServerStatus): Promise<void> {
  await sql`
    UPDATE servers SET status = ${status}, updated_at = now() WHERE id = ${serverId}
  `;
}

// --- Environment variables ----------------------------------------------------

/** One env var as its writer sees it: the value in the clear. */
export interface EnvWrite {
  key: string;
  /** Plaintext. {@link writeEnvValues} encrypts it when `isSecret`. */
  value: string;
  isSecret: boolean;
}

/**
 * Persist env vars: one statement, and encryption decided in one place.
 *
 * Both properties matter, and neither was true of the two loops this replaced.
 *
 * *One statement*, because provisioning writes a blueprint's whole env at once,
 * a dozen or more variables, and a round trip each made that a visible part of
 * how long creating a server took.
 *
 * *One place for encryption*, because the other writer (the owner's env form)
 * did not encrypt. `loadEnvForContainer` decrypts every row flagged
 * `is_secret`, so a plaintext value written under that flag is not a cosmetic
 * inconsistency: it throws on decrypt the next time the container is built.
 * `VELOCITY_FORWARDING_SECRET` is both `editable` and `secret`, so editing it
 * was enough to leave a server that could no longer be rebuilt. Callers hand
 * over plaintext and say whether it is secret; this decides what is stored.
 */
export async function writeEnvValues(
  serverId: string,
  entries: EnvWrite[],
): Promise<void> {
  if (entries.length === 0) return;

  const keys = entries.map((e) => e.key);
  const values = entries.map((e) => (e.isSecret ? encryptSecret(e.value) : e.value));
  const secretFlags = entries.map((e) => e.isSecret);

  await sql`
    INSERT INTO server_env (server_id, key, value, is_secret)
    SELECT ${serverId}, k, v, s
    FROM UNNEST(
      ${sql.array(keys)}::text[],
      ${sql.array(values)}::text[],
      ${sql.array(secretFlags)}::boolean[]
    ) AS t(k, v, s)
    ON CONFLICT (server_id, key) DO UPDATE SET
      value = EXCLUDED.value, is_secret = EXCLUDED.is_secret
  `;
}

/** Persist resolved env vars, encrypting the ones the preset marks secret. */
async function storeEnv(
  serverId: string,
  values: Record<string, string>,
  secretKeys: string[],
): Promise<void> {
  const secrets = new Set(secretKeys);

  await writeEnvValues(
    serverId,
    Object.entries(values).map(([key, value]) => ({
      key,
      value,
      isSecret: secrets.has(key),
    })),
  );
}

/** Load env vars for display, masking secret values. */
export async function loadEnvForDisplay(
  serverId: string,
): Promise<{ key: string; value: string; isSecret: boolean }[]> {
  const rows = (await sql`
    SELECT key, value, is_secret FROM server_env
    WHERE server_id = ${serverId}
    ORDER BY key ASC
  `) as { key: string; value: string; is_secret: boolean }[];

  return rows.map((row) => ({
    key: row.key,
    value: row.is_secret ? "********" : row.value,
    isSecret: row.is_secret,
  }));
}

// --- Creation -----------------------------------------------------------------

export interface CreateServerInput {
  name: string;
  ownerId: string;
  blueprintKey: string;
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
  env?: Record<string, unknown>;
  /**
   * Explicit target node. When omitted the scheduler picks the most suitable
   * node; when given, that node's free capacity is validated instead.
   */
  nodeId?: string;
  /**
   * Who initiated the creation. Defaults to the owner (self-provisioning via
   * the legacy flow); the admin-provisioning endpoint sets this to the admin
   * so the audit log records who actually created the server on someone's
   * behalf.
   */
  actorId?: string;
  /**
   * Start the server as soon as it is built, instead of leaving it `stopped`.
   *
   * Opt-in, and off for ordinary provisioning: an admin building servers for
   * other people should not have them all boot and start consuming CPU the
   * moment they exist. The setup wizard sets it, because a wizard that ends on
   * a built-but-stopped container leaves the operator one manual step short of
   * knowing whether any of this works, and the start is the part that actually
   * exercises the image and the port binding.
   *
   * It lives here rather than in the browser so the start survives the operator
   * closing the tab mid-build, which the wizard explicitly invites them to do.
   */
  startWhenBuilt?: boolean;
}

/**
 * Validate the requested resources against the blueprint's stated minimums.
 * Catching this early avoids provisioning a container that cannot boot.
 */
function assertMeetsMinimums(blueprint: Blueprint, request: ResourceRequest): void {
  const problems: string[] = [];

  if (request.cpuLimit < blueprint.minimums.cpuLimit) {
    problems.push(`cpuLimit must be at least ${blueprint.minimums.cpuLimit}`);
  }
  if (request.memoryLimitMb < blueprint.minimums.memoryLimitMb) {
    problems.push(`memoryLimitMb must be at least ${blueprint.minimums.memoryLimitMb}`);
  }
  if (request.diskLimitMb < blueprint.minimums.diskLimitMb) {
    problems.push(`diskLimitMb must be at least ${blueprint.minimums.diskLimitMb}`);
  }

  if (problems.length > 0) {
    throw badRequest(
      `Requested resources are below the minimum for "${blueprint.name}": ${problems.join("; ")}`,
    );
  }
}

/**
 * Derive the JVM heap for Minecraft Java from the container memory limit.
 *
 * Leaves headroom for the JVM's non-heap overhead, otherwise the container hits
 * its cgroup limit and is OOM-killed despite a "valid" heap setting.
 */
function deriveJvmMemory(memoryLimitMb: number): string {
  const heap = Math.max(512, Math.floor(memoryLimitMb * 0.8));
  return `${heap}M`;
}

// --- Provisioning -------------------------------------------------------------

/**
 * The statuses that mean "the panel is still building this server".
 *
 * `creating` covers everything before the blueprint's install step (the row,
 * its ports, its env); `installing` covers the install script and the container
 * build that follows it. Both are one phase as far as a viewer is concerned:
 * there is nothing to operate yet.
 */
export function isProvisioning(status: ServerStatus): boolean {
  return status === "creating" || status === "installing";
}

/**
 * In-flight provisioning tasks, keyed by server id.
 *
 * Provisioning outlives the request that started it, so the promise has to be
 * reachable from somewhere other than the closure that created it: the route
 * hands it to Next's `after()` so the runtime does not consider the work
 * finished when the response goes out. The map is also what makes a second
 * provision of the same server impossible while the first is running.
 *
 * Deliberately in-process and deliberately not durable. A panel restart mid
 * install loses the task, which is why {@link failInterruptedProvisions} runs
 * at boot. A row stuck in `installing` with nobody working on it is worse than
 * an honest `error`.
 */
const inFlightProvisions = new Map<string, Promise<void>>();

/**
 * Await a server's provisioning task, if one is running in this process.
 *
 * Resolves immediately when there is nothing in flight (already finished, or
 * started by a process that has since been replaced). Never rejects: failures
 * are recorded on the row, not thrown at whoever happened to be waiting.
 */
export async function waitForProvisioning(serverId: string): Promise<void> {
  await inFlightProvisions.get(serverId);
}

/** Cap on the stored install log, so a chatty installer cannot bloat the row. */
const MAX_INSTALL_LOG_CHARS = 256_000;

/**
 * Append a line to a server's install log.
 *
 * Written straight to the row rather than buffered in memory: the reader is a
 * different request (an admin's console poll), and a provision that dies with
 * the process should still leave behind everything it had managed to say.
 *
 * The append happens in SQL, not read-modify-write, so the install script's
 * captured output and the panel's own phase lines cannot clobber each other.
 * Failures are swallowed. A log line must never be the reason a provision
 * fails, exactly like an audit write.
 */
async function appendInstallLog(serverId: string, text: string): Promise<void> {
  try {
    await sql`
      UPDATE servers
      SET install_log = right(install_log || ${text}, ${MAX_INSTALL_LOG_CHARS})
      WHERE id = ${serverId}
    `;
  } catch (error) {
    console.error(`[serverManager] install log append failed for ${serverId}:`, error);
  }
}

/** A panel-authored progress line, marked so it reads apart from script output. */
async function logPhase(serverId: string, message: string): Promise<void> {
  await appendInstallLog(serverId, `[panel] ${message}\n`);
}

/**
 * Fail every server this panel left mid-provision.
 *
 * Provisioning lives in this process (see {@link inFlightProvisions}), so a
 * restart abandons whatever was in flight, whether it is a deploy, a crash or
 * a dev-server reload. Nothing would ever move those rows again: they are not
 * reconciled (no container to ask about) and the owner is locked out of a
 * server that claims to be installing. Marking them `error` at boot is the
 * recovery: an admin can read how far the install got in the log and delete or
 * re-create.
 *
 * Called from `instrumentation.ts`, before the panel serves its first request.
 */
export async function failInterruptedProvisions(): Promise<void> {
  const rows = (await sql`
    UPDATE servers
    SET status = 'error', updated_at = now()
    WHERE status IN ('creating', 'installing')
    RETURNING id, name
  `) as { id: string; name: string }[];

  for (const row of rows) {
    await logPhase(
      row.id,
      "Provisioning was interrupted. The panel restarted while this server " +
        "was still being built. Reinstall it from its settings to build it " +
        "again, or delete it and create it fresh.",
    );
  }

  if (rows.length > 0) {
    console.warn(
      `[serverManager] marked ${rows.length} interrupted provision(s) as error: ` +
        rows.map((row) => row.name).join(", "),
    );
  }
}

/** A server's provisioning output, as the console renders it. */
export interface InstallLogView {
  /** Everything recorded so far: panel phase lines plus install-script output. */
  log: string;
  /** Whether the panel is still building this server. */
  provisioning: boolean;
  status: ServerStatus;
  /** When the current (or last) provision started. Null for older servers. */
  startedAt: Date | null;
}

/**
 * Read a server's provisioning output.
 *
 * Two sources, because the install container is gone by the time the panel has
 * anything durable to show: the row holds every line already recorded, and the
 * node holds the tail of a script that is running *right now*. The live tail is
 * only asked for (and only appended) while the row still says the server is
 * being provisioned. Once the install has finished, its full output is in the
 * row and asking the node again would either duplicate those lines or, more
 * likely, answer with nothing at all.
 *
 * An unreachable node is not an error here: the stored log is the answer, and a
 * note is appended to the view (not the row) so the reader knows the live tail
 * is missing rather than empty.
 */
export async function readInstallLog(serverId: string): Promise<InstallLogView> {
  const rows = (await sql`
    SELECT status, install_log, install_started_at, node_id
    FROM servers WHERE id = ${serverId}
  `) as {
    status: ServerStatus;
    install_log: string;
    install_started_at: Date | null;
    node_id: string;
  }[];

  const row = rows[0];
  if (!row) throw notFound("Server not found");

  const view: InstallLogView = {
    log: row.install_log,
    provisioning: isProvisioning(row.status),
    status: row.status,
    startedAt: row.install_started_at,
  };
  if (!view.provisioning) return view;

  try {
    const live = await getServerInstallLogs(row.node_id, serverId);
    if (live.logs.trim().length > 0) {
      view.log = `${view.log}${live.logs.trimEnd()}\n`;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    view.log = `${view.log}[panel] Could not read live install output: ${reason}\n`;
  }

  return view;
}

/** Raised when a provision finds its own server no longer wants building. */
class ProvisionAbandoned extends Error {}

/**
 * Stop a provision whose server has been deleted (or is being deleted) under it.
 *
 * A provision runs for minutes and an admin can delete the server during any of
 * them. Without this check the task would go on to create a container for a row
 * that no longer exists. That is the orphan this module's ordering principle
 * exists to avoid, and the worst kind, because nothing in the panel can see it
 * to clean it up. Checked before each step that creates something on the node.
 *
 * `deleteServer` writes `deleting` before it touches the node, so that status is
 * caught here too, not just an already-vanished row.
 */
async function assertStillProvisioning(serverId: string): Promise<void> {
  const rows = (await sql`
    SELECT status FROM servers WHERE id = ${serverId}
  `) as { status: ServerStatus }[];

  const row = rows[0];
  if (!row) throw new ProvisionAbandoned("the server was deleted");
  if (!isProvisioning(row.status)) {
    throw new ProvisionAbandoned(`the server moved to "${row.status}"`);
  }
}

/**
 * Everything the background task needs, resolved while the request is still
 * around to be told about a bad input.
 */
interface ProvisionPlan {
  blueprint: Blueprint;
  nodeId: string;
  env: Record<string, string>;
  secretKeys: string[];
  // No disk limit: it is a scheduling number, enforced by the node's own quota
  // on the data directory rather than by anything the container spec carries.
  cpuLimit: number;
  memoryLimitMb: number;
  /** See `CreateServerInput.startWhenBuilt`. */
  startWhenBuilt?: boolean;
  /** Who the automatic start is audited against. Only read when starting. */
  startedBy: string;
}

/**
 * Build a server on its node: ports, env, install script, container.
 *
 * Runs detached from the request that asked for the server (see
 * {@link createServer}). That is not an optimisation. It is what makes a
 * blueprint with an install step possible at all. Every step here talks to the
 * node, and the node's answers are slow in ways that have nothing to do with
 * whether the create was valid: a cold node pulls a few hundred megabytes of
 * image before the install container can start, and the install script itself
 * downloads a server jar. Holding an HTTP request open across all of that means
 * any timeout anywhere in the chain turns a working create into a 502 and a row
 * stuck in `error`, whether it is the panel's own, a reverse proxy's or the
 * browser's.
 *
 * So the request reserves the row and returns; this runs afterwards and the row
 * is how it reports. Each phase is announced into the install log first, so an
 * admin reading the console sees where a stall is happening rather than a
 * spinner. A failure lands in the log too, next to the output that explains it.
 */
async function provisionServer(
  serverId: string,
  plan: ProvisionPlan,
): Promise<void> {
  const { blueprint, nodeId } = plan;

  try {
    // Reserve ports. The UNIQUE constraint on server_ports is what makes
    // concurrent creation safe; allocateHostPort just picks a likely candidate.
    const bindings: PortBinding[] = [];
    const mainPort = primaryPort(blueprint);
    let primaryHostPort: number | undefined;

    await logPhase(serverId, "Allocating ports…");

    for (const port of blueprint.defaultPorts) {
      const isPrimary = port === mainPort;
      // The blueprint's declared number (e.g. 25565) is a best-effort
      // preference, honored when it is in the node's pool and free. Anything
      // else is a random free pool port; nobody gets to pick one.
      const hostPort = await allocateHostPort(nodeId, port.container);

      // Identity mapping: the same number is published on the host and bound
      // inside the container (host N → container N), so a port is one number,
      // not a pair.
      await sql`
        INSERT INTO server_ports (
          server_id, node_id, host_port, container_port, is_primary
        ) VALUES (
          ${serverId}, ${nodeId}, ${hostPort}, ${hostPort}, ${isPrimary}
        )
      `;

      if (isPrimary) primaryHostPort = hostPort;

      // One number, both protocols: the agent's spec is still per-protocol, so
      // the claim is expanded here rather than stored twice.
      bindings.push(...portBindingsFor(hostPort));
    }

    // The game must listen on the number that was actually published, so the
    // primary port's number is injected into the env (SERVER_PORT for the itzg
    // images) before anything is persisted or interpolated.
    if (blueprint.primaryPortEnv && primaryHostPort !== undefined) {
      plan.env[blueprint.primaryPortEnv] = String(primaryHostPort);
    }

    await storeEnv(serverId, plan.env, plan.secretKeys);

    // A blueprint's startup command is interpolated with the resolved env once,
    // here, so the agent receives a concrete argv rather than a template. This
    // runs after the primary-port env is set, so {{SERVER_PORT}}-style
    // placeholders see the allocated port.
    const command = blueprint.startupCommand
      ? ["/bin/sh", "-c", interpolateCommand(blueprint.startupCommand, plan.env)]
      : undefined;

    // First-launch provisioning, when the blueprint defines it: run the install
    // script against the (agent-owned) data directory before the runtime
    // container exists, so a failure leaves no half-built container behind.
    if (blueprint.install) {
      await assertStillProvisioning(serverId);
      await setStatus(serverId, "installing");
      await logPhase(
        serverId,
        `Running the install script in ${blueprint.install.image}. ` +
          "The image is pulled first, so there may be no output for a while.",
      );

      const { logs } = await runServerInstall(nodeId, serverId, {
        image: blueprint.install.image,
        script: blueprint.install.script,
        entrypoint: blueprint.install.entrypoint,
        containerDataPath: blueprint.dataPath,
        env: plan.env,
        cpuLimit: plan.cpuLimit,
        memoryLimitMb: plan.memoryLimitMb,
      });

      // The install container is removed the moment its script exits, so this
      // is the only durable copy of what it printed. Storing it whole cannot
      // duplicate the tail an admin was watching: that tail came from the
      // container, and by now there is no container left to read it from.
      await appendInstallLog(serverId, `${logs.trimEnd()}\n`);
      await logPhase(serverId, "Install script finished.");
    } else {
      await setStatus(serverId, "installing");
    }

    // Last check before anything exists on the node: past this point a delete
    // has a container to find, so a create that races it is recoverable rather
    // than an invisible orphan.
    await assertStillProvisioning(serverId);
    await logPhase(
      serverId,
      `Creating the container from ${blueprint.dockerImage}. ` +
        "A node that has not run this image before pulls it now, which can " +
        "take several minutes.",
    );

    // The agent creates the data directory on the node's own disk and derives
    // the bind mount from it. The panel never names a host path.
    const { containerId } = await createServerContainer(nodeId, serverId, {
      image: blueprint.dockerImage,
      containerDataPath: blueprint.dataPath,
      env: plan.env,
      ports: bindings,
      cpuLimit: plan.cpuLimit,
      memoryLimitMb: plan.memoryLimitMb,
      readOnlyRootFilesystem: blueprint.supportsReadOnlyRoot === true,
      command,
      user: blueprint.user,
      tty: blueprint.tty === true,
      // A newly created server has no databases yet, but the call is kept for
      // symmetry with recreateServerContainer.
      extraNetworks: await extraNetworksForServer(serverId),
    });

    await sql`
      UPDATE servers
      SET container_id = ${containerId}, status = 'stopped', updated_at = now()
      WHERE id = ${serverId}
    `;

    await logPhase(serverId, "Done. The server is ready to start.");

    if (plan.startWhenBuilt) {
      // Its own catch, so a start failure never reaches the build's error
      // handler below: everything above is what makes the server exist, and a
      // container that is built but refuses to boot is a different problem from
      // one that never got built. A failed start therefore writes its own log
      // line rather than being reported as a failed build, and leaves the
      // container on the node to be inspected and started by hand.
      //
      // Routed through `startServer` rather than straight at the container so
      // the first start is the same start as every other one: it runs the
      // plugin auto-updater before the game process boots, and it records the
      // `server.start` audit entry. Starting the container directly would skip
      // both, and a start nobody can find in the audit log is exactly the kind
      // of privileged action that must not be invisible.
      await logPhase(serverId, "Starting the server…");
      try {
        await startServer(serverId, plan.startedBy);
        await logPhase(
          serverId,
          "Started. The game process may take another moment to accept " +
            "connections.",
        );
      } catch (error) {
        // `startServer` has already put the row in `error`.
        const reason = error instanceof Error ? error.message : String(error);
        await logPhase(serverId, `The server was built but did not start: ${reason}`);
        console.error(`[serverManager] first start failed for ${serverId}:`, error);
      }
    }
  } catch (error) {
    // A provision that stopped because its server was deleted did not fail.
    // Writing `error` here would resurrect a row mid-delete, or log a failure
    // against a server nobody asked for any more.
    if (error instanceof ProvisionAbandoned) {
      console.warn(
        `[serverManager] provisioning abandoned for ${serverId}: ${error.message}`,
      );
      return;
    }

    // Leave a visible, recoverable record instead of a silent orphan.
    await setStatus(serverId, "error");
    const reason = error instanceof Error ? error.message : String(error);
    await logPhase(serverId, `Provisioning failed: ${reason}`);
    console.error(`[serverManager] provisioning failed for ${serverId}:`, error);
  }
}

/**
 * Create a server: reserve DB state, then provision on the node in the
 * background.
 *
 * Everything that can reject the request outright happens here, synchronously,
 * so a bad create still fails as a 4xx/5xx with nothing left behind: an unknown
 * blueprint, resources below its minimums, bad env, a node with no capacity or
 * an unwritable data root. Once the row exists the caller gets it back
 * immediately in `creating`, and {@link provisionServer} takes over; the row's
 * status and install log are how it reports from there.
 *
 * On any provisioning failure the server is left in `error` (not deleted) so the
 * owner or an admin can inspect and retry rather than silently losing the record.
 */
export async function createServer(
  input: CreateServerInput,
): Promise<ServerSummary> {
  const blueprint = await getBlueprintByKey(input.blueprintKey);
  if (!blueprint) throw badRequest(`Unknown blueprint: "${input.blueprintKey}"`);

  const blueprintId = await getBlueprintIdByKey(input.blueprintKey);
  if (!blueprintId) {
    throw conflict(
      `Blueprint "${input.blueprintKey}" is not in the database. Restart the panel to re-sync built-ins.`,
    );
  }

  const request: ResourceRequest = {
    cpuLimit: input.cpuLimit,
    memoryLimitMb: input.memoryLimitMb,
    diskLimitMb: input.diskLimitMb,
  };
  assertMeetsMinimums(blueprint, request);

  // Validate env before touching any infrastructure.
  let resolved;
  try {
    resolved = resolveEnv(blueprint, input.env ?? {});
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : "Invalid environment");
  }

  // Fill in the JVM heap from the plan's memory limit if the user left it blank.
  if (blueprint.key === "minecraft-java" && !resolved.values.MEMORY) {
    resolved.values.MEMORY = deriveJvmMemory(input.memoryLimitMb);
  }

  const node = input.nodeId
    ? await scheduleServerOnNode(input.nodeId, request)
    : await scheduleServer(request);

  // The scheduler only knows what the database records: free capacity and the
  // drain flag. Ask the node itself whether it can actually take a server. An
  // agent that is down, or whose data root it cannot write to, fails every
  // provision at `mkdir`. Checking here means the admin gets one actionable
  // error instead of a half-created server left in `error`.
  await assertNodeReadyToProvision(node.nodeId);

  const inserted = (await sql`
    INSERT INTO servers (
      name, owner_id, node_id, blueprint_id, status,
      cpu_limit, memory_limit_mb, disk_limit_mb, install_started_at
    ) VALUES (
      ${input.name}, ${input.ownerId}, ${node.nodeId}, ${blueprintId}, 'creating',
      ${input.cpuLimit}, ${input.memoryLimitMb}, ${input.diskLimitMb}, now()
    )
    RETURNING *
  `) as ServerRow[];

  const server = inserted[0]!;

  await logPhase(
    server.id,
    `Provisioning "${server.name}" from blueprint ${blueprint.key} on node ` +
      `${node.nodeId}.`,
  );

  // Audited on reservation, not on completion: the create is the admin's
  // action, and it has happened. Whether the node then builds the container
  // successfully is the provision's story, told by the status and install log.
  await recordAudit({
    userId: input.actorId ?? input.ownerId,
    action: "server.create",
    targetType: "server",
    targetId: server.id,
    metadata: {
      ownerId: input.ownerId,
      // Only recorded when someone else created the server for the owner.
      ...(input.actorId && input.actorId !== input.ownerId
        ? { onBehalfOf: input.ownerId }
        : {}),
      blueprintKey: blueprint.key,
      nodeId: node.nodeId,
      cpuLimit: input.cpuLimit,
      memoryLimitMb: input.memoryLimitMb,
    },
  });

  // Detached on purpose, see provisionServer. It records its own failures on
  // the row, so the promise never rejects and nothing here needs to await it;
  // the route hands it to `after()` so the runtime keeps it alive.
  const task = provisionServer(server.id, {
    blueprint,
    nodeId: node.nodeId,
    env: resolved.values,
    secretKeys: resolved.secretKeys,
    cpuLimit: input.cpuLimit,
    memoryLimitMb: input.memoryLimitMb,
    startWhenBuilt: input.startWhenBuilt === true,
    startedBy: input.actorId ?? input.ownerId,
  }).finally(() => {
    inFlightProvisions.delete(server.id);
  });
  inFlightProvisions.set(server.id, task);

  return getServer(server.id);
}

// --- Lifecycle ----------------------------------------------------------------

/** A suspended server must not be startable by its owner. */
function assertNotSuspended(server: ServerRow): void {
  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be started.",
    );
  }
}

/**
 * A server must have been provisioned before it can be operated.
 *
 * The container itself is addressed by server id agent-side, so this only
 * guards the "still provisioning or failed to create" case.
 */
function assertHasContainer(server: ServerRow): void {
  if (!server.container_id) {
    // Distinguish the two cases the owner can act on differently: an install
    // that is still running will finish on its own, while a failed one needs
    // an admin (who can read the install log to find out why).
    throw conflict(
      isProvisioning(server.status)
        ? "This server is still installing. It can be started once the install finishes."
        : "This server has no container yet. It may still be provisioning or have failed to create.",
    );
  }
}

/**
 * Rebuild a container the node no longer has.
 *
 * Panel/node drift is a real state, not a corrupted one: a container can be
 * removed out of band by a manual `docker rm`, a prune or a rebuilt node, while
 * the server row still points at its id. Every lifecycle call then comes back
 * as the agent's "no container exists on this node" 404, and nothing in the UI
 * can clear it, because the only path that creates a container is provisioning
 * and that already ran.
 *
 * Rebuilding from the stored spec is the way out, and it is non-destructive:
 * the data directory belongs to the agent and outlives any container, so the
 * new container comes up on the world, config and logs the old one left.
 *
 * Returns false when the node does have the container after all. The 404 came
 * from something else and the caller must re-throw it.
 */
async function healMissingContainer(server: ServerRow): Promise<boolean> {
  const state = await getServerState(server.node_id, server.id);
  if (state !== "missing") return false;

  console.warn(
    `[serverManager] container for ${server.id} is gone from node ${server.node_id}; rebuilding it`,
  );

  // Drop the stale id first: it names a container that no longer exists, so
  // recreating would otherwise spend a stop + remove round trip on it and log
  // two failures that mean nothing.
  await sql`
    UPDATE servers SET container_id = NULL, updated_at = now() WHERE id = ${server.id}
  `;
  await recreateServerContainer(server.id);
  return true;
}

/**
 * Run a container operation, rebuilding the container once if the node reports
 * it is missing.
 *
 * Every power action goes through here, so drift is repaired by the action the
 * operator already took rather than by a support ticket. The retry is safe for
 * all four: start on a fresh container is the normal case, and stop/kill are
 * idempotent against a container that is not running.
 */
async function withMissingContainerRecovery<T>(
  server: ServerRow,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    // A rebuild that fails carries the more useful message (an unreachable
    // node, a blueprint that is gone), so it replaces the 404 rather than
    // being swallowed in favour of it.
    if (!(await healMissingContainer(server))) throw error;
    return await operation();
  }
}

export async function startServer(
  serverId: string,
  actorId: string,
): Promise<ServerSummary> {
  const server = await loadServerRow(serverId);
  assertNotSuspended(server);
  assertHasContainer(server);

  await setStatus(serverId, "starting");
  try {
    // Plugins must be on disk before the game process boots, so the
    // auto-updater runs inside the "starting" phase. Best-effort by contract,
    // so a catalog outage never blocks a start.
    await autoUpdateServerPlugins(serverId);
    await withMissingContainerRecovery(server, () =>
      startServerContainer(server.node_id, serverId),
    );
    await setStatus(serverId, "running");
  } catch (error) {
    await setStatus(serverId, "error");
    throw error;
  }

  await recordAudit({
    userId: actorId,
    action: "server.start",
    targetType: "server",
    targetId: serverId,
  });

  return getServer(serverId);
}

export async function stopServer(
  serverId: string,
  actorId: string,
): Promise<ServerSummary> {
  const server = await loadServerRow(serverId);
  assertHasContainer(server);

  await setStatus(serverId, "stopping");
  try {
    await withMissingContainerRecovery(server, () =>
      stopServerContainer(server.node_id, serverId),
    );
    await setStatus(serverId, "stopped");
  } catch (error) {
    await setStatus(serverId, "error");
    throw error;
  }

  await recordAudit({
    userId: actorId,
    action: "server.stop",
    targetType: "server",
    targetId: serverId,
  });

  return getServer(serverId);
}

/**
 * Force-stop a server with SIGKILL, bypassing the graceful stop.
 *
 * The escape hatch for a container stuck in a graceful stop or restart: no
 * grace period, no chance for the game to save. Audited distinctly from a
 * normal stop (`server.kill`) so the use of a destructive action is visible.
 * Does not require the server to be in any particular state. It is offered
 * precisely when a `stopping` transition has stalled.
 */
export async function killServer(
  serverId: string,
  actorId: string,
): Promise<ServerSummary> {
  const server = await loadServerRow(serverId);
  assertHasContainer(server);

  await setStatus(serverId, "stopping");
  try {
    await withMissingContainerRecovery(server, () =>
      killServerContainer(server.node_id, serverId),
    );
    await setStatus(serverId, "stopped");
  } catch (error) {
    await setStatus(serverId, "error");
    throw error;
  }

  await recordAudit({
    userId: actorId,
    action: "server.kill",
    targetType: "server",
    targetId: serverId,
  });

  return getServer(serverId);
}

export async function restartServer(
  serverId: string,
  actorId: string,
): Promise<ServerSummary> {
  const server = await loadServerRow(serverId);
  assertNotSuspended(server);
  assertHasContainer(server);

  // A restart is a stop with a start behind it, and the stop half is the part
  // that can hang. Recording `stopping` for the whole action is what makes the
  // transition visible to everyone, including a second tab or a page loaded
  // mid-restart, rather than only to the client that clicked the button, which
  // is what puts Kill within reach when the shutdown wedges.
  await setStatus(serverId, "stopping");
  try {
    // A restart re-reads the plugins directory at boot, so the auto-updater
    // runs before the agent restarts the container.
    await autoUpdateServerPlugins(serverId);
    await withMissingContainerRecovery(server, () =>
      restartServerContainer(server.node_id, serverId),
    );
    await setStatus(serverId, "running");
  } catch (error) {
    await setStatus(serverId, "error");
    throw error;
  }

  await recordAudit({
    userId: actorId,
    action: "server.restart",
    targetType: "server",
    targetId: serverId,
  });

  return getServer(serverId);
}

/**
 * Suspend a server: stop it and mark it un-startable by the owner.
 * Used by admin review and (optionally) the abuse watcher.
 */
export async function suspendServer(
  serverId: string,
  actorId: string | null,
  reason: string,
): Promise<void> {
  const server = await loadServerRow(serverId);

  if (server.container_id) {
    try {
      await stopServerContainer(server.node_id, serverId);
    } catch (error) {
      // Suspension must still be recorded even if the node is unreachable,
      // otherwise an offline node becomes a way to dodge enforcement.
      console.error(
        `[serverManager] could not stop ${serverId} while suspending:`,
        error,
      );
    }
  }

  await sql`
    UPDATE servers
    SET status = 'suspended', suspension_reason = ${reason},
        suspended_at = now(), updated_at = now()
    WHERE id = ${serverId}
  `;
  await recordAudit({
    userId: actorId,
    action: "server.suspend",
    targetType: "server",
    targetId: serverId,
    metadata: { reason },
  });
}

export async function unsuspendServer(
  serverId: string,
  actorId: string,
): Promise<void> {
  const server = await loadServerRow(serverId);
  if (server.status !== "suspended") {
    throw conflict("Server is not suspended");
  }

  await sql`
    UPDATE servers
    SET status = 'stopped', suspension_reason = NULL,
        suspended_at = NULL, updated_at = now()
    WHERE id = ${serverId}
  `;
  await recordAudit({
    userId: actorId,
    action: "server.unsuspend",
    targetType: "server",
    targetId: serverId,
  });
}

/**
 * Delete a server.
 *
 * The world data directory is retained unless `deleteData` is explicitly true,
 * because an accidental delete should be recoverable (plan.md section 11 step 8).
 *
 * **The node's cleanup is not best-effort.** Dropping the panel record while the
 * container survives inverts this module's ordering principle: a container with
 * no row is an orphan nobody can see. Worse, it keeps running, a deleted server
 * that still serves players, still writes to disk, and still holds its published
 * host ports, which the panel is now free to hand to the next server on that
 * node. So a node that cannot confirm the removal aborts the delete: the record
 * stays, the status goes back to what it was, and the operator retries once the
 * node is back. Retrying is safe because the agent's delete is idempotent.
 *
 * `force` is the escape hatch for the node that is never coming back
 * (decommissioned hardware, a lost host). It accepts the orphan knowingly, and
 * is admin-only for that reason, see `handleDeleteServer`. What was left behind
 * is written into the audit entry, because after the row is gone that log is the
 * only record of what still needs cleaning up by hand.
 *
 * A row with no container is exempt from the gate: there is nothing on the node
 * that can run or hold a port, so an unreachable node must not strand a failed
 * provision as an undeletable row. Asking to delete the data is not exempt,
 * because the files may well exist even when the container never did.
 */
export async function deleteServer(
  serverId: string,
  actorId: string,
  deleteData = false,
  force = false,
): Promise<void> {
  const server = await loadServerRow(serverId);
  const previousStatus = server.status;
  const cleanupMustSucceed =
    !force && (server.container_id !== null || deleteData);

  await setStatus(serverId, "deleting");

  // Detach any server links while both containers still exist, so the peer is
  // dropped from the pair network too. Best-effort: this only unwires networks
  // on the node, and the same node failure that would strand a link network is
  // the one the container delete below is about to refuse over.
  try {
    await detachAllServerLinks(serverId);
  } catch (error) {
    console.error(
      `[serverManager] link detach failed for ${serverId} (continuing):`,
      error,
    );
  }

  /** What the node still holds, when a forced delete walks away from it. */
  const orphaned: { container?: string; databases?: string[] } = {};

  try {
    // The agent removes the container, the per-server network and, only when
    // asked, the data directory, all on the node that owns them.
    await deleteServerContainer(server.node_id, serverId, deleteData);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (cleanupMustSucceed) {
      await setStatus(serverId, previousStatus);
      throw new HttpError(
        error instanceof HttpError ? error.status : 502,
        `${reason} Nothing was deleted. The server's container and files are ` +
          `still on the node. Retry once the node is reachable, or force the ` +
          `delete to drop the panel's record and leave them behind.`,
      );
    }

    console.error(
      `[serverManager] node cleanup failed for ${serverId} (${
        force ? "forced" : "no container"
      }, continuing):`,
      error,
    );
    if (server.container_id) orphaned.container = server.container_id;
  }

  // Drop any provisioned databases on the node's MariaDB before the panel
  // record disappears. Best-effort even when the container delete is not: the
  // node just answered that call, so a failure here is the database's, not the
  // node's, and it leaves data rather than a running container. The stored
  // name/user are passed so the agent drops each one by its real name.
  const dbRows = (await sql`
    SELECT id, db_name, db_user, node_id FROM server_databases
    WHERE server_id = ${serverId}
  `) as { id: string; db_name: string; db_user: string; node_id: string }[];

  for (const row of dbRows) {
    const node = await getNodeWithSecrets(row.node_id);
    if (node?.db.host && node.db.user && node.db.password) {
      try {
        await dropServerDatabase(
          row.node_id,
          serverId,
          row.db_name,
          row.db_user,
          node.db.user,
          node.db.password,
        );
      } catch (error) {
        console.error(
          `[serverManager] DB drop failed for ${serverId}/${row.id} (continuing):`,
          error,
        );
        orphaned.databases = [...(orphaned.databases ?? []), row.db_name];
      }
    } else {
      orphaned.databases = [...(orphaned.databases ?? []), row.db_name];
    }
  }

  // Cascades clear server_ports, server_env, server_subusers, server_databases.
  await sql`DELETE FROM servers WHERE id = ${serverId}`;

  const leftBehind = orphaned.container || orphaned.databases;
  if (leftBehind) {
    console.error(
      `[serverManager] ${serverId} deleted with leftovers on node ${server.node_id}:`,
      orphaned,
    );
  }

  await recordAudit({
    userId: actorId,
    action: "server.delete",
    targetType: "server",
    targetId: serverId,
    metadata: {
      dataDeleted: deleteData,
      ...(force ? { forced: true } : {}),
      // The row is gone after this; the audit entry is the only place an
      // operator can later find what is still sitting on the node.
      ...(leftBehind ? { nodeId: server.node_id, orphaned } : {}),
    },
  });
}

/**
 * Reconcile the stored status of a server with the node's actual container
 * state, so the dashboard does not show "running" for a crashed server.
 *
 * The decision itself lives in `statusReconcile.ts`, including why a graceful
 * stop is believed over a node that reports the container as still up. Here it
 * is only given the two inputs it needs: the observed state, and how long the
 * stored status has been in place (`updated_at`, which `setStatus` bumps).
 */
async function reconcileRowStatus(server: ServerRow): Promise<ServerStatus> {
  if (server.status === "suspended") return "suspended";
  if (!server.container_id) return server.status;

  const state = await getServerState(server.node_id, server.id);
  const resolved = reconcileStatus(
    server.status,
    state,
    Date.now() - new Date(server.updated_at).getTime(),
  );

  if (resolved !== server.status) {
    await setStatus(server.id, resolved);
  }
  return resolved;
}

export async function reconcileServerStatus(serverId: string): Promise<ServerStatus> {
  return reconcileRowStatus(await loadServerRow(serverId));
}

/**
 * {@link getServer} plus a live status reconcile, off a single read of the row.
 *
 * This is the server detail endpoint, so it runs on every page load and every
 * poll behind one. The ports, the plugin-support probe, and asking the node
 * what the container is actually doing all follow from the row, and each is
 * independent of the others, so they all run at once; the whole endpoint is two
 * database round trips and one node round trip deep.
 *
 * A node that cannot be reached must not cost the owner the page, so the
 * reconcile falls back to the stored status rather than propagating.
 */
export async function getServerReconciled(
  serverId: string,
): Promise<ServerSummary> {
  const row = await loadServerRow(serverId);

  const [summary, pluginSupport, status] = await Promise.all([
    toSummary(row),
    getServerPluginSupportSummary(serverId, row),
    reconcileRowStatus(row).catch((error) => {
      console.error(`[servers] status reconcile failed for ${serverId}:`, error);
      return row.status;
    }),
  ]);

  return { ...summary, pluginSupport, status };
}

// --- Reinstall ------------------------------------------------------------------

/**
 * Wipe a server's files and build it again from its blueprint.
 *
 * The destructive counterpart to {@link healMissingContainer}: that one rebuilds
 * a container *around* the data directory, this one deletes the directory and
 * runs the blueprint's install step over the empty space. Worlds, configs,
 * plugin jars, and anything the owner uploaded are gone; there is no backup and
 * no undo. Everything the panel records about the server survives, because
 * none of it lives in the data directory: its ports, env, databases, subusers,
 * SFTP credentials and links. That is the whole distinction between this and
 * delete-and-create-again: the server keeps its identity and its address.
 *
 * Every reason to refuse is checked here, synchronously, so a rejected reinstall
 * leaves the files intact. That includes asking the node whether it is ready:
 * an agent that is down fails every step below, and discovering it after the
 * wipe would leave the owner with neither their files nor a server.
 *
 * The rebuild itself is detached, for the same reason provisioning is (see
 * {@link provisionServer}). An image pull and an install script are minutes of
 * work that no HTTP request should be holding open. It reports the same way,
 * through the row's status and a freshly emptied install log.
 */
export async function reinstallServer(
  serverId: string,
  actorId: string,
): Promise<ServerSummary> {
  const server = await loadServerRow(serverId);

  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be reinstalled.",
    );
  }
  if (server.status === "deleting") {
    throw conflict("This server is being deleted.");
  }
  // Two ways to already be building: the row says so, or this process holds the
  // task. The second catches the window where a reinstall has been accepted but
  // has not written its status yet.
  if (isProvisioning(server.status) || inFlightProvisions.has(serverId)) {
    throw conflict(
      "This server is already being built. Wait for that to finish before reinstalling it.",
    );
  }

  const blueprintKey = await getBlueprintKeyById(server.blueprint_id);
  const blueprint = blueprintKey ? await getBlueprintByKey(blueprintKey) : null;
  if (!blueprint) {
    throw conflict(
      "This server's blueprint is no longer registered, so there is nothing to reinstall it from.",
    );
  }

  // The rebuild republishes the ports already reserved for this server rather
  // than allocating new ones. An address that moved under the players would
  // make a reinstall a migration. A server with no ports never got far enough
  // through its first provision to have anything to rebuild onto.
  const ports = (await sql`
    SELECT 1 FROM server_ports WHERE server_id = ${serverId} LIMIT 1
  `) as { 1: number }[];
  if (ports.length === 0) {
    throw conflict(
      "This server has no published ports, so its first install never finished. " +
        "Delete it and create it again instead.",
    );
  }

  await assertNodeReadyToProvision(server.node_id);

  // The install log starts empty: the previous build's output describes files
  // that are about to stop existing, and the reinstall's own progress is what a
  // reader wants from here on.
  await sql`
    UPDATE servers
    SET status = 'installing', install_log = '', install_started_at = now(),
        updated_at = now()
    WHERE id = ${serverId}
  `;
  await logPhase(
    serverId,
    `Reinstalling "${server.name}" from blueprint ${blueprint.key}. ` +
      "Everything in the server's data directory is deleted first.",
  );

  // Audited on acceptance, like `server.create`: the destructive decision has
  // been made and taken, whether or not the node then rebuilds successfully.
  await recordAudit({
    userId: actorId,
    action: "server.reinstall",
    targetType: "server",
    targetId: serverId,
    metadata: { blueprintKey: blueprint.key, nodeId: server.node_id },
  });

  // Detached on purpose, see provisionServer. Shares `inFlightProvisions` with
  // the create path so the two can never run against the same server at once.
  const task = rebuildServerFromBlueprint(serverId, blueprint).finally(() => {
    inFlightProvisions.delete(serverId);
  });
  inFlightProvisions.set(serverId, task);

  return getServer(serverId);
}

/**
 * The reinstall's background half: stop, wipe, install, rebuild.
 *
 * Ordered so that nothing is destroyed while the game may still be writing, and
 * so that a failure at any step leaves a row an operator can read rather than a
 * container pointing at files that are gone. Like {@link provisionServer} it
 * never rejects. The row's status and install log are how it reports.
 */
async function rebuildServerFromBlueprint(
  serverId: string,
  blueprint: Blueprint,
): Promise<void> {
  try {
    const server = await loadServerRow(serverId);

    // Stop before deleting, so the world is not half-written when it goes.
    // Best-effort: a container that is already stopped, or already gone, is
    // the state this is trying to reach.
    if (server.container_id) {
      await logPhase(serverId, "Stopping the server…");
      try {
        await stopServerContainer(server.node_id, serverId, 30);
      } catch (error) {
        console.error(
          `[serverManager] stop before reinstall failed for ${serverId} (continuing):`,
          error,
        );
      }
    }

    await assertStillProvisioning(serverId);
    await logPhase(serverId, "Deleting the server's files…");

    // The wipe, and the one step here that is *not* best-effort: reinstalling on
    // top of the old files is not what was asked for, so a failure has to stop
    // the rebuild rather than quietly become a reinstall-in-place.
    await deleteServerContainer(server.node_id, serverId, true);

    // The id named a container that no longer exists. Dropped before anything
    // can fail below, so a rebuild that dies mid-way leaves the drift
    // healMissingContainer expects rather than a row pointing at nothing.
    await sql`
      UPDATE servers SET container_id = NULL, updated_at = now() WHERE id = ${serverId}
    `;

    // The installed-plugin rows described jars that have just been deleted.
    // Left behind, they would read as "missing" in the plugins tab and be
    // re-downloaded by the pre-start auto-updater, a fresh install that
    // quietly restores the plugins it was asked to remove.
    await sql`DELETE FROM server_plugins WHERE server_id = ${serverId}`;

    if (blueprint.install) {
      await assertStillProvisioning(serverId);
      await logPhase(
        serverId,
        `Running the install script in ${blueprint.install.image}. ` +
          "The image is pulled first, so there may be no output for a while.",
      );

      // The server's stored env, not the blueprint's defaults: the install
      // script must see the same values the container will boot with, including
      // the published port and any key the owner has edited since creation.
      const { logs } = await runServerInstall(server.node_id, serverId, {
        image: blueprint.install.image,
        script: blueprint.install.script,
        entrypoint: blueprint.install.entrypoint,
        containerDataPath: blueprint.dataPath,
        env: await loadEnvForContainer(serverId),
        cpuLimit: Number(server.cpu_limit),
        memoryLimitMb: server.memory_limit_mb,
      });

      await appendInstallLog(serverId, `${logs.trimEnd()}\n`);
      await logPhase(serverId, "Install script finished.");
    }

    await assertStillProvisioning(serverId);
    await logPhase(
      serverId,
      `Creating the container from ${blueprint.dockerImage}. ` +
        "A node that has not run this image before pulls it now, which can " +
        "take several minutes.",
    );

    // Republishes the server's existing ports, env, limits and networks. It
    // leaves the server stopped, which is what the row's `installing` status
    // buys: there is no "was running" to restore, because a freshly installed
    // server is one the owner starts when they are ready for players on it.
    await recreateServerContainer(serverId);

    await logPhase(
      serverId,
      "Done. The server has been reinstalled and is ready to start.",
    );
  } catch (error) {
    if (error instanceof ProvisionAbandoned) {
      console.warn(
        `[serverManager] reinstall abandoned for ${serverId}: ${error.message}`,
      );
      return;
    }

    await setStatus(serverId, "error");
    const reason = error instanceof Error ? error.message : String(error);
    await logPhase(serverId, `Reinstall failed: ${reason}`);
    console.error(`[serverManager] reinstall failed for ${serverId}:`, error);
  }
}

// --- Additional port assignment ------------------------------------------------

/**
 * Load a server's resolved env vars for re-creating its container.
 *
 * `server_env` stores secret values encrypted; the container needs the plaintext.
 * Used by {@link recreateServerContainer}, which must hand the agent the same env
 * the server originally booted with, minus the masking the display path applies.
 */
async function loadEnvForContainer(serverId: string): Promise<Record<string, string>> {
  const rows = (await sql`
    SELECT key, value, is_secret FROM server_env
    WHERE server_id = ${serverId}
  `) as { key: string; value: string; is_secret: boolean }[];

  const env: Record<string, string> = {};
  for (const row of rows) {
    env[row.key] = row.is_secret ? decryptSecret(row.value) : row.value;
  }
  return env;
}

/**
 * Rebuild a server's container against its current `server_ports` set.
 *
 * Docker's port bindings (`HostConfig.PortBindings`) are fixed at container
 * creation, so adding or removing a published port is not an in-place update.
 * The container must be recreated. The data volume is a bind mount owned by the
 * agent, so recreating is non-destructive: world data, config and logs survive.
 *
 * The recreated container keeps the server's image, env, resource limits and
 * startup command exactly as they were at provisioning. It is left in `stopped`
 * state, matching the post-create contract: the owner starts it when ready.
 *
 * A server that is currently `running` is stopped first (graceful, then the
 * container is removed). One that never had a container (still `creating`/error
 * during provisioning) is treated as a plain create rather than a recreate.
 */
async function recreateServerContainer(serverId: string): Promise<void> {
  const server = await loadServerRow(serverId);
  const blueprintKey = await getBlueprintKeyById(server.blueprint_id);
  if (!blueprintKey) throw badRequest("Server blueprint is not available");
  const blueprint = await getBlueprintByKey(blueprintKey);
  if (!blueprint) throw badRequest("Server blueprint is not available");

  // The full port set the recreated container must publish: blueprint defaults
  // plus any owner-added additional ports, all read from `server_ports`.
  const portRows = (await sql`
    SELECT host_port, is_primary
    FROM server_ports
    WHERE server_id = ${serverId}
    ORDER BY is_primary DESC, host_port ASC
  `) as { host_port: number; is_primary: boolean }[];

  if (portRows.length === 0) {
    throw badRequest("Server has no ports to publish");
  }

  // Identity mapping by construction: the published number is the number the
  // game binds inside the container, on TCP and UDP both.
  const ports: PortBinding[] = portRows.flatMap((row) =>
    portBindingsFor(row.host_port),
  );

  const env = await loadEnvForContainer(serverId);

  // Keep the primary-port env (SERVER_PORT) pinned to the allocated port: the
  // game re-reads it on every boot, so a stale value would leave it listening
  // where nothing is forwarded. Persisting keeps `server_env` truthful for the
  // display path as well.
  if (blueprint.primaryPortEnv) {
    const primary = portRows.find((row) => row.is_primary) ?? portRows[0]!;
    const portValue = String(primary.host_port);
    if (env[blueprint.primaryPortEnv] !== portValue) {
      env[blueprint.primaryPortEnv] = portValue;
      await storeEnv(serverId, { [blueprint.primaryPortEnv]: portValue }, []);
    }
  }

  // Stop + remove the old container so the new one can take its port bindings.
  // Idempotent: a missing container (first create, or already removed) is fine.
  if (server.container_id) {
    try {
      await stopServerContainer(server.node_id, serverId, 30);
    } catch (error) {
      console.error(
        `[serverManager] stop before recreate failed for ${serverId} (continuing):`,
        error,
      );
    }
    try {
      await deleteServerContainer(server.node_id, serverId, false);
    } catch (error) {
      console.error(
        `[serverManager] remove before recreate failed for ${serverId} (continuing):`,
        error,
      );
    }

    // The old id must not survive the removal: if the create below fails, a row
    // still pointing at a container the node no longer has is exactly the drift
    // healMissingContainer would have to repair later.
    await sql`
      UPDATE servers SET container_id = NULL, updated_at = now() WHERE id = ${serverId}
    `;
  }

  // Rebuild the same startup command the create path produced, so a recreated
  // container launches identically. The command was interpolated at create time
  // and is not stored, so it is re-derived from the blueprint + resolved env.
  const command = blueprint.startupCommand
    ? ["/bin/sh", "-c", interpolateCommand(blueprint.startupCommand, env)]
    : undefined;

  const wasRunning = server.status === "running";

  await setStatus(serverId, "creating");
  try {
    const { containerId } = await createServerContainer(server.node_id, serverId, {
      image: blueprint.dockerImage,
      containerDataPath: blueprint.dataPath,
      env,
      ports,
      cpuLimit: Number(server.cpu_limit),
      memoryLimitMb: server.memory_limit_mb,
      readOnlyRootFilesystem: blueprint.supportsReadOnlyRoot === true,
      command,
      user: blueprint.user,
      tty: blueprint.tty === true,
      // Re-attach the DB network if the server has databases. The old
      // container's network attachments are lost when it is removed.
      extraNetworks: await extraNetworksForServer(serverId),
    });

    await sql`
      UPDATE servers
      SET container_id = ${containerId}, status = 'stopped', updated_at = now()
      WHERE id = ${serverId}
    `;

    // If the server was running before the recreate, bring it back up so the
    // owner experiences the port change as a brief restart, not a stop.
    if (wasRunning) {
      try {
        await startServerContainer(server.node_id, serverId);
        await setStatus(serverId, "running");
      } catch (error) {
        await setStatus(serverId, "error");
        console.error(
          `[serverManager] restart after recreate failed for ${serverId}:`,
          error,
        );
        throw error;
      }
    }
  } catch (error) {
    await setStatus(serverId, "error");
    console.error(`[serverManager] recreate failed for ${serverId}:`, error);
    throw error;
  }
}

/** Count a server's owner-added (additional) ports, for limit checks. */
export async function countAdditionalPorts(serverId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM server_ports
    WHERE server_id = ${serverId} AND is_additional = TRUE
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

export interface AddServerPortInput {
  serverId: string;
  actorId: string;
  /** Optional owner note shown in the ports card, e.g. "Metrics". */
  label?: string;
}

/**
 * Add an additional port to a server. **The panel picks the number.**
 *
 * The owner asks for "one more port", not for a specific one: a number is drawn
 * at random from the node's pool, then published as an identity mapping (host N
 * → container N) on TCP and UDP both. Letting the owner name the number meant
 * every failure mode was theirs to debug, for a number that has no meaning
 * until it is allocated anyway: not in the pool, taken by another server, held
 * by a host process. The allocated port comes back in the returned summary, and
 * the owner points their plugin config at it.
 *
 * The container is then recreated so the new binding takes effect. Docker
 * cannot apply a new port binding to a running container.
 *
 * Enforces the panel-wide `maxAdditionalPortsPerServer` limit before
 * allocating, so a refused add never consumes a pool port. Blueprint ports and
 * the primary port are never affected and never count against the limit.
 */
export async function addServerPort(
  input: AddServerPortInput,
): Promise<ServerSummary> {
  const server = await loadServerRow(input.serverId);

  const label =
    input.label !== undefined && input.label !== null
      ? input.label.trim().slice(0, 64)
      : null;

  // Enforce the per-server additional-port limit before touching the pool.
  const limits = await getServerLimits();
  const current = await countAdditionalPorts(input.serverId);
  if (current >= limits.maxAdditionalPortsPerServer) {
    throw conflict(
      `This server already has the maximum of ${limits.maxAdditionalPortsPerServer} additional port(s). ` +
        "Remove one before adding another, or ask an administrator to raise the limit.",
    );
  }

  // A random free number from the node's pool, verified bindable on both
  // protocols. Allocation is what decides the number, so there is no
  // already-published pre-check to run: a number this server already holds is
  // in `server_ports` and therefore not a candidate.
  const port = await allocateHostPort(server.node_id);

  await sql`
    INSERT INTO server_ports (
      server_id, node_id, host_port, container_port,
      is_primary, is_additional, label
    ) VALUES (
      ${input.serverId}, ${server.node_id}, ${port}, ${port},
      FALSE, TRUE, ${label}
    )
  `;

  await recreateServerContainer(input.serverId);

  await recordAudit({
    userId: input.actorId,
    action: "server.port.add",
    targetType: "server",
    targetId: input.serverId,
    metadata: { port, label },
  });

  return getServer(input.serverId);
}

/**
 * Remove an owner-added additional port from a server.
 *
 * Blueprint ports (`is_additional = FALSE`) cannot be removed here. They are
 * part of the game's definition, not an owner assignment. The container is
 * recreated afterwards so the freed host binding is actually released.
 *
 * The port is freed from `server_ports` by the row delete; it returns to the
 * node's pool for future allocation. There is no lingering Docker binding once
 * the old container is removed.
 */
export async function removeServerPort(
  serverId: string,
  port: number,
  actorId: string,
): Promise<ServerSummary> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest("port must be an integer between 1 and 65535");
  }

  const rows = (await sql`
    DELETE FROM server_ports
    WHERE server_id = ${serverId}
      AND host_port = ${port}
      AND is_additional = TRUE
    RETURNING host_port, is_primary
  `) as { host_port: number; is_primary: boolean }[];

  if (rows.length === 0) {
    // Either the port doesn't exist on this server, or it is a blueprint port
    // (not additional). Both are reported the same way to avoid leaking which.
    throw notFound(
      "That additional port was not found on this server. Blueprint ports cannot be removed.",
    );
  }

  const removed = rows[0]!;
  if (removed.is_primary) {
    // Unreachable by construction: the create path sets is_primary only on
    // blueprint ports (is_additional = FALSE), and addServerPort always sets
    // is_primary = FALSE. The DELETE above filtered on is_additional = TRUE, so
    // a primary row can never have been returned here. Guard anyway so a future
    // schema drift cannot silently delete the player-facing port.
    throw conflict(
      "The primary port cannot be removed. Blueprint ports are managed by the server's game.",
    );
  }

  await recreateServerContainer(serverId);

  await recordAudit({
    userId: actorId,
    action: "server.port.remove",
    targetType: "server",
    targetId: serverId,
    metadata: { port },
  });

  return getServer(serverId);
}

// --- Database provisioning ----------------------------------------------------

/**
 * A database provisioned for a server, as the API returns it.
 *
 * The password is included **only** at creation time (and on a reset). The list
 * endpoint returns `null` for `password`, because the stored value is encrypted
 * and never decrypted for display. The owner is told to copy it when it is shown.
 */
export interface ServerDatabaseSummary {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  /** Plaintext password, only present at creation/reset, null on list. */
  password: string | null;
  createdAt: Date;
}

/** List a server's provisioned databases (passwords never decrypted for display). */
export async function listServerDatabases(
  serverId: string,
): Promise<ServerDatabaseSummary[]> {
  return loadDatabases(serverId);
}

/** Load a server's provisioned databases, with passwords decrypted for the DB
 *  name/user/host (never for display, it stays encrypted in the row). */
async function loadDatabases(
  serverId: string,
): Promise<ServerDatabaseSummary[]> {
  const rows = (await sql`
    SELECT id, db_name, db_user, db_password_encrypted, host, port, created_at
    FROM server_databases
    WHERE server_id = ${serverId}
    ORDER BY created_at ASC
  `) as {
    id: string;
    db_name: string;
    db_user: string;
    db_password_encrypted: string;
    host: string;
    port: number;
    created_at: Date;
  }[];

  // The password is never decrypted for the list view, only at creation.
  return rows.map((row) => ({
    id: row.id,
    name: row.db_name,
    user: row.db_user,
    host: row.host,
    port: row.port,
    password: null,
    createdAt: row.created_at,
  }));
}

/** Count a server's provisioned databases, for limit checks. */
export async function countServerDatabases(serverId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM server_databases
    WHERE server_id = ${serverId}
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/**
 * Generate a unique, safe DB name and user for a new database.
 *
 * The name is `db_<short-server-id>_<6 random hex chars>` and the user is the
 * matching `u_` form. The random suffix is what lets one server own multiple
 * databases. A name derived from the server id alone would collide on the
 * `(node_id, db_name)` unique constraint on the second database.
 *
 * The suffix (2^24 possibilities) is checked against existing names on this
 * node, and regenerated on the astronomically rare collision.
 */
async function generateDbIdentifiers(
  serverId: string,
  nodeId: string,
): Promise<{ dbName: string; dbUser: string }> {
  const shortId = serverId.replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomBytes(3).toString("hex"); // 6 hex chars
    const dbName = `db_${shortId}${suffix}`;
    const dbUser = `u_${shortId}${suffix}`;
    // Confirm this name is not already taken on this node before handing it out.
    const existing = (await sql`
      SELECT 1 FROM server_databases
      WHERE node_id = ${nodeId} AND db_name = ${dbName}
      LIMIT 1
    `) as { 1: number }[];
    if (existing.length === 0) {
      return { dbName, dbUser };
    }
  }
  // Five 1-in-16M collisions in a row is not a real outcome; fail loudly.
  throw conflict("Could not generate a unique database name. Please try again.");
}

/**
 * The extra Docker networks a server's container should be attached to.
 *
 * A server with at least one provisioned database needs to be on the node's
 * `node_db_net` so it can reach the shared MariaDB. The network name is the
 * well-known default the agent's `setup-db` script creates; if the agent is
 * configured with a custom name it still matches because the agent owns the
 * attach logic and treats an already-present network as a no-op.
 *
 * Server links each contribute their pairwise network, so a recreate restores
 * the link's connectivity. See `serverLinks.ts`.
 */
async function extraNetworksForServer(serverId: string): Promise<string[]> {
  const networks: string[] = [];
  if ((await countServerDatabases(serverId)) > 0) {
    networks.push("node_db_net");
  }
  networks.push(...(await listServerLinkNetworks(serverId)));
  return networks;
}

export interface AddServerDatabaseInput {
  serverId: string;
  actorId: string;
}

/**
 * Provision a database for a server on its node's shared MariaDB.
 *
 * Generates a database name, a scoped user, and a random password (32 chars,
 * alphanumeric only so it is safe in connection strings). The agent executes
 * the CREATE DATABASE / CREATE USER / GRANT SQL via `docker exec` against the
 * node DB container, and attaches the server's container to `node_db_net`.
 *
 * The password is stored encrypted and returned **once** in the result so the
 * owner can copy it; it is never decryptable again.
 *
 * Enforces the panel-wide `maxDatabasesPerServer` limit before touching the
 * node. A node without a configured DB admin credential (or without the
 * container running) fails with a clear error.
 */
export async function addServerDatabase(
  input: AddServerDatabaseInput,
): Promise<ServerDatabaseSummary> {
  const server = await loadServerRow(input.serverId);

  // Enforce the per-server database limit before generating anything.
  const limits = await getServerLimits();
  const current = await countServerDatabases(input.serverId);
  if (current >= limits.maxDatabasesPerServer) {
    throw conflict(
      `This server already has the maximum of ${limits.maxDatabasesPerServer} database(s). ` +
        "Remove one before adding another, or ask an administrator to raise the limit.",
    );
  }

  // Load the node's DB admin credentials. A node without them configured cannot
  // provision databases. The operator needs to run setup-db and re-register.
  const node = await getNodeWithSecrets(server.node_id);
  if (!node) throw notFound("Node not found");
  if (!node.db.host || !node.db.user || !node.db.password) {
    throw conflict(
      `Node "${node.name}" does not have a database server configured. ` +
        "An administrator must run the node database setup and configure the node's DB admin credentials.",
    );
  }

  // Generate the per-server database password. Alphanumeric only so it is safe
  // to embed in a connection string or a game-server config file.
  const dbPassword = generateStrongPassword(32);

  // Generate a unique DB name + user for this database. The random suffix is
  // what lets a server own multiple databases. A name derived from the server
  // id alone would collide on the (node_id, db_name) unique constraint.
  const { dbName, dbUser } = await generateDbIdentifiers(
    input.serverId,
    server.node_id,
  );

  const result = await provisionServerDatabase(
    server.node_id,
    input.serverId,
    dbName,
    dbUser,
    node.db.user,
    node.db.password,
    dbPassword,
  );

  // Persist the record. The host comes from the agent (the DB container's IP on
  // node_db_net), which is what the game server will connect to.
  const inserted = (await sql`
    INSERT INTO server_databases (
      server_id, node_id, db_name, db_user, db_password_encrypted, host, port
    ) VALUES (
      ${input.serverId}, ${server.node_id}, ${result.name}, ${result.user},
      ${encryptSecret(dbPassword)}, ${result.host}, ${result.port}
    )
    RETURNING *
  `) as {
    id: string;
    db_name: string;
    db_user: string;
    host: string;
    port: number;
    created_at: Date;
  }[];

  const row = inserted[0]!;

  await recordAudit({
    userId: input.actorId,
    action: "server.database.add",
    targetType: "server",
    targetId: input.serverId,
    metadata: {
      databaseId: row.id,
      dbName: result.name,
      dbUser: result.user,
      host: result.host,
      port: result.port,
    },
  });

  return {
    id: row.id,
    name: row.db_name,
    user: row.db_user,
    host: row.host,
    port: row.port,
    password: dbPassword,
    createdAt: row.created_at,
  };
}

/**
 * Remove a server's database: drop the DB and user on the node MariaDB, detach
 * the container from `node_db_net`, and delete the panel record.
 *
 * Best-effort on the node side: a node that is unreachable still loses its
 * panel record (the orphaned DB is a manual cleanup task, better than blocking
 * the owner's request). The stored encrypted password is not needed for the
 * DROP (the admin credential is), so it is simply deleted.
 */
export async function removeServerDatabase(
  serverId: string,
  databaseId: string,
  actorId: string,
): Promise<void> {
  const rows = (await sql`
    DELETE FROM server_databases
    WHERE id = ${databaseId} AND server_id = ${serverId}
    RETURNING db_name, db_user, node_id
  `) as { db_name: string; db_user: string; node_id: string }[];

  if (rows.length === 0) {
    throw notFound("Database not found on this server.");
  }

  const removed = rows[0]!;

  // Drop the DB and user on the node. Best-effort: an unreachable node should
  // not block the panel-side removal. Pass the stored name/user so the agent
  // drops exactly this database, not a name re-derived from the server id.
  const node = await getNodeWithSecrets(removed.node_id);
  if (node?.db.host && node.db.user && node.db.password) {
    try {
      await dropServerDatabase(
        removed.node_id,
        serverId,
        removed.db_name,
        removed.db_user,
        node.db.user,
        node.db.password,
      );
    } catch (error) {
      console.error(
        `[serverManager] node DB drop failed for ${serverId}/${databaseId} (continuing):`,
        error,
      );
    }
  }

  await recordAudit({
    userId: actorId,
    action: "server.database.remove",
    targetType: "server",
    targetId: serverId,
    metadata: {
      databaseId,
      dbName: removed.db_name,
      dbUser: removed.db_user,
    },
  });
}

/**
 * Reset a database's password: generate a new one, run ALTER USER on the node,
 * and update the encrypted record. Returns the new plaintext password once.
 */
export async function resetServerDatabasePassword(
  serverId: string,
  databaseId: string,
  actorId: string,
): Promise<{ password: string }> {
  const rows = (await sql`
    SELECT id, db_name, db_user, node_id FROM server_databases
    WHERE id = ${databaseId} AND server_id = ${serverId}
  `) as { id: string; db_name: string; db_user: string; node_id: string }[];

  if (rows.length === 0) {
    throw notFound("Database not found on this server.");
  }

  const db = rows[0]!;
  const node = await getNodeWithSecrets(db.node_id);
  if (!node?.db.host || !node.db.user || !node.db.password) {
    throw conflict("This node's database server is not configured.");
  }

  const newPassword = generateStrongPassword(32);

  // ALTER USER via the agent's SQL exec path. We reuse provisionServerDatabase's
  // exec by calling a dedicated node endpoint is overkill; instead, the agent's
  // existing provision endpoint is CREATE-or-replace, so re-calling it with the
  // stored name/user but a new password re-creates the user with the new
  // password (DROP USER IF EXISTS + CREATE USER). The database itself survives
  // (CREATE DATABASE IF NOT EXISTS). The name/user come from the stored row so
  // the reset targets exactly this database.
  await provisionServerDatabase(
    db.node_id,
    serverId,
    db.db_name,
    db.db_user,
    node.db.user,
    node.db.password,
    newPassword,
  );

  await sql`
    UPDATE server_databases
    SET db_password_encrypted = ${encryptSecret(newPassword)}
    WHERE id = ${databaseId}
  `;

  await recordAudit({
    userId: actorId,
    action: "server.database.reset_password",
    targetType: "server",
    targetId: serverId,
    metadata: { databaseId },
  });

  return { password: newPassword };
}

