# First-Time Setup

CitadelPanel ships with no default credentials. The first-time setup wizard runs
once to configure the panel and, if the operator lets it, to build their first
server before the wizard closes.

Deploying with Docker splits `bun run setup` across three places: secrets on the
host, migrations at container boot, this wizard in the browser. See
[docker.md](docker.md).

## Overview

Setup is a six-step wizard at `/setup`:

| # | Step | Writes | Required |
|---|------|--------|----------|
| 1 | Admin account | the first `user` row | yes |
| 2 | Panel identity | `branding`, `timezone` | yes (both pre-filled) |
| 3 | Access | `registration`, `captcha` | no |
| 4 | Email | `mail`, `verification` | no |
| 5 | First node | a `nodes` row + its port pool | no |
| 6 | First server | a `servers` row, built live | no |

The wizard is server-gated: Next.js checks database-backed setup status before
rendering it. Once completed, `/setup` redirects to the panel without sending
wizard UI to the browser, and the bootstrap endpoint refuses further calls.

### Why only six of thirteen settings groups

The panel has thirteen configurable settings groups (see
[site-settings.md](site-settings.md), [theming.md](theming.md),
[backups.md](backups.md), [ai-helper.md](ai-helper.md),
[legal-pages.md](legal-pages.md)). The wizard asks about four of them.

The dividing line is *what a wrong default costs*. Registration defaults to
**open**, captcha to **off**, and mail to **absent**, so an operator who never
sees those three ends up with a publicly-writable signup form and no way to
reset a password. Those are worth interrupting for. Backups, theming, analytics,
the AI helper and the server limits are all safe or inert by default, and asking
about them here would turn the wizard into thirteen screens that get clicked
through without reading.

Everything the wizard skips is listed on its final screen with a direct link, so
it is deferred rather than hidden. That screen is the only place an operator is
told these features exist at all.

## When setup runs

The login page redirects to `/setup` automatically when `GET /api/setup/status`
reports `needsSetup: true`. This happens when:

- No admin account exists yet, **or**
- The `setup.completedAt` flag in `panel_settings` is null

Setup is complete only when an admin exists and the completion latch is set.
This lets an interrupted wizard resume and prevents an admin created by CLI or
promotion from silently skipping configuration.

### The startup check costs nothing on a configured panel

A fresh install must send its first visitor to `/setup`, but a configured
install must never pay a network round trip to discover that it is configured.
Setup completion is *irreversible* because `completedAt` never clears, so the
frontend treats it as a one-way latch (`lib/setup-gate.ts`):

- On first visit to a fresh panel, one `GET /api/setup/status` call happens and
  the visitor is sent to `/setup`.
- Normal panel routing caches that result in `localStorage` the moment the
  service reports "complete", either from the wizard's final step
  (`markSetupComplete`) or from a client-side status check.
- Direct visits to `/setup` always bypass that browser cache: the Next.js server
  asks the internal service and redirects before rendering when setup is
  complete.

The cache only ever stores "complete", never "needs setup", so it can be wrong
only in one direction, and even that self-heals. Two code paths deliberately
bypass the cache and ask the Next.js control plane live: the login page (already
calling the backend for its captcha config) and the session provider's "you're
not authenticated" branch (`checkSetupLive` in `lib/setup-gate.ts`). So if the
database is wiped and setup re-opens, any unauthenticated visit re-discovers
`needsSetup` and gets sent to the wizard. Signed-in users never hit these paths,
which is exactly the point of the cache. There is no demo mode; the panel
requires its control-plane database, and unauthenticated visitors are routed to
`/setup` or `/login`, never into the panel.

## Step 1: Admin account

The wizard begins by claiming the first admin account. This step is
**unauthenticated**. It has to be, because no account exists yet.

Password rules are checked as the operator types, and the submit button stays
disabled with the first unmet requirement named beneath it. This is the only
credential that will exist on the install and the one password nobody can reset
by email yet, so discovering after submit that it was two characters short is
the wrong moment.

### Race condition

Whoever reaches the panel first becomes admin. This is inherent to any
no-default-credential bootstrap. The window closes the moment the first account
is created: the endpoint refuses once `COUNT(*) FROM "user" WHERE role =
'admin'` is non-zero.

### Skipping step 1

If an admin already exists when setup is unfinished, anonymous visitors are sent
to `/login`. That happens when someone else finished step 1, or when the account
was made via CLI (`bun run cli init` followed by manual DB promotion). After the
existing admin signs in, the wizard skips step 1 and resumes at step 2.
Non-admin accounts cannot open the remaining wizard.

### How it works

