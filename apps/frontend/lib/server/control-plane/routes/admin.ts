/**
 * Admin routes (plan.md sections 5, 9.2).
 *
 * Every handler is gated on `requireAdmin`, which checks the global role only —
 * subuser permissions can never reach these endpoints.
 */

import { requireAdmin } from "../auth/middleware";
import { auth, isRole } from "../auth/betterAuth";
import {
  badRequest,
  conflict,
  json,

  notFound,
  optionalString,
  parseJsonBody,
  requireNumber,
  requireString,
  requireUuidParam,
} from "../lib/http";
import { sql } from "../db/client";
import {
  countUnreviewed,
  getSuspiciousActivity,
  listSuspiciousActivity,
  setReviewed,
} from "../security/suspiciousList";
import { runSweep } from "../security/watcher";
import { listAuditLogs, recordAuditFromRequest } from "../services/auditLog";
import {
  createServer,
  listAllServers,
  listServersForOwner,
  suspendServer,
  unsuspendServer,
} from "../services/serverManager";
import { sampleNodeServers } from "../nodes/nodeServerApi";
import { getBlueprintByKey } from "../blueprints/registry";

// --- Suspicious activity review ----------------------------------------------

/** GET /api/admin/suspicious-activity */
export async function handleListSuspicious(request: Request): Promise<Response> {
  await requireAdmin(request);

  const url = new URL(request.url);
  const includeReviewed = url.searchParams.get("includeReviewed") === "true";

  const [activity, pendingCount] = await Promise.all([
    listSuspiciousActivity({ includeReviewed }),
    countUnreviewed(),
  ]);

  return json({ activity, pendingCount });
}

/**
 * POST /api/admin/suspicious-activity/:id/review
 *
 * Marks a flag reviewed. Enforcement (suspend) is a SEPARATE endpoint on
 * purpose: dismissing a false positive and punishing abuse are different
 * decisions and should be individually audited.
 */
export async function handleReviewSuspicious(
  request: Request,
  activityId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(activityId, "activityId");

  const body = await parseJsonBody(request).catch(() => ({}) as Record<string, unknown>);
  const reviewed = body.reviewed === undefined ? true : body.reviewed === true;

  const row = await setReviewed(id, admin.id, reviewed);
  if (!row) throw notFound("Suspicious activity record not found");

  return json({ activity: row });
}

/** GET /api/admin/suspicious-activity/:id — full evidence detail. */
export async function handleGetSuspicious(
  request: Request,
  activityId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(activityId, "activityId");

  const activity = await getSuspiciousActivity(id);
  if (!activity) throw notFound("Suspicious activity record not found");

  return json({ activity });
}

/** POST /api/admin/scan — trigger an out-of-band detection sweep. */
export async function handleTriggerScan(request: Request): Promise<Response> {
  await requireAdmin(request);
  return json({ result: await runSweep() });
}

// --- Server enforcement -------------------------------------------------------

/** POST /api/admin/servers/:id/suspend */
export async function handleSuspendServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(serverId, "serverId");

  const body = await parseJsonBody(request);
  const reason = requireString(body, "reason", { min: 3, max: 500 });

  const exists = (await sql`SELECT id FROM servers WHERE id = ${id}`) as {
    id: string;
  }[];
  if (exists.length === 0) throw notFound("Server not found");

  await suspendServer(id, admin.id, reason);
  return json({ suspended: true, serverId: id, reason });
}

/** POST /api/admin/servers/:id/unsuspend */
export async function handleUnsuspendServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(serverId, "serverId");

  await unsuspendServer(id, admin.id);
  return json({ suspended: false, serverId: id });
}

// --- Resource limits ----------------------------------------------------------

/**
 * PATCH /api/admin/servers/:id — change a server's resource allocation.
 *
 * Resource limits are an ADMIN-ONLY concern (plan.md section 5): a user manages
 * their server but never sizes it. There is deliberately no owner-facing
 * equivalent of this route.
 *
 * Every field is optional; omitted fields keep their current value. The
 * resulting triple is validated against the preset minimums the same way
 * creation does, so an edit can never leave a server below the floor its game
 * needs to boot.
 *
 * Requires the server to be stopped: Docker's `--memory` and `--cpus` are set
 * at container creation, so a running container would keep its old limits and
 * the DB would start lying about reality. serverManager recreates the container
 * from these columns on next start.
 */
