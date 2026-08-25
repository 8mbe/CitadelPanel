/**
 * Admin routes (plan.md sections 5, 9.2).
 *
 * Every handler is gated on `requireAdmin`, which checks the global role only.
 * Subuser permissions can never reach these endpoints.
 */

import { after } from "next/server";

import { requireAdmin } from "../auth/middleware";
import { auth, isRole, MIN_PASSWORD_LENGTH } from "../auth/betterAuth";
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
import { env } from "../config/env";
import { generateStrongPassword } from "../lib/crypto";
import { sendMail } from "../services/mail";
import { getBranding } from "../services/settings";
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
  waitForProvisioning,
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

/** GET /api/admin/suspicious-activity/:id. Full evidence detail. */
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

/** POST /api/admin/scan. Triggers an out-of-band detection sweep. */
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
 * PATCH /api/admin/servers/:id. Changes a server's resource allocation.
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

  // Same floor the creation path enforces, reported together so an admin fixes
  // every problem in one pass instead of one error at a time.
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
 * POST /api/admin/servers. Provisions a server for a user.
 *
 * This is the only way a server can come into existence: users cannot create
 * servers for themselves. The target owner, limits and optional target node
 * are validated; the audit trail records the admin as the acting user
 * (createServer writes the `server.create` entry with the admin's identity
 * and an `onBehalfOf` marker).
 *
 * Answers 202, not 201: the row exists and is valid, but the server does not
 * exist on its node yet. Pulling images and running the blueprint's install
 * script happen after this response, and their progress is the returned
 * server's status (`installing`) plus its install log. Waiting for it here is
 * what used to make a create fail on a slow node: any timeout in the chain
 * aborted a provision that was working fine.
 */
export async function handleAdminCreateServer(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const body = await parseJsonBody(request);

  const name = requireString(body, "name", { min: 1, max: 64 });
  // Better Auth user ids are opaque strings (nanoid-style), not UUIDs, so no
  // format assumptions here. The account's existence is verified below.
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
  // No port input: the panel draws the server's ports at random from the target
  // node's pool. See `allocateHostPort`.

  // Opt-in, strict `=== true`: a missing or malformed value must never boot a
  // server the caller did not ask to boot. The setup wizard is the only caller
  // that sets it.
  const startWhenBuilt = body.startWhenBuilt === true;

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
    nodeId,
    startWhenBuilt,
  });

  // The provisioning task is already running; this tells the Next runtime not
  // to treat the request's work as finished when the response goes out, so a
  // long install is not torn down mid-pull. It never rejects, because
  // provisionServer records its own failures on the row.
  after(() => waitForProvisioning(server.id));

  return json({ server }, 202);
}

/** GET /api/admin/users. Every account on the panel, with optional search. */
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
 * POST /api/admin/users. Creates an account for someone else (the invite flow).
 *
 * The panel needs this because registration can be closed: an invite-only
 * install has no other way for a new operator or customer to get an account,
 * and telling them to "sign up" is exactly what the closed-registration gate
 * refuses. Creation here deliberately bypasses that gate rather than
 * special-casing it, because an admin typing someone's details *is* the
 * invitation the gate exists to require.
 *
 * Account creation is delegated to Better Auth's admin plugin
 * (`auth.api.createUser`) for the same reason the setup wizard delegates to
 * `signUpEmail`: it owns password hashing and the `credential` account link, and
 * a hand-inserted row would be the one account in the system whose credentials
 * were handled differently. Unlike `signUpEmail` it issues no session, so
 * creating an account never touches the admin's own cookie.
 *
 * Two deliberate decisions:
 *
 *  - **The password is optional.** An admin who has no secure channel to invent
 *    one on gets a generated 24-character password back in the response, shown
 *    once (`generateStrongPassword`, the same generator used for provisioned
 *    database users). When they do supply one it is validated against
 *    `MIN_PASSWORD_LENGTH` here, because the admin plugin hashes whatever it is
 *    given without consulting `emailAndPassword.minPasswordLength`. A supplied
 *    password is never echoed back; the admin already has it.
 *  - **The account starts email-verified.** An admin typing the address is the
 *    vouching that verification exists to provide, and the panel has no
 *    unauthenticated "resend verification" route: if the operator has turned on
 *    "require a verified email to sign in", an unverified invited account would
 *    be locked out with no way to fix it from the outside.
 *
 * The invitation email is best-effort and its outcome is reported rather than
 * assumed: `sendMail` returns false both when mail is unconfigured and when the
 * provider fails, so the response says whether the person was actually told,
 * and the admin knows to pass the credentials along by hand when it says no.
 * The email never carries the password. It is sent inline (not deferred) so the
 * dialog can state the outcome instead of guessing at it.
 */
