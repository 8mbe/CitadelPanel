/**
 * The API-key scope vocabulary (see docs/api-keys.md).
 *
 * A key may be *unrestricted* (scopes `null`) — the original behaviour, where
 * the key is simply its owner — or *scoped*, in which case it carries an
 * explicit grant per resource. Every resource has exactly two actions, `read`
 * and `write`, so a grant is one of three useful shapes: read, write, or both.
 *
 * This module is deliberately pure and free of server imports: the browser
 * needs the same resource list and labels to render the scope picker, and the
 * control plane needs the same `scopesAllow` decision to enforce it. One
 * vocabulary, two consumers, no chance of the picker offering a resource the
 * enforcer has never heard of.
 *
 * Scopes are persisted in Better Auth's `apikey.permissions` column, whose
 * shape (`Record<string, string[]>`) is exactly this type. Nothing here reads
 * or writes the database.
 */

/** The two actions every resource has. `write` does NOT imply `read`. */
export const SCOPE_ACTIONS = ["read", "write"] as const;
export type ScopeAction = (typeof SCOPE_ACTIONS)[number];

/** One resource a key can be scoped to. */
export interface ApiKeyResourceInfo {
  id: ApiKeyResource;
  label: string;
  /** What the two actions cover, phrased for the scope picker. */
  description: string;
  /**
   * Whether the resource only ever resolves to `/api/admin/*` routes. Purely a
   * UI grouping hint: authority still comes from the owner's role, which
   * `requireAdmin` re-checks per request. Granting `admin_users` to a
   * non-admin's key grants nothing.
   */
  admin: boolean;
}

/**
 * Every resource the panel's API surface is partitioned into.
 *
 * The partition follows the panel's own navigation rather than its route
 * table, because an operator scoping a key thinks in terms of "can this script
 * touch files?", not "can it call PUT /servers/:id/files/content". The
 * route→resource mapping lives in `auth/routeScopes.ts` and is what actually
 * decides; this list is the vocabulary it maps onto.
 */
export const API_KEY_RESOURCES: readonly ApiKeyResourceInfo[] = [
  {
    id: "servers",
    label: "Servers",
    description:
      "Server list and detail, power actions, environment, ports, links and activity.",
    admin: false,
  },
  {
    id: "files",
    label: "Files",
    description: "The file manager: listing, reading, writing, uploads and downloads.",
    admin: false,
  },
  {
    id: "console",
    label: "Console",
    description: "Log output, console sessions and sending commands to a server.",
    admin: false,
  },
  {
    id: "backups",
    label: "Backups",
    description: "A server's own snapshots: listing, creating, restoring and deleting.",
    admin: false,
  },
  {
    id: "databases",
    label: "Databases",
    description: "Server databases and the in-panel database explorer.",
    admin: false,
  },
  {
    id: "schedules",
    label: "Schedules",
    description: "Per-server task schedules and their run history.",
    admin: false,
  },
  {
    id: "subusers",
    label: "Subusers",
    description: "Delegated per-server access: who holds it and which flags.",
    admin: false,
  },
  {
    id: "sftp",
    label: "SFTP",
    description: "Per-server SFTP credentials and connection details.",
    admin: false,
  },
  {
    id: "plugins",
    label: "Plugins",
    description: "Blueprint-declared plugins and mods on a server.",
    admin: false,
  },
  {
    id: "account",
    label: "Account",
    description:
      "The key owner's own account: profile, sessions, password and two-factor.",
    admin: false,
  },
  {
    id: "api_keys",
    label: "API keys",
    description:
      "Minting and revoking API keys. A key holding this can only create keys no broader than itself.",
    admin: false,
  },
  {
    id: "admin_users",
    label: "Admin · users",
    description: "The user directory, invites, roles and bans.",
    admin: true,
  },
  {
    id: "admin_servers",
    label: "Admin · servers",
    description:
      "Fleet-wide server administration: resources, suspension and migrations.",
    admin: true,
  },
  {
    id: "admin_nodes",
    label: "Admin · nodes",
    description: "Node registration, health, port pools and the per-node database.",
    admin: true,
  },
  {
    id: "admin_blueprints",
    label: "Admin · blueprints",
    description: "The blueprint catalogue and imports.",
    admin: true,
  },
  {
    id: "admin_settings",
    label: "Admin · settings",
    description: "Panel settings, branding, mail, AI, legal pages and the setup wizard.",
    admin: true,
  },
  {
    id: "admin_audit",
    label: "Admin · audit",
    description: "Audit logs, suspicious activity and scans.",
    admin: true,
  },
  {
    id: "admin_backups",
    label: "Admin · backups",
    description: "Backup destinations, storage accounting and per-node database backups.",
    admin: true,
  },
] as const;

