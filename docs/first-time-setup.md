# First-Time Setup

CitadelPanel ships with no default credentials. The first-time setup wizard runs once to configure the panel before any servers can be provisioned.

Deploying with Docker splits `bun run setup` across three places: secrets on the host, migrations at container boot, this wizard in the browser. See [docker.md](docker.md).

## Overview

Setup is a four-step wizard reached at `/setup`:

1. **Admin account**: claim the first admin account (unauthenticated, once)
2. **Timezone**: how the panel displays timestamps
3. **Captcha**: optional bot protection for sign-in/sign-up
4. **First node**: optional, can be skipped and added later

The wizard is server-gated: Next.js checks database-backed setup status before rendering it. Once completed, `/setup` redirects to the panel without sending wizard UI to the browser, and the bootstrap endpoint refuses further calls.

## When setup runs

The login page redirects to `/setup` automatically when `GET /api/setup/status` reports `needsSetup: true`. This happens when:

- No admin account exists yet, **or**
- The `setup.completedAt` flag in `panel_settings` is null

Setup is complete only when an admin exists and the completion latch is set. This lets an interrupted wizard resume and prevents an admin created by CLI or promotion from silently skipping configuration.

### The startup check costs nothing on a configured panel

A fresh install must send its first visitor to `/setup`, but a configured install must never pay a network round trip to discover that it is configured. Setup completion is *irreversible* because `completedAt` never clears, so the frontend treats it as a one-way latch (`lib/setup-gate.ts`):

- On first visit to a fresh panel, one `GET /api/setup/status` call happens and the visitor is sent to `/setup`.
- Normal panel routing caches that result in `localStorage` the moment the service reports "complete", either from the wizard's final step (`markSetupComplete`) or from a client-side status check.
- Direct visits to `/setup` always bypass that browser cache: the Next.js server asks the internal service and redirects before rendering when setup is complete.

The cache only ever stores "complete", never "needs setup", so it can be wrong only in one direction, and even that self-heals. Two code paths deliberately bypass the cache and ask the Next.js control plane live: the login page (already calling the backend for its captcha config) and the session provider's "you're not authenticated" branch (`checkSetupLive` in `lib/setup-gate.ts`). So if the database is wiped and setup re-opens, any unauthenticated visit re-discovers `needsSetup` and gets sent to the wizard. Signed-in users never hit these paths, which is exactly the point of the cache. There is no demo mode; the panel requires its control-plane database, and unauthenticated visitors are routed to `/setup` or `/login`, never into the panel.

## Step 1: Admin account

The wizard begins by claiming the first admin account. This step is **unauthenticated**. It has to be, because no account exists yet.

### Race condition

Whoever reaches the panel first becomes admin. This is inherent to any no-default-credential bootstrap. The window closes the moment the first account is created: the endpoint refuses once `COUNT(*) FROM "user" WHERE role = 'admin'` is non-zero.

### Skipping step 1

If an admin already exists when setup is unfinished, anonymous visitors are sent to `/login`. That happens when someone else finished step 1, or when the account was made via CLI (`bun run cli init` followed by manual DB promotion). After the existing admin signs in, the wizard skips step 1 and resumes at the timezone step. Non-admin accounts cannot open the remaining wizard.

### How it works

- `POST /api/setup/admin` delegates account creation to Better Auth's `auth.api.signUpEmail` so password hashing and session issuance remain its concern. No hand-rolled user insert.
- The response carries Better Auth's `Set-Cookie` header through, so the browser is signed in for the remaining steps. Steps 2-4 authenticate normally as the freshly-created admin.
- The account's `role` is set to `admin` explicitly after creation, independently of the `FIRST_USER_BECOMES_ADMIN` env flag (which an operator may have turned off).

## Step 2: Timezone

How the panel renders timestamps: audit logs, activity, heartbeat times. Stored data stays in UTC; this only affects display.

