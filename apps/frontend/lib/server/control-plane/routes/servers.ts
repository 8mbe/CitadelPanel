/**
 * Server routes.
 *
 * Every handler resolves permissions through `auth/middleware.ts` before doing
 * anything. The permission required per action is chosen deliberately:
 *   - viewing         -> any access (owner, subuser, admin)
 *   - start/stop      -> "start_stop"
 *   - settings/env    -> "settings"
 *   - ports           -> "settings" (viewing and editing alike)
 *   - links (view)    -> "settings" (matching ports)
 *   - links (edit)    -> owner or admin of BOTH servers (a link attaches two
 *                        containers, so both must be the actor's)
 *   - databases       -> "database"
 *   - delete          -> owner or admin only (never delegable)
 *   - reinstall       -> owner or admin only (never delegable), and the caller
 *                        must name the server in the body
 *
 * Read endpoints gate on the same permission as their mutations — a subuser
 * granted only `console` sees the console (and the activity feed) and nothing
 * else. The detail view returns the caller's access (`viewer`) so the UI can
 * hide sections the caller cannot use; the API remains the enforcement point.
 */

import { after } from "next/server";

import {
  requireAuth,
  requireServerOwner,
  requireServerPermission,
} from "../auth/middleware";
import {
  badRequest,
  conflict,
  forbidden,
  isUuid,
  json,
  noContent,
  notFound,
  optionalString,
  parseJsonBody,
  requireNumber,
  requireUuidParam,
} from "../lib/http";
import {
  accessAllowsOwnerOnly,
  resolveServerAccess,
} from "../auth/rbac";
import { listBlueprints, getBlueprintByKey } from "../blueprints/registry";
import { recordAuditFromRequest } from "../services/auditLog";
import {
  deleteServer,
  getServer,
  getServerReconciled,
  listAccessibleServers,
  loadEnvForDisplay,
  restartServer,
  startServer,
  stopServer,
  killServer,
  addServerPort,
  removeServerPort,
  addServerDatabase,
  removeServerDatabase,
  resetServerDatabasePassword,
  listServerDatabases,
  readInstallLog,
  reinstallServer,
  waitForProvisioning,
  writeEnvValues,
  type EnvWrite,
} from "../services/serverManager";
import {
  createServerLink,
  listServerLinks,
  removeServerLink,
} from "../services/serverLinks";
import { listAuditLogs } from "../services/auditLog";
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

/**
 * GET /api/servers — servers the caller owns or is a subuser on.
 *
 * The dashboard is a personal view, so admins see their own servers here too;
 * the fleet-wide listing lives on the admin endpoints (GET /api/admin/servers).
 * Admins still reach any individual server via the admin panel —
 * `resolveServerAccess` grants them access regardless of ownership.
 */
export async function handleListServers(request: Request): Promise<Response> {
  const user = await requireAuth(request);

  const servers = await listAccessibleServers(user.id);

  return json({ servers });
}

/** GET /api/servers/:id — detail view, with a live status reconcile. */
export async function handleGetServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  // Console permission is the baseline "can look at this server" grant.
  const { access } = await requireServerPermission(request, id, "console");

  // One call: the record and the live status reconcile share a single read of
  // the row and run their independent parts concurrently. See
  // `getServerReconciled` for why this endpoint is shaped around round trips.
  const server = await getServerReconciled(id);

  // Tell the caller what they can do here so the UI can hide sections they
  // hold no permission for. Owners/admins have an empty permission set — the
  // `kind` says they implicitly hold all of them.
  return json({
    server,
    viewer: { kind: access.kind, permissions: access.permissions },
  });
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

/**
 * POST /api/servers/:id/reinstall — delete every file and build the server
 * again from its blueprint.
 *
 * Owner-or-admin only, like delete: this destroys more of the owner's work than
 * any other action in the panel and is not something a subuser with `settings`
 * should be able to do on their behalf.
 *
 * The body must carry `confirmName`, matching the server's name exactly. That is
 * not belt-and-braces on top of the UI's confirmation — it is the rule the UI's
 * type-the-name box implements. Every other destructive endpoint here can be hit
 * with an empty body, so a mis-routed retry, a stale tab replaying a request, or
 * a script iterating the wrong list can fire one; this one cannot be reached
 * without naming the exact server whose files are about to go.
 */
export async function handleReinstallServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  const body = await parseJsonBody(request);
  const confirmName = body.confirmName;
  if (typeof confirmName !== "string") {
    throw badRequest(
      '"confirmName" must be the server\'s name, to confirm the reinstall.',
    );
  }

  // Read the name before anything is touched, and compare it as typed (trimmed
  // only for stray whitespace). A mismatch changes nothing.
  const current = await getServer(id);
  if (confirmName.trim() !== current.name) {
    throw badRequest(
      "That is not this server's name, so nothing was changed. Type the name " +
        "exactly as it is shown to confirm the reinstall.",
    );
  }

  const server = await reinstallServer(id, user.id);

  // The rebuild outlives this response (see serverManager.reinstallServer), so
  // the runtime is told to keep it alive — exactly as the create path does.
  after(() => waitForProvisioning(id));

  return json({ server });
}

