/**
 * SFTP credential routes.
 *
 * Two audiences use these endpoints:
 *
 *   1. **The agent** calls `POST /api/internal/sftp/authenticate` on every SFTP
 *      connect, presenting the username/password the client gave. The panel
 *      authenticates the agent by its long-lived bearer (reverse-looked-up to a
 *      node), looks up the `sftp_credentials` row by username, verifies the
 *      password with Better Auth's scrypt `verifyPassword`, re-checks the user
 *      still has `files` access to that server (ownership can change hands, and
 *      a subuser's `files` flag can be revoked between credential mint and
 *      connect), and returns `{serverId, userId}`. This mirrors the direct-
 *      console callback pattern (`routes/console.ts`).
 *
 *   2. **The browser** calls the `/api/servers/:id/sftp/*` routes to mint,
 *      regenerate, view, and delete credentials — gated on the `files`
 *      permission, the same flag the file manager uses.
 *
 * Passwords are generated server-side (never chosen), stored as a scrypt
 * `salt:hash` (the same scheme Better Auth uses for login passwords), and shown
 * to the user exactly once — on creation or regeneration. There is no
 * "retrieve password" endpoint; a lost password is regenerated, which
 * invalidates the old one.
 */

import { hashPassword, verifyPassword } from "better-auth/crypto";
import { randomBytes } from "node:crypto";

import { buildSftpUsername } from "./sftpUsername";
import { requireServerPermission } from "@/lib/server/control-plane/auth/middleware";
import {
  accessAllows,
  resolveServerAccess,
  type AuthenticatedUser,
} from "@/lib/server/control-plane/auth/rbac";
import { sql } from "@/lib/server/control-plane/db/client";
import {
  badRequest,
  clientIp,
  conflict,
  json,
  noContent,
  notFound,
  parseJsonBody,
  requireUuidParam,
  unauthorized,
} from "@/lib/server/control-plane/lib/http";
import { findNodeByAgentToken } from "@/lib/server/control-plane/nodes/nodeRegistry";
import { recordAudit, recordAuditFromRequest } from "@/lib/server/control-plane/services/auditLog";

/**
 * Generate a strong random password.
 *
 * 24 bytes of entropy, base64url-encoded (no `+/=` so it pastes cleanly into any
 * SFTP client). ~192 bits — far beyond what a brute-force over SSH would ever
 * reach, and the panel hashes it before storage so the plaintext is never in the
 * DB.
 */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Response shape for a credential whose plaintext password is being revealed. */
interface SftpCredentialResponse {
  id: string;
  serverId: string;
  userId: string;
  username: string;
  password: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Shape for a credential list entry — no password, ever. */
interface SftpCredentialSummary {
  id: string;
  serverId: string;
  userId: string;
  username: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A credential row as read from the DB. */
interface SftpCredentialRow {
  id: string;
  server_id: string;
  user_id: string;
  username: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Resolve the user's email for a given server access, so the username can be
 * derived from it. The owner's email is used; for subusers, their own email.
 *
 * `resolveServerAccess` already confirms the user has access; this just fetches
 * the email (which `AuthenticatedUser` already carries from the session).
 */
async function upsertCredential(
  user: AuthenticatedUser,
  serverId: string,
): Promise<{ row: SftpCredentialRow; plaintext: string }> {
  const username = buildSftpUsername(user.email, serverId);
  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  // Upsert: a user minting again for the same server regenerates the password
  // rather than creating a duplicate. The UNIQUE(server_id, user_id) constraint
  // is the conflict target.
  const rows = (await sql`
    INSERT INTO sftp_credentials (server_id, user_id, username, password_hash)
    VALUES (${serverId}, ${user.id}, ${username}, ${passwordHash})
    ON CONFLICT (server_id, user_id) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          updated_at = now()
    RETURNING id, server_id, user_id, username, password_hash, created_at, updated_at
  `) as SftpCredentialRow[];

  return { row: rows[0]!, plaintext: password };
}

function toResponse(row: SftpCredentialRow, plaintext: string): SftpCredentialResponse {
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    username: row.username,
    password: plaintext,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: SftpCredentialRow): SftpCredentialSummary {
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    username: row.username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Agent callback ---------------------------------------------------------

/**
 * Authenticate the agent by its bearer, or throw 401.
 *
 * Identical to `requireCallingAgent` in `routes/console.ts`: the panel
 * reverse-looks-up the node from the token so it knows *which* node is calling,
 * and so a token leaked from one node cannot be used to validate SFTP creds on
 * another node's behalf (the server's node_id is checked against the caller).
 */
async function requireCallingAgent(request: Request) {
  const header = request.headers.get("authorization");
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) throw unauthorized("A valid agent bearer token is required.");
  const node = await findNodeByAgentToken(match[1]!);
  if (!node) throw unauthorized("Unknown agent token.");
  return node;
}

/**
 * `POST /api/internal/sftp/authenticate` — agent callback at SFTP connect.
 *
 * The agent sends `{username, password}`. The panel:
 *   1. looks up the credential by username,
 *   2. verifies the password (constant-time via scrypt),
 *   3. confirms the user still has `files` access to that server (a revoked
 *      subuser or a handed-off server must not keep working via SFTP),
 *   4. confirms the server lives on the calling node (so node Y cannot validate
 *      a credential minted for a server on node X),
 *   5. returns `{serverId, userId}` the agent chroots the session to.
 *
 * A failure at any step is a generic 401 — the agent does not distinguish bad
 * password from no-access, so an attacker cannot enumerate valid usernames from
 * the error.
 */
export async function handleSftpAuthenticate(request: Request): Promise<Response> {
  const node = await requireCallingAgent(request);
  const body = await parseJsonBody(request);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) throw unauthorized("Invalid credentials.");

