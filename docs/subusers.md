# Subusers (per-server delegated access)

A subuser is a panel user invited to someone else's server with a chosen set
of permission flags. Subusers are the only delegation mechanism. There are
exactly two global roles (`user`, `admin`), and no subuser grant can ever
confer admin capability or reach beyond its one server.

## The permission model

Flags live in `server_subusers.permissions` (JSONB) and are normalised through
`sanitizePermissions` (`auth/rbac.ts`), which drops unknown keys, so a client
cannot invent permission names. Access resolution (`resolveServerAccess`)
follows a strict precedence: **admin > owner > subuser**. Owners and admins
implicitly hold every server-scoped permission; a subuser holds only the flags
explicitly granted, and `console` is the baseline "can look at this server at
all" grant. A subuser with only `console` sees the console and the activity
feed and nothing else.

| Flag | Gates |
| --- | --- |
| `console` | Server detail, logs, stats, live console + commands, activity feed |
| `start_stop` | Start / stop / restart / kill |
| `files` | File manager (all `/files/*` routes) and SFTP credentials |
| `database` | Database list, create, delete, password reset, **including the list** |
| `settings` | Env view/edit, ports view/add/remove, connected-servers list |
| `backups` | Backup list, status, logs, and taking a backup. **Not** restore or delete, which are owner-only (`backups.md`) |

Two design rules keep this coherent:

- **Reads gate with writes.** `GET /servers/:id/databases` requires
  `database` and `GET /servers/:id/ports` requires `settings`, the same as
  their mutations. A read-only peek at management data (DB names, host port
  mappings) is still reconnaissance a console-only subuser should not get.
- **Some actions are never delegable.** Managing subusers and deleting the
  server are owner-or-admin only (`requireServerOwner`) no matter which flags
  were granted. Otherwise a delegated grant could escalate itself. Connecting
  servers (`server-links.md`) is the same: a link attaches the *target's*
  container to a shared network, so it requires owner-or-admin on both
  servers even though its read sits under `settings`. Restoring or deleting a
  backup is the same again: `backups` is enough to *take* one, but a restore
  overwrites a world and every database in the snapshot, and a delete destroys
  the only copy of a point in time, so both sit behind `requireServerOwner`
  while the rest of the tab sits under the flag.

## Enforcement: API first, UI second

Every server-scoped route resolves permissions through `auth/middleware.ts`
(`requireServerPermission` / `requireServerOwner`) before doing anything. A
user with no relationship to the server gets 404, not 403. Confirming a
server exists is itself information. **The API is the security boundary**;
the UI checks exist so denials are visible instead of a page full of 403s.

`GET /api/servers/:id` reports the caller's access alongside the record:

```json
{ "server": { ... }, "viewer": { "kind": "subuser", "permissions": { "console": true } } }
```

The frontend maps sections to permissions in `lib/permissions.ts` (with
`SECTION_PERMISSIONS`, `viewerAllows`, `sectionAllowed`, all unit-tested
in `permissions.test.ts`):

- `components/server/server-tabs.tsx` lists only sections the viewer may use
  (Subusers tab: owner/admin only; Ports and Settings: `settings`; Database:
  `database`; Files: `files`; Console + Activity: any access).
- The server layout (`app/(panel)/servers/[id]/layout.tsx`) guards the
  section routes themselves. Every section has its own URL, so navigating
  straight to `/servers/:id/files` without the grant renders a "no access"
  state rather than mounting the page.
- `power-controls.tsx` renders nothing without `start_stop`.

A missing `viewer` (only possible for list views or a stale payload) fails
*open* in the UI. The backend still rejects every call, so the failure mode
is visible 403s, not a security hole.

## Managing subusers

All of `routes/subusers.ts` is owner-or-admin only: list, invite (an existing
account, matched by email), update flags, revoke. Every action is audited
(`subuser.invite` / `subuser.update` / `subuser.remove`) with the invitee's
email and granted permission set in the metadata. The email is denormalized
into the record at write time, the same posture as SFTP's `deletedUsername`,
so audit history still names who was invited after the grant is revoked or the
account deleted, when a read-time join could no longer resolve the user id.

Revocation is immediate for panel routes (the row is the source of truth) and
immediate for delegated protocol access too: the [direct console](./direct-console.md)
token dies with its session, and the [SFTP auth callback](./sftp.md)
re-checks `files` access on every login, so a removed subuser cannot keep an
open door.
