/**
 * Current-user routes.
 *
 * Account creation, login and logout are handled entirely by Better Auth's own
 * mounted handler — these endpoints only expose panel-specific profile data.
 */

import { requireAuth } from "../auth/middleware";
import { auth } from "../auth/betterAuth";
import {
  badRequest,
  conflict,
  json,
  parseJsonBody,
  requireString,
} from "../lib/http";
import { sql } from "../db/client";
import { recordAuditFromRequest } from "../services/auditLog";
import { loadMeProfile } from "../services/me";

/** GET /api/me — the caller's identity and role. */
export async function handleGetMe(request: Request): Promise<Response> {
  const user = await requireAuth(request);

  // Shared with the SSR session resolver (see lib/server/session.ts), so the
  // payload is identical whether `/api/me` answers from this route or from the
  // panel layout's server-side read.
  const profile = await loadMeProfile(user);

  return json({
    user: {
      id: user.id,
      email: user.email,
      name: profile.name,
      role: user.role,
      twoFactorEnabled: profile.twoFactorEnabled,
      ownedServers: profile.ownedServers,
      subuserServers: profile.subuserServers,
      ...(profile.pendingReviews !== undefined
        ? { pendingReviews: profile.pendingReviews }
        : {}),
    },
  });
}

/**
 * POST /api/account/delete — delete the caller's own account.
 *
 * Two guards, both deliberate:
 *
 *  - The caller must own **zero** servers. `servers.owner_id` cascades on user
 *    deletion (`001_initial_schema.sql`), so allowing a delete with owned
 *    servers would silently destroy those servers — and their data. The gate is
 *    checked here, server-side, so a tampered client cannot bypass it. (An admin
 *    who wants a user gone reassigns or deletes their servers first.)
 *  - The caller must re-supply their password. Account deletion is irreversible,
 *    so it is password-confirmed exactly as the sign-in flow is.
 *
 * The actual deletion is delegated to Better Auth by re-entering its handler at
 * `/api/auth/delete-user` with the session cookie forwarded: Better Auth then
 * verifies the password, deletes the user row, revokes every session, and
 * clears the session cookie. Re-implementing that would mean handling password
 * verification and session teardown ourselves for no gain.
 *
 * Returns Better Auth's response (including its `Set-Cookie` that ends the
 * session) so the browser is signed out as the account disappears.
 */
export async function handleDeleteAccount(request: Request): Promise<Response> {
  const user = await requireAuth(request);

  const owned = (await sql`
    SELECT COUNT(*)::int AS count FROM servers WHERE owner_id = ${user.id}
  `) as { count: number }[];

  if ((owned[0]?.count ?? 0) > 0) {
    throw conflict(
      "Delete your servers before deleting your account. An account that owns servers cannot be removed — doing so would delete those servers and their data.",
    );
  }

  const body = await parseJsonBody(request);
  const password = requireString(body, "password", { min: 1, max: 1024 });

  // Reconstruct the request Better Auth's handler expects: same method, same
  // cookie (so it can resolve + then end the session), JSON body with the
  // password. `delete-user` verifies the credential and deletes immediately
  // when `sendDeleteAccountVerification` is unset (it is, by default).
  const origin = new URL(request.url).origin;
  const authRequest = new Request(`${origin}/api/auth/delete-user`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: request.headers.get("cookie") ?? "",
    },
    body: JSON.stringify({ password }),
  });

  let result: Response;
  try {
    result = await auth.handler(authRequest);
  } catch (error) {
    // Better Auth throws an APIError for a wrong password; surface its message.
    const message =
      error instanceof Error ? error.message : "Could not delete the account.";
    throw badRequest(message);
  }

  // The deletion succeeded only if Better Auth says so. A wrong password comes
  // back as a 4xx with a JSON body — pass that through verbatim.
  const payload = (await result.json().catch(() => null)) as
    | { success?: boolean; message?: string }
    | null;

  if (!result.ok || !payload?.success) {
    throw badRequest(
      payload?.message ?? "Could not delete the account. Check your password.",
    );
  }

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "user.delete",
    targetType: "user",
    targetId: user.id,
    metadata: { email: user.email },
  });

  // Re-emit Better Auth's Set-Cookie (the one that clears the session) so the
  // browser is signed out atomically with the deletion.
  const headers = new Headers({ "content-type": "application/json" });
  const setCookie = result.headers.getSetCookie();
  if (setCookie.length > 0) {
    headers.append("set-cookie", setCookie.join(", "));
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers,
  });
}
