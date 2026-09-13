# API keys (programmatic panel access + admin oversight)

Panel accounts can mint API keys that authenticate the same `/api/*` surface
the browser uses, including every admin action, when the key's owner is an
admin. Keys are Better Auth's `apiKey` plugin (`apikey` table, created by
`bun run auth:migrate`); the panel adds three things on top: the
`Authorization: Bearer` header convention, **per-resource scopes**, and an
admin oversight surface (`/admin/api-keys`) with fleet-wide listing,
enable/disable, re-scoping, and revocation.

## The model: a key is its owner, optionally narrowed

Authority comes from the owner. With `enableSessionForAPIKeys: true`
(`auth/betterAuth.ts`), the plugin's before-hook validates the key and
synthesizes the *owner's* session for every `auth.api.*` call, and
`getAuthenticatedUser` (`auth/middleware.ts`) is the single chokepoint every
panel route authenticates through. Consequences:

- A user's key can do at most what the signed-in user can: server power
  actions, files, their own settings, and nothing more.
- An admin's key can do what the signed-in admin can, including every
  `/api/admin/*` route. `requireAdmin` re-checks the role from the user row on
  every request, so a key can never escalate; and demoting or banning the
  owner takes effect on the key's next request, because the synthesized
  session re-reads the real `role`/`banned` columns (`middleware.ts` does the
  ban check explicitly).

On top of that, a key may carry **scopes**, which narrow it further. A key is
therefore the *intersection* of two things, never the union:

```
what the key may do  =  what its owner may do   ∩   what the key is scoped to
                        (role, ownership,           (this document, below)
                         subuser grants)
```

Granting `admin_users` to a normal user's key grants nothing. Scopes cannot add
authority; only remove it.

## Scopes

A key is either **unrestricted** or **scoped**.

- *Unrestricted* is the original behaviour: the key is simply its owner. Every
  key minted before this feature existed is unrestricted, and stays so — the
  `apikey.permissions` column is NULL for them, and NULL means "no
  restriction".
- *Scoped* means the key carries an explicit grant: a set of resources, each
  with some subset of the two actions `read` and `write`.

### The two actions

Every resource has exactly the same two actions, so the three useful grants
fall out of a pair of checkboxes rather than needing a third control:

| Grant | Meaning |
| --- | --- |
| `["read"]` | GET/HEAD on that resource |
| `["write"]` | everything else (POST/PUT/PATCH/DELETE) |
| `["read","write"]` | both |

**`write` does not imply `read`.** That is deliberate, not an oversight: it is
what makes a write-only key expressible — a webhook that issues restarts, or a
CI job that uploads a file, with no ability to enumerate anything it was not
told about. If a script needs to read before it writes, tick both.

### The resources

Defined once in `lib/api-key-scopes.ts`, which the browser and the control
plane both import, so the picker can never offer a resource the enforcer has
never heard of.

| Resource | Covers |
| --- | --- |
| `servers` | server list/detail, power actions, env, ports, links, activity, stats, the blueprint catalogue |
| `files` | the file manager |
| `console` | logs, the console stream, console sessions, commands, the AI helper |
| `backups` | a server's own snapshots |
| `databases` | server databases and the database explorer |
| `schedules` | per-server task schedules and runs |
| `subusers` | per-server delegated access |
| `sftp` | per-server SFTP credentials |
| `plugins` | blueprint-declared plugins/mods |
| `account` | the owner's own account, sessions, password, 2FA |
| `api_keys` | minting and revoking keys (see *Attenuation*) |
| `admin_users` | the user directory, invites, roles, bans |
| `admin_servers` | fleet-wide server administration and migrations |
| `admin_nodes` | nodes, health, port pools, the per-node database |
| `admin_blueprints` | the blueprint catalogue and imports |
| `admin_settings` | panel settings, branding, mail, AI, legal, the setup wizard |
| `admin_audit` | audit logs, suspicious activity, scans |
| `admin_backups` | backup destinations, storage accounting, node database backups |

The partition follows the panel's own navigation rather than its route table,
because an operator scoping a key thinks "can this script touch files?", not
"can it call `PUT /servers/:id/files/content`".

### Where scopes are enforced

In **one place**: a gate in front of the dispatcher
(`app/api/[...path]/route.ts` → `middleware.enforceApiKeyScope`), keyed on the
same two things the dispatcher itself routes on — the path and the method. The
path→resource map is `auth/routeScopes.ts`.