/** GET /api/servers/:id/env — masked environment variables the owner may edit. */
export async function handleGetServerEnv(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "settings");

  return json({ env: await loadOwnerEnv(id) });
}

/** Where a server's container lives, for the endpoints that only need that. */
interface ServerLocation {
  container_id: string | null;
  node_id: string;
}

/**
 * Resolve `console` permission and the server's location in one round trip
 * instead of two.
 *
 * The logs and stats endpoints are polled for as long as a server page is open,
 * and both spent a database round trip on the guard and then another on a
 * two-column read. Running them together halves that. The guard is still what
 * gates the response: if it throws, this rejects and the caller gets its error —
 * the row is read but never surfaced.
 */
async function requireConsoleAccessAndLocation(
  request: Request,
  serverId: string,
): Promise<ServerLocation | undefined> {
  const [, rows] = await Promise.all([
    requireServerPermission(request, serverId, "console"),
    sql`
      SELECT container_id, node_id FROM servers WHERE id = ${serverId}
    ` as unknown as Promise<ServerLocation[]>,
  ]);
  return rows[0];
}

/** GET /api/servers/:id/logs — recent console output. */
export async function handleGetServerLogs(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const server = await requireConsoleAccessAndLocation(request, id);
  if (!server?.container_id) {
    return json({ logs: "" });
  }

  const tailParam = new URL(request.url).searchParams.get("tail");
  const tail = Math.min(Math.max(Number(tailParam) || 200, 1), 2000);

  const logs = await getServerLogs(server.node_id, id, tail);

  return json({ logs });
}

/**
 * GET /api/servers/:id/install-log — the provisioning output.
 *
 * Admin-only, and not because the log is secret in the usual sense: it is the
 * install script's stdout, and a blueprint's script is written by whoever
 * registered the blueprint. It can name internal image registries, echo an env
 * value, or print a node-side path — operator detail, not owner detail. The
 * owner does not need it either. What they need to know is "this is still
 * installing", which the status already says; *why* an install failed is an
 * operator's problem to read and act on.
 *
 * `requireServerPermission` first so a non-admin with no relationship to the
 * server still gets the 404 that hides its existence, rather than a 403 that
 * confirms it.
 */
export async function handleGetServerInstallLog(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { access } = await requireServerPermission(request, id, "console");
  if (access.kind !== "admin") {
    throw forbidden("Only an administrator can read a server's install log.");
  }

  const view = await readInstallLog(id);
  return json({ installLog: view });
}

/** GET /api/servers/:id/stats — a live resource sample. */
export async function handleGetServerStats(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const server = await requireConsoleAccessAndLocation(request, id);
  if (!server?.container_id) {
    return json({ stats: null });
  }

  const stats = await getServerStats(server.node_id, id);

  return json({ stats });
}

/**
 * Resolve the blueprint backing a server. Throws if the server or its blueprint
 * is missing — both are bugs in practice, since deletion cascades.
 */
async function getServerBlueprint(id: string) {
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
  return blueprint;
}

/**
 * Load env vars for the owner's view: the keys the blueprint marks `editable`,
 * with secret values masked. Non-editable vars are internal configuration the
 * owner cannot see or change. Schema metadata (description, options) is joined
 * in so the client can render the right input affordance per field.
 *
 * Keys with no stored row yet (an editable field without a default that the
 * owner never filled, e.g. JVM_OPTS) are included with their schema default or
 * an empty string — otherwise the owner would have no input to type into and
 * no way to set the variable at all.
 */
async function loadOwnerEnv(
  id: string,
): Promise<
  {
    key: string;
    value: string;
    isSecret: boolean;
    description: string | null;
    options: string[] | null;
  }[]
> {
  const blueprint = await getServerBlueprint(id);
  const editableSchema = Object.entries(blueprint.envSchema).filter(
    ([, field]) => field.editable === true,
  );

  const rows = await loadEnvForDisplay(id);
  const stored = new Map(
    rows
      .filter((row) => editableSchema.some(([key]) => key === row.key))
      .map((row) => [row.key, row]),
  );

  return editableSchema.map(([key, field]) => {
    const row = stored.get(key);
    return {
      key,
      value: row?.value ?? field.default ?? "",
      isSecret: row?.isSecret ?? field.secret === true,
      description: field.description ?? null,
      options:
        field.options && field.options.length > 0 ? field.options : null,
    };
  });
}

