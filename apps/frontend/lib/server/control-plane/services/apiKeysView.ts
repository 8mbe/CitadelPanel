/**
 * Pure row→view mapping for the admin API-key surface.
 *
 * Split from `apiKeys.ts` (which owns the queries) so the mapping is testable
 * without dragging in `db/client.ts`, the same arrangement as
 * `dbExplorerSql.ts` vs `dbExplorer.ts`. Nothing here touches the database or
 * any secret: the hashed `key` column is never part of `ApiKeyRow`.
 */

/** One raw `apikey` row joined with its owner, exactly as the queries select it. */
export interface ApiKeyRow {
  id: string;
  name: string | null;
  /** The display prefix the plugin stores (never the full key material). */
  prefix: string | null;
  start: string | null;
  enabled: boolean | null;
  request_count: number | null;
  last_request: Date | string | null;
  expires_at: Date | string | null;
  created_at: Date | string | null;
  owner_id: string | null;
  owner_email: string | null;
  owner_name: string | null;
  owner_role: string | null;
}

/** The camelCase, secret-free shape the admin list endpoint returns. */
export interface ApiKeyAdminView {
  id: string;
  name: string | null;
  /**
   * Display prefix. Panel-configured keys carry an explicit `prefix`; keys the
   * plugin minted without one store `start` (first ~6 chars) instead. Fall
   * back to it so every row shows something.
   */
  prefix: string | null;
  enabled: boolean;
  /** "expired" wins over "disabled": an expired key is dead either way. */
  status: "active" | "disabled" | "expired";
  requestCount: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  ownerRole: "admin" | "user";
}

/**
 * Map a joined row into the admin view. `now` is injected so the expiry
 * computation is deterministic and testable.
 *
 * Dates arrive as `Date` objects over the panel's Postgres driver but as ISO
 * strings in some deployments (pooler serialization); both are accepted, and
 * an unparseable value reads as null rather than throwing mid-listing.
 */
export function toApiKeyAdminView(row: ApiKeyRow, now: Date): ApiKeyAdminView {
  const asMs = (value: Date | string | null): number | null => {
    if (value === null) return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  const asIso = (value: Date | string | null): string | null => {
    const ms = asMs(value);
    return ms === null ? null : new Date(ms).toISOString();
  };

  const expiresAtMs = asMs(row.expires_at);
  const expired = expiresAtMs !== null && expiresAtMs <= now.getTime();

  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix ?? row.start ?? null,
    enabled: row.enabled !== false,
    status: expired ? "expired" : row.enabled === false ? "disabled" : "active",
    requestCount: row.request_count ?? 0,
    lastUsedAt: asIso(row.last_request),
    expiresAt: asIso(row.expires_at),
    createdAt: asIso(row.created_at),
    ownerId: row.owner_id ?? "",
    ownerEmail: row.owner_email,
    ownerName: row.owner_name,
    ownerRole: row.owner_role === "admin" ? "admin" : "user",
  };
}