This is the answer to the objection that used to live in this document (*"every
guard would then need a second permission-resolution path to stay honest"*).
The gate does not participate in authorization at all; it only *subtracts*.
Every handler's own `requireAuth` / `requireAdmin` /
`requireServerPermission` still runs behind it, unchanged and unaware that
scopes exist. There is no second path to keep honest, because there is no
second path.

Three properties make that safe:

- **It only narrows.** A gate that can only reject cannot grant. The worst a
  bug in the map can do is refuse a request that should have been allowed.
- **It fails closed.** A path `routeScopes.ts` does not recognise resolves to
  `null`, and `null` denies. Adding a route without mapping it makes it
  unreachable *by scoped keys only* — cookie sessions and unrestricted keys are
  unaffected. A new endpoint is never silently in scope for a key that predates
  it. **This is the thing to remember when adding routes:** add the mapping, or
  scoped keys get a 403 they should not.
- **It covers Better Auth's surface too.** `/api/auth/*` is handed straight to
  `auth.handler`, and it carries two sets of endpoints that would otherwise be
  an unscoped route around the whole scheme: the key-management endpoints
  (`auth/api-key/*` → `api_keys`) and the admin plugin's own ban/set-role
  endpoints (`auth/admin/*` → `admin_users`). Both are gated.

Non-obvious classifications, all in `routeScopes.ts`:

- The panel uses POST for several things that only read (`servers/stats-batch`,
  node probes, schedule/backup previews, migration preflight). Those are pinned
  to `read`, because classifying them by method would mean a read-only key could
  not read the dashboard.
- `POST /servers/:id/console/session` is a **write**, not a read. It hands back
  a capability token for a bidirectional terminal; that is the authority to send
  commands, not the authority to tail a log.
- The AI helper is a console **read**: it reads the server's own logs and asks a
  question about them, and changes nothing.
- `admin/settings/test-email` is a **write** — it sends something — while the AI
  provider probes next to it are reads.
- `internal/*` (the agent callbacks for the direct console and SFTP) maps to
  nothing, so no scope can reach it. Those routes authenticate their callers
  their own way (`docs/direct-console.md`, `docs/sftp.md`); a panel API key is
  not the credential for them.

### Attenuation: why `api_keys` is grantable

`api_keys:write` would be a one-request escalation if a scoped key could mint an
unrestricted successor, and every other scope would then be decorative. So a
scoped key may only create or re-scope a key **no broader than itself**
(`middleware.assertScopeSubset`, enforced on the plugin's
`/api/auth/api-key/create` and `/update` via a cloned body, and on
`POST /api/admin/api-keys`). An unrestricted key or a cookie session passes
unconditionally: both already hold everything the new key could be given.

Being an admin does not lift this. Admin is authority over the panel; it is not
permission for a *credential* to exceed itself.

### NULL is not `{}`

Three states, and conflating any two of them is a security bug:

| Stored `permissions` | Means |
| --- | --- |
| `NULL` | unrestricted — the key is its owner |
| `"{}"` | scoped to nothing — the key can reach nothing |
| `'{"files":["read"]}'` | scoped to that grant |

`parseApiKeyScopes` degrades in the safe direction throughout: an unreadable
grant (corrupt JSON, wrong type, only resource names this build does not know)
parses to `{}`, never to `null`. A damaged restriction must not read as "no
restriction" — that is precisely the restriction someone asked for. Only an
absent column produces `null`.

The API refuses to *store* `{}` from a request, because a key that can do
nothing is almost certainly a caller mistake; disabling the key is how you
express that. But `{}` is still handled correctly if it ever appears.

## Authentication: two header conventions

Send the key on any `/api/*` request (except `/api/auth/*`, which the
dispatcher routes to Better Auth directly):

```
x-api-key: <key>
# or, normalized by the panel:
Authorization: Bearer <key>
```

The plugin is configured to read `x-api-key` only. Better Auth's own
`bearer()` plugin translates Bearer *session tokens*, not keys, so
`withApiKeyHeaderAlias` (`auth/middleware.ts`) rewrites a Bearer header onto
`x-api-key` before the session is resolved. Only the headers handed to Better
Auth are rewritten; the original request is untouched so the audit trail sees
what the client actually sent. Cookie-session requests never carry either
header, and a request bearing an invalid key is rejected 401 by the plugin
before any handler runs.

## Management surfaces

**Self-service (owner)** is `/settings` → *API keys*, backed by the plugin's
own endpoints (`/api/auth/api-key/list|create|delete`). A key lists, mints,
and revokes only the caller's own keys. The create form carries the scope
picker, and `permissions` is **omitted entirely** for an unrestricted key —
sending `{}` would ask for a key that can reach nothing (see *NULL is not
`{}`*).

**Admin oversight** lives at `/admin/api-keys`, backed by panel routes (the
plugin has no cross-user surface, so these query the `apikey` table directly
like the other admin list routes):

| Route | Purpose |
| --- | --- |
| `GET /api/admin/api-keys?q=` | every key with owner context (email, role), scopes, status, usage counters |
| `POST /api/admin/api-keys` | mint a key **for the calling admin**, optionally scoped (`permissions`); full key returned once |
| `PATCH /api/admin/api-keys/:id` | enable/disable (`enabled`) and/or re-scope (`permissions`) any key. At least one field is required |
| `DELETE /api/admin/api-keys/:id` | revoke any key (hard delete, matching the plugin's semantics) |

There are now three compromise responses, in increasing severity:

- **Re-scope** (`permissions`) cuts a key down without rotating it. The secret,
  prefix and counters are untouched, so an over-broad key stops being
  over-broad while the script holding it keeps working with less authority.
  Sending `permissions: null` is the widening direction — back to unrestricted —
  which is why the audit entry records the scope on *both* sides.
- **Disable** keeps the row (prefix, counters, last-used) for forensics and
  stops the key working.
- **Revoke** removes it.

Creation is delegated to `auth.api.createApiKey` so hashing/prefixing stay
library-owned; the session fixes the owner, so an admin cannot mint a key into
someone else's account from this route. Re-scoping writes the `permissions`
column directly (`services/apiKeys.setApiKeyScopes`), because the plugin's own
update endpoint is session-scoped to the caller's own keys and cross-user
oversight is the reason this surface exists.

The admin service (`services/apiKeys.ts`) never selects the hashed `key`
column; the pure row→view mapping lives in `services/apiKeysView.ts` (split
so it is testable without `db/client.ts`'s `server-only` import, the same
arrangement as `dbExplorerSql.ts`).

## Audit trail

- Key lifecycle actions are audited: `apikey.create` / `apikey.update` /
  `apikey.delete` with target type `api_key`, recording the key's name and
  display prefix, never key material. Every entry also records the key's
  **scopes** in the `describeScopes` phrasing the UI uses (`Full access`,
  `No access`, or `Servers (read), Files (read/write)`), and an `apikey.update`
  that moved the scope carries `scopesBefore` as well: "an admin key was
  minted" and "an admin key scoped to `backups:read` was minted" are very
  different entries to read back six months later.
- **Every** audited action records *how* it was authenticated:
  `recordAuditFromRequest` (`services/auditLog.ts`) stamps
  `viaApiKey: true` + `viaKeyPrefix` (first 8 chars of the credential used)
  onto the metadata when the request carried either header convention. The
  audit UI renders this as a "via API key" suffix, so "the admin clicked
  this" and "a script holding the admin's key did" are distinguishable after
  the fact. (`viaKeyPrefix` names the *actor's* key; a handler-supplied
  `keyPrefix` names the key being *acted on*, often a different key.)
  Since panel UI requests never send those headers and invalid keys are
  rejected before handlers run, header presence at audit time means the key
  authenticated.

## Security notes

- Keys are stored hashed (`apikey.key`, base64url SHA-256); the full key is
  shown exactly once at creation. Only the short display prefix is
  recoverable afterwards.
- The plugin rejects any presented credential shorter than 64 characters
  (`defaultKeyLength`) before it ever queries the database. Panel-generated
  keys are comfortably above that, but anything provisioning keys by hand
  must match it.
- Banning a user does not by itself revoke their keys, but the explicit ban
  check in `getAuthenticatedUser` rejects key-authenticated requests from
  banned owners immediately. For certainty (or on key compromise), disable or
  revoke the key from `/admin/api-keys`.
- `apikey.expiresAt` / rate-limit fields exist in the table; the panel UI
  creates non-expiring, unlimited keys. Expiry can be passed to the plugin
  API when minting programmatically.
- **Scope changes are not instant.** The panel caches a resolved session — and,
  for key requests, the key's scopes alongside it — for the few seconds
  `sessionCache.ts` documents. Narrowing or revoking a key takes effect on the
  next cache miss, not the next request. That window already applied to
  revocation before scopes existed; it is unchanged, not newly introduced. For
  certainty on a compromised key, revoke it and treat the secret as burned.
- Resolving a key's scopes costs **one extra query**, by primary key, and only
  on a key-authenticated cache miss. Cookie sessions pay nothing. The gate
  itself is free: it resolves the same cached session the handler behind it is
  about to resolve.
- A scoped key that presents a credential the panel can authenticate but whose
  `apikey` row it cannot then read is treated as scoped to **nothing**, not as
  unrestricted. Failing to learn a key's scopes must deny.
- API-key requests are not cookie-bearing, so the CSRF considerations of the
  session-cookie surface do not apply; the keys themselves are the secret and
  should be treated like passwords.

## Related docs

- `docs/subusers.md`: the per-server permission model a *user's* key
  inherits when it acts on a server the owner has delegated access to. Note
  that the two systems are orthogonal and both apply: a subuser's key scoped to
  `files:write` can write files on the servers where the owner granted them the
  `files` flag, and nowhere else.
- `docs/sftp.md`: the other long-lived credential type (per-(user,server)
  SFTP passwords), and its panel-callback auth.