export async function handleUpdateServerResources(
  request: Request,
  serverId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(serverId, "serverId");

  const body = await parseJsonBody(request);

  const rows = (await sql`
    SELECT
      s.status, s.cpu_limit, s.memory_limit_mb, s.disk_limit_mb,
      bp.key AS blueprint_key
    FROM servers s
    JOIN blueprints bp ON bp.id = s.blueprint_id
    WHERE s.id = ${id}
  `) as {
    status: string;
    cpu_limit: string | number;
    memory_limit_mb: number;
    disk_limit_mb: number;
    blueprint_key: string;
  }[];

  const current = rows[0];
  if (!current) throw notFound("Server not found");

  if (current.status !== "stopped") {
    throw conflict(
      "Stop the server before changing its resource limits. Docker applies CPU and memory caps when the container is created.",
    );
  }

  // Absent field means "leave as-is", so fall back to the stored value.
  const cpuLimit =
    body.cpuLimit === undefined
      ? Number(current.cpu_limit)
      : requireNumber(body, "cpuLimit", { min: 0.1, max: 64 });
  const memoryLimitMb =
    body.memoryLimitMb === undefined
      ? current.memory_limit_mb
      : requireNumber(body, "memoryLimitMb", { min: 256, max: 262_144 });
  const diskLimitMb =
    body.diskLimitMb === undefined
      ? current.disk_limit_mb
      : requireNumber(body, "diskLimitMb", { min: 512, max: 2_000_000 });

  const blueprint = await getBlueprintByKey(current.blueprint_key);
  if (!blueprint) throw badRequest("Server blueprint is not available");

  // Same floor the creation path enforces — reported together so an admin
  // fixes every problem in one pass instead of one error at a time.
  const problems: string[] = [];
  if (cpuLimit < blueprint.minimums.cpuLimit) {
    problems.push(`cpuLimit must be at least ${blueprint.minimums.cpuLimit}`);
  }
  if (memoryLimitMb < blueprint.minimums.memoryLimitMb) {
    problems.push(
      `memoryLimitMb must be at least ${blueprint.minimums.memoryLimitMb}`,
    );
  }
  if (diskLimitMb < blueprint.minimums.diskLimitMb) {
    problems.push(`diskLimitMb must be at least ${blueprint.minimums.diskLimitMb}`);
  }
  if (problems.length > 0) {
    throw badRequest(`${blueprint.name} requires: ${problems.join(", ")}`);
  }

  await sql`
    UPDATE servers
    SET cpu_limit = ${cpuLimit},
        memory_limit_mb = ${memoryLimitMb},
        disk_limit_mb = ${diskLimitMb}
    WHERE id = ${id}
  `;

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "server.resources.update",
    targetType: "server",
    targetId: id,
    metadata: {
      from: {
        cpuLimit: Number(current.cpu_limit),
        memoryLimitMb: current.memory_limit_mb,
        diskLimitMb: current.disk_limit_mb,
      },
      to: { cpuLimit, memoryLimitMb, diskLimitMb },
    },
  });

  return json({ serverId: id, cpuLimit, memoryLimitMb, diskLimitMb });
}

// --- Users --------------------------------------------------------------------

/**
 * POST /api/admin/servers — provision a server for a user.
 *
 * This is the only way a server can come into existence: users cannot create
 * servers for themselves. The target owner, limits and optional target node
 * are validated; the audit trail records the admin as the acting user
 * (createServer writes the `server.create` entry with the admin's identity
 * and an `onBehalfOf` marker).
 */
export async function handleAdminCreateServer(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const body = await parseJsonBody(request);

  const name = requireString(body, "name", { min: 1, max: 64 });
  // Better Auth user ids are opaque strings (nanoid-style), not UUIDs, so no
  // format assumptions here — the account's existence is verified below.
  if (body.ownerId === undefined || body.ownerId === null || body.ownerId === "") {
    throw badRequest('"ownerId" is required');
  }
  const ownerId = requireString(body, "ownerId", { min: 1, max: 128 });
  const blueprintKey = requireString(body, "blueprintKey", { max: 64 });
  const cpuLimit = requireNumber(body, "cpuLimit", { min: 0.1, max: 64 });
  const memoryLimitMb = requireNumber(body, "memoryLimitMb", {
    min: 256,
    max: 262_144,
  });
  const diskLimitMb = requireNumber(body, "diskLimitMb", {
    min: 512,
    max: 2_000_000,
  });
  const nodeId = optionalString(body, "nodeId");
  const preferredPort =
    body.preferredPort === undefined
      ? undefined
      : requireNumber(body, "preferredPort", { min: 1024, max: 65535 });

  const envInput =
    typeof body.env === "object" && body.env !== null && !Array.isArray(body.env)
      ? (body.env as Record<string, unknown>)
      : {};

  // The owner must be a real, existing account.
  const ownerRows = (await sql`
    SELECT id FROM "user" WHERE id = ${ownerId}
  `) as { id: string }[];
  if (ownerRows.length === 0) throw notFound("Owner account not found");

  // Blueprint minimums and node capacity are enforced inside createServer;
  // failures surface as 400/409 responses just like the owner-facing flow.
  const server = await createServer({
    name,
    ownerId,
    actorId: admin.id,
    blueprintKey,
    cpuLimit,
    memoryLimitMb,
    diskLimitMb,
    env: envInput,
    preferredPort,
    nodeId,
  });

  return json({ server }, 201);
}

