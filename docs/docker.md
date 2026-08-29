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
| `env:init`: generate secrets, write `.env` | a writable repo checkout | **host, before `compose up`** |
| `auth:migrate` + `db:migrate` | a reachable PostgreSQL | **in the control-plane container, at boot** |
| `/setup` wizard: admin account, timezone, captcha, first node | a browser | **first visit to the panel** |

So the deployment is:

```bash
bun run env:init                 # or: cp .env.example .env && fill it in
docker compose up -d --build
# open http://localhost:3000 → the setup wizard
```

### Why secrets are generated on the host

Compose interpolates `${POSTGRES_PASSWORD}`, `${PANEL_ENCRYPTION_KEY}` and
`${AGENT_TOKEN}` while it is *reading* the compose file, before any container
exists. A container cannot generate a value that compose already needed. The
`.env` file is the operator handing secrets to compose, not something the
application can bootstrap for itself.

This is also why the image's `CMD` runs `bun run migrate` and **not**
`bun run setup`. `env:init` inside the container would:

- write to a path outside `/app` that the unprivileged `nextjs` user cannot
  create, failing the boot; and
- if it could write, mint a **fresh `PANEL_ENCRYPTION_KEY`** on every start,
  which nothing reads (`process.env` from compose always wins) but which is one
  configuration slip away from making every secret already encrypted at rest
  unreadable. Node tokens, database passwords and secret env values are all
  encrypted with that key.

Without bun on the host, `.env.example` documents every variable; the three
secrets are `openssl rand -base64 48`.

### Why migrations run on every boot

The control-plane container runs `auth:migrate && db:migrate` before
`next start`. Both are idempotent. The panel's own migrator records applied
files in `schema_migrations`, Better Auth's CLI diffs the schema, and the
blueprint seed is an upsert, so the same command is the fresh install and the
upgrade. There is no separate "migrate" step for an operator to forget, and no
window where a new image serves requests against an old schema.

The container waits for `postgres` to be healthy (`depends_on` +
`pg_isready`), so the migration is not racing the database's first boot.

That probe passes `-d` as well as `-U`. `pg_isready` defaults the database name
to the user name, so an operator whose `POSTGRES_DB` differs from their
`POSTGRES_USER` — which the setup script's generated credentials make likely —
got a `FATAL: database "…" does not exist` in the postgres log every ten
seconds forever. Nothing was broken: the server answering "that database is not
here" is still a server that is up, so the check returned healthy and the only
symptom was a log nobody could read.

### What the wizard still owns

No account exists in a fresh image. `/setup` claims the first admin, sets the
timezone, optionally configures captcha, and optionally registers the first
node, all in the browser, gated on a database latch. See
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

That scoping changes *where* the packages land, which the runtime stage has to
respect. A filtered install does not hoist to the workspace root: bun writes
the agent's dependencies to `apps/backend/node_modules` and leaves the root
`node_modules` empty. A runtime stage that copies only `/app/node_modules`
therefore builds and pushes cleanly and then dies on its first import:

```
error: Cannot find package 'ssh2' from '/app/apps/backend/src/sftp.ts'
```

So the agent's runtime stage copies the whole `/app` tree from the deps stage
rather than one directory inside it. The deps stage holds nothing but the
manifests and the lockfile besides, and copying the tree keeps the image
correct whichever way a future bun decides to hoist.

The control-plane image keeps `devDependencies` on purpose: it runs the
migration scripts from source at boot and loads a TypeScript `next.config.ts`,
so pruning them buys layer size at the cost of a boot-time failure mode.

### Build-time placeholder env

`config/env.ts` validates at import time and Next evaluates route modules while
collecting build metadata, so the build sets throwaway `DATABASE_URL`,
`PANEL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`. Nothing connects during the
build, because the database clients are lazy, and runtime environment replaces
all three. They are values that *parse*, not values that work.

## The node agent

The agent is the only container with the Docker socket, and its token is
root-equivalent for that host. It can start a container with any mount the
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
sweep:

```
[agent] failed to sample server <id>: connect EACCES /var/run/docker.sock
```

That names the library, not the fix. So the socket is treated the way the
data root is (see `dataRoot.ts` and [performance.md](performance.md) for the
same posture applied elsewhere): probed at boot, probed again on every
`/v1/health`, never cached, and reported as a *status* rather than thrown.

- `docker/socket.ts` pings the daemon, and on failure reads the socket's inode
  and the process's own credentials to decide which of three things it is:
  permissions (`EACCES`/`EPERM`), no socket at all (`ENOENT`, which means Docker
  is not installed, or `DOCKER_SOCKET` points elsewhere), or a stopped daemon
  (`ECONNREFUSED`).
- `/v1/health` answers `status: "degraded"` with a `dockerSocket` object instead
  of 500-ing out of `docker.info()`. The panel shows that on the node's admin
  page and in the connection test, and `assertNodeReadyToProvision` refuses to
  place a server on such a node, the same pre-flight the data root gets.