- `POST /api/setup/admin` delegates account creation to Better Auth's
  `auth.api.signUpEmail` so password hashing and session issuance remain its
  concern. No hand-rolled user insert.
- The response carries Better Auth's `Set-Cookie` header through, so the browser
  is signed in for the remaining steps. Steps 2-6 authenticate normally as the
  freshly-created admin.
- The account's `role` is set to `admin` explicitly after creation,
  independently of the `FIRST_USER_BECOMES_ADMIN` env flag (which an operator
  may have turned off).

## Steps 2-4 share one endpoint

Once the admin session exists, the wizard reads the whole settings surface once
with `GET /api/admin/settings` and seeds every later step from it. That is what
makes the wizard resumable: an operator who reloads at step 4 sees what steps 2
and 3 already saved, not blank defaults.

Writes go to `PATCH /api/setup/settings`, which is the *same handler* as
`PATCH /api/admin/settings` (`handleUpdateSettings`, mounted twice). The wizard
can therefore write any settings group the admin pages can, and the two share
their form components rather than maintaining two copies:

- `components/captcha-settings-form.tsx`: `CaptchaSettingsForm`
- `components/mail-settings-form.tsx`: `MailSettingsForm`

Both are fully controlled: value in, `onChange` out, no fetching and no save
button of their own. Both take a `hasStored*` flag because their secrets are
write-only (see below), which the form itself cannot determine.

Each step folds its saved patch into the in-memory settings copy
(`mergeSettings` in `setup-wizard.tsx`) rather than re-fetching. Write-only
secrets become the "one is stored" booleans a re-read would have reported.

## Step 2: Panel identity

The site name, its tagline and the display timezone. One step because they are
one decision from the operator's side: how this install presents itself.

The site name is a setting rather than a constant (see
[site-settings.md](site-settings.md)); it appears on the sign-in page, in the
sidebar and in the browser tab, and the step previews that. The timezone form
preselects the browser's detected zone via
`Intl.DateTimeFormat().resolvedOptions().timeZone`, so the operator usually just
confirms. Stored data stays in UTC; the setting only affects display.

## Step 3: Access

Public registration and the captcha, paired deliberately. Open registration
without a captcha is the combination that fills a database with junk accounts
overnight, and this is the only screen where an operator sees both at once. The
step warns explicitly when it is left in that state.

Turning registration off reveals the message shown on the sign-up page, because
a closed form with no explanation reads as a broken panel.

### Captcha

Bot protection for `POST /api/auth/sign-in/email`, `POST
/api/auth/sign-up/email`, and `POST /api/auth/forget-password`. Three providers
are supported and chosen at runtime from `panel_settings`, not at build time:

| Provider | Type | Notes |
|----------|------|-------|
| `cloudflare-turnstile` | Hosted, free | No user interaction in the common case |
| `google-recaptcha` | Hosted | v2 checkbox or v3 score (configurable `minScore`) |
| `cap` | Self-hosted | Proof-of-work (capjs.js.org / trycap.dev), no third party |

- **Frontend**: The `CaptchaWidget` component (`components/captcha-widget.tsx`)
  loads the chosen provider's script on demand and renders its widget. The token
  is sent in the `x-captcha-response` header.
- **Next.js backend**: A Better Auth `before` hook (`auth/betterAuth.ts`) calls
  `verifyCaptcha` from `security/captcha.ts` before the credential handler runs.
  The hook reads current settings per request (cached in `services/settings.ts`
  with a 10s TTL), so changing provider takes effect without a restart.

Verification **fails closed**: if the provider is unreachable, the request is
rejected. An attacker who can make the provider unreachable must not thereby
bypass the captcha.

## Step 4: Email

Outbound mail (SMTP or Resend), plus the email-verification policy.

The step carries a **test send**, and it saves before it sends. Mail
configuration is the kind that looks saved and still does not work, and the
probe (`POST /api/admin/settings/test-email`) runs against *stored* settings, so
testing un-saved form values would report on the previous configuration and be
quietly wrong. Any edit to the form clears a previous green result, because a
tick under changed credentials is a lie.

Verification lives in this step because it depends on mail: requiring a verified
address with no way to send the verification email locks every new account out,
including ones the admin creates. The switch is therefore only offered when mail
is enabled, the saved value is forced to `false` when it is not, and enabling it
without a successful test send is called out.

## Step 5: First node

A node is a machine running the agent next to Docker. See
[docker.md](docker.md) for what has to be installed there.

### Test before write

The step probes the agent with `POST /api/admin/nodes/probe` before anything is
persisted. A node saved against a typo'd URL looks registered and fails at the
first server, with an error that reads like a panel bug. The probe reports three
distinct outcomes, each with what to do about it:

