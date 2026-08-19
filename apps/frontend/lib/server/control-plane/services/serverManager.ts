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
  allocateSpecificHostPort,
  scheduleServer,
  scheduleServerOnNode,
  type ResourceRequest,
} from "../nodes/scheduler";
import {
  createServerContainer,
  deleteServerContainer,
  getServerState,
  killServerContainer,
  restartServerContainer,
  runServerInstall,
  startServerContainer,
  stopServerContainer,
  provisionServerDatabase,
  dropServerDatabase,
  type PortBinding,
} from "../nodes/nodeServerApi";
import { checkPortsFree, type PortProtocol } from "../nodes/nodePortsApi";
import { expandNodePortPool } from "../nodes/portPool";
import { assertNodeReadyToProvision } from "../nodes/nodeApi";
import { getNodeWithSecrets } from "../nodes/nodeRegistry";
import { recordAudit } from "./auditLog";
import { getServerLimits } from "./settings";
import { listServerLinkNetworks, detachAllServerLinks } from "./serverLinks";
import {
  autoUpdateServerPlugins,
  getServerPluginSupportSummary,
} from "./pluginManager";

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
  created_at: Date;
  updated_at: Date;
  /** Joined from `nodes.hostname` — the address players connect to. */
  node_hostname?: string;
  /** Why the server was suspended, shown to the owner. Null when not suspended. */
  suspension_reason?: string | null;
  /** When the server was last suspended. Null when not suspended. */
  suspended_at?: Date | null;
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
    /** The published port — identity mapping: host and container side are this number. */
    port: number;
    protocol: string;
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
   * set on the detail read (`getServer`), never on list reads — list callers
   * don't need it and it costs a blueprint + env lookup.
   */
  pluginSupport?: {
    label: string;
    providerId: string;
    directory: string;
  } | null;
}

// --- Reads --------------------------------------------------------------------

async function loadPorts(serverId: string) {
  const rows = (await sql`
    SELECT host_port, protocol, is_primary, is_additional, label
    FROM server_ports
    WHERE server_id = ${serverId}
    ORDER BY is_primary DESC, is_additional ASC, host_port ASC
  `) as {
    host_port: number;
    protocol: string;
    is_primary: boolean;
    is_additional: boolean;
    label: string | null;
  }[];

  // host_port IS the port: bindings are identity mappings (host N → container
  // N), so container_port — still stored for the table's primary key — is not
  // part of the API surface.
  return rows.map((row) => ({
    port: row.host_port,
    protocol: row.protocol,
    isPrimary: row.is_primary,
    isAdditional: row.is_additional,
    label: row.label,
  }));
}

async function toSummary(row: ServerRow): Promise<ServerSummary> {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    nodeId: row.node_id,
    nodeHostname: row.node_hostname ?? null,
    blueprintKey: await getBlueprintKeyById(row.blueprint_id),
    status: row.status,
    cpuLimit: Number(row.cpu_limit),
    memoryLimitMb: row.memory_limit_mb,
    diskLimitMb: row.disk_limit_mb,
    ports: await loadPorts(row.id),
    createdAt: row.created_at,
    suspensionReason: row.suspension_reason ?? null,
    suspendedAt: row.suspended_at ?? null,
  };
}

/**
 * Count servers hosted on a node, for the node-deletion gate.
 *
 * Cheaper than {@link listServersForNode} (no ports, no owner lookups) — it
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
    SELECT s.*, n.hostname AS node_hostname
    FROM servers s JOIN nodes n ON n.id = s.node_id
    WHERE s.owner_id = ${ownerId} ORDER BY s.created_at DESC
  `) as ServerRow[];
  return Promise.all(rows.map(toSummary));
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
    SELECT s.*, n.hostname AS node_hostname
    FROM servers s JOIN nodes n ON n.id = s.node_id
    WHERE s.node_id = ${nodeId} ORDER BY s.created_at DESC
  `) as ServerRow[];
  return Promise.all(rows.map(toSummary));
}

/** Servers the user can see: owned plus any they are a subuser on. */
export async function listAccessibleServers(userId: string): Promise<ServerSummary[]> {
  const rows = (await sql`
    SELECT DISTINCT s.*, n.hostname AS node_hostname
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    LEFT JOIN server_subusers su ON su.server_id = s.id
    WHERE s.owner_id = ${userId} OR su.user_id = ${userId}
    ORDER BY s.created_at DESC
  `) as ServerRow[];
  return Promise.all(rows.map(toSummary));
}

export async function listAllServers(): Promise<ServerSummary[]> {
  const rows = (await sql`
    SELECT s.*, n.hostname AS node_hostname
    FROM servers s JOIN nodes n ON n.id = s.node_id
    ORDER BY s.created_at DESC
  `) as ServerRow[];
  return Promise.all(rows.map(toSummary));
}

