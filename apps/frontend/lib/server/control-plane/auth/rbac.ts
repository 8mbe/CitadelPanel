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
 */
export async function resolveServerAccess(
  user: AuthenticatedUser,
  serverId: string,
): Promise<ServerAccess | null> {
  const serverRows = (await sql`
    SELECT id, owner_id FROM servers WHERE id = ${serverId}
  `) as { id: string; owner_id: string }[];

  const server = serverRows[0];
  if (!server) return null;

  if (isAdmin(user)) {
    return { kind: "admin", serverId: server.id, permissions: {} };
  }

  if (server.owner_id === user.id) {
    return { kind: "owner", serverId: server.id, permissions: {} };
  }

  const subuserRows = (await sql`
    SELECT permissions
    FROM server_subusers
    WHERE server_id = ${serverId} AND user_id = ${user.id}
  `) as { permissions: unknown }[];

  const subuser = subuserRows[0];
  if (!subuser) return null;

  return {
    kind: "subuser",
    serverId: server.id,
    permissions: sanitizePermissions(subuser.permissions),
  };
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