  const rows = (await sql`
    SELECT c.id, c.server_id, c.user_id, c.username, c.password_hash,
           s.node_id, u.banned, u."banExpires"
    FROM sftp_credentials c
    JOIN servers s ON s.id = c.server_id
    JOIN "user" u ON u.id = c.user_id
    WHERE c.username = ${username}
  `) as {
    id: string;
    server_id: string;
    user_id: string;
    username: string;
    password_hash: string;
    node_id: string;
    banned: boolean | null;
    banExpires: Date | null;
  }[];

  const cred = rows[0];

  // Verify the password before reporting anything about the username — but only
  // if the row exists. A missing username still runs a dummy verify so the
  // response time does not reveal whether the username is valid (timing attack).
  const hashToCheck = cred?.password_hash ?? "$invalid:$";
  const passwordOk = await verifyPassword({ hash: hashToCheck, password });
  if (!cred || !passwordOk) throw unauthorized("Invalid credentials.");

  // Banned user: same 401, never a distinct error.
  if (cred.banned && (!cred.banExpires || cred.banExpires.getTime() > Date.now())) {
    throw unauthorized("Invalid credentials.");
  }

  // The server must live on the calling node — a credential minted for a server
  // on node X must not be usable against node Y's agent.
  if (cred.node_id !== node.id) throw unauthorized("Invalid credentials.");

  // Re-check live access: the credential row may predate a permission revocation
  // or ownership transfer. `files` is the permission that gates the file manager
  // and SFTP alike.
  const user: AuthenticatedUser = {
    id: cred.user_id,
    email: "",
    role: "user",
  };
  // Fetch the real role + email so resolveServerAccess's admin check works.
  const userRows = (await sql`
    SELECT email, role FROM "user" WHERE id = ${cred.user_id}
  `) as { email: string; role: string }[];
  const u = userRows[0];
  if (u) {
    user.email = u.email;
    user.role = (u.role === "admin" ? "admin" : "user") as AuthenticatedUser["role"];
  }
  const access = await resolveServerAccess(user, cred.server_id);
  if (!access || !accessAllows(access, "files")) {
    throw unauthorized("Invalid credentials.");
  }

  // Audit the successful auth. The IP is the agent's (it is the caller), not
  // the SFTP client's — the agent does not forward the client IP, and that is
  // fine: the userId attributes the action to a person.
  await recordAudit({
    userId: cred.user_id,
    action: "server.sftp.auth",
    targetType: "server",
    targetId: cred.server_id,
    ip: clientIp(request),
    metadata: { username: cred.username, nodeId: node.id },
  });

  return json({ serverId: cred.server_id, userId: cred.user_id });
}

// --- User-facing routes -----------------------------------------------------

/**
 * `POST /api/servers/:id/sftp/credentials` — mint (or regenerate) the caller's
 * SFTP credential for this server.
 *
 * Gated on the `files` permission. The password is generated server-side and
 * returned in plaintext exactly this once; it is stored only as a hash. Calling
 * this again for an existing credential rotates the password (the ON CONFLICT
 * upsert), which is the "Regenerate password" button.
 */
export async function handleCreateSftpCredential(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const { row, plaintext } = await upsertCredential(user, id);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.sftp.credential.create",
    targetType: "server",
    targetId: id,
    metadata: { username: row.username },
  });

