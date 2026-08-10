/**
 * Server routes.
 *
 * Every handler resolves permissions through `auth/middleware.ts` before doing
 * anything. The permission required per action is chosen deliberately:
 *   - viewing         -> any access (owner, subuser, admin)
 *   - start/stop      -> "start_stop"
 *   - settings/env    -> "settings"
 *   - delete          -> owner or admin only (never delegable)
 */

import {
  requireAuth,
  requireServerOwner,
  requireServerPermission,
} from "../auth/middleware";
import { isAdmin } from "../auth/rbac";
import {
  badRequest,
  json,
  noContent,
  parseJsonBody,
  requireUuidParam,
} from "../lib/http";
import { listBlueprints, getBlueprintByKey } from "../blueprints/registry";
import { recordAuditFromRequest } from "../services/auditLog";
import {
  deleteServer,
  getServer,
  listAccessibleServers,
  listAllServers,
  loadEnvForDisplay,
  reconcileServerStatus,
  restartServer,
  startServer,
  stopServer,
  killServer,
} from "../services/serverManager";
// (killServer kept at the end of the lifecycle-action group.)
import { getServerLogs, getServerStats } from "../nodes/nodeServerApi";
import { sql } from "../db/client";

/** GET /api/blueprints — the blueprints a user can choose from. */
export async function handleListBlueprints(request: Request): Promise<Response> {
  await requireAuth(request);

  // Only the fields a client needs; internal hints (install scripts, resource
  // profile, read-only-root support) stay server-side.
  return json({
    blueprints: (await listBlueprints()).map((bp) => ({
      key: bp.key,
      name: bp.name,
      description: bp.description ?? null,
      defaultPorts: bp.defaultPorts,
      envSchema: bp.envSchema,
      minimums: bp.minimums,
    })),
  });
}

/** GET /api/servers — servers visible to the caller. */
export async function handleListServers(request: Request): Promise<Response> {
  const user = await requireAuth(request);

  // Admins see everything; everyone else sees owned + subuser servers.
  const servers = isAdmin(user)
    ? await listAllServers()
    : await listAccessibleServers(user.id);

  return json({ servers });
}

/** GET /api/servers/:id — detail view, with a live status reconcile. */
export async function handleGetServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  // Console permission is the baseline "can look at this server" grant.
  await requireServerPermission(request, id, "console");

  // Best-effort: a node being unreachable should not break the detail view.
  try {
    await reconcileServerStatus(id);
  } catch (error) {
    console.error(`[servers] status reconcile failed for ${id}:`, error);
  }

  const server = await getServer(id);
  return json({ server });
}

/** POST /api/servers/:id/start */
export async function handleStartServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "start_stop");

  const server = await startServer(id, user.id);
  return json({ server });
}

/** POST /api/servers/:id/stop */
export async function handleStopServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "start_stop");

  const server = await stopServer(id, user.id);
  return json({ server });
}

/** POST /api/servers/:id/restart */
export async function handleRestartServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "start_stop");

  const server = await restartServer(id, user.id);
  return json({ server });
}

/**
 * POST /api/servers/:id/kill — force-stop with SIGKILL.
 *
 * The escape hatch for a container stuck in a graceful stop/restart. Same
 * `start_stop` permission as Stop/Restart: anyone who can stop a server can
 * force-stop it. Audited as `server.kill` to distinguish the destructive path.
 */
export async function handleKillServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "start_stop");

  const server = await killServer(id, user.id);
  return json({ server });
}

/**
 * DELETE /api/servers/:id
 *
 * Owner-or-admin only: deletion is not a delegable subuser permission.
 * World data is retained unless `?deleteData=true` is passed explicitly.
 */
export async function handleDeleteServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  const deleteData =
    new URL(request.url).searchParams.get("deleteData") === "true";

  await deleteServer(id, user.id, deleteData);
  return noContent();
}

/** GET /api/servers/:id/env — masked environment variables. */
export async function handleGetServerEnv(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "settings");

  return json({ env: await loadEnvForDisplay(id) });
}

/** GET /api/servers/:id/logs — recent console output. */
export async function handleGetServerLogs(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "console");

  const rows = (await sql`
    SELECT container_id, node_id FROM servers WHERE id = ${id}
  `) as { container_id: string | null; node_id: string }[];

  const server = rows[0];
  if (!server?.container_id) {
    return json({ logs: "" });
  }

  const tailParam = new URL(request.url).searchParams.get("tail");
  const tail = Math.min(Math.max(Number(tailParam) || 200, 1), 2000);

  const logs = await getServerLogs(server.node_id, id, tail);

  return json({ logs });
}

/** GET /api/servers/:id/stats — a live resource sample. */
export async function handleGetServerStats(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "console");

  const rows = (await sql`
    SELECT container_id, node_id FROM servers WHERE id = ${id}
  `) as { container_id: string | null; node_id: string }[];

  const server = rows[0];
  if (!server?.container_id) {
    return json({ stats: null });
  }

  const stats = await getServerStats(server.node_id, id);

  return json({ stats });
}

/**
 * PATCH /api/servers/:id/env — update environment variables.
 *
 * Only keys already present in the blueprint's schema are accepted; the update
 * is routed through the same validation as creation so a user cannot inject
 * arbitrary env vars into their container.
 */
export async function handleUpdateServerEnv(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "settings");

  const body = await parseJsonBody(request);
  const updates = body.env;

  if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
    throw badRequest('"env" must be an object of key/value pairs');
  }

  const rows = (await sql`
    SELECT bp.key AS blueprint_key
    FROM servers s
    JOIN blueprints bp ON bp.id = s.blueprint_id
    WHERE s.id = ${id}
  `) as { blueprint_key: string }[];

  const blueprintKey = rows[0]?.blueprint_key;
  if (!blueprintKey) throw badRequest("Server has no valid blueprint");

  const blueprint = await getBlueprintByKey(blueprintKey);
  if (!blueprint) throw badRequest("Server blueprint is not available");

  const applied: string[] = [];
  for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
    const field = blueprint.envSchema[key];
    // Unknown keys are rejected loudly here (rather than silently dropped) so
    // the user knows their change did not take effect.
    if (!field) {
      throw badRequest(`"${key}" is not a configurable variable for this game`);
    }
    if (typeof value !== "string") {
      throw badRequest(`"${key}" must be a string`);
    }
    if (field.options && !field.options.includes(value)) {
      throw badRequest(`"${key}" must be one of: ${field.options.join(", ")}`);
    }

    await sql`
      INSERT INTO server_env (server_id, key, value, is_secret)
      VALUES (${id}, ${key}, ${value}, ${field.secret === true})
      ON CONFLICT (server_id, key) DO UPDATE SET value = EXCLUDED.value
    `;
    applied.push(key);
  }

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.env.update",
    targetType: "server",
    targetId: id,
    // Keys only, never values: some of these are secrets.
    metadata: { keys: applied },
  });

  return json({
    env: await loadEnvForDisplay(id),
    note: "Changes take effect the next time the server is restarted.",
  });
}