export type ApiKeyResource =
  | "servers"
  | "files"
  | "console"
  | "backups"
  | "databases"
  | "schedules"
  | "subusers"
  | "sftp"
  | "plugins"
  | "account"
  | "api_keys"
  | "admin_users"
  | "admin_servers"
  | "admin_nodes"
  | "admin_blueprints"
  | "admin_settings"
  | "admin_audit"
  | "admin_backups";

const RESOURCE_IDS: ReadonlySet<string> = new Set(
  API_KEY_RESOURCES.map((resource) => resource.id),
);

export function isApiKeyResource(value: unknown): value is ApiKeyResource {
  return typeof value === "string" && RESOURCE_IDS.has(value);
}

export function isScopeAction(value: unknown): value is ScopeAction {
  return value === "read" || value === "write";
}

/**
 * A scoped key's grant. A resource absent from the record is not granted at
 * all; present with an empty array means the same thing and is normalised away
 * by {@link sanitizeApiKeyScopes}.
 */
export type ApiKeyScopes = Partial<Record<ApiKeyResource, ScopeAction[]>>;

/**
 * Normalise an untrusted permissions object into known resources and actions.
 *
 * Unknown resource names and unknown actions are dropped rather than stored,
 * so a client cannot invent a scope the enforcer will never check — the same
 * rule `rbac.sanitizePermissions` applies to subuser flags. Actions are
 * de-duplicated and ordered so two equal grants serialise identically, which
 * is what makes the subset check and the audit diff readable.
 */
export function sanitizeApiKeyScopes(input: unknown): ApiKeyScopes {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};

  const result: ApiKeyScopes = {};
  for (const [resource, actions] of Object.entries(input as Record<string, unknown>)) {
    if (!isApiKeyResource(resource)) continue;
    if (!Array.isArray(actions)) continue;

    const granted = SCOPE_ACTIONS.filter((action) => actions.includes(action));
    if (granted.length > 0) result[resource] = granted;
  }
  return result;
}

/**
 * Read the stored `apikey.permissions` value.
 *
 * `null` is a meaningful answer, not an error: an absent column is how an
 * *unrestricted* key is represented, which is what every key minted before
 * scopes existed still is. That is the only input that produces it.
 *
 * Everything else degrades toward *less* access, never more. A grant that is
 * present but unreadable — corrupt JSON, the wrong type, a resource name this
 * build has never heard of — parses to an empty grant, i.e. a key that can
 * reach nothing. A damaged scope must not read as "no restrictions", because
 * that is precisely the restriction someone asked for.
 */
export function parseApiKeyScopes(value: unknown): ApiKeyScopes | null {
  if (value === null || value === undefined) return null;

  let parsed: unknown = value;
  if (typeof value === "string") {
    // An empty column is an unset one, not an empty grant.
    if (value.trim() === "") return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }

  return sanitizeApiKeyScopes(parsed);
}

/** Whether a scoped key may perform `action` on `resource`. */
export function scopesAllow(
  scopes: ApiKeyScopes | null,
  resource: ApiKeyResource,
  action: ScopeAction,
): boolean {
  // An unrestricted key is its owner, exactly as before scopes existed.
  if (scopes === null) return true;
  return scopes[resource]?.includes(action) === true;
}

/**
 * Whether `child` grants nothing `parent` does not.
 *
 * This is the attenuation rule for minting keys: a scoped key may create a key
 * no broader than itself, so `api_keys` write is a way to delegate a subset of
 * your access, never a way to climb out of your own scope. An unrestricted
 * parent permits anything; an unrestricted *child* is only permitted under an
 * unrestricted parent, which is why the null child is checked first.
 */
export function isScopeSubset(
  child: ApiKeyScopes | null,
  parent: ApiKeyScopes | null,
): boolean {
  if (parent === null) return true;
  if (child === null) return false;

  return Object.entries(child).every(([resource, actions]) =>
    (actions ?? []).every((action) =>
      scopesAllow(parent, resource as ApiKeyResource, action),
    ),
  );
}

/** Count of granted actions, for the "3 of 18 resources" line in the UI. */
export function countScopedResources(scopes: ApiKeyScopes | null): number {
  return scopes === null ? API_KEY_RESOURCES.length : Object.keys(scopes).length;
}

/**
 * A short human summary of a grant, e.g. `Servers (read), Files (read/write)`.
 * Used in the admin table and in audit metadata, so the same phrasing shows up
 * wherever a scope is reported.
 */
export function describeScopes(scopes: ApiKeyScopes | null): string {
  if (scopes === null) return "Full access";

  const parts = API_KEY_RESOURCES.flatMap((resource) => {
    const actions = scopes[resource.id];
    if (!actions || actions.length === 0) return [];
    return [`${resource.label} (${actions.join("/")})`];
  });

  return parts.length > 0 ? parts.join(", ") : "No access";
}