  return json(toResponse(row, plaintext), 201);
}

/**
 * `POST /api/servers/:id/sftp/credentials/regenerate` — explicit regenerate.
 *
 * Functionally identical to POST (the upsert rotates the password), but a
 * distinct route so the audit action and intent are clear, and so a "regenerate"
 * click does not accidentally create a credential where none existed (this
 * route 404s if the caller has no existing credential for this server).
 */
export async function handleRegenerateSftpCredential(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const existing = (await sql`
    SELECT id FROM sftp_credentials WHERE server_id = ${id} AND user_id = ${user.id}
  `) as { id: string }[];
  if (!existing[0]) throw notFound("No SFTP credential exists for this server.");

  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const rows = (await sql`
    UPDATE sftp_credentials
    SET password_hash = ${passwordHash}, updated_at = now()
    WHERE server_id = ${id} AND user_id = ${user.id}
    RETURNING id, server_id, user_id, username, password_hash, created_at, updated_at
  `) as SftpCredentialRow[];

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.sftp.credential.regenerate",
    targetType: "server",
    targetId: id,
    metadata: { username: rows[0]!.username },
  });

  return json(toResponse(rows[0]!, password));
}

/**
 * `GET /api/servers/:id/sftp/credentials` — list credentials the caller can see
 * for this server.
 *
 * Owners and admins see all credentials for the server (every user who minted
 * one); a subuser sees only their own. No passwords are ever returned.
 */
export async function handleListSftpCredentials(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user, access } = await requireServerPermission(request, id, "files");

  const ownerOnly = access.kind === "subuser";
  const rows = (await sql`
    SELECT c.id, c.server_id, c.user_id, c.username, c.password_hash, c.created_at, c.updated_at,
           u.email AS user_email
    FROM sftp_credentials c
    JOIN "user" u ON u.id = c.user_id
    WHERE c.server_id = ${id}
      ${ownerOnly ? sql`AND c.user_id = ${user.id}` : sql``}
    ORDER BY c.created_at DESC
  `) as (SftpCredentialRow & { user_email: string })[];

  return json({
    credentials: rows.map((r) => ({ ...toSummary(r), userEmail: r.user_email })),
  });
}

/**
 * `DELETE /api/servers/:id/sftp/credentials/:credentialId` — delete a credential.
 *
 * Owners/admins can delete any credential on their server; a subuser can delete
 * only their own. Deleting is the revocation path: the agent's next auth
 * callback for that username will 401.
 */
export async function handleDeleteSftpCredential(
  request: Request,
  serverId: string,
  credentialId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const credId = requireUuidParam(credentialId, "credentialId");
  const { user, access } = await requireServerPermission(request, id, "files");

  // A subuser can only delete their own credential; owners/admins can delete any.
  const scope = access.kind === "subuser" ? sql`AND user_id = ${user.id}` : sql``;
  const rows = (await sql`
    DELETE FROM sftp_credentials
    WHERE id = ${credId} AND server_id = ${id} ${scope}
    RETURNING username, user_id
  `) as { username: string; user_id: string }[];

  if (!rows[0]) throw notFound("SFTP credential not found.");

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.sftp.credential.delete",
    targetType: "server",
    targetId: id,
    metadata: { deletedUsername: rows[0].username, credentialOwner: rows[0].user_id },
  });

  return noContent();
}

/**
 * `GET /api/servers/:id/sftp/connection` — the connection details a user needs
 * to configure their SFTP client: host, port, and the username (if they have a
 * credential). The password is never returned; the user must regenerate to see
 * it once.
 *
 * The host is the node's `hostname`; the port is the agent's SFTP port (8022 by
 * default, surfaced from the node record so a future per-node override is easy).
 */
export async function handleGetSftpConnection(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const rows = (await sql`
    SELECT n.hostname, c.username
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    LEFT JOIN sftp_credentials c ON c.server_id = s.id AND c.user_id = ${user.id}
    WHERE s.id = ${id}
  `) as { hostname: string; username: string | null }[];

  const row = rows[0];
  if (!row) throw notFound("Server not found.");

  return json({
    hostname: row.hostname,
    port: 8022,
    username: row.username,
    hasCredential: row.username !== null,
  });
}
