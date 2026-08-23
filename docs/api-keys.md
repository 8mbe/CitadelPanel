# API keys (programmatic panel access + admin oversight)

Panel accounts can mint API keys that authenticate the same `/api/*` surface
the browser uses, including every admin action, when the key's owner is an
admin. Keys are Better Auth's `apiKey` plugin (`apikey` table, created by
`bun run auth:migrate`); the panel adds two things on top: the
`Authorization: Bearer` header convention, and an admin oversight surface
(`/admin/api-keys`) with fleet-wide listing, enable/disable, and revocation.

## The model: a key is its owner

A key carries **no permissions of its own**. With
`enableSessionForAPIKeys: true` (`auth/betterAuth.ts`), the plugin's
before-hook validates the key and synthesizes the *owner's* session for every
`auth.api.*` call, and `getAuthenticatedUser` (`auth/middleware.ts`) is the
single chokepoint every panel route authenticates through. Consequences:

- A user's key can do exactly what the signed-in user can: server power
  actions, files, their own settings, and nothing more.
- An admin's key can do what the signed-in admin can, including every
  `/api/admin/*` route. `requireAdmin` re-checks the role from the user row on
  every request, so a key can never escalate; and demoting or banning the
  owner takes effect on the key's next request, because the synthesized
  session re-reads the real `role`/`banned` columns (`middleware.ts` does the
  ban check explicitly).
- There are deliberately **no scoped/finer-grained key permissions**. If a
  script needs less than full owner power, give it its own (subuser or
  non-admin) account's key. The plugin supports a `permissions` field; the
  panel does not expose it, because every guard would then need a second
  permission-resolution path to stay honest.

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
and revokes only the caller's own keys.

**Admin oversight** lives at `/admin/api-keys`, backed by panel routes (the
plugin has no cross-user surface, so these query the `apikey` table directly
like the other admin list routes):

| Route | Purpose |
| --- | --- |
| `GET /api/admin/api-keys?q=` | every key with owner context (email, role), status, usage counters |
| `POST /api/admin/api-keys` | mint a key **for the calling admin** (full key returned once) |
| `PATCH /api/admin/api-keys/:id` | enable/disable any key, which is reversible and preserves the row and counters |
| `DELETE /api/admin/api-keys/:id` | revoke any key (hard delete, matching the plugin's semantics) |

Disable-vs-revoke is the compromise-response pair: disabling keeps the row
(prefix, counters, last-used) for forensics; revoking removes it. Creation is
delegated to `auth.api.createApiKey` so hashing/prefixing stay library-owned;
the session fixes the owner, so an admin cannot mint a key into someone
else's account from this route.

The admin service (`services/apiKeys.ts`) never selects the hashed `key`
column; the pure row→view mapping lives in `services/apiKeysView.ts` (split
so it is testable without `db/client.ts`'s `server-only` import, the same
arrangement as `dbExplorerSql.ts`).

## Audit trail

- Key lifecycle actions are audited: `apikey.create` / `apikey.update` /
  `apikey.delete` with target type `api_key`, recording the key's name and
  display prefix, never key material.
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
- API-key requests are not cookie-bearing, so the CSRF considerations of the
  session-cookie surface do not apply; the keys themselves are the secret and
  should be treated like passwords.

## Related docs

- `docs/subusers.md`: the per-server permission model a *user's* key
  inherits when it acts on a server the owner has delegated access to.
- `docs/sftp.md`: the other long-lived credential type (per-(user,server)
  SFTP passwords), and its panel-callback auth.
