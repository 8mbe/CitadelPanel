# CitadelPanel — Bun node backend

This service runs on each game-server node. It has no users, sessions, panel
database, or browser-facing API. The Next.js control plane is its only caller.

## Responsibilities

- Create and manage hardened Docker containers
- Read/write server files below `SERVER_DATA_ROOT`
- Return logs, state, health, capacity, and runtime statistics
- Accept console commands

Every `/v1/*` request requires a bearer token. Treat that token as a root
credential because this process controls the Docker socket.

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

For remote nodes, deploy `docker-compose.agent.yml`, keep port 8081 on a private
network or behind TLS, then register its URL and token in the panel.
