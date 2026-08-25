# User accounts: invites and deletion (the admin side)

Two admin-side halves of an account's life: creating one for somebody
("Add user"), and removing one for good. Self-service sign-up is
`docs/site-settings.md`; per-server delegated access, which involves no account
at all, is `docs/subusers.md`.

## Invites (admin-created accounts)

An admin can create an account for someone else from `/admin/users` ("Add
user"): name, email, and an optional password. The account exists immediately,
the person is emailed that it exists (when mail is configured), and the
password is handed back to the admin to relay when the panel generated it.

The panel needs this because registration is a setting, not a constant. An
invite-only install (`docs/site-settings.md`) closes `POST /sign-up/email`
behind the registration gate, and "just sign up" is exactly what that gate
refuses. Without this route, an invite-only panel has no way to onboard anyone
after the first admin.

### The flow

1. `POST /api/admin/users` (`routes/admin.ts`, `handleAdminCreateUser`), gated
   on `requireAdmin`.
2. Creation is delegated to Better Auth's admin plugin, `auth.api.createUser`,
   which hashes the password and links the `credential` account. Nothing here
   inserts a user row by hand, for the same reason the setup wizard delegates
   to `signUpEmail`: a hand-built account would be the one account in the
   system whose credentials were handled differently.
3. The account is marked `emailVerified`.
4. An invitation email is sent (best effort), and its outcome is reported.
5. The action is audited as `user.create`, with `passwordGenerated` and
   `invitationEmailSent` in the metadata.

The response carries the generated password (or `null`) and `emailSent`. The
dialog (`components/admin/add-user-dialog.tsx`) shows the password exactly once
and states whether the person was actually emailed, because "they have been
told" and "mail is off, pass this on yourself" lead the admin to do different
things next. When the admin supplied the password *and* the email went out,
there is nothing to reveal and the dialog just closes.

### Why it deliberately bypasses the registration gate

The gate exists to require an invitation. An admin typing someone's details
**is** that invitation, so the invite route is a separate endpoint under
`requireAdmin` rather than a special case inside the gate. The gate itself is
untouched: anything that can POST to `/sign-up/email` still hits it. Better
Auth's `before` hook only inspects `/sign-up/email`, and this route goes
through `/admin/create-user`, so no exemption logic was needed.

### Why the password is optional

An admin inviting a customer usually has no secure channel to invent a password
on. Leaving the field blank generates one with `generateStrongPassword(24)`
(`lib/crypto.ts`, the same generator used for provisioned database users) and
returns it once; it is stored hashed and never retrievable again.

Two non-obvious consequences:

- **The route enforces the length floor itself.** `auth.api.createUser` hashes
  whatever password it is given without consulting
  `emailAndPassword.minPasswordLength`, so a supplied password is checked
  against `MIN_PASSWORD_LENGTH` (exported from `auth/betterAuth.ts`, which is
  also where the Better Auth option reads it) before the call. Skipping that
  check would make this the one path in the panel that accepts a 3-character
  password.
- **A supplied password is never echoed back.** The admin typed it; sending it
  back over the wire for them to read again buys nothing and puts a plaintext
  credential in a response body.

### Why the account starts email-verified

An admin typing the address is the vouching that verification exists to
provide. More practically, the panel has no unauthenticated "resend
verification" route: with `requireVerifiedSignIn` on
(`docs/site-settings.md`), an unverified invited account would be locked out
with no way to fix it from outside, since the only place to request a new
verification email is inside the account settings the person cannot reach.

The column is set with an explicit `UPDATE` right after creation rather than by
passing `emailVerified` through the plugin's `data` field: an account that
silently stayed unverified is a lockout, so the outcome should not depend on how
the plugin forwards extra fields into its insert.

### The invitation email

`sendInvitationEmail` (`routes/admin.ts`) tells the person an account was
created for them and where to sign in (`FRONTEND_URL` + `/login`), signed with
the operator's configured site name rather than the product's.

It **never contains the password.** The invitation travels over whatever email
path the operator configured while the credential goes through the admin, so a
single intercepted mailbox is not a working login.

It is sent inline rather than deferred, unlike Better Auth's own email
callbacks (which it runs in the background). The admin is waiting on a dialog
that has to state what happened, and a guess would be worse than the wait.
`sendMail` returns `false` both when mail is unconfigured and when the provider
fails, and never throws (see `services/mail.ts`), so a mail outage produces an
honest "no email was sent" rather than a failed account creation. The account is
already created at that point either way.

### Role

Invited accounts are always created as `user`. Promotion is a separate,
separately audited action (`PATCH /api/admin/users/:id/role`), reachable from
the same row's menu.

## Deletion

Two routes delete an account, and they are gated differently because the person
pressing the button is different:

| | who | gate |
|---|---|---|
| `POST /api/account/delete` | the account holder | their password, and zero owned servers |
| `DELETE /api/admin/users/:id` | an admin | an **active ban**, and zero owned servers |

Both delegate the deletion itself (`/delete-user` and the admin plugin's
`removeUser`) rather than deleting rows by hand, so sessions and credential
accounts go with the row.

### Why the admin route requires a ban first

A ban is what makes the deletion safe rather than merely permitted. Banning
already revokes every session the account holds and suspends its servers
(`handleBanUser`), so by the time the delete runs the account cannot be
mid-request. It also gives the admin a reversible step to change their mind in,
and it splits one irreversible decision into two audited entries
(`user.ban`, then `user.delete`).

The UI follows the same shape: the delete item in the row menu is disabled
until the account is banned and owns nothing, and hovering it explains which
gate is in the way rather than leaving a greyed-out row unexplained. The
tooltip hangs off a wrapper element, because a disabled menu item is
`pointer-events-none` and can never be hovered itself. The confirmation dialog
does not re-check the rules; it renders whatever the route refuses with, so the
reason shown is the reason applied.

An **expired** ban does not count. The sign-in hook clears lapsed bans lazily
and the list already renders such an account as active, so treating it as
banned would let an old ban authorise a deletion nobody re-confirmed.

### Why zero servers, in both routes

`servers.owner_id` is `ON DELETE CASCADE` (`001_initial_schema.sql`). Deleting
an owner would silently take their servers, data directories and port
allocations with it, leaving the node holding orphaned containers. So the panel
refuses and names the count: an admin who wants the account gone deletes the
servers first, deliberately, one at a time, through the path that also tears
down the containers.

### What the delete has to clean up itself

Almost everything that hangs off an account cascades (subuser grants, SFTP
credentials, console sessions) or goes null (audit actor, `invited_by`,
`installed_by`, `reviewed_by`, `requested_by`). Two exceptions:

- **`apikey`** has no foreign key back to `"user"` at all: the plugin stores the
  owner in `referenceId`. Its rows would outlive the account, so the route
  deletes them explicitly. They could not authenticate anything without a user
  row to synthesize a session from (`docs/api-keys.md`), but credential rows for
  an account that no longer exists are not a state worth keeping.
- **`server_links.created_by`** is the one reference to `"user"` with no
  `ON DELETE` action, so a surviving row makes the delete fail on a foreign
  key. The ordinary case cannot reach it (a link dies with its server, and the
  account owns none), but an *admin* counts as owner for link creation, so an
  ex-admin can have created links on other people's servers. The route checks
  for those first and names the servers, rather than surfacing a raw constraint
  violation as a 500.

### What survives on purpose

The audit trail. `audit_logs.user_id` is `ON DELETE SET NULL`, so the deleted
account's actions stay on record with their targets intact, attributed to
nobody. The deletion itself is audited as `user.delete` by the acting admin,
with the deleted address in the metadata, which is what keeps the trail
readable after the name is gone.
