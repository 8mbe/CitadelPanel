CitadelPanel is a game-server control panel. It is a Bun monorepo: a Next.js control plane (`apps/frontend`) and a Bun node agent (`apps/backend`) that drives the Docker socket.

## Architecture

- **`apps/frontend`** — the only public web service. Owns Better Auth sessions, PostgreSQL metadata, audit logs, node registration, server admin APIs, and all UI. The browser never sees the backend's address. `app/api/[...path]/route.ts` is a single native Next.js route dispatcher that calls control-plane modules under `lib/server/control-plane/` directly — it does **not** proxy to a generic backend.
- **`apps/backend`** — runs on every node, next to Docker. No users, sessions, or DB; the panel is its only caller and authenticates with a long-lived bearer token (root-equivalent). The one exception is the direct-console WebSocket and SFTP, which authenticate via panel-callback capability tokens — see `docs/direct-console.md` and `docs/sftp.md`.

## Common commands

Run from the repo root:

```bash
bun run setup          # create/repair .env + auth + DB migrations (interactive)
bun run dev:frontend   # Next.js on :3000
bun run dev:backend    # Bun node agent on :8081
bun run test           # bun test (backend) — tests are colocated *.test.ts
bun run typecheck      # tsc --noEmit across both apps
```

TypeScript path alias: `@/*` → repo root (`@/components`, `@/lib`, `@/app`).

## Dev server rules

**Never stop or restart a dev server the user started.** Before launching one, check whether the port is already in use (`3000` for frontend, `8081` for backend, e.g. `ss -ltnp | grep :3000`). If something is already listening, treat that as the user's server — use it, don't touch it.

Only start a dev server if **none** is running for that app. If you started it, you own it: stop every dev server you started before finishing the task. A dev server you started must not outlive your work.

## Committing

**Always commit when a task is done.** Finishing work without a commit leaves the
repo dirty for the next agent — don't do it. Never leave changes uncommitted
because the task "seems small".

Use the **`file-commit` skill** to write the commit. If that skill isn't
installed in this environment, fall back to your own judgement: stage only the
files your task touched, and write a conventional-commit message
(`feat(scope):`, `fix(scope):`, `docs:`, `test:`, …) matching the existing log.

- Commit only. Don't push unless the user asks.
- Never stage `.env`, secrets, or unrelated files that were already dirty when
  you started.
- If you're on `main` and the change is more than a small fix, branch first.

## Design system (frontend)

Follow the existing visual language exactly. Match the surrounding code — do not introduce new patterns, color literals, or component primitives.

- **shadcn `base-nova` style, `stone` base color, `default-translucent` menus.** Components live in `components/ui/` and are built on `@base-ui/react` primitives (not Radix) with `class-variance-authority`. Reuse them — don't hand-roll equivalents.
- **Tailwind v4 with CSS variables in `oklch`.** All colors come from `app/globals.css` tokens (`bg-card`, `text-muted-foreground`, `border`, `bg-primary`, …). Never use raw hex/rgb or arbitrary color values. Dark mode is driven by the `.dark` class; design for both themes.
- **`cn()` from `@/lib/utils`** merges classes (clsx + tailwind-merge). Every component accepts `className` and spreads it through `cn()`.
- **`data-slot` attributes** mark component parts (`data-slot="button"`, `data-slot="card-header"`). Keep this convention on new/edited components.
- **`cva` for variants**, with `VariantProps<typeof x>` exported. Sizes are dense (`h-8` default button, `text-sm`).
- **Icons from `lucide-react`**, default `size-4`, `className="size-4"`.
- Server pages are tabbed routes under `(panel)/servers/[id]/<section>`; see `components/server/server-tabs.tsx` for the section list. One route per section so each has its own URL.

## Documentation

`docs/` is the source of truth for how features are implemented. **Read the relevant doc before changing a feature**, and **update or add a doc when you implement or meaningfully change one.** Each doc covers one feature end-to-end: the flow, the security model, configuration, and the non-obvious design decisions (why the panel mints a capability token, why the agent is stateless, why `paths.ts` is the containment boundary, etc.).

Existing docs:

- `docs/first-time-setup.md` — the setup wizard and setup-gate latch.
- `docs/direct-console.md` — browser → agent WebSocket console, capability-token
  auth.
- `docs/sftp.md` — per-(user,server) SFTP credentials, panel-callback auth.
- `docs/subusers.md` — per-server delegated access: the permission flags,
  what each gates (API and UI), and the reads-gate-with-writes rule.