/** GET /api/admin/users — every account on the panel, with optional search. */
export async function handleListUsers(request: Request): Promise<Response> {
  await requireAdmin(request);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  // Case-insensitive search on email and name. Empty query returns everyone.
  const pattern = q.length > 0 ? `%${q}%` : null;

  const rows = (await sql`
    SELECT
      u.id, u.email, u.name, u.role, u."createdAt" AS created_at,
      u.banned, u."banReason" AS ban_reason, u."banExpires" AS ban_expires,
      COUNT(s.id)::int AS server_count
    FROM "user" u
    LEFT JOIN servers s ON s.owner_id = u.id
    ${pattern !== null ? sql`WHERE u.email ILIKE ${pattern} OR u.name ILIKE ${pattern}` : sql``}
    GROUP BY u.id, u.email, u.name, u.role, u."createdAt", u.banned, u."banReason", u."banExpires"
    ORDER BY u."createdAt" DESC
  `) as Record<string, unknown>[];

  return json({ users: rows });
}

/**
 * PATCH /api/admin/users/:id/role — promote or demote a user.
 *
 * Two guards, both deliberate:
 *  - An admin cannot change their own role (no accidental self-lockout).
 *  - The last remaining admin cannot be demoted (the panel must always have one).
 */
export async function handleUpdateUserRole(
  request: Request,
  userId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);

  const body = await parseJsonBody(request);
  const role = requireString(body, "role", { max: 16 });

  if (!isRole(role)) {
    throw badRequest('"role" must be either "user" or "admin"');
  }

  if (userId === admin.id) {
    throw conflict(
      "You cannot change your own role. Ask another admin to do it.",
    );
  }

  const targetRows = (await sql`
    SELECT id, role FROM "user" WHERE id = ${userId}
  `) as { id: string; role: string | null }[];

  const target = targetRows[0];
  if (!target) throw notFound("User not found");

  if (target.role === "admin" && role === "user") {
    const adminCount = (await sql`
      SELECT COUNT(*)::int AS count FROM "user" WHERE role = 'admin'
    `) as { count: number }[];

    if ((adminCount[0]?.count ?? 0) <= 1) {
      throw conflict("Cannot demote the last remaining admin");
    }
  }

  await sql`UPDATE "user" SET role = ${role} WHERE id = ${userId}`;

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "user.role.update",
    targetType: "user",
    targetId: userId,
    metadata: { from: target.role, to: role },
  });

  return json({ user: { id: userId, role } });
}

// --- User ban / unban ---------------------------------------------------------

/**
 * POST /api/admin/users/:id/ban — ban a user and suspend their servers.
 *
 * Delegates the ban itself to Better Auth's admin plugin (`auth.api.banUser`),
 * which sets `banned` and revokes every session the user holds — so they are
 * signed out everywhere and cannot sign back in. We then suspend every server
 * the user owns, so a banned account cannot keep running game servers.
 *
 * The admin plugin accepts an optional `banReason` and `banExpiresIn` (seconds);
 * an absent expiry means a permanent ban. The reason and remaining duration are
 * surfaced to the banned user at sign-in via the session-create hook in
 * `auth/betterAuth.ts`.
 *
 * An admin cannot ban themselves (mirror of the role-change self-guard).
 */
export async function handleBanUser(
  request: Request,
  userId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);

  // Better Auth user ids are opaque strings (nanoid-style), not UUIDs — match
  // handleUpdateUserRole, which trusts the route param. Guard against an empty
  // id so a malformed route cannot reach the lookup.
  const targetId = userId.trim();
  if (targetId.length === 0) throw badRequest('"userId" is required.');

  if (targetId === admin.id) {
    throw conflict("You cannot ban your own account. Ask another admin to do it.");
  }

  const body = await parseJsonBody(request).catch(() => ({}) as Record<string, unknown>);
  const reason = optionalString(body, "reason", { max: 500 });
  const banExpiresIn =
    body.banExpiresInSeconds === undefined
      ? undefined
      : requireNumber(body, "banExpiresInSeconds", { min: 60, max: 60 * 60 * 24 * 365 });

  const targetRows = (await sql`
    SELECT id, email FROM "user" WHERE id = ${targetId}
  `) as { id: string; email: string }[];
  if (targetRows.length === 0) throw notFound("User not found");
  const target = targetRows[0]!;

  // banUser sets banned + banReason + banExpires and revokes all sessions. The
  // admin plugin's middleware resolves the calling admin's session from the
  // request headers, so forward them — without headers the call has no session
  // and is rejected as FORBIDDEN.
  await auth.api.banUser({
    headers: request.headers,
    body: {
      userId: targetId,
      ...(reason ? { banReason: reason } : {}),
      ...(banExpiresIn ? { banExpiresIn } : {}),
    },
  });

  // Suspend every server the user owns. `suspendServer` stops the container and
  // marks it `suspended`; it tolerates an unreachable node, so a ban still takes
  // effect when the node is down. Already-suspended/deleting servers are skipped.
  const servers = await listServersForOwner(targetId);
  let suspendedCount = 0;
  for (const server of servers) {
    if (server.status === "suspended" || server.status === "deleting") continue;
    try {
      await suspendServer(server.id, admin.id, `User banned: ${reason ?? "No reason provided"}`);
      suspendedCount += 1;
    } catch (error) {
      // A single failure must not abort the ban; record it and continue.
      console.error(`[admin] failed to suspend ${server.id} during ban:`, error);
    }
  }

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "user.ban",
    targetType: "user",
    targetId: targetId,
    metadata: {
      email: target.email,
      reason: reason ?? null,
      banExpiresInSeconds: banExpiresIn ?? null,
      serversSuspended: suspendedCount,
    },
  });

  return json({ banned: true, userId: targetId, serversSuspended: suspendedCount });
}