export async function handleAdminCreateUser(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);

  const body = await parseJsonBody(request);
  const email = requireString(body, "email", { max: 255 }).trim().toLowerCase();
  const name = requireString(body, "name", { max: 128 }).trim();

  if (!email.includes("@") || /\s/.test(email)) {
    throw badRequest('"email" must be a valid email address');
  }
  if (name.length === 0) {
    throw badRequest('"name" must not be blank');
  }

  // Absent, null or blank all mean "generate one for me", so the browser can
  // send an untouched form field without having to omit the key.
  if (
    body.password !== undefined &&
    body.password !== null &&
    typeof body.password !== "string"
  ) {
    throw badRequest('"password" must be a string');
  }
  const supplied = typeof body.password === "string" ? body.password : "";
  const generated = supplied.length === 0;
  const password = generated ? generateStrongPassword(24) : supplied;

  if (!generated && password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(
      `"password" must be at least ${MIN_PASSWORD_LENGTH} characters, or omitted to have one generated`,
    );
  }
  if (password.length > 512) {
    throw badRequest('"password" must be at most 512 characters');
  }

  let created: { user: { id: string; email: string; name: string } };
  try {
    created = await auth.api.createUser({
      // The admin's own session, so the plugin's `user: ["create"]` permission
      // check resolves. `requireAdmin` has already authorised the call; this is
      // the plugin re-deriving the same session, exactly as banUser does.
      headers: request.headers,
      body: { email, name, password },
    });
  } catch (error) {
    // Better Auth reports a duplicate email or a malformed address as an
    // APIError; surface its message rather than a generic 500.
    const message =
      error instanceof Error ? error.message : "Could not create the account.";
    throw badRequest(message);
  }

  const userId = created.user.id;

  // Mark the address verified (see the doc comment). Done as an explicit write
  // rather than by passing `emailVerified` through the plugin's `data` field,
  // because an account that silently stayed unverified is a lockout under the
  // verified-sign-in policy, and this way the outcome does not depend on how
  // the plugin forwards extra fields to the insert.
  await sql`UPDATE "user" SET "emailVerified" = TRUE WHERE id = ${userId}`;

  const emailSent = await sendInvitationEmail({ email, name });

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "user.create",
    targetType: "user",
    targetId: userId,
    metadata: { email, passwordGenerated: generated, invitationEmailSent: emailSent },
  });

  return json(
    {
      user: { id: userId, email, name, role: "user" },
      // Only ever the generated one. A password the admin chose is not worth
      // sending back over the wire for them to read.
      password: generated ? password : null,
      emailSent,
    },
    201,
  );
}

/**
 * Tell someone an account was made for them. Returns whether it was actually
 * sent (false when mail is unconfigured or the provider failed).
 *
 * Deliberately does not contain the password: the invitation travels over
 * whatever email path the operator configured, while the credential goes
 * through the admin, so a single intercepted mailbox is not a working login.
 * The sign-in URL is the panel's own, from `FRONTEND_URL`, the same origin
 * Better Auth signs its links with.
 */
async function sendInvitationEmail({
  email,
  name,
}: {
  email: string;
  name: string;
}): Promise<boolean> {
  const { siteName } = await getBranding();
  const signInUrl = `${env.frontendUrl}/login`;
  const greeting = name ? `Hi ${name},` : "Hi,";

  return sendMail({
    to: email,
    subject: `You have been invited to ${siteName}`,
    text: `${greeting}\n\nAn administrator has created an account for you on ${siteName}.\n\nSign in at ${signInUrl} using this email address (${email}). The administrator who invited you has your password; ask them for it if you have not received it, and change it from your account settings once you are in.\n\nIf you were not expecting this, you can ignore this message.`,
    html: `<p>${greeting}</p><p>An administrator has created an account for you on <strong>${siteName}</strong>.</p><p>Sign in at <a href="${signInUrl}">${signInUrl}</a> using this email address (${email}). The administrator who invited you has your password; ask them for it if you have not received it, and change it from your account settings once you are in.</p><p style="color:#666">If you were not expecting this, you can ignore this message.</p>`,
  });
}

