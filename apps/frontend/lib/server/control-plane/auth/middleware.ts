/**
 * Request-scoped auth guards (plan.md section 6).
 *
 * Each guard validates the Better Auth session first, then layers role and
 * server-scoped permission checks on top. Guards throw `HttpError`, which the
 * router converts into a response.
 */

import { auth, isRole, type Role } from "./betterAuth";
import {
  readSessionCache,
  sessionCacheKey,
  writeSessionCache,
  type SessionIdentity,
} from "./sessionCache";
import {
  accessAllows,
  accessAllowsOwnerOnly,
  accessFromRow,
  loadServerAccessRow,
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
 * than fight either library, the alias is normalized here, in the single place
 * sessions are resolved, so scripts can use the conventional Bearer scheme
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
 * Resolve who the caller is, from the session alone.
 *
 * Kept separate from the ban/role check below because resolving *who* should be
 * free while the authoritative check costs a round trip. Knowing the caller's
 * id cheaply is what lets the server guards start their own lookup at the same
 * time as that check (see {@link requireServerPermission}). See
 * `sessionCache.ts` for why the result is cached at all.
 */
async function resolveSessionIdentity(
  request: Request,
): Promise<SessionIdentity | null> {
  const headers = withApiKeyHeaderAlias(request.headers);
  const key = sessionCacheKey(headers);

  const cached = readSessionCache(key);
  if (cached) return cached.identity;

  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    writeSessionCache(key, null);
    return null;
  }

  const identity: SessionIdentity = {
    id: session.user.id,
    email: session.user.email,
    sessionRole: (session.user as { role?: unknown }).role,
  };
  writeSessionCache(key, identity);
  return identity;
}

/**
 * Turn a session into an authenticated user: reject bans, resolve the real role.
 *
 * A banned user is never allowed past the auth layer, regardless of how their
 * session was established (cookie or API key). The role is read from the same
 * row: with the session served from the cookie cache, `session.user.role` could
 * be up to the cache lifetime stale, so the authoritative value comes from the
 * database here. A promotion or demotion takes effect on the next request, not
 * minutes later.
 */
async function authorizeSession(
  identity: SessionIdentity,
): Promise<AuthenticatedUser> {
  const banRows = (await sql`
    SELECT banned, "banExpires", role FROM "user" WHERE id = ${identity.id}
  `) as { banned: boolean | null; banExpires: Date | null; role: unknown }[];
  const banRow = banRows[0];
  if (banRow?.banned) {
    if (banRow.banExpires && banRow.banExpires.getTime() < Date.now()) {
      // Expired ban: clear it so future requests skip this path, and allow.
      await sql`
        UPDATE "user" SET banned = FALSE, "banReason" = NULL, "banExpires" = NULL
        WHERE id = ${identity.id}
      `;
    } else {
      throw forbidden(
        "Your account has been banned. Contact an administrator if you believe this is an error.",
      );
    }
  }

  // Prefer the row's role; fall back to the session's copy if the row is
  // somehow absent. `role` is read defensively: an unexpected value degrades to
  // the least-privileged role rather than granting admin.
  const rawRole = banRow?.role ?? identity.sessionRole;
  const role: Role = isRole(rawRole) ? rawRole : "user";

  return { id: identity.id, email: identity.email, role };
}

/**
 * Resolve the current session into a typed user, or null when unauthenticated.
 */
export async function getAuthenticatedUser(
  request: Request,
): Promise<AuthenticatedUser | null> {
  const identity = await resolveSessionIdentity(request);
  if (!identity) return null;
  return authorizeSession(identity);
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
 * Subuser permissions never satisfy this check. Admin capability is gated
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
  const { user, access } = await resolveServerContext(request, serverId);

  if (!access) throw notFound("Server not found");
  if (!accessAllows(access, permission)) {
    throw forbidden(`Missing "${permission}" permission for this server`);
  }

  return { user, access };
}

/**
 * Resolve the caller and their access to one server, in one round trip.
 *
 * Both lookups hang off the session's user id, and the session is served from
 * the signed cookie cache, so the id is known before either query runs.
 * Running them one after the other made every guarded server endpoint wait
 * twice for no reason. They go together now.
 *
 * The ban check is not weakened by this: `authorizeSession` still throws for a
 * banned user, and it throws *before* this returns, so the access row is read
 * but never acted on. Nothing is authorized off a query that merely completed.
 */
async function resolveServerContext(
  request: Request,
  serverId: string,
): Promise<{ user: AuthenticatedUser; access: ServerAccess | null }> {
  const identity = await resolveSessionIdentity(request);
  if (!identity) throw unauthorized();

  const [user, row] = await Promise.all([
    authorizeSession(identity),
    loadServerAccessRow(identity.id, serverId),
  ]);

  return { user, access: accessFromRow(user, row) };
}

/**
 * Require owner-or-admin on a server, for non-delegable actions such as
 * managing subusers or deleting the server.
 */
export async function requireServerOwner(
  request: Request,
  serverId: string,
): Promise<ServerContext> {
  const { user, access } = await resolveServerContext(request, serverId);

  if (!access) throw notFound("Server not found");
  if (!accessAllowsOwnerOnly(access)) {
    throw forbidden("Only the server owner can perform this action");
  }

  return { user, access };
}
