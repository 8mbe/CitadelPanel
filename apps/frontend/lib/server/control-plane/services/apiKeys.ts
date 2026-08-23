/**
 * API-key oversight queries for the admin panel (see docs/api-keys.md).
 *
 * Keys live in Better Auth's `apikey` table (created by `auth:migrate`): only
 * the hashed `key` column is secret, and it is never selected here. Owners
 * manage their own keys through the plugin's `/api/auth/api-key/*` endpoints;
 * this module is the *admin* surface for fleet-wide visibility and revocation,
 * which the plugin deliberately has no cross-user equivalent for, so it reads
 * the table directly like the other admin list routes.
 */

import { sql } from "../db/client";
import {
  toApiKeyAdminView,
  type ApiKeyAdminView,
  type ApiKeyRow,
} from "./apiKeysView";

export type { ApiKeyAdminView, ApiKeyRow } from "./apiKeysView";

/** The shared SELECT: every display field, never the hashed `key` column. */
const API_KEY_COLUMNS = sql`
  SELECT
    k.id, k.name, k.prefix, k.start, k.enabled,
    k."requestCount" AS request_count,
    k."lastRequest" AS last_request,
    k."expiresAt" AS expires_at,
    k."createdAt" AS created_at,
    u.id AS owner_id, u.email AS owner_email, u.name AS owner_name, u.role AS owner_role
  FROM apikey k
  LEFT JOIN "user" u ON u.id = k."referenceId"
`;

/** List every key on the panel, optionally filtered by owner email/name/key name. */
export async function listApiKeys(options: {
  q?: string;
  now?: Date;
}): Promise<ApiKeyAdminView[]> {
  const q = options.q?.trim() ?? "";
  const pattern = q.length > 0 ? `%${q}%` : null;

  const rows = (await sql`
    ${API_KEY_COLUMNS}
    ${pattern !== null
      ? sql`WHERE u.email ILIKE ${pattern} OR u.name ILIKE ${pattern} OR k.name ILIKE ${pattern}`
      : sql``}
    ORDER BY k."createdAt" DESC
  `) as ApiKeyRow[];

  const now = options.now ?? new Date();
  return rows.map((row) => toApiKeyAdminView(row, now));
}

/** Enable or disable any user's key. Returns the updated view, or null when no such key. */
export async function setApiKeyEnabled(
  keyId: string,
  enabled: boolean,
  options: { now?: Date } = {},
): Promise<ApiKeyAdminView | null> {
  const rows = (await sql`
    UPDATE apikey SET enabled = ${enabled}, "updatedAt" = now()
    WHERE id = ${keyId}
    RETURNING id, name, prefix, start, enabled,
      "requestCount" AS request_count,
      "lastRequest" AS last_request,
      "expiresAt" AS expires_at,
      "createdAt" AS created_at
  `) as Omit<ApiKeyRow, "owner_id" | "owner_email" | "owner_name" | "owner_role">[];

  const row = rows[0];
  if (!row) return null;

  // Re-join the owner so the response (and the audit entry) can name the key's
  // owner. The UPDATE ... RETURNING above cannot carry the join. The owner may
  // be gone if the account was deleted; the key is still administrable.
  const ownerRows = (await sql`
    SELECT u.id AS owner_id, u.email AS owner_email, u.name AS owner_name, u.role AS owner_role
    FROM apikey k LEFT JOIN "user" u ON u.id = k."referenceId"
    WHERE k.id = ${keyId}
  `) as Pick<ApiKeyRow, "owner_id" | "owner_email" | "owner_name" | "owner_role">[];
  const owner = ownerRows[0];

  return toApiKeyAdminView(
    {
      ...row,
      owner_id: owner?.owner_id ?? null,
      owner_email: owner?.owner_email ?? null,
      owner_name: owner?.owner_name ?? null,
      owner_role: owner?.owner_role ?? null,
    },
    options.now ?? new Date(),
  );
}

/** Revoke (hard-delete, matching the plugin's own delete semantics) any user's key. */
export async function deleteApiKey(
  keyId: string,
  options: { now?: Date } = {},
): Promise<ApiKeyAdminView | null> {
  // Read first so the audit entry and response can describe what was removed;
  // DELETE ... RETURNING cannot join the owner either.
  const existing = await listApiKeyById(keyId, options.now ?? new Date());
  if (!existing) return null;

  await sql`DELETE FROM apikey WHERE id = ${keyId}`;
  return existing;
}

/** Fetch one key's view by id, or null. */
export async function listApiKeyById(
  keyId: string,
  now: Date = new Date(),
): Promise<ApiKeyAdminView | null> {
  const rows = (await sql`
    ${API_KEY_COLUMNS}
    WHERE k.id = ${keyId}
    LIMIT 1
  `) as ApiKeyRow[];

  return rows[0] ? toApiKeyAdminView(rows[0], now) : null;
}