- **Unauthorized.** The machine answered, so the URL is right and the token is
  wrong.
- **Unreachable.** No answer: agent not running, wrong port, or a firewall.
- **Reachable with a problem.** `agentProblem()` in `lib/node-health.ts` folds
  "no Docker socket" and "data root not writable" into one sentence. Both used
  to be discovered as a failed server creation.

The probe needs a token to authenticate with, so it is only offered once one has
been typed. The generate-a-token-for-me path cannot be pre-tested by design: the
token is generated server-side, during creation.

### Then the port pool

**A node with no port pool cannot host anything.** There is no default range
(see [ports.md](ports.md)), so provisioning on a fresh node fails at allocation.
Registering a node and stopping there is the single easiest way to end setup
with an install that looks finished and is not, which is why reserving the first
range happens here rather than being left to `/admin/nodes`.

The pool is reserved through `POST /api/admin/nodes/:id/ports`, which asks the
agent to confirm every port is actually free on the host. That means it needs a
**reachable** agent: when the node was registered offline, the step says so and
points at the admin area rather than showing a form that cannot work.

### The rest of the node form

- If no token is supplied, one is **generated and shown once**. The operator
  must copy it now and set it as `AGENT_TOKEN` on the node. It is stored
  encrypted and cannot be shown again.
- CPU and memory are probed from the agent automatically when it is reachable,
  and fall back to defaults when it is not, so an offline node still registers.
  Only disk is asked for.
- The optional shared database server (`dbAdminHost` and friends, see
  `docs/database-explorer.md`) is behind a switch. Most first installs do not
  need one, and four more credential fields on the first node form is where
  operators give up. The three credential fields are all-or-nothing; the backend
  rejects a partial triple.

## Step 6: First server

The wizard ends by provisioning a server for the admin's own account, on the
node from step 5.

This exists because a configured panel with nothing in it does not tell an
operator whether any of it works. Creating one server exercises the node, its
Docker socket, its data root and its port pool in a single action, so a mistake
in any of them surfaces now, while the operator is still in the flow that made
it, rather than a week later.

Choosing a game refills the CPU/memory/disk fields from that blueprint's
minimums, so nobody has to guess whether 2 CPU is enough for the thing they just
picked. Servers for *other* accounts are provisioned from `/admin/servers`,
which has an owner picker; this step always creates for the admin.

### Watching the build

Provisioning pulls a Docker image and can run for minutes (see
[server-lifecycle.md](server-lifecycle.md)). A spinner is the wrong shape for
that: past about ten seconds nobody can distinguish a slow pull from a hung
panel. So the step polls `GET /api/servers/:id/install-log` every two seconds
and shows named stages, derived from the panel's own `[panel]` log lines:

```
Allocating ports -> Running the install script -> Creating the container
  -> Container built -> Starting the server
```

Nothing here blocks: the build runs server-side whether or not the page is open,
so "Finish setup" stays available throughout. A dropped poll is reported as
"not getting updates" and retried, not as a failed build, because it is not one.

### The server starts itself