/**
 * GET /api/admin/users/:id. A single account's profile plus the servers they
 * own, for the admin user-detail page.
 *
 * Returns 404 (not "deleted") when the account is gone, so the detail page can
 * show its not-found state. Server rows are the owner's only. Subuser access
 * is intentionally excluded from this view to keep the page focused on what the
 * account *owns*.
 */
export async function handleGetUser(
  request: Request,
  userId: string,
): Promise<Response> {
  await requireAdmin(request);

  const rows = (await sql`
    SELECT
      u.id, u.email, u.name, u.role, u."createdAt" AS created_at,
      u.banned, u."banReason" AS ban_reason, u."banExpires" AS ban_expires
    FROM "user" u
    WHERE u.id = ${userId}
  `) as {
    id: string;
    email: string;
    name: string | null;
    role: string | null;
    created_at: string | null;
    banned: boolean | null;
    ban_reason: string | null;
    ban_expires: string | null;
  }[];

  const user = rows[0];
  if (!user) throw notFound("User not found");

  // Owned servers, newest first. Reuses listServersForOwner so the shape matches
  // the rest of the panel's server summaries.
  const servers = await listServersForOwner(user.id);

  return json({ user: { ...user, servers } });
}

/**
 * PATCH /api/admin/users/:id/role. Promotes or demotes a user.
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
 * POST /api/admin/users/:id/ban. Bans a user and suspends their servers.
 *
 * Delegates the ban itself to Better Auth's admin plugin (`auth.api.banUser`),
 * which sets `banned` and revokes every session the user holds, so they are
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

  // Better Auth user ids are opaque strings (nanoid-style), not UUIDs, so this
  // matches handleUpdateUserRole, which trusts the route param. Guard against
  // an empty id so a malformed route cannot reach the lookup.
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
  // request headers, so forward them. Without headers the call has no session
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
 * POST /api/admin/users/:id/unban. Lifts a ban.
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

// --- User deletion -----------------------------------------------------------

/**
 * DELETE /api/admin/users/:id. Removes an account for good.
 *
 * Deletion is gated on **an active ban**, not offered as a first response. The
 * ban is what makes the delete safe rather than merely permitted: banning
 * already revokes every session the account holds and suspends its servers, so
 * by the time this route runs the account cannot be mid-request, and the admin
 * has had a reversible step (unban) to change their mind in. It also means the
 * two-part decision reads in the audit log as two entries.
 *
 * The other gates:
 *
 *  - **Zero owned servers.** `servers.owner_id` cascades on user deletion
 *    (`001_initial_schema.sql`), so deleting an owner would silently destroy
 *    their servers, their data directories and their port allocations, with the
 *    node left holding orphaned containers. This is the same rule the
 *    self-service delete enforces (`routes/users.ts`); an admin who wants the
 *    account gone deletes its servers first, deliberately, one at a time.
 *  - **Not yourself.** Self-deletion goes through `POST /api/account/delete`,
 *    which requires the password. Better Auth's `removeUser` refuses it too;
 *    this check just gives the better message.
 *  - **Not the last admin**, mirroring the demote guard: the panel must always
 *    have one.
 *  - **No surviving server-link attribution.** `server_links.created_by` is the
 *    one reference to `"user"` with no `ON DELETE` action (every other
 *    attribution column is `SET NULL`), so the delete would fail on a foreign
 *    key. The normal case cannot hit it, because a link's row dies with its
 *    server and the account owns none; an *admin* who wired up links on someone
 *    else's servers can, and gets told which ones rather than a 500.
 *
 * What survives the deletion, on purpose: the audit trail. `audit_logs.user_id`
 * is `ON DELETE SET NULL`, so the account's actions stay on record as "system"
 * with their target intact, and this deletion is itself audited with the
 * deleted address in the metadata.
 */
