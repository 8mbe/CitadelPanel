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

import { sql } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/http";
import { encryptSecret } from "../lib/crypto";
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
  getServerState,
  killServerContainer,
  restartServerContainer,
  runServerInstall,
  startServerContainer,
  stopServerContainer,
  type PortBinding,
} from "../nodes/nodeServerApi";
import { assertNodeReadyToProvision } from "../nodes/nodeApi";
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
  ports: { hostPort: number; containerPort: number; protocol: string; isPrimary: boolean }[];
  createdAt: Date;
}

// --- Reads --------------------------------------------------------------------

async function loadPorts(serverId: string) {
  const rows = (await sql`
    SELECT host_port, container_port, protocol, is_primary
    FROM server_ports
    WHERE server_id = ${serverId}
    ORDER BY is_primary DESC, container_port ASC
  `) as {
    host_port: number;
    container_port: number;
    protocol: string;
    is_primary: boolean;
  }[];

  return rows.map((row) => ({
    hostPort: row.host_port,
    containerPort: row.container_port,
    protocol: row.protocol,
    isPrimary: row.is_primary,
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
  };
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
  return toSummary(await loadServerRow(serverId));
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

  // A blueprint's startup command is interpolated with the resolved env once,
  // here, so the agent receives a concrete argv rather than a template.
  const command = blueprint.startupCommand
    ? ["/bin/sh", "-c", interpolateCommand(blueprint.startupCommand, resolved.values)]
    : undefined;

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

    for (const port of blueprint.defaultPorts) {
      const isPrimary = port === mainPort;
      const hostPort = await allocateHostPort(
        node.nodeId,
        port.protocol,
        isPrimary ? input.preferredPort : undefined,
      );

      await sql`
        INSERT INTO server_ports (
          server_id, node_id, host_port, container_port, protocol, is_primary
        ) VALUES (
          ${server.id}, ${node.nodeId}, ${hostPort}, ${port.container},
          ${port.protocol}, ${isPrimary}
        )
      `;

      bindings.push({
        hostPort,
        containerPort: port.container,
        protocol: port.protocol,
      });
    }

    await storeEnv(server.id, resolved.values, resolved.secretKeys);

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

export async function startServer(
  serverId: string,
  actorId: string,
): Promise<ServerSummary> {
  const server = await loadServerRow(serverId);
  assertNotSuspended(server);
  assertHasContainer(server);

  await setStatus(serverId, "starting");
  try {
    await startServerContainer(server.node_id, serverId);
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
    await stopServerContainer(server.node_id, serverId);
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
    await killServerContainer(server.node_id, serverId);
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
    await restartServerContainer(server.node_id, serverId);
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

  await setStatus(serverId, "suspended");
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

  await setStatus(serverId, "stopped");
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
      tty: blueprint.tty === true,
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
async function extraNetworksForServer(serverId: string): Promise<string[]> {
  const networks: string[] = [];
  networks.push(...(await listServerLinkNetworks(serverId)));
  return networks;
}