async function loadServerRow(serverId: string): Promise<ServerRow> {
  const rows = (await sql`
    SELECT s.*, n.hostname AS node_hostname
    FROM servers s JOIN nodes n ON n.id = s.node_id
    WHERE s.id = ${serverId}
  `) as ServerRow[];
  const row = rows[0];
  if (!row) throw notFound("Server not found");
  return row;
}

export async function getServer(serverId: string): Promise<ServerSummary> {
  const summary = await toSummary(await loadServerRow(serverId));
  return {
    ...summary,
    pluginSupport: await getServerPluginSupportSummary(serverId),
  };
}

async function setStatus(serverId: string, status: ServerStatus): Promise<void> {
  await sql`
    UPDATE servers SET status = ${status}, updated_at = now() WHERE id = ${serverId}
  `;
}

// --- Environment variables ----------------------------------------------------

/** Persist resolved env vars, encrypting the ones the preset marks secret. */
async function storeEnv(
  serverId: string,
  values: Record<string, string>,
  secretKeys: string[],
): Promise<void> {
  const secrets = new Set(secretKeys);

  for (const [key, value] of Object.entries(values)) {
    const isSecret = secrets.has(key);
    const stored = isSecret ? encryptSecret(value) : value;

    await sql`
      INSERT INTO server_env (server_id, key, value, is_secret)
      VALUES (${serverId}, ${key}, ${stored}, ${isSecret})
      ON CONFLICT (server_id, key) DO UPDATE SET
        value = EXCLUDED.value, is_secret = EXCLUDED.is_secret
    `;
  }
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
  /** Requested host port for the primary game port; best-effort. */
  preferredPort?: number;
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

/**
 * Create a server: reserve DB state, then provision on the node.
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
  // drain flag. Ask the node itself whether it can actually take a server —
  // an agent that is down, or whose data root it cannot write to, fails every
  // provision at `mkdir`. Checking here means the admin gets one actionable
  // error instead of a half-created server left in `error`.
  await assertNodeReadyToProvision(node.nodeId);

  const inserted = (await sql`
    INSERT INTO servers (
      name, owner_id, node_id, blueprint_id, status,
      cpu_limit, memory_limit_mb, disk_limit_mb
    ) VALUES (
      ${input.name}, ${input.ownerId}, ${node.nodeId}, ${blueprintId}, 'creating',
      ${input.cpuLimit}, ${input.memoryLimitMb}, ${input.diskLimitMb}
    )
    RETURNING *
  `) as ServerRow[];

  const server = inserted[0]!;

  try {
    // Reserve ports. The UNIQUE constraint on server_ports is what makes
    // concurrent creation safe; allocateHostPort just picks a likely candidate.
    const bindings: PortBinding[] = [];
    const mainPort = primaryPort(blueprint);
    let primaryHostPort: number | undefined;

    for (const port of blueprint.defaultPorts) {
      const isPrimary = port === mainPort;
      // Best-effort preference: the admin's explicit choice for the primary
      // port, otherwise the blueprint's preferred number (e.g. 25565) when it
      // happens to be in the node's pool and free.
      const hostPort = await allocateHostPort(
        node.nodeId,
        port.protocol,
        isPrimary ? input.preferredPort ?? port.container : port.container,
      );

      // Identity mapping: the same number is published on the host and bound
      // inside the container (host N → container N), so a port is one number,
      // not a pair.
      await sql`
        INSERT INTO server_ports (
          server_id, node_id, host_port, container_port, protocol, is_primary
        ) VALUES (
          ${server.id}, ${node.nodeId}, ${hostPort}, ${hostPort},
          ${port.protocol}, ${isPrimary}
        )
      `;

      if (isPrimary) primaryHostPort = hostPort;

      bindings.push({
        hostPort,
        containerPort: hostPort,
        protocol: port.protocol,
      });
    }

    // The game must listen on the number that was actually published, so the
    // primary port's number is injected into the env (SERVER_PORT for the itzg
    // images) before anything is persisted or interpolated.
    if (blueprint.primaryPortEnv && primaryHostPort !== undefined) {
      resolved.values[blueprint.primaryPortEnv] = String(primaryHostPort);
    }

    await storeEnv(server.id, resolved.values, resolved.secretKeys);

    // A blueprint's startup command is interpolated with the resolved env once,
    // here, so the agent receives a concrete argv rather than a template. This
    // runs after the primary-port env is set, so {{SERVER_PORT}}-style
    // placeholders see the allocated port.
    const command = blueprint.startupCommand
      ? ["/bin/sh", "-c", interpolateCommand(blueprint.startupCommand, resolved.values)]
      : undefined;

    // First-launch provisioning, when the blueprint defines it: run the install
    // script against the (agent-owned) data directory before the runtime
    // container exists, so a failure leaves no half-built container behind.
    if (blueprint.install) {
      await setStatus(server.id, "installing");
      await runServerInstall(node.nodeId, server.id, {
        image: blueprint.install.image,
        script: blueprint.install.script,
        entrypoint: blueprint.install.entrypoint,
        containerDataPath: blueprint.dataPath,
        env: resolved.values,
        cpuLimit: input.cpuLimit,
        memoryLimitMb: input.memoryLimitMb,
      });
    }

    // The agent creates the data directory on the node's own disk and derives
    // the bind mount from it — the panel never names a host path.
    const { containerId } = await createServerContainer(node.nodeId, server.id, {
      image: blueprint.dockerImage,
      containerDataPath: blueprint.dataPath,
      env: resolved.values,
      ports: bindings,
      cpuLimit: input.cpuLimit,
      memoryLimitMb: input.memoryLimitMb,
      readOnlyRootFilesystem: blueprint.supportsReadOnlyRoot === true,
      command,
      user: blueprint.user,
      tty: blueprint.tty === true,
      // A newly created server has no databases yet, but the call is kept for
      // symmetry with recreateServerContainer.
      extraNetworks: await extraNetworksForServer(server.id),
    });

    await sql`
      UPDATE servers
      SET container_id = ${containerId}, status = 'stopped', updated_at = now()
      WHERE id = ${server.id}
    `;

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

    return getServer(server.id);
  } catch (error) {
    // Leave a visible, recoverable record instead of a silent orphan.
    await setStatus(server.id, "error");
    console.error(`[serverManager] provisioning failed for ${server.id}:`, error);
    throw error;
  }
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
    throw conflict(
      "This server has no container yet. It may still be provisioning or have failed to create.",
    );
  }
}

/**
 * Rebuild a container the node no longer has.
 *
 * Panel/node drift is a real state, not a corrupted one: a container can be
 * removed out of band — a manual `docker rm`, a prune, a rebuilt node — while
 * the server row still points at its id. Every lifecycle call then comes back
 * as the agent's "no container exists on this node" 404, and nothing in the UI
 * can clear it, because the only path that creates a container is provisioning
 * and that already ran.
 *
 * Rebuilding from the stored spec is the way out, and it is non-destructive:
 * the data directory belongs to the agent and outlives any container, so the
 * new container comes up on the world, config and logs the old one left.
 *
 * Returns false when the node does have the container after all — the 404 came
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
    // auto-updater runs inside the "starting" phase. Best-effort by contract —
    // a catalog outage never blocks a start.
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
 * Does not require the server to be in any particular state — it is offered
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
 * The world data directory is retained unless `deleteData` is explicitly true —
 * an accidental delete should be recoverable (plan.md section 11 step 8).
 */
export async function deleteServer(
  serverId: string,
  actorId: string,
  deleteData = false,
): Promise<void> {
  const server = await loadServerRow(serverId);
  await setStatus(serverId, "deleting");

  // Detach any server links while both containers still exist, so the peer is
  // dropped from the pair network too. Best-effort, like the cleanup below.
  try {
    await detachAllServerLinks(serverId);
  } catch (error) {
    console.error(
      `[serverManager] link detach failed for ${serverId} (continuing):`,
      error,
    );
  }

  try {
    // The agent removes the container, the per-server network and — only when
    // asked — the data directory, all on the node that owns them.
    await deleteServerContainer(server.node_id, serverId, deleteData);
  } catch (error) {
    // A node that is unreachable must not block removal of the panel record;
    // the container is already stopped-or-gone from the user's perspective.
    console.error(
      `[serverManager] node cleanup failed for ${serverId} (continuing):`,
      error,
    );
  }

  // Drop any provisioned databases on the node's MariaDB before the panel
  // record disappears. Best-effort: an unreachable node leaves orphaned DBs
  // (a manual cleanup task), but that is better than blocking the delete. The
  // stored name/user are passed so the agent drops each one by its real name.
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
      }
    }
  }

  // Cascades clear server_ports, server_env, server_subusers, server_databases.
  await sql`DELETE FROM servers WHERE id = ${serverId}`;

  await recordAudit({
    userId: actorId,
    action: "server.delete",
    targetType: "server",
    targetId: serverId,
    metadata: { dataDeleted: deleteData },
  });
}