export async function handleAdminDeleteUser(
  request: Request,
  userId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);

  const targetId = userId.trim();
  if (targetId.length === 0) throw badRequest('"userId" is required.');

  if (targetId === admin.id) {
    throw conflict(
      "You cannot delete your own account from here. Use your account settings, which require your password.",
    );
  }

  const targetRows = (await sql`
    SELECT id, email, name, role, banned, "banExpires" AS ban_expires
    FROM "user" WHERE id = ${targetId}
  `) as {
    id: string;
    email: string;
    name: string | null;
    role: string | null;
    banned: boolean | null;
    ban_expires: Date | null;
  }[];

  const target = targetRows[0];
  if (!target) throw notFound("User not found");

  // An expired ban is not a ban: the sign-in hook clears it lazily and the UI
  // already renders such an account as active, so treating it as banned here
  // would let a lapsed ban authorise a deletion nobody re-confirmed.
  const banActive =
    Boolean(target.banned) &&
    (target.ban_expires === null || target.ban_expires.getTime() > Date.now());

  if (!banActive) {
    throw conflict(
      "Ban the account before deleting it. Banning signs the user out everywhere and suspends their servers, which is what makes the deletion safe.",
    );
  }

  if (target.role === "admin") {
    const adminCount = (await sql`
      SELECT COUNT(*)::int AS count FROM "user" WHERE role = 'admin'
    `) as { count: number }[];

    if ((adminCount[0]?.count ?? 0) <= 1) {
      throw conflict("Cannot delete the last remaining admin");
    }
  }

  const ownedRows = (await sql`
    SELECT COUNT(*)::int AS count FROM servers WHERE owner_id = ${targetId}
  `) as { count: number }[];
  const owned = ownedRows[0]?.count ?? 0;

  if (owned > 0) {
    throw conflict(
      `This account still owns ${owned} server${owned === 1 ? "" : "s"}. Deleting the account would delete ${owned === 1 ? "it" : "them"} and ${owned === 1 ? "its" : "their"} data with it. Delete the server${owned === 1 ? "" : "s"} first.`,
    );
  }

  const linkRows = (await sql`
    SELECT s.name
    FROM server_links l
    JOIN servers s ON s.id = l.server_id
    WHERE l.created_by = ${targetId}
    ORDER BY s.name
    LIMIT 4
  `) as { name: string }[];

  if (linkRows.length > 0) {
    const names = linkRows.slice(0, 3).map((row) => row.name).join(", ");
    throw conflict(
      `This account created server connections that still exist (on ${names}${linkRows.length > 3 ? ", and more" : ""}). Remove those connections first.`,
    );
  }

  // Delegated to the admin plugin, which drops the user's sessions and their
  // credential accounts alongside the row. Everything panel-owned that hangs
  // off the account cascades (subuser grants, SFTP credentials, console
  // sessions); attribution columns go null.
  await auth.api.removeUser({
    headers: request.headers,
    body: { userId: targetId },
  });

  // The `apikey` table is the one thing with no foreign key back to `"user"`
  // (the plugin stores the owner in `referenceId`), so its rows would outlive
  // the account. They could not authenticate anything without a user row to
  // synthesize a session from, but leaving credential rows behind for an
  // account that no longer exists is not a state worth having.
  await sql`DELETE FROM apikey WHERE "referenceId" = ${targetId}`;

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "user.delete",
    targetType: "user",
    targetId,
    metadata: { email: target.email, name: target.name, role: target.role, byAdmin: true },
  });

  return json({ deleted: true, userId: targetId });
}

// --- Audit log ----------------------------------------------------------------

/**
 * GET /api/admin/audit-logs. Fleet-wide audit feed for the admin page.
 *
 * The raw `audit_logs` rows carry opaque IDs: a `user_id` (the actor) and a
 * `target_id` whose table depends on `target_type`. Resolving those into names
 * client-side would mean an N+1 round-trip per row, so the join is done here in
 * two batched passes, one for actors and one per target type, and the enriched
 * rows are returned in snake_case to match the existing contract.
 *
 * System actions (`user_id` is null) and deleted targets (the actor's user row
 * is gone, or a server/node was removed) pass through with null names; the UI
 * falls back to "system" / a truncated ID rather than hiding the row.
 */
