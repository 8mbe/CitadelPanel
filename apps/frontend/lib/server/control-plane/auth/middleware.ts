/**
 * Request-scoped auth guards (plan.md section 6).
 *
 * Each guard validates the Better Auth session first, then layers role and
 * server-scoped permission checks on top. Guards throw `HttpError`, which the
 * router converts into a response.
 */

import {
  isScopeSubset,
  parseApiKeyScopes,
  scopesAllow,
  type ApiKeyResource,
  type ApiKeyScopes,
  type ScopeAction,
} from "@/lib/api-key-scopes";
import { auth, isRole, type Role } from "./betterAuth";
import { resolveRouteScope } from "./routeScopes";
import {
  readSessionCache,
  sessionCacheKey,
  writeSessionCache,
  type ApiKeyContext,
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
    apiKey: headers.get("x-api-key")
      ? await loadApiKeyContext(
          (session as { session?: { id?: unknown } }).session?.id,
        )
      : null,
  };
  writeSessionCache(key, identity);
  return identity;
}

/**
 * Resolve the scopes of the key that authenticated this request.
 *
 * The api-key plugin synthesizes a session whose `session.id` *is* the `apikey`
 * row id (it has no session row to point at), which is what lets this be a
 * lookup by primary key rather than a re-hash of the presented credential. We
 * depend on that one property rather than on the plugin's hashing scheme,
 * because the scheme is an implementation detail and the id is part of what the
 * plugin returns.
 *
 * If that id is missing or names no row, the key is treated as scoped to
 * nothing rather than as unrestricted: we know a key authenticated the request
 * (the header is present and `getSession` succeeded), so failing to learn its
 * scopes must deny, not grant.
 */
async function loadApiKeyContext(sessionId: unknown): Promise<ApiKeyContext> {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { id: "", scopes: {} };
  }

  const rows = (await sql`
    SELECT permissions FROM apikey WHERE id = ${sessionId}
  `) as { permissions: unknown }[];

  const row = rows[0];
  if (!row) return { id: sessionId, scopes: {} };

  return { id: sessionId, scopes: parseApiKeyScopes(row.permissions) };
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

// --- API-key scopes -----------------------------------------------------------

/**
 * Whether the request carries an API key at all, from the headers alone.
 *
 * Cheap on purpose. Every scope check starts here so that cookie-session and
 * anonymous requests — which are almost all of them — cost exactly what they
 * cost before scopes existed: nothing. Only a request that actually presents a
 * key goes on to resolve a session in the gate.
 */
function carriesApiKey(headers: Headers): boolean {
  return headers.get("x-api-key") !== null || Boolean(
    headers.get("authorization")?.toLowerCase().startsWith("bearer "),
  );
}

/**
 * The key that authenticated this request, or null for a cookie session.
 *
 * Exposed so the dispatcher's scope gate can read the caller's own grant when
 * it has to compare it against something (see {@link assertScopeSubset}).
 */
export async function getRequestApiKey(
  request: Request,
): Promise<ApiKeyContext | null> {
  if (!carriesApiKey(request.headers)) return null;
  const identity = await resolveSessionIdentity(request);
  return identity?.apiKey ?? null;
}

/**
 * Refuse a request whose API key is not scoped to what the route touches.
 *
 * Called by the dispatcher for every `/api/*` path, *before* the handler and
 * its own guards run. Three cases:
 *
 * - **No key** (cookie session, or no credential at all): nothing to check.
 *   Unauthenticated requests still fail in the handler's own guard, as before.
 * - **Unrestricted key** (`scopes === null`): nothing to check. Every key
 *   minted before scopes existed is unrestricted, so this is a pure addition
 *   and no existing integration changes behaviour.
 * - **Scoped key**: the route's `(resource, action)` must be granted.
 *
 * The gate only ever *narrows*. It cannot grant anything, because the handler's
 * `requireAdmin` / `requireServerPermission` still run behind it — a key is the
 * intersection of its owner's authority and its own scope, never the union.
 *
 * An unmapped path denies (see `routeScopes.ts` on failing closed).
 */
export async function enforceApiKeyScope(
  request: Request,
  path: string,
): Promise<void> {
  const apiKey = await getRequestApiKey(request);
  if (!apiKey || apiKey.scopes === null) return;

  const scope = resolveRouteScope(path, request.method);
  // `undefined` is a route that needs no scope; `null` is one we do not
  // recognise, which a scoped key may not reach.
  if (scope === undefined) return;
  if (scope === null) {
    throw forbidden(
      "This API key is scoped, and this endpoint is not covered by any scope.",
    );
  }

  if (!scopesAllow(apiKey.scopes, scope.resource, scope.action)) {
    throw forbidden(
      `This API key is missing the "${scope.resource}:${scope.action}" scope.`,
    );
  }
}

/**
 * Refuse to mint or re-scope a key broader than the one asking for it.
 *
 * Without this, `api_keys:write` would be an escape hatch rather than a
 * delegation: a key scoped to `files:read` could call the key-creation endpoint
 * and hand itself an unrestricted successor. Attenuation makes the scope
 * lattice monotonic — a key can only ever produce keys weaker than or equal to
 * itself — which is what lets `api_keys` be a grantable scope at all.
 *
 * A cookie session or an unrestricted key passes unconditionally: both already
 * hold everything the new key could be given.
 */
export async function assertScopeSubset(
  request: Request,
  requested: ApiKeyScopes | null,
): Promise<void> {
  const apiKey = await getRequestApiKey(request);
  if (!apiKey || apiKey.scopes === null) return;

  if (requested === null) {
    throw forbidden(
      "A scoped API key cannot create an unrestricted key. Specify permissions that are a subset of this key's own scopes.",
    );
  }
  if (!isScopeSubset(requested, apiKey.scopes)) {
    throw forbidden(
      "A scoped API key cannot grant permissions beyond its own scopes.",
    );
  }
}

/**
 * Require one specific scope, for a handler that needs a check the path alone
 * cannot express. The gate above covers the ordinary case; this is the escape
 * hatch for a route whose resource depends on its body.
 */
export async function requireApiKeyScope(
  request: Request,
  resource: ApiKeyResource,
  action: ScopeAction,
): Promise<void> {
  const apiKey = await getRequestApiKey(request);
  if (!apiKey || apiKey.scopes === null) return;

  if (!scopesAllow(apiKey.scopes, resource, action)) {
    throw forbidden(`This API key is missing the "${resource}:${action}" scope.`);
  }
}