The form preselects the browser's detected timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` so the operator usually just confirms.

## Step 3: Captcha (optional)

Bot protection for `POST /api/auth/sign-in/email`, `POST /api/auth/sign-up/email`, and `POST /api/auth/forget-password`. Three providers are supported and chosen at runtime from `panel_settings`, not at build time:

| Provider | Type | Notes |
|----------|------|-------|
| `cloudflare-turnstile` | Hosted, free | No user interaction in the common case |
| `google-recaptcha` | Hosted | v2 checkbox or v3 score (configurable `minScore`) |
| `cap` | Self-hosted | Proof-of-work (capjs.js.org / trycap.dev), no third party |

The operator can skip this step and enable it later from the admin settings page, or leave it off entirely if the panel is on a private network.

### How it works

- **Frontend**: The `CaptchaWidget` component (`components/captcha-widget.tsx`) loads the chosen provider's script on demand and renders its widget. The token is sent in the `x-captcha-response` header.
- **Next.js backend**: A Better Auth `before` hook (`auth/betterAuth.ts`) calls `verifyCaptcha` from `security/captcha.ts` before the credential handler runs. The hook reads current settings per request (cached in `services/settings.ts` with a 10s TTL), so changing provider in the admin settings takes effect without a restart.

Verification **fails closed**: if the provider is unreachable, the request is rejected. An attacker who can make the provider unreachable must not thereby bypass the captcha.

### Secret storage

The captcha secret key is stored AES-256-GCM encrypted in `panel_settings.value->>'secretKeyEncrypted'` and can never be read back. The form shows "leave blank to keep unchanged" when editing an existing config. An empty submission is read as "unchanged", not "clear it".

## Step 4: First node (optional)

The wizard prompts to register the first node, but this can be skipped. An operator without a node yet (waiting on a provisioning ticket, setting up Docker on the host) can skip it and add one later from `/admin/nodes`.

When a node is registered here:

- Capacity (CPU, memory) is probed from the agent automatically when it is reachable.
- If no token is supplied, one is **generated and shown once**. The operator must copy it now and set it as `AGENT_TOKEN` on the node. It is stored encrypted and cannot be shown again.
- The response reports whether the agent was reachable. An unreachable agent is still registered (the row is persisted), but the warning is surfaced so the operator knows provisioning will fail until it responds.

## Finishing

`POST /api/setup/complete` writes the current ISO timestamp to `panel_settings` as `setup.completedAt`. This is the latch that closes the wizard: once set, `GET /api/setup/status` reports `needsSetup: false` and the login page stops redirecting to `/setup`.

The endpoint is idempotent: calling it on an already-completed install returns the existing timestamp rather than refusing, so a double-submit from the wizard's last step is not an error.

## Database schema

Settings are stored in the `panel_settings` table (`003_panel_settings.sql`). Three keys are seeded by the migration:

```sql
INSERT INTO panel_settings (key, value) VALUES
  ('timezone', '"UTC"'),
  ('captcha', '{"enabled": false, "provider": null, ...}'),
  ('setup', '{"completedAt": null}');
```

The wizard remains reachable until `completedAt` is set and at least one admin exists.

Secret values inside the `captcha` JSON object are encrypted before being written:

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