/**
 * PATCH /api/servers/:id/env — update environment variables.
 *
 * Only keys the blueprint marks `editable` are accepted; everything else is
 * rejected loudly so the owner knows the change did not take effect. Validation
 * mirrors creation so a user cannot inject arbitrary env vars or bypass
 * `options` constraints.
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

  const blueprint = await getServerBlueprint(id);

  // Validate every key *before* writing any of them. Interleaving the two meant
  // a request rejected on its third variable had already committed the first
  // two — the owner got an error and a half-applied form. Nothing is written
  // until the whole submission is known to be good.
  const writes: EnvWrite[] = [];
  for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
    const field = blueprint.envSchema[key];
    if (!field) {
      throw badRequest(`"${key}" is not a configurable variable for this game`);
    }
    if (field.editable !== true) {
      throw badRequest(`"${key}" cannot be changed on a running server`);
    }
    if (typeof value !== "string") {
      throw badRequest(`"${key}" must be a string`);
    }
    if (field.options && !field.options.includes(value)) {
      throw badRequest(`"${key}" must be one of: ${field.options.join(", ")}`);
    }

    writes.push({ key, value, isSecret: field.secret === true });
  }

  // Plaintext in, storage decided by `writeEnvValues` — including encrypting the
  // secret ones, which this handler used to skip. See its comment for why that
  // mattered.
  await writeEnvValues(id, writes);
  const applied = writes.map((write) => write.key);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.env.update",
    targetType: "server",
    targetId: id,
    // Keys only, never values: some of these are secrets.
    metadata: { keys: applied },
  });

  return json({
    env: await loadOwnerEnv(id),
    note: "Changes take effect the next time the server is restarted.",
  });
}

/**
 * GET /api/servers/:id/activity — per-server audit feed.
 *
 * Visible to anyone with access to the server (owner, subuser, admin). The
 * underlying `listAuditLogs` already filters by `targetType: "server"`,
 * `targetId`; this route layers on actor identity (email/name) via a join so the
 * UI can show *who* without a second round-trip.
 */
export async function handleListServerActivity(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  // Console permission is the baseline "can look at this server" grant, matching
  // handleGetServer. Activity is server-scoped, so any access suffices.
  await requireServerPermission(request, id, "console");

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit")) || 100;

  const rows = await listAuditLogs({
    targetType: "server",
    targetId: id,
    limit,
  });

  if (rows.length === 0) {
    return json({ entries: [] });
  }

  // Resolve actor identities in one query rather than N. System actions
  // (userId is null) pass through with null email/name.
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((v): v is string => v !== null))];
  let usersById = new Map<string, { email: string; name: string | null }>();
  if (userIds.length > 0) {
    const userRows = (await sql`
      SELECT id, email, name FROM "user" WHERE id = ANY(${sql.array(userIds)})
    `) as { id: string; email: string; name: string | null }[];
    usersById = new Map(userRows.map((u) => [u.id, { email: u.email, name: u.name }]));
  }

  return json({
    entries: rows.map((row) => {
      const actor = row.user_id ? usersById.get(row.user_id) ?? null : null;
      return {
        id: row.id,
        action: row.action,
        userId: row.user_id,
        actorEmail: actor?.email ?? null,
        actorName: actor?.name ?? null,
        ip: row.ip,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
      };
    }),
  });
}

// --- Additional port assignment -----------------------------------------------

/** GET /api/servers/:id/ports — the server's published ports. */
export async function handleListServerPorts(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  // Same permission as adding/removing a port: the port table is management
  // information, not something a console-only subuser needs.
  await requireServerPermission(request, id, "settings");

  const server = await getServer(id);
  return json({ ports: server.ports });
}

/**
 * POST /api/servers/:id/ports — publish an additional port.
 *
 * Body: { port, protocol, label? }
 *
 * The port is an identity mapping (host N → container N) and must be available:
 * in the node's port pool, unallocated, and free on the host. The container is
 * recreated so the new binding takes effect. Requires the "settings"
 * permission, matching the env-update action.
 */
export async function handleAddServerPort(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "settings");

  const body = await parseJsonBody(request);
  const port = requireNumber(body, "port", {
    min: 1,
    max: 65535,
  });

  const protocol = body.protocol;
  if (protocol !== "tcp" && protocol !== "udp") {
    throw badRequest('"protocol" must be "tcp" or "udp"');
  }

  const label = optionalString(body, "label", { max: 64 });

  // A suspended server cannot have its container recreated (it must stay
  // un-startable), so refuse before allocating a port that would just sit idle.
  const server = await getServer(id);
  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be modified.",
    );
  }

  const updated = await addServerPort({
    serverId: id,
    actorId: user.id,
    port,
    protocol,
    label,
  });

  return json({ server: updated });
}