/**
 * Reconcile the stored status of a server with the node's actual container
 * state, so the dashboard does not show "running" for a crashed server.
 *
 * Suspended servers are never reconciled away: that state is an administrative
 * decision, not an observation of the node.
 */
export async function reconcileServerStatus(serverId: string): Promise<ServerStatus> {
  const server = await loadServerRow(serverId);
  if (server.status === "suspended") return "suspended";
  if (!server.container_id) return server.status;

  const state = await getServerState(server.node_id, serverId);

  const mapped: ServerStatus =
    state === "running" || state === "restarting"
      ? "running"
      : state === "missing" || state === "dead"
        ? "error"
        : "stopped";

  if (mapped !== server.status) {
    await setStatus(serverId, mapped);
  }
  return mapped;
}

// --- Additional port assignment ------------------------------------------------

/**
 * Load a server's resolved env vars for re-creating its container.
 *
 * `server_env` stores secret values encrypted; the container needs the plaintext.
 * Used by {@link recreateServerContainer}, which must hand the agent the same env
 * the server originally booted with — minus the masking the display path applies.
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
 * creation, so adding or removing a published port is not an in-place update —
 * the container must be recreated. The data volume is a bind mount owned by the
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
    SELECT host_port, protocol, is_primary
    FROM server_ports
    WHERE server_id = ${serverId}
    ORDER BY is_primary DESC, host_port ASC
  `) as { host_port: number; protocol: string; is_primary: boolean }[];

  if (portRows.length === 0) {
    throw badRequest("Server has no ports to publish");
  }

  // Identity mapping by construction: the published number is the number the
  // game binds inside the container.
  const ports: PortBinding[] = portRows.map((row) => ({
    hostPort: row.host_port,
    containerPort: row.host_port,
    protocol: row.protocol as PortProtocol,
  }));

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
      // Re-attach the DB network if the server has databases — the old
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
  /** The port to publish (1-65535) — identity-mapped, host and container. */
  port: number;
  protocol: PortProtocol;
  /** Optional owner note shown in the ports card, e.g. "Metrics". */
  label?: string;
}

