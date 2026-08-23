# Docker Deployment

Two images, because the panel is two things: a control plane that owns the
database and every browser-facing route, and a node agent that owns a Docker
daemon. They are built from the same repository and deployed to different
machines.

| Image | Dockerfile | Where it runs | What it needs |
|-------|-----------|---------------|---------------|
| Control plane | `apps/frontend/Dockerfile` | one machine, public | PostgreSQL, secrets |
| Node agent | `apps/backend/Dockerfile` | every game-server node | the Docker socket, a token |

Two compose files match that split: `docker-compose.yml` brings up
PostgreSQL + control plane + one local node, and
`docker-compose.agent.yml` is the agent alone, to copy onto each additional
node.

## Where setup happens

`bun run setup` is convenient on a workstation but it is three unrelated jobs,
and only one of them can run inside a container. Splitting them is the whole
design of these images.

| Job | Needs | Runs |
|-----|-------|------|
| `env:init` — generate secrets, write `.env` | a writable repo checkout | **host, before `compose up`** |
| `auth:migrate` + `db:migrate` | a reachable PostgreSQL | **in the control-plane container, at boot** |
| `/setup` wizard — admin account, timezone, captcha, first node | a browser | **first visit to the panel** |

So the deployment is:

```bash
bun run env:init                 # or: cp .env.example .env && fill it in
docker compose up -d --build
# open http://localhost:3000 → the setup wizard
```

### Why secrets are generated on the host

Compose interpolates `${POSTGRES_PASSWORD}`, `${PANEL_ENCRYPTION_KEY}` and
`${AGENT_TOKEN}` while it is *reading* the compose file — before any container
exists. A container cannot generate a value that compose already needed. The
`.env` file is the operator handing secrets to compose, not something the
application can bootstrap for itself.

This is also why the image's `CMD` runs `bun run migrate` and **not**
`bun run setup`. `env:init` inside the container would:

- write to a path outside `/app` that the unprivileged `nextjs` user cannot
  create, failing the boot; and
- if it could write, mint a **fresh `PANEL_ENCRYPTION_KEY`** on every start —
  which nothing reads (`process.env` from compose always wins) but which is one
  configuration slip away from making every secret already encrypted at rest
  unreadable. Node tokens, database passwords and secret env values are all
  encrypted with that key.

Without bun on the host, `.env.example` documents every variable; the three
secrets are `openssl rand -base64 48`.

### Why migrations run on every boot

The control-plane container runs `auth:migrate && db:migrate` before
`next start`. Both are idempotent — the panel's own migrator records applied
files in `schema_migrations`, Better Auth's CLI diffs the schema, and the
blueprint seed is an upsert — so the same command is the fresh install and the
upgrade. There is no separate "migrate" step for an operator to forget, and no
window where a new image serves requests against an old schema.

The container waits for `postgres` to be healthy (`depends_on` +
`pg_isready`), so the migration is not racing the database's first boot.

### What the wizard still owns

No account exists in a fresh image. `/setup` claims the first admin, sets the
timezone, optionally configures captcha, and optionally registers the first
node — all in the browser, gated on a database latch. See
[first-time-setup.md](first-time-setup.md). Deploy behind a firewall until that
first admin is claimed: whoever reaches the panel first becomes admin.

## Build context is the repository root

Both Dockerfiles are built with the **repository root** as context:

```bash
docker build -f apps/frontend/Dockerfile -t citadel-panel .
docker build -f apps/backend/Dockerfile  -t citadel-agent .
```

`bun.lock` lives at the root and covers both workspaces. Building from
`apps/frontend` would leave the lockfile outside the context, and an install
without it is an unpinned install that resolves differently on every rebuild.
Each image copies the root manifest + lockfile + both workspace manifests
first, so a source-only change reuses the dependency layer. The agent's install
is scoped (`--filter=backend --production`) so a node never carries the panel's
Next.js tree.

The control-plane image keeps `devDependencies` on purpose: it runs the
migration scripts from source at boot and loads a TypeScript `next.config.ts`,
so pruning them buys layer size at the cost of a boot-time failure mode.

### Build-time placeholder env

`config/env.ts` validates at import time and Next evaluates route modules while
collecting build metadata, so the build sets throwaway `DATABASE_URL`,
`PANEL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`. Nothing connects during the
build — the database clients are lazy — and runtime environment replaces all
three. They are values that *parse*, not values that work.

## The node agent

The agent is the only container with the Docker socket, and its token is
root-equivalent for that host — it can start a container with any mount the
agent allows. It runs as root because the socket's group id differs per host;
its containment boundary is `paths.ts` and the bearer token, not a uid.

Deploying an extra node is the agent compose file plus a `.env` holding
`AGENT_TOKEN` and `PANEL_URL`; there is no database, no migration and no setup
step on a node. Register it afterwards from `/admin/nodes` (or the wizard's
last step), which is where the panel learns the address and stores the token
encrypted.