/**
 * POST /api/admin/users/:id/unban — lift a ban.
 *
 * Clears the ban via `auth.api.unbanUser`. Servers are NOT automatically
 * unsuspended: suspension is a separate, individually-audited decision, and an
 * admin re-enables servers deliberately. The UI makes this explicit.
 */
export async function handleUnbanUser(
  request: Request,
  userId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const targetId = userId.trim();
  if (targetId.length === 0) throw badRequest('"userId" is required.');

  const targetRows = (await sql`
    SELECT id, email FROM "user" WHERE id = ${targetId}
  `) as { id: string; email: string }[];
  if (targetRows.length === 0) throw notFound("User not found");
  const target = targetRows[0]!;

  await auth.api.unbanUser({ headers: request.headers, body: { userId: targetId } });

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "user.unban",
    targetType: "user",
    targetId: targetId,
    metadata: { email: target.email },
  });

  return json({ banned: false, userId: targetId });
}

// --- Audit log ----------------------------------------------------------------

/** GET /api/admin/audit-logs */
export async function handleListAuditLogs(request: Request): Promise<Response> {
  await requireAdmin(request);

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit")) || 100;

  return json({ logs: await listAuditLogs({ limit }) });
}

// --- Admin server list ---------------------------------------------------------

/**
 * GET /api/admin/servers — fleet-wide view for the admin dashboard.
 *
 * Extends the normal summary rows with owner context plus live CPU and memory
 * usage sampled from each node's agent (with graceful fallback when a node is
 * unreachable or a container is missing).
 *
 * Sampling is batched **per node** rather than per server: one request per node
 * regardless of how many servers it hosts, so this page does not slow down
 * linearly as the fleet grows.
 */
export async function handleListAdminServers(request: Request): Promise<Response> {
  await requireAdmin(request);

  const servers = await listAllServers();

  const ownerIds = [...new Set(servers.map((server) => server.ownerId))];
  const ownersById = new Map<string, { email: string; name: string | null }>();

  for (const ownerId of ownerIds) {
    const rows = (await sql`
      SELECT id, email, name FROM "user" WHERE id = ${ownerId}
    `) as { id: string; email: string; name: string | null }[];
    if (rows[0]) ownersById.set(rows[0].id, { email: rows[0].email, name: rows[0].name });
  }

  // Group by node so each node is asked exactly once.
  const serverIdsByNode = new Map<string, string[]>();
  for (const server of servers) {
    const list = serverIdsByNode.get(server.nodeId) ?? [];
    list.push(server.id);
    serverIdsByNode.set(server.nodeId, list);
  }

  const usageByServer = new Map<
    string,
    { cpuPercent: number; memoryUsageMb: number }
  >();

  await Promise.all(
    [...serverIdsByNode].map(async ([nodeId, serverIds]) => {
      try {
        for (const sample of await sampleNodeServers(nodeId, serverIds)) {
          usageByServer.set(sample.serverId, {
            cpuPercent: sample.cpuPercent,
            memoryUsageMb: sample.memoryUsageMb,
          });
        }
      } catch {
        // Node unreachable — its servers simply report null usage below.
      }
    }),
  );

  const enriched = servers.map((server) => {
    const usage = usageByServer.get(server.id);
    const owner = ownersById.get(server.ownerId);
    return {
      ...server,
      ownerEmail: owner?.email ?? "unknown",
      ownerName: owner?.name ?? null,
      cpuPercent: usage?.cpuPercent ?? null,
      memoryUsageMb: usage?.memoryUsageMb ?? null,
    };
  });

  return json({ servers: enriched });
}