- The agent stays up either way. A process that exits on a bad socket reads to
  the panel as "node unreachable", which sends the operator after a network
  fault when the problem is a group membership on the host.

The permission case has a trap worth stating, because it makes a correct fix
look like it did not work: **supplementary groups are fixed when a process
starts.** `sudo usermod -aG docker $USER` changes `/etc/group`, not the groups
of anything already running, so an agent (or a shell, or a dev-server process
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

- `servers/` holds game data. The path the agent reports is the path the daemon
  bind-mounts into game containers, so the mount is identical on both sides
  (`/var/lib/citadel:/var/lib/citadel`). A named volume, or a different path
  inside the container, would make the agent report paths the daemon cannot
  resolve.
- `sftp_host_key` is generated on first boot. Inside the container only, it is
  regenerated on every restart and every SFTP client sees a changed
  fingerprint.
- `backup-staging/` holds database dumps and restic's chunk cache. restic runs
  in a *sibling* container that bind-mounts this directory **from the host**, so
  a path that exists only inside the agent's filesystem gives restic an empty
  directory. See [backups.md](backups.md).

### Ports

| Port | Service | Exposure |
|------|---------|----------|
| 3000 | control plane | public (put TLS in front) |
| 8081 | agent HTTP/WS | browsers reach it for the direct console, behind a TLS proxy or `AGENT_TLS_*` |
| 8022 | agent SFTP | operators' SFTP clients; keep it on a trusted network |

Every listener is fixed *inside* its container (`3000` for the panel,
`AGENT_PORT=8081`, `SFTP_PORT=8022`). Only the published host side moves, via
`PANEL_PORT`, `AGENT_PUBLIC_PORT` and `SFTP_PORT`. Keeping the inside fixed is
what lets `PANEL_URL`, the healthchecks and the agent's own callbacks name a
constant port regardless of what the host had free.

A taken host port is not a subtle failure. The daemon refuses the container
outright and the deploy stops:

```
Bind for 0.0.0.0:3000 failed: port is already allocated
```

This is the usual first result of deploying the panel onto a PaaS, because
**Dokploy serves its own dashboard on 3000** — its installer requires 80, 443
and 3000 to be free. Set `PANEL_PORT` to something else, or, better, publish
nothing and let the platform's proxy reach the container on 3000 directly:
add a domain pointing at the `frontend` service and put it on
`dokploy-network`. Publishing a host port and routing through Traefik are
alternatives, not a pair.

If the panel is served over HTTPS, the agent **must** be reachable as `wss://`.
A browser blocks a `ws://` connection from an `https://` page as mixed content.
Either terminate TLS in a proxy in front of 8081 or give the agent
`AGENT_TLS_CERT`/`AGENT_TLS_KEY` and mount the material. See
[direct-console.md](direct-console.md) and [sftp.md](sftp.md).

### Service names are aliases, because a PaaS may rename them

Three hostnames hold this stack together: `postgres` in `DATABASE_URL`,
`frontend` in the agent's `PANEL_URL`, and the node's API URL stored in the
database at registration. All three are resolved by Docker's embedded DNS, and
under plain `docker compose` a service's name *is* its hostname, so they need
nothing.

A PaaS deploying this file may not leave the names alone. Dokploy is the case
that surfaced it: its **Randomize** option rewrites every service to
`<name>-<suffix>` (and every network and volume with it) so two projects on one
host cannot collide. The panel then looks up `postgres`, gets NXDOMAIN, and the
symptom is a control plane that cannot find a database that is running fine two
containers away.

So every service declares an explicit **network alias** rather than relying on
its service name:

```yaml
    networks:
      panel_net:
        aliases:
          - postgres
```

Aliases are the one part of the specification those transforms copy through
untouched — Dokploy's network rewriter suffixes the keys around them and
special-cases `aliases` to leave the values alone. The alias is therefore a
hostname the deployment platform has promised not to touch, which is exactly
what an environment variable pointing at it needs. `backend` carries two
(`agent` and its own service name) because a node's address is typed by an
operator at registration and stored in the database, where a later redeploy has
no opportunity to correct it.

Note which Dokploy feature does what, because the names mislead: **Isolated
Deployment** does *not* rename services (it only attaches them to a
per-project external network), so only **Randomize** ever needed this. The
aliases are harmless either way, and plain `docker compose up` is unaffected.

Two things this file deliberately does *not* do for Dokploy's sake. It sets no
`container_name` — Dokploy breaks on that, and Compose's generated names are
what its logs and metrics key on. And it does not join `dokploy-network`, which
would have to be declared `external: true` and would then break every plain
`docker compose up` on a host that has no such network; an operator routing
Traefik to the panel adds that network to the `frontend` service themselves.

## Upgrading

```bash
git pull
docker compose up -d --build
```

The new control-plane container migrates on boot. Node agents are independent:
they hold no state of their own, so an agent can be rebuilt at any time. The
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