- `docs/file-editor.md` — the in-panel code editor: CodeMirror 6, CSS-var
  theming, the client-side binary sniff, and dirty/save semantics.
- `docs/server-lifecycle.md` — provisioning, the power actions and the stored
  status: why status is a record and the node is the truth, why a server is
  built *after* the create request answers (and what the `installing` gate and
  the admin-only install log are for), and how a container that vanished from
  its node is rebuilt on the next start instead of 404ing forever.
- `docs/ports.md` — published ports as identity mappings (host N → container
  N): per-node port pools, the `SERVER_PORT` env sync, and the owner's
  publish-a-port flow.
- `docs/server-links.md` — connecting a server to another of the owner's
  servers: the pairwise ICC-enabled link networks, stable container-name
  addresses (never container IPs), and cross-node public addresses.
- `docs/velocity-proxy.md` — the built-in Velocity proxy blueprint: why its
  listen port is patched into `velocity.toml` instead of injected as env, what
  the install step seeds (and which two keys stop Velocity booting into its own
  examples), and how backends are wired to it.
- `docs/plugins.md` — blueprint-declared plugin/mod support: the provider
  fetch spec (data, never code), the fetch engine's host pinning, and the
  pre-start auto-updater.
- `docs/database-explorer.md` — the in-panel database browser/editor for
  provisioned server databases: panel-composed SQL (never browser SQL), the
  scoped-user execution model, and why the agent parses `--xml` output.
- `docs/api-keys.md` — API keys for programmatic `/api/*` access: the
  key-is-its-owner session-synthesis model, the `Authorization: Bearer`
  alias, admin oversight (`/admin/api-keys`), and via-API-key audit
  attribution.
- `docs/ai-helper.md` — the AI console helper: admin OpenAI-compatible
  config (write-only key, fetch-models/test buttons), the panel-composed
  prompt flow, and why the browser only sends the question.
- `docs/theming.md` — the three-theme switcher (site/light/dark, no "system"),
  why the site theme's base is baked into its `<html>` class, and why an
  operator's colour is parsed to numbers before it becomes CSS.
- `docs/site-settings.md` — branding (the site name is a setting, not a
  constant), the registration toggle, SEO/`robots.txt`/`sitemap.xml` with
  indexing off by default, the Plausible/GA analytics toggle, and the error
  pages.
- `docs/backups.md` — restic snapshots to S3: the two scopes (owner-triggered
  server *files*, admin-triggered per-node *databases*) and why the credential
  forces that split, why restic in a throwaway container, the FIFO snapshot
  quota enforced before the new snapshot, the async job/reconciler split, the
  storage accounting, and why TLS is a field rather than part of the endpoint.
- `docs/legal-pages.md` — operator-authored terms and privacy policy: why the
  panel ships drafts rather than defaults, the "what this codebase stores"
  privacy inventory, and why Markdown is rendered to React nodes.
- `docs/performance.md` — the two costs that dominate a request: why the agent
  must never call `docker stats` with `stream: false`, and why panel read
  endpoints are shaped around the number of database round trips (read the row
  once, batch across rows, and the two caches whose writers must invalidate).

When adding a feature, create `docs/<feature>.md` in the same style and cross-link related docs. Don't duplicate what the code already says — document the *why* and the cross-cutting flow, the way the existing docs do.

## Backend conventions

- Fail fast at boot: `config.ts` validates env vars at import time. Keep that posture for new config.
- Routes are keyed by **server id**, never container id or host path — that indirection is load-bearing (see `servers.ts`).
- File operations resolve through `paths.ts`, which is the containment boundary (`..` traversal and symlink escapes are caught there). Don't bypass it.
- `SERVER_DATA_ROOT` is the only root; the panel never supplies a host path.
- Tests are colocated (`*.test.ts`, run with `bun test`). Add tests for new logic in `paths.ts`, `auth.ts`, `sftpAuth.ts`, `consoleAudit.ts`, etc.

## Secrets & security

- `.env` is gitignored and must never be committed. `.env.example` documents every variable.
- `AGENT_TOKEN` and `PANEL_ENCRYPTION_KEY` are root-equivalent. ≥32 chars, generated with `openssl rand -base64 48`. Use a different `AGENT_TOKEN` per node.
- The panel encrypts secrets at rest (node tokens, DB passwords, secret env values) with an AES-256-GCM key derived from `PANEL_ENCRYPTION_KEY`. Rotating it makes existing encrypted values unreadable.
- Audit every privileged action via `services/auditLog.ts`. Audit must never break the operation it records (fire-and-forget).