The wizard ends with the server **running**, not merely built. The create
request sets `startWhenBuilt` (see
[server-lifecycle.md](server-lifecycle.md#starting-it-straight-away-startwhenbuilt)),
so the start is part of the provision task rather than something this page does.

That placement is the whole point. This step tells the operator they do not have
to wait, and means it; a browser-side start would then not happen for anyone who
took it up on that, and they would arrive at the panel holding a stopped
container. Asking for it at create time means the server is running by the time
they get there either way.

So the last stage is *observed*, not driven. The step watches the reported
status and stops polling once it settles on `running` or `error`, which is why
it keeps polling past the end of the build: `provisioning` is already false
while the start is happening.

Three outcomes, told apart because they need different things from the operator:

- **Running.** The connect address (the node's hostname and the allocated port)
  is shown with a copy button. The copy says the game process is still booting,
  because `docker start` returning is not the same as a game accepting
  connections, and a first join attempt is often refused.
- **Built but did not start.** The container is on the node and intact, so this
  is reported as a start failure rather than a build failure, and the retry is
  "Start it now" rather than a reinstall.
- **Built, and the start never arrived.** If the status is still `stopped` 45
  seconds after the build finished, the step says so instead of spinning
  forever, and offers the same manual start. An indefinite "starting…" is the
  state this whole screen exists to avoid.

The connect address needs a second read (`GET /api/servers/:id`) because ports
are allocated *during* the build: the row returned by the create request has
none yet.

The step degrades in both directions it can. With no node (step 5 skipped) it
renders an empty state explaining that a server needs somewhere to run, offering
"add a node" and "finish setup" instead of a form that cannot submit. With a
node that is unreachable or has no ports, the form is shown but blocked, saying
which of the two is missing.

## Finishing

`POST /api/setup/complete` writes the current ISO timestamp to `panel_settings`
as `setup.completedAt`. This is the latch that closes the wizard: once set,
`GET /api/setup/status` reports `needsSetup: false` and the login page stops
redirecting to `/setup`.

The endpoint is idempotent: calling it on an already-completed install returns
the existing timestamp rather than refusing, so a double-submit is not an error.

The final screen then lists what the install ended up with, including whether
the server is running and at what address, and what was left undone, each with a
link. Backups, the legal pages, theming, the AI helper and
search indexing are all listed there whether or not the operator asked about
them, because they are all easy to postpone and easy to forget forever.

### And the panel's own empty state

An admin who finishes setup without creating a server lands on "Your servers"
with nothing in it. That screen tells ordinary users to contact their
administrator, which is useless advice for the administrator. It reads the
session role and offers "Create a server" and "Manage nodes" instead
(`components/your-servers.tsx`), so a fresh install never dead-ends.

## Database schema

Settings are stored in the `panel_settings` table (`003_panel_settings.sql`),
one row per group. Three keys are seeded by the migration:

```sql
INSERT INTO panel_settings (key, value) VALUES
  ('timezone', '"UTC"'),
  ('captcha', '{"enabled": false, "provider": null, ...}'),
  ('setup', '{"completedAt": null}');
```

The wizard remains reachable until `completedAt` is set and at least one admin
exists.

### Secret storage

Secrets inside a settings group are encrypted before being written and can never
be read back. `GET /api/admin/settings` reports their presence as a boolean
(`hasSecretKey`, `hasSmtpPassword`, `hasResendApiKey`) and never their value.
Both shared forms therefore read an empty secret field as "leave the stored one
unchanged" when one exists, and "there is nothing to store" when there is not.
An empty submission is never an accidental wipe.

```typescript
{
  enabled: boolean;
  provider: "cloudflare-turnstile" | "google-recaptcha" | "cap" | null;
  siteKey: string | null;
  secretKeyEncrypted: string | null;  // AES-256-GCM ciphertext, never plaintext
  apiEndpoint: string | null;         // Cap only; inferred for the others
  minScore: number;                   // reCAPTCHA v3 score floor
}
```

## API surface

Wizard routes in `routes/setup.ts`:

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/setup/status` | None | Wizard state and counts; drives the redirect |
| POST | `/api/setup/admin` | None | Claim the first admin account (refuses once an admin exists) |
| PATCH | `/api/setup/settings` | Admin | Save any subset of the settings groups |
| POST | `/api/setup/complete` | Admin | Close the wizard (idempotent) |
| GET | `/api/settings/public` | None | Captcha site key, branding and timezone for the login page |
| GET | `/api/admin/settings` | Admin | Current settings, seeding steps 2-4 |
| POST | `/api/admin/settings/test-email` | Admin | The step 4 probe |

Routes the wizard borrows from the admin surface:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/admin/nodes/probe` | Test an agent without persisting anything |
| POST | `/api/admin/nodes` | Register the node |
| POST | `/api/admin/nodes/:id/ports` | Reserve the first port range |
| POST | `/api/admin/servers` | Provision the first server (with `startWhenBuilt`) |
| GET | `/api/servers/:id/install-log` | Poll the build and the first start |
| GET | `/api/servers/:id` | Read the allocated port for the connect address |
| POST | `/api/servers/:id/start` | Retry the start by hand when it failed |

`/api/setup/admin` is the one unauthenticated mutating endpoint. It is gated on
the admin count, not the `completedAt` latch alone, because the latch is
writable by the same unauthenticated flow and could be reset. The admin count is
derived from real accounts and cannot be reset from outside.

## Files

### Next.js control plane

- `lib/server/control-plane/db/migrations/003_panel_settings.sql`: settings table and defaults
- `lib/server/control-plane/services/settings.ts`: typed accessors over `panel_settings`, with caching
- `lib/server/control-plane/security/captcha.ts`: server-side verification for the three providers
- `lib/server/control-plane/routes/setup.ts`: wizard and settings endpoints
- `lib/server/control-plane/auth/betterAuth.ts`: captcha hook wired as a `before` middleware

### Frontend

- `app/setup/page.tsx`: server-side completion and admin-session gate
- `app/setup/setup-wizard.tsx`: the shell: stepper, settings load, step routing, `mergeSettings`
- `app/setup/steps/wizard-ui.tsx`: the shared state primitives (`ErrorNote`, `WarningNote`, `SuccessNote`, `StepNav`, `BlockingIssues`, `GeneratedToken`)
- `app/setup/steps/admin-step.tsx` … `server-step.tsx`: one file per step
- `app/setup/steps/node-ports.tsx`: the port-pool panel shown after registration
- `app/setup/steps/node-result.tsx`: the probe verdict and post-registration view
- `app/setup/steps/server-install.tsx`: the staged build progress
- `app/setup/steps/finish-step.tsx`: the summary and the deferred-work list
- `components/captcha-settings-form.tsx`, `components/mail-settings-form.tsx`: shared with `/admin/settings`
- `components/admin/general-settings.tsx`: the admin-side consumer of both
- `lib/node-health.ts`: `agentProblem()`, shared by the wizard and `/admin/nodes`
- `lib/setup-gate.ts`: one-way localStorage latch plus the live-check escape hatch
- `lib/timezones.ts`: IANA timezone list and browser detection

## Interface states

Every step is written to answer the same four questions, and reviewing a change
to one means checking all four are still answered:

- **Loading.** Under a second, nothing. Saves and probes put a spinner in the
  button that caused them. Whole-panel reads (settings, blueprints, the port
  pool) use skeletons. The one operation that runs for minutes, the server build
  and its first start, gets named stages and an elapsed clock rather than a
  spinner, and a bounded wait rather than an open-ended one.
- **Error.** Always inline, next to the control that caused it, with a retry
  where repeating is safe. Never a toast: every failure here is correctable by
  the operator, and a toast can scroll away unseen. No raw backend text reaches
  the operator without a sentence saying what to do about it.
- **Empty.** The "no node" and "no blueprints" cases in step 6 are real empty
  states with an explanation and an action, not a disabled dropdown.
- **Success.** Every action confirms in place: a green probe result, the
  reserved ranges as badges, "sent to <address>", the registered-node view, the
  running server's connect address.

Disabled primary buttons always name the first thing that is missing
(`BlockingIssues`). A greyed-out control with no explanation is indistinguishable
from a broken one.

## Changing settings after setup

Everything except the admin account can be changed from the admin area:
`/admin/settings` (branding, theme, timezone, registration, captcha, mail, AI,
verification, server limits, SEO, analytics), `/admin/backups`, `/admin/legal`,
`/admin/nodes`, `/admin/servers`.

The `setup.completedAt` latch is write-once: there is no "reopen setup" action.
An operator who wants to reset the panel destroys the database and re-runs
`bun run cli migrate`.

## CLI bypass

The CLI can create an admin without the wizard:

```bash
bun run cli init       # generates secrets, not accounts
bun run cli migrate    # creates tables
# Manually insert a user with role='admin', or sign up and promote via SQL
```

When the wizard loads and an admin already exists, step 1 is skipped
automatically. The operator signs in with the existing account and continues
from step 2.

## Testing

Run `bun test` from the repository root. The captcha verification logic is
covered by `apps/backend/src/security/captcha.test.ts`, including:

- Fail-closed behavior when the provider is unreachable
- reCAPTCHA v3 score threshold enforcement
- Cap's JSON POST and endpoint-path handling
- Missing token rejection before contacting the provider

## Security notes

1. **The bootstrap window.** The panel is claimable by whoever reaches it first.
   Deploy it on a private network or behind a firewall until setup is complete,
   then open it to the internet.

2. **Secrets at rest.** Captcha secrets, mail credentials and node tokens are
   encrypted (`lib/crypto.ts`, AES-256-GCM) and can never be read back. The
   plaintext is only in memory during use.

3. **Admin count, not a flag.** The first-admin endpoint gates on
   `COUNT(*) FROM "user" WHERE role = 'admin'`, not the `setup.completedAt` flag
   alone. The flag is writable by an unauthenticated flow; the count is not.

4. **Session cookie.** Step 1 signs the browser in, so later steps authenticate
   as the admin. The session is httpOnly, sameSite strict, 7-day lifetime
   (updated daily).

5. **The agent token is root-equivalent** for the machine it belongs to. The
   node step says so next to the field, because an operator who puts the agent
   on a public address has given away that machine.

## Main data DB vs node DB

The setup wizard configures the **panel control-plane database** (the
`DATABASE_URL` in `.env`, created by `bun run cli init`). This is the database
that holds the panel's own state: users, nodes, servers, audit logs.

The **node database** is separate and optional. It is the shared MySQL server
*on a node* that game servers can optionally be given a database on (see
[database-explorer.md](database-explorer.md)). It is configured per-node, in
step 5's optional section or later in the "Add node" dialog, and is not the
panel's own control-plane DB.