export async function handleListAuditLogs(request: Request): Promise<Response> {
  await requireAdmin(request);

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit")) || 100;

  const rows = await listAuditLogs({ limit });

  if (rows.length === 0) {
    return json({ logs: [] });
  }

  // Resolve actors (who performed the action) in one query. user_id is TEXT
  // because Better Auth user IDs are opaque nanoid-style strings, not UUIDs.
  const actorIds = [
    ...new Set(rows.map((r) => r.user_id).filter((v): v is string => v !== null)),
  ];
  let actorsById = new Map<string, { email: string; name: string | null }>();
  if (actorIds.length > 0) {
    const actorRows = (await sql`
      SELECT id, email, name FROM "user" WHERE id = ANY(${sql.array(actorIds)})
    `) as { id: string; email: string; name: string | null }[];
    actorsById = new Map(
      actorRows.map((u) => [u.id, { email: u.email, name: u.name }]),
    );
  }

  // Resolve target names in one query per target type. Only server/node/user/
  // blueprint have human-readable names worth showing (and linkable detail
  // pages); subuser/database/suspicious_activity/settings targets are described
  // by their metadata instead, so their name is left null.
  const targetIdsByType = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.target_type || !row.target_id) continue;
    if (!["server", "node", "user", "blueprint"].includes(row.target_type)) continue;
    const list = targetIdsByType.get(row.target_type) ?? [];
    list.push(row.target_id);
    targetIdsByType.set(row.target_type, list);
  }

  // Build "type:id" -> name maps. Keys are namespaced so a server id and a user
  // id (both UUIDs) never collide.
  const nameByKey = new Map<string, string>();

  // target_id is stored as TEXT in audit_logs, but these tables key on UUID.
  // Pass the UUID type OID (2950) so the array is typed uuid[] and Postgres can
  // compare uuid = uuid. The "user" lookup needs no cast, since user.id is TEXT.
  if (targetIdsByType.has("server")) {
    const serverRows = (await sql`
      SELECT id, name FROM servers WHERE id = ANY(${sql.array(targetIdsByType.get("server")!, 2950)})
    `) as { id: string; name: string }[];
    for (const s of serverRows) nameByKey.set(`server:${s.id}`, s.name);
  }
  if (targetIdsByType.has("node")) {
    const nodeRows = (await sql`
      SELECT id, name FROM nodes WHERE id = ANY(${sql.array(targetIdsByType.get("node")!, 2950)})
    `) as { id: string; name: string }[];
    for (const n of nodeRows) nameByKey.set(`node:${n.id}`, n.name);
  }
  if (targetIdsByType.has("user")) {
    const userTargetRows = (await sql`
      SELECT id, name, email FROM "user" WHERE id = ANY(${sql.array(targetIdsByType.get("user")!)})
    `) as { id: string; name: string | null; email: string }[];
    for (const u of userTargetRows) {
      nameByKey.set(`user:${u.id}`, u.name ?? u.email);
    }
  }
  if (targetIdsByType.has("blueprint")) {
    const blueprintRows = (await sql`
      SELECT id, name FROM blueprints WHERE id = ANY(${sql.array(targetIdsByType.get("blueprint")!, 2950)})
    `) as { id: string; name: string }[];
    for (const b of blueprintRows) nameByKey.set(`blueprint:${b.id}`, b.name);
  }

  return json({
    logs: rows.map((row) => {
      const actor = row.user_id ? actorsById.get(row.user_id) ?? null : null;
      const targetName =
        row.target_type && row.target_id
          ? nameByKey.get(`${row.target_type}:${row.target_id}`) ?? null
          : null;
      return {
        id: row.id,
        user_id: row.user_id,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        ip: row.ip,
        metadata: row.metadata ?? {},
        created_at: row.created_at,
        actor_email: actor?.email ?? null,
        actor_name: actor?.name ?? null,
        target_name: targetName,
      };
    }),
  });
}

// --- Admin server list ---------------------------------------------------------

/**
 * GET /api/admin/servers. Fleet-wide view for the admin dashboard.
 *
 * Extends the normal summary rows with owner context plus live CPU and memory
 * usage sampled from each node's agent (with graceful fallback when a node is
 * unreachable or a container is missing).
 *
 * Sampling is batched **per node** rather than per server: one request per node
 * regardless of how many servers it hosts, so this page does not slow down
 * linearly as the fleet grows.
 *
 * `?q=` narrows the fleet by server name or owner name/email (see
 * {@link listAllServers}). The filter is applied in SQL before any sampling, so
 * a search also shrinks the set of nodes this endpoint has to talk to.
 */
export async function handleListAdminServers(request: Request): Promise<Response> {
  await requireAdmin(request);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";

  const servers = await listAllServers(q);

  const ownerIds = [...new Set(servers.map((server) => server.ownerId))];
  const ownersById = new Map<string, { email: string; name: string | null }>();

  if (ownerIds.length > 0) {
    // One query for every owner, rather than one per server. The fleet-wide
    // list fans out across users, and a serial per-owner SELECT turned each
    // page load into a loop whose length was the number of distinct owners.
    const ownerRows = (await sql`
      SELECT id, email, name FROM "user" WHERE id = ANY(${sql.array(ownerIds)})
    `) as { id: string; email: string; name: string | null }[];
    for (const row of ownerRows) {
      ownersById.set(row.id, { email: row.email, name: row.name });
    }
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
        // Node unreachable, so its servers simply report null usage below.
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
