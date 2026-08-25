# User invites (admin-created accounts)

An admin can create an account for someone else from `/admin/users` ("Add
user"): name, email, and an optional password. The account exists immediately,
the person is emailed that it exists (when mail is configured), and the
password is handed back to the admin to relay when the panel generated it.

The panel needs this because registration is a setting, not a constant. An
invite-only install (`docs/site-settings.md`) closes `POST /sign-up/email`
behind the registration gate, and "just sign up" is exactly what that gate
refuses. Without this route, an invite-only panel has no way to onboard anyone
after the first admin.

## The flow

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

## Why it deliberately bypasses the registration gate

The gate exists to require an invitation. An admin typing someone's details
**is** that invitation, so the invite route is a separate endpoint under
`requireAdmin` rather than a special case inside the gate. The gate itself is
untouched: anything that can POST to `/sign-up/email` still hits it. Better
Auth's `before` hook only inspects `/sign-up/email`, and this route goes
through `/admin/create-user`, so no exemption logic was needed.

## Why the password is optional

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

## Why the account starts email-verified

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

## The invitation email

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

## Role

Invited accounts are always created as `user`. Promotion is a separate,
separately audited action (`PATCH /api/admin/users/:id/role`), reachable from
the same row's menu. See `docs/subusers.md` for the other kind of access
(per-server delegation), which does not involve creating an account at all.