All routes in `routes/setup.ts`:

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/setup/status` | None | Wizard state and counts; drives the redirect |
| POST | `/api/setup/admin` | None | Claim the first admin account (refuses once an admin exists) |
| PATCH | `/api/setup/settings` | Admin | Save timezone and/or captcha |
| POST | `/api/setup/complete` | Admin | Close the wizard (idempotent) |
| GET | `/api/settings/public` | None | Captcha site key and timezone for the login page |

`/api/setup/admin` is the one unauthenticated mutating endpoint. It is gated on the admin count, not the `completedAt` latch alone, because the latch is writable by the same unauthenticated flow and could be reset. The admin count is derived from real accounts and cannot be reset from outside.

## Files

### Next.js control plane

- `apps/frontend/lib/server/control-plane/db/migrations/003_panel_settings.sql`: settings table and defaults
- `apps/frontend/lib/server/control-plane/services/settings.ts`: typed accessors over `panel_settings`, with caching
- `apps/frontend/lib/server/control-plane/security/captcha.ts`: server-side verification for the three providers
- `apps/frontend/lib/server/control-plane/routes/setup.ts`: wizard and settings endpoints
- `apps/frontend/lib/server/control-plane/auth/betterAuth.ts`: captcha hook wired as a `before` middleware

### Frontend

- `app/setup/page.tsx`: server-side completion and admin-session gate
- `app/setup/setup-wizard.tsx`: client-side wizard UI
- `app/login/page.tsx`: captcha widget and live-check redirect to `/setup` when `needsSetup`
- `components/session-provider.tsx`: session load; on failure uses the setup gate to decide `/setup` vs `/login`
- `components/captcha-widget.tsx`: dynamic script loading per provider
- `components/captcha-settings-form.tsx`: the captcha form, shared by wizard and admin settings
- `lib/setup-gate.ts`: one-way localStorage latch for "setup complete" plus the live-check escape hatch
- `lib/timezones.ts`: IANA timezone list and browser detection

## Testing

Run `bun test` from the repository root. The captcha verification logic is covered by `apps/backend/src/security/captcha.test.ts`, including:

- Fail-closed behavior when the provider is unreachable
- reCAPTCHA v3 score threshold enforcement
- Cap's JSON POST and endpoint-path handling
- Missing token rejection before contacting the provider

## Changing settings after setup

Timezone and captcha can be changed later from the admin settings page (route TBD; the backend endpoint `/api/admin/settings` exists and uses the same `updateSetupSettings` handler, so the form will be the `CaptchaSettingsForm` component the wizard already uses).

The `setup.completedAt` latch is write-once: there is no "reopen setup" action. An operator who wants to reset the panel destroys the database and re-runs `bun run cli migrate`.

## CLI bypass

The CLI can create an admin without the wizard:

```bash
bun run cli init       # generates secrets, not accounts
bun run cli migrate    # creates tables
# Manually insert a user with role='admin', or sign up and promote via SQL
```

When the wizard loads and an admin already exists, step 1 is skipped automatically. The operator signs in with the existing account and continues from step 2.

## Security notes

1. **The bootstrap window.** The panel is claimable by whoever reaches it first. Deploy it on a private network or behind a firewall until setup is complete, then open it to the internet.

2. **Captcha secret keys** are stored encrypted at rest (`lib/crypto.ts` AES-256-GCM) and can never be read back. The plaintext is only in memory during verification.

3. **Admin count, not a flag.** The first-admin endpoint gates on `COUNT(*) FROM "user" WHERE role = 'admin'`, not the `setup.completedAt` flag alone. The flag is writable by an unauthenticated flow; the count is not.

4. **Session cookie.** Step 1 signs the browser in, so steps 2-4 authenticate as the admin. The session is httpOnly, sameSite strict, 7-day lifetime (updated daily).

## Main data DB vs node DB

The setup wizard configures the **panel control-plane database** (the `DATABASE_URL` in `.env`, created by `bun run cli init`). This is the database that holds the panel's own state: users, nodes, servers, audit logs.

The **node database** is separate and optional. It is the shared MySQL/Postgres server *on a node* that game servers can optionally use (provisioned databases for servers that need one, e.g. Minecraft with a plugin that stores data in MySQL). The node DB is configured per-node in the "Add node" dialog (the `dbAdminHost` / `dbAdminUser` / `dbAdminPassword` fields in `POST /api/admin/nodes`), not during first-time setup.

The wizard's step 4 (add first node) can configure a node's shared database server, but that is not the same as the panel's own control-plane DB.
