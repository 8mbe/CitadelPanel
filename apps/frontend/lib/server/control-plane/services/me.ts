/**
 * The `/api/me` payload, as a shared server-side loader.
 *
 * Both the `GET /api/me` route handler and the SSR session resolver (see
 * `lib/server/session.ts`) need the same data: the caller's display profile
 * plus their owned/subuser server counts. Keeping the query in one place means a
 * change to what `/api/me` returns lands in both paths at once.
 *
 * One query carries everything: the user's display fields (`name`,
 * `twoFactorEnabled`) plus correlated count subqueries for owned and subuser
 * servers. The subqueries use the indexed FKs on `servers.owner_id` and
 * `server_subusers.user_id`. The admin-only review-queue count is a separate
 * call — it scans the suspicious-activity table and is meaningless for non-admins.
 */

import { sql } from "../db/client";
import { countUnreviewed } from "../security/suspiciousList";
import type { AuthenticatedUser } from "../auth/rbac";

export interface MeProfile {
  name: string | null;
  twoFactorEnabled: boolean;
  ownedServers: number;
  subuserServers: number;
  /** Admin-only; undefined for non-admins. */
  pendingReviews?: number;
}

export async function loadMeProfile(
  user: AuthenticatedUser,
): Promise<MeProfile> {
  const rows = (await sql`
    SELECT
      u.name,
      u."twoFactorEnabled",
      (SELECT COUNT(*)::int FROM servers WHERE owner_id = ${user.id}) AS owned_servers,
      (SELECT COUNT(*)::int FROM server_subusers WHERE user_id = ${user.id}) AS subuser_servers
    FROM "user" u
    WHERE u.id = ${user.id}
  `) as {
    name: string | null;
    twoFactorEnabled: boolean | null;
    owned_servers: number;
    subuser_servers: number;
  }[];

  const row = rows[0];
  const pendingReviews =
    user.role === "admin" ? await countUnreviewed() : undefined;

  return {
    name: row?.name ?? null,
    twoFactorEnabled: row?.twoFactorEnabled ?? false,
    ownedServers: row?.owned_servers ?? 0,
    subuserServers: row?.subuser_servers ?? 0,
    pendingReviews,
  };
}
