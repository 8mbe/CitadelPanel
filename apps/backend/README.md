# CitadelPanel — Bun node backend

This service runs on each game-server node. It has no users, sessions, panel
database, or browser-facing API. The Next.js control plane is its only caller.

## Responsibilities

- Create and manage hardened Docker containers
- Read/write server files below `SERVER_DATA_ROOT`
- Return logs, state, health, capacity, and runtime statistics
- Accept console commands
- Serve the direct console WebSocket (browser → agent, capability-token gated)
- Serve a custom SFTP server (per-(user,server) credentials, panel-callback auth,
  chrooted to each server's data directory)

Every `/v1/*` request requires a bearer token. Treat that token as a root
credential because this process controls the Docker socket.

| `AGENT_MAX_UPLOAD_BYTES` | `134217728` | Cap on a single uploaded file or URL pull (128 MB). |
| `AGENT_MAX_DIR_ENTRIES` | `2000` | Cap on directory listing size. |
| `PANEL_URL` | `""` | Panel base URL for direct-console validate/audit callbacks. Empty disables the browser-direct console (the WS path returns 503). |
| `AGENT_TLS_CERT` | `""` | Path to PEM cert. When set with `AGENT_TLS_KEY`, the agent serves HTTPS/WSS. |
| `AGENT_TLS_KEY` | `""` | Path to PEM key. |
| `NODE_DB_NETWORK` | `node_db_net` | Docker network the shared node database lives on. The setup script creates it; the agent attaches server containers to it when their owner provisions a database. |
| `NODE_DB_CONTAINER` | `citadel-node-db` | Name of the MariaDB container on `NODE_DB_NETWORK`. Used by the agent to exec SQL and resolve the database's IP. |

The direct console (`/v1/sessions/:token/console`) is the one path that does
**not** use the bearer token — it authenticates with a short-lived, single-use
capability token the panel mints. See `docs/direct-console.md`.


## Development

```bash
AGENT_TOKEN=development-token bun run dev
bun test
bun run typecheck
```

The service listens on port `8081` by default. Configuration:

- `NODE_TOKEN` or legacy `AGENT_TOKEN` — required bearer token
- `AGENT_PORT` — defaults to `8081`
- `SERVER_DATA_ROOT` — defaults to `/var/lib/citadel/servers`
- `DOCKER_SOCKET` — defaults to `/var/run/docker.sock`
- `AGENT_MAX_FILE_BYTES` and `AGENT_MAX_DIR_ENTRIES` — file API limits

## Server data root

The agent creates each server's directory under `SERVER_DATA_ROOT` **as its own
user**, so that directory must be writable by whoever runs the process. The
default `/var/lib/citadel/servers` is root-owned, which means a `bun run dev`
started by an ordinary user cannot provision anything. Either give the agent's
user ownership:

```bash
sudo mkdir -p /var/lib/citadel/servers
sudo chown -R "$(id -u):$(id -g)" /var/lib/citadel/servers
```

…or point the agent somewhere it already owns (what `apps/backend/.env` does for
local development):

```bash
SERVER_DATA_ROOT=$HOME/.local/share/citadel/servers
```

The root's state is not left to be discovered by a failed provision. It is
probed at boot — the log line says `(writable)` or prints the exact command that
fixes it — and on every `/v1/health` call, which the panel checks before placing
a server on the node. A node whose root is unwritable refuses creation with 503
and that same remediation text, shown to the admin who requested the server;
`Test connection` in the panel's node UI reports it too.

## Shared node database (optional)

A node can host one shared MariaDB instance that server owners request
databases from (for plugins/mods that need MySQL). It is optional: a node
without it simply cannot provision databases, and servers on it work normally.

Set it up once per node:

```bash
bun run setup-db
```

This creates a `node_db_net` Docker network (with inter-container communication
disabled, so tenants on it can reach the database but not each other) and a
MariaDB container with a randomly-generated root password. No host ports are
published — the database is only reachable from containers attached to
`node_db_net`.

The script prints the connection details (`dbAdminHost`, `dbAdminPort`,
`dbAdminUser`, `dbAdminPassword`). Paste those into the node registration form
in the panel; they are stored encrypted and used to create/drop per-server
databases and users on demand.

The host it prints is the MariaDB container's IP on `node_db_net` — that is the
address the agent (and therefore server containers) use to connect.

For remote nodes, deploy `docker-compose.agent.yml`, keep port 8081 on a private
network or behind TLS, then register its URL and token in the panel.