/**
 * DELETE /api/servers/:id/ports — remove an additional port.
 *
 * Query: ?port=&protocol= identifies the port to remove. Only owner-added
 * (additional) ports are removable; blueprint ports are rejected. The container
 * is recreated to release the binding. Requires "settings".
 */
export async function handleRemoveServerPort(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "settings");

  const url = new URL(request.url);
  const portRaw = url.searchParams.get("port");
  const protocol = url.searchParams.get("protocol");

  if (portRaw === null) {
    throw badRequest('"port" query parameter is required');
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest('"port" must be an integer between 1 and 65535');
  }
  if (protocol !== "tcp" && protocol !== "udp") {
    throw badRequest('"protocol" must be "tcp" or "udp"');
  }

  const server = await getServer(id);
  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be modified.",
    );
  }

  const updated = await removeServerPort(id, port, protocol, user.id);

  return json({ server: updated });
}

// --- Server links ---------------------------------------------------------------

/**
 * GET /api/servers/:id/links — this server's connections to other servers.
 *
 * Same "settings" gate as the ports list: the addresses are management
 * information (they reveal host ports), not something a console-only subuser
 * needs.
 */
export async function handleListServerLinks(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "settings");

  return json({ links: await listServerLinks(id) });
}

/**
 * POST /api/servers/:id/links — connect this server to another of the actor's
 * servers. Body: { targetId }
 *
 * Owner-or-admin on **both** servers: the link attaches the target's container
 * to a shared network, so a subuser with `settings` on one server must not be
 * able to reach into a server they only partially control. The target's
 * existence is not revealed to unrelated users (404, as everywhere).
 */
export async function handleCreateServerLink(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  const body = await parseJsonBody(request);
  const targetId = body.targetId;
  if (typeof targetId !== "string" || !isUuid(targetId)) {
    throw badRequest('"targetId" must be a server id.');
  }

  const targetAccess = await resolveServerAccess(user, targetId);
  if (!targetAccess) throw notFound("Server not found");
  if (!accessAllowsOwnerOnly(targetAccess)) {
    throw forbidden("Only the owner of both servers can connect them.");
  }

  const link = await createServerLink({
    serverId: id,
    targetId,
    actorId: user.id,
  });

  return json({ link }, 201);
}

/**
 * DELETE /api/servers/:id/links/:linkId — remove a connection.
 *
 * Owner-or-admin of this server (the service allows a link to be removed from
 * either side). The agent detaches the pair network before the row is deleted,
 * so an unreachable node fails the request rather than leaving live
 * connectivity behind a vanished link.
 */
export async function handleRemoveServerLink(
  request: Request,
  serverId: string,
  linkId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const linkParam = requireUuidParam(linkId, "linkId");
  const { user } = await requireServerOwner(request, id);

  await removeServerLink(id, linkParam, user.id);
  return noContent();
}

// --- Database provisioning -----------------------------------------------------

/**
 * GET /api/servers/:id/databases — the server's provisioned databases.
 *
 * Requires the "database" permission, matching every mutation on this
 * resource; the password column is always null here.
 */
export async function handleListServerDatabases(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "database");

  const databases = await listServerDatabases(id);
  return json({ databases });
}

/**
 * POST /api/servers/:id/databases — provision a database for this server.
 *
 * Requires the "database" permission. The database name, user, and host are
 * generated server-side; the owner does not choose them. The password is
 * generated, stored encrypted, and returned **once** in the response so the
 * owner can copy it — it is never decryptable again.
 *
 * The panel calls the node agent, which execs SQL against the shared MariaDB
 * container and attaches the server's container to `node_db_net`.
 */
export async function handleAddServerDatabase(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "database");

  const server = await getServer(id);
  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be modified.",
    );
  }

  const database = await addServerDatabase({
    serverId: id,
    actorId: user.id,
  });

  return json({ database }, 201);
}

/**
 * DELETE /api/servers/:id/databases/:databaseId — drop a database.
 *
 * Requires the "database" permission. Drops the DB and user on the node MariaDB
 * and removes the panel record. Best-effort on the node: an unreachable node
 * still loses the panel record.
 */
export async function handleRemoveServerDatabase(
  request: Request,
  serverId: string,
  databaseId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");

  await removeServerDatabase(id, dbId, user.id);
  return noContent();
}

/**
 * POST /api/servers/:id/databases/:databaseId/reset-password — generate a new
 * password for the database user.
 *
 * Requires the "database" permission. The new plaintext password is returned
 * once; the old one is unrecoverable.
 */
export async function handleResetServerDatabasePassword(
  request: Request,
  serverId: string,
  databaseId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");

  const result = await resetServerDatabasePassword(id, dbId, user.id);
  return json({ password: result.password });
}