### Socket access, and why the agent reports it

An agent that cannot open the socket is not a broken agent: it boots, serves
HTTP, answers `/v1/health`, and fails every container operation. Left
undiagnosed it surfaced as one dockerode stack trace per container per stats
sweep —

```
[agent] failed to sample server <id>: connect EACCES /var/run/docker.sock
```

— which names the library, not the fix. So the socket is treated the way the
data root is (see `dataRoot.ts` and [performance.md](performance.md) for the
same posture applied elsewhere): probed at boot, probed again on every
`/v1/health`, never cached, and reported as a *status* rather than thrown.

- `docker/socket.ts` pings the daemon, and on failure reads the socket's inode
  and the process's own credentials to decide which of three things it is:
  permissions (`EACCES`/`EPERM`), no socket at all (`ENOENT` — Docker is not
  installed, or `DOCKER_SOCKET` points elsewhere), or a stopped daemon
  (`ECONNREFUSED`).
- `/v1/health` answers `status: "degraded"` with a `dockerSocket` object instead
  of 500-ing out of `docker.info()`. The panel shows that on the node's admin
  page and in the connection test, and `assertNodeReadyToProvision` refuses to
  place a server on such a node — the same pre-flight the data root gets.
- The agent stays up either way. A process that exits on a bad socket reads to
  the panel as "node unreachable", which sends the operator after a network
  fault when the problem is a group membership on the host.

The permission case has a trap worth stating, because it makes a correct fix
look like it did not work: **supplementary groups are fixed when a process
starts.** `sudo usermod -aG docker $USER` changes `/etc/group`, not the groups
of anything already running — so an agent (or a shell, or a dev-server process
tree) started before that command keeps the old group set no matter how many
times the command is repeated. A *new login session* is what applies it:

```bash
sudo usermod -aG docker "$(id -un)"   # once, per host
newgrp docker                          # or log out and back in
# then start the agent from that session
```

For a running process that must not be restarted, an ACL grants access
immediately and resets when the daemon restarts:

```bash
sudo setfacl -m u:"$(id -un)":rw /var/run/docker.sock
```

Containerised agents dodge all of this: the compose file bind-mounts the socket
and the agent runs as root inside its own namespace, which is why the image does
not try to guess the host's docker gid.

### `/var/lib/citadel` is bind-mounted whole

Not just `servers/`. The agent puts three things in that tree, and all of them
have to be real host paths:

- `servers/` — game data. The path the agent reports is the path the daemon
  bind-mounts into game containers, so the mount is identical on both sides
  (`/var/lib/citadel:/var/lib/citadel`). A named volume, or a different path
  inside the container, would make the agent report paths the daemon cannot
  resolve.
- `sftp_host_key` — generated on first boot. Inside the container only, it is
  regenerated on every restart and every SFTP client sees a changed
  fingerprint.
- `backup-staging/` — database dumps and restic's chunk cache. restic runs in a
  *sibling* container that bind-mounts this directory **from the host**, so a
  path that exists only inside the agent's filesystem gives restic an empty
  directory. See [backups.md](backups.md).

### Ports

| Port | Service | Exposure |
|------|---------|----------|
| 3000 | control plane | public (put TLS in front) |
| 8081 | agent HTTP/WS | browsers reach it for the direct console — TLS proxy, or `AGENT_TLS_*` |
| 8022 | agent SFTP | operators' SFTP clients; keep it on a trusted network |

The agent's listen ports are fixed inside the container (`AGENT_PORT=8081`,
`SFTP_PORT=8022`); remap the published side if the host has a conflict.

If the panel is served over HTTPS, the agent **must** be reachable as `wss://`
— a browser blocks a `ws://` connection from an `https://` page as mixed
content. Either terminate TLS in a proxy in front of 8081 or give the agent
`AGENT_TLS_CERT`/`AGENT_TLS_KEY` and mount the material. See
[direct-console.md](direct-console.md) and [sftp.md](sftp.md).

## Upgrading

```bash
git pull
docker compose up -d --build
```

The new control-plane container migrates on boot. Node agents are independent:
they hold no state of their own, so an agent can be rebuilt at any time — the
containers it manages keep running, and the panel re-reads their status from
the node. See [server-lifecycle.md](server-lifecycle.md) for why the node, not
the panel, is the truth about a container.

## Secrets checklist

- `.env` is gitignored and excluded from both build contexts by
  `.dockerignore`; secrets reach a container as environment, never as a layer.
- `AGENT_TOKEN` must differ per node. It grants root-equivalent control of that
  host.
- `PANEL_ENCRYPTION_KEY` is not rotatable in place: everything encrypted at
  rest becomes unreadable. Back it up with the database, not next to it.