/**
 * Add an owner-configured additional port to a server.
 *
 * The port is an identity mapping — the same number is published on the host
 * and bound in the container — and must be available: a member of the node's
 * port pool for this protocol, unallocated in the panel, and free on the host
 * (verified through the agent). A port that fails any check is a readable 409;
 * no fallback is substituted because the owner chose that exact number.
 *
 * The container is then recreated so the new binding takes effect — Docker
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

  if (
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  ) {
    throw badRequest("port must be an integer between 1 and 65535");
  }

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

  // A (port, protocol) pair must be unique per server — the table's PRIMARY KEY
  // enforces it, but a pre-check gives a readable 409 instead of a raw
  // constraint violation.
  const existing = (await sql`
    SELECT 1 FROM server_ports
    WHERE server_id = ${input.serverId}
      AND host_port = ${input.port}
      AND protocol = ${input.protocol}
  `) as { 1: number }[];
  if (existing.length > 0) {
    throw conflict(
      `Port ${input.port}/${input.protocol} is already published on this server.`,
    );
  }

  // The port must be reservable exactly as asked — see the function doc for why
  // there is no fallback here, unlike at create.
  await allocateSpecificHostPort(server.node_id, input.protocol, input.port);

  await sql`
    INSERT INTO server_ports (
      server_id, node_id, host_port, container_port, protocol,
      is_primary, is_additional, label
    ) VALUES (
      ${input.serverId}, ${server.node_id}, ${input.port}, ${input.port},
      ${input.protocol}, FALSE, TRUE, ${label}
    )
  `;

  await recreateServerContainer(input.serverId);

  await recordAudit({
    userId: input.actorId,
    action: "server.port.add",
    targetType: "server",
    targetId: input.serverId,
    metadata: {
      port: input.port,
      protocol: input.protocol,
      label,
    },
  });

  return getServer(input.serverId);
}

/**
 * Remove an owner-added additional port from a server.
 *
 * Blueprint ports (`is_additional = FALSE`) cannot be removed here — they are
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
  protocol: PortProtocol,
  actorId: string,
): Promise<ServerSummary> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest("port must be an integer between 1 and 65535");
  }

  const rows = (await sql`
    DELETE FROM server_ports
    WHERE server_id = ${serverId}
      AND host_port = ${port}
      AND protocol = ${protocol}
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
    metadata: {
      port,
      protocol,
    },
  });

  return getServer(serverId);
}

// --- Database provisioning ----------------------------------------------------

/**
 * A database provisioned for a server, as the API returns it.
 *
 * The password is included **only** at creation time (and on a reset). The list
 * endpoint returns `null` for `password` — the stored value is encrypted and
 * never decrypted for display. The owner is told to copy it when it is shown.
 */
export interface ServerDatabaseSummary {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  /** Plaintext password — only present at creation/reset, null on list. */
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
 *  name/user/host (never for display — password stays encrypted in the row). */
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

  // The password is never decrypted for the list view — only at creation.
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
 * databases — a name derived from the server id alone would collide on the
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
 * the link's connectivity — see `serverLinks.ts`.
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
  // provision databases — the operator needs to run setup-db and re-register.
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
  // what lets a server own multiple databases — a name derived from the server
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

