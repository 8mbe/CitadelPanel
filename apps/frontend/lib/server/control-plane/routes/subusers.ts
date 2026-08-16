/**
 * Subuser routes (plan.md section 5).
 *
 * Subusers are the delegation mechanism, scoped to exactly one server. Managing
 * them is owner-or-admin only — a subuser can never invite further subusers,
 * which would let a delegated grant escalate itself.
 */

import { requireServerOwner } from "../auth/middleware";
import { sanitizePermissions, SUBUSER_PERMISSIONS } from "../auth/rbac";
import {
  badRequest,
  conflict,
  json,
  noContent,
  notFound,
  parseJsonBody,
  requireString,
  requireUuidParam,
} from "../lib/http";
import { sql } from "../db/client";
import { recordAuditFromRequest } from "../services/auditLog";

/** GET /api/servers/:id/subusers */
export async function handleListSubusers(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerOwner(request, id);

  const rows = (await sql`
    SELECT su.user_id, su.permissions, su.created_at, su.invited_by, u.email, u.name
    FROM server_subusers su
    JOIN "user" u ON u.id = su.user_id
    WHERE su.server_id = ${id}
    ORDER BY su.created_at ASC
  `) as {
    user_id: string;
    permissions: unknown;
    created_at: Date;
    invited_by: string | null;
    email: string;
    name: string | null;
  }[];

  return json({
    subusers: rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      name: row.name,
      permissions: sanitizePermissions(row.permissions),
      invitedBy: row.invited_by,
      createdAt: row.created_at,
    })),
    availablePermissions: SUBUSER_PERMISSIONS,
  });
}

/**
 * POST /api/servers/:id/subusers — invite an existing user to a server.
 *
 * The invitee must already have an account. Deliberately no email-invite flow
 * yet: creating accounts as a side effect of an invite is an abuse vector.
 */
export async function handleInviteSubuser(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user, access } = await requireServerOwner(request, id);

  const body = await parseJsonBody(request);
  const email = requireString(body, "email", { max: 320 }).toLowerCase();
  const permissions = sanitizePermissions(body.permissions);

  if (Object.values(permissions).every((granted) => granted !== true)) {
    throw badRequest(
      `Grant at least one permission. Available: ${SUBUSER_PERMISSIONS.join(", ")}`,
    );
  }

  const userRows = (await sql`
    SELECT id, email FROM "user" WHERE lower(email) = ${email}
  `) as { id: string; email: string }[];

  const invitee = userRows[0];
  if (!invitee) {
    throw notFound("No account exists with that email address");
  }

  // The owner is already all-powerful on their own server.
  const ownerRows = (await sql`
    SELECT owner_id FROM servers WHERE id = ${id}
  `) as { owner_id: string }[];

  if (ownerRows[0]?.owner_id === invitee.id) {
    throw conflict("That user already owns this server");
  }

  await sql`
    INSERT INTO server_subusers (server_id, user_id, permissions, invited_by)
    VALUES (${id}, ${invitee.id}, ${sql.json(permissions)}, ${user.id})
    ON CONFLICT (server_id, user_id) DO UPDATE SET
      permissions = EXCLUDED.permissions
  `;

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "subuser.invite",
    targetType: "server",
    targetId: id,
    // The email is denormalized into the record on purpose: audit history
    // should name who was invited even after the grant is revoked or the
    // account is deleted, when a read-time join could no longer resolve it.
    metadata: {
      subuserId: invitee.id,
      subuserEmail: invitee.email,
      permissions,
      actorKind: access.kind,
    },
  });

  return json(
    {
      subuser: {
        userId: invitee.id,
        email: invitee.email,
        permissions,
      },
    },
    201,
  );
}

/** PATCH /api/servers/:id/subusers/:userId — change granted permissions. */
export async function handleUpdateSubuser(
  request: Request,
  serverId: string,
  subuserId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  const body = await parseJsonBody(request);
  const permissions = sanitizePermissions(body.permissions);

  const rows = (await sql`
    UPDATE server_subusers
    SET permissions = ${sql.json(permissions)}
    WHERE server_id = ${id} AND user_id = ${subuserId}
    RETURNING user_id
  `) as { user_id: string }[];

  if (rows.length === 0) {
    throw notFound("That user is not a subuser of this server");
  }

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "subuser.update",
    targetType: "server",
    targetId: id,
    metadata: {
      subuserId,
      subuserEmail: await lookupEmail(subuserId),
      permissions,
    },
  });

  return json({ subuser: { userId: subuserId, permissions } });
}

/** DELETE /api/servers/:id/subusers/:userId — revoke access. */
export async function handleRemoveSubuser(
  request: Request,
  serverId: string,
  subuserId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  // Resolve the email before the row disappears — it names the subuser in the
  // audit record, which must outlive the grant itself.
  const email = await lookupEmail(subuserId);

  const rows = (await sql`
    DELETE FROM server_subusers
    WHERE server_id = ${id} AND user_id = ${subuserId}
    RETURNING user_id
  `) as { user_id: string }[];

  if (rows.length === 0) {
    throw notFound("That user is not a subuser of this server");
  }

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "subuser.remove",
    targetType: "server",
    targetId: id,
    metadata: { subuserId, subuserEmail: email },
  });

  return noContent();
}

/** The email behind a subuser id, for audit records. Null if the user is gone. */
async function lookupEmail(userId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT email FROM "user" WHERE id = ${userId}
  `) as { email: string }[];
  return rows[0]?.email ?? null;
}
