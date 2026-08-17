/**
 * Request-scoped auth guards (plan.md section 6).
 *
 * Each guard validates the Better Auth session first, then layers role and
 * server-scoped permission checks on top. Guards throw `HttpError`, which the
 * router converts into a response.
 */

import { auth } from "./betterAuth";
import { isRole, type Role } from "./betterAuth";
import {
  accessAllows,
  accessAllowsOwnerOnly,
  resolveServerAccess,
  type AuthenticatedUser,
  type ServerAccess,
  type SubuserPermission,
} from "./rbac";
import { sql } from "../db/client";
import { forbidden, notFound, unauthorized } from "../lib/http";

/**
 * Accept `Authorization: Bearer <api-key>` as an alias for the `x-api-key`
 * header the plugin is configured to read.
 *
 * The apiKey plugin only inspects `apiKeyHeaders` (`x-api-key`); Better Auth's
 * own `bearer()` plugin translates Bearer *session tokens*, not keys. Rather
 * than fight either library, the alias is normalized here — the single place
 * sessions are resolved — so scripts can use the conventional Bearer scheme
 * against the same `/api/*` surface. Only the headers handed to Better Auth
 * are rewritten; the original request (and its audit-trail headers) is kept.
 */
function withApiKeyHeaderAlias(headers: Headers): Headers {
  if (headers.get("x-api-key")) return headers;
  const authorization = headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) return headers;

  const rewritten = new Headers(headers);
  rewritten.set("x-api-key", authorization.slice(7).trim());
  return rewritten;
}

/**
 * Resolve the current session into a typed user, or null when unauthenticated.
 *
 * `role` is read defensively: if the column somehow holds an unexpected value,
 * it degrades to the least-privileged role rather than granting admin.
 *
 * Banned users are rejected here even if they hold a live session cookie or an
 * API key: `auth.api.banUser` revokes sessions and the admin plugin blocks new
 * sign-ins, but this is the single chokepoint every panel route passes through,
 * so checking `banned` here is belt-and-suspenders against a surviving session
 * or the API-key-synthesized session. An expired ban is cleared and allowed.
 */
export async function getAuthenticatedUser(
  request: Request,
): Promise<AuthenticatedUser | null> {
  const session = await auth.api.getSession({
    headers: withApiKeyHeaderAlias(request.headers),
  });
  if (!session?.user) return null;

  const rawRole = (session.user as { role?: unknown }).role;
  const role: Role = isRole(rawRole) ? rawRole : "user";

  // A banned user is never allowed past the auth layer, regardless of how their
  // session was established (cookie or API key).
  const banRows = (await sql`
    SELECT banned, "banExpires" FROM "user" WHERE id = ${session.user.id}
  `) as { banned: boolean | null; banExpires: Date | null }[];
  const banRow = banRows[0];
  if (banRow?.banned) {
    if (banRow.banExpires && banRow.banExpires.getTime() < Date.now()) {
      // Expired ban: clear it so future requests skip this path, and allow.
      await sql`
        UPDATE "user" SET banned = FALSE, "banReason" = NULL, "banExpires" = NULL
        WHERE id = ${session.user.id}
      `;
    } else {
      throw forbidden(
        "Your account has been banned. Contact an administrator if you believe this is an error.",
      );
    }
  }

  return {
    id: session.user.id,
    email: session.user.email,
    role,
  };
}

/** Require any authenticated user. */
export async function requireAuth(request: Request): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser(request);
  if (!user) throw unauthorized();
  return user;
}

/**
 * Require a global admin.
 *
 * Subuser permissions never satisfy this check — admin capability is gated
 * purely on the global role (plan.md section 5).
 */
export async function requireAdmin(request: Request): Promise<AuthenticatedUser> {
  const user = await requireAuth(request);
  if (user.role !== "admin") throw forbidden("Admin role required");
  return user;
}

export interface ServerContext {
  user: AuthenticatedUser;
  access: ServerAccess;
}

/**
 * Require a specific permission on a specific server.
 *
 * A user with no access at all gets 404 rather than 403: revealing that a
 * server exists to someone with no relationship to it is an information leak.
 */
export async function requireServerPermission(
  request: Request,
  serverId: string,
  permission: SubuserPermission,
): Promise<ServerContext> {
  const user = await requireAuth(request);
  const access = await resolveServerAccess(user, serverId);

  if (!access) throw notFound("Server not found");
  if (!accessAllows(access, permission)) {
    throw forbidden(`Missing "${permission}" permission for this server`);
  }

  return { user, access };
}

/**
 * Require owner-or-admin on a server, for non-delegable actions such as
 * managing subusers or deleting the server.
 */
export async function requireServerOwner(
  request: Request,
  serverId: string,
): Promise<ServerContext> {
  const user = await requireAuth(request);
  const access = await resolveServerAccess(user, serverId);

  if (!access) throw notFound("Server not found");
  if (!accessAllowsOwnerOnly(access)) {
    throw forbidden("Only the server owner can perform this action");
  }

  return { user, access };
}
