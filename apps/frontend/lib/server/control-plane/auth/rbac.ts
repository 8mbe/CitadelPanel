/**
 * Authorization rules (plan.md section 5).
 *
 * Two global roles only: `user` and `admin`. Anything more granular is a
 * per-server subuser grant, which is scoped to a single server and can never
 * confer admin capability.
 */

import { sql } from "../db/client";
import type { Role } from "./betterAuth";

/** Permission flags a server owner can delegate to a subuser. */
export const SUBUSER_PERMISSIONS = [
  "console",
  "files",
  "start_stop",
  "settings",
  "backups",
  "database",
] as const;

export type SubuserPermission = (typeof SUBUSER_PERMISSIONS)[number];

export type SubuserPermissionSet = Partial<Record<SubuserPermission, boolean>>;

export function isSubuserPermission(value: unknown): value is SubuserPermission {
  return (
    typeof value === "string" &&
    (SUBUSER_PERMISSIONS as readonly string[]).includes(value)
  );
}

/**
 * Normalise an untrusted permissions object from an API request into a set
 * containing only known flags with boolean values. Unknown keys are dropped
 * rather than stored, so a client cannot invent its own permission names.
 */
export function sanitizePermissions(input: unknown): SubuserPermissionSet {
  if (typeof input !== "object" || input === null) return {};

  const result: SubuserPermissionSet = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSubuserPermission(key)) {
      result[key] = value === true;
    }
  }
  return result;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

/** How a user is entitled to act on a given server. */
export type ServerAccessKind = "admin" | "owner" | "subuser";

export interface ServerAccess {
  kind: ServerAccessKind;
  serverId: string;
  /** Only populated for `subuser` access; owners and admins have implicit all. */
  permissions: SubuserPermissionSet;
}

export function isAdmin(user: AuthenticatedUser): boolean {
  return user.role === "admin";
}

/**
 * Resolve what access a user has to a server, or null if they have none.
 *
 * Precedence: admin (everything) > owner (everything on their own server) >
 * subuser (only the flags explicitly granted).
 *
 * The subuser grant is LEFT JOINed rather than looked up after the owner check
 * fails. Every guarded endpoint passes through here, so the second query cost a
 * database round trip on every request a subuser made — and the join is free
 * for the owner and admin cases, where the joined column is simply ignored.
 */
/** What the database knows about one user's relationship to one server. */
export interface ServerAccessRow {
  id: string;
  owner_id: string;
  /** Null unless the user holds a subuser grant on this server. */
  permissions: unknown;
}

/**
 * The read half of {@link resolveServerAccess}, split from the decision.
 *
 * It needs only the caller's *id*, which the session carries without a database
 * read — so a guard can start this at the same time as the ban/role lookup
 * instead of after it. The decision below still waits for both.
 */
export async function loadServerAccessRow(
  userId: string,
  serverId: string,
): Promise<ServerAccessRow | null> {
  const rows = (await sql`
    SELECT s.id, s.owner_id, su.permissions
    FROM servers s
    LEFT JOIN server_subusers su
      ON su.server_id = s.id AND su.user_id = ${userId}
    WHERE s.id = ${serverId}
  `) as ServerAccessRow[];

  return rows[0] ?? null;
}

/** The decision half: pure, given the row and the authenticated user. */
export function accessFromRow(
  user: AuthenticatedUser,
  server: ServerAccessRow | null,
): ServerAccess | null {
  if (!server) return null;

  if (isAdmin(user)) {
    return { kind: "admin", serverId: server.id, permissions: {} };
  }

  if (server.owner_id === user.id) {
    return { kind: "owner", serverId: server.id, permissions: {} };
  }

  // No matching subuser row: the LEFT JOIN leaves this null.
  if (server.permissions === null || server.permissions === undefined) {
    return null;
  }

  return {
    kind: "subuser",
    serverId: server.id,
    permissions: sanitizePermissions(server.permissions),
  };
}

export async function resolveServerAccess(
  user: AuthenticatedUser,
  serverId: string,
): Promise<ServerAccess | null> {
  return accessFromRow(user, await loadServerAccessRow(user.id, serverId));
}

/**
 * Whether an access grant satisfies a required permission.
 *
 * Admins and owners implicitly hold every server-scoped permission; subusers
 * hold only what was granted.
 */
export function accessAllows(
  access: ServerAccess,
  permission: SubuserPermission,
): boolean {
  if (access.kind === "admin" || access.kind === "owner") return true;
  return access.permissions[permission] === true;
}

/**
 * Actions that only a server owner (or admin) may perform, never a subuser —
 * regardless of which flags the owner granted. Managing subusers and deleting
 * the server itself are deliberately non-delegable.
 */
export function accessAllowsOwnerOnly(access: ServerAccess): boolean {
  return access.kind === "admin" || access.kind === "owner";
}
