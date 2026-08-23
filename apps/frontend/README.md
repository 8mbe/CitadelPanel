# CitadelPanel: Next.js control plane

This application owns the complete browser-facing panel and control plane:

- Better Auth sessions, users, and roles
- First-time setup and panel settings
- PostgreSQL metadata, permissions, and audit logs
- Node registration and scheduling
- Server administration APIs and UI
- Authenticated calls to Bun node backends

The browser only talks to this Next.js service on port 3000. Node URLs and bearer
tokens remain server-side and are encrypted in PostgreSQL.

## Development

From the repository root:

```bash
bun run setup         # creates/repairs .env, then runs auth + DB migrations
bun run dev:backend   # local Bun/Docker node, port 8081
bun run dev:frontend  # Next.js control plane, port 3000
```

`bun run setup` is interactive by default: it prompts for the main database and
panel settings using the current `.env` values as defaults, and generates any
missing secrets automatically (`POSTGRES_PASSWORD`, `PANEL_ENCRYPTION_KEY`,
`BETTER_AUTH_SECRET`, `AGENT_TOKEN`).

For unattended use, run `bun run setup -- --yes` to accept defaults and only
fill missing values.

## API architecture

`app/api/[...path]/route.ts` is a native Next.js route dispatcher. It invokes the
control-plane modules under `lib/server/control-plane` directly; it does not proxy
to a general backend service. Those modules use `postgres` for panel queries and
`pg` for Better Auth.

Server console output is polled through authorized Next.js endpoints. Commands
are authorized and audited in Next.js, then sent to the selected node's protected
`/v1/servers/:id/command` endpoint.

## Validation

```bash
bun run lint
bun run typecheck
bun run build
```
