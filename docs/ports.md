# Ports

How a server's published ports are allocated, forwarded, and kept in sync with
the game process. Covers the identity-mapping model, the per-node port pools,
and the owner-facing "publish a port" flow.

## The model: one number, identity-mapped

A published port is **a single number**, not a host/container pair: Docker
publishes host port N and the game binds port N inside the container
(`host N → container N`). Nothing translates between the two sides, so the
port a player connects to is also the port in every config file and plugin
setting — there is no "internal port" to remember.

Because the game must bind the allocated number itself, the blueprint declares
which env var carries the primary port to the game process
(`Blueprint.primaryPortEnv`, stored as `blueprints.primary_port_env`):

- `minecraft-java` → `SERVER_PORT` (the itzg image writes
  `server.properties`' `server-port` from it)
- `minecraft-bedrock` → `SERVER_PORT` (the itzg image rewrites
  `server.properties` from it, overriding manual edits — by design of the image)
- `velocity` → `CFG_PROXY_PORT` (Velocity's listen address lives in
  `velocity.toml`, not in any env var, so the proxy blueprint routes the number
  through the image's start-time config patcher — see `velocity-proxy.md`)

The panel sets that env var to the allocated primary port at create time and
**re-syncs it on every container recreate** (`recreateServerContainer` in
`services/serverManager.ts`), so a changed allocation can never leave the game
listening where nothing is forwarded. The key is deliberately absent from the
blueprint's `envSchema`, which means owners cannot edit it and create-time
requests cannot inject it — only the panel writes it.

The node agent enforces the invariant at the far end: `docker/hardening.ts`
rejects any non-identity binding (`hostPort !== containerPort`) at container
create, so a confused or hostile panel cannot reintroduce split mappings.

`server_ports` still stores both `host_port` and `container_port` (the primary
key needs a port column and legacy rows predate the change; migration
`017_port_identity.sql` collapsed them onto the identity form), but
`container_port` is internal — the API surface exposes a single `port`.

## Where ports come from: per-node pools

Every published port is drawn from a **port pool an admin reserved on the
node** (`node_port_pools`, managed on the node page). Pool entries are verified
through the agent to be actually bindable on the host before they are reserved,
and `UNIQUE(node_id, host_port, protocol)` on `server_ports` is the concurrency
safety net. See `nodes/portPool.ts` and `nodes/scheduler.ts`.

Two allocation modes:

- **Best-effort** (`allocateHostPort`) — used at server create. A preferred
  number (the admin's `preferredPort`, else the blueprint's declared port, e.g.
  25565) is honored when it is in the pool and free; otherwise the next free
  pool port is drawn. A create must not fail just because 25565 is taken.
- **Strict** (`allocateSpecificHostPort`) — used when an owner publishes an
  additional port. The exact number must be in the pool, unallocated, and free
  on the host; each failure is a readable 409. No fallback is substituted
  because the owner chose that number for a reason (a plugin config references
  it).

## Adding and removing ports as the owner

The Ports tab (`components/server/ports-tab.tsx`) lists every published port as
`port/protocol`. Blueprint ports — including the primary player port — are
read-only (badged "Blueprint"/"Primary"); owner-added ports are badged
"Additional" and removable.

Publishing a port requires the `settings` permission (so subusers need it too —
the reads-gate-with-writes rule from `subusers.md`). Docker port bindings are
fixed at container creation, so both add and remove **recreate the container**:
a running server is stopped, rebuilt with the new binding set, and restarted —
experienced by the owner as a brief restart, which the UI states inline. The
per-server cap (`maxAdditionalPortsPerServer` in admin general settings) is
enforced before anything is allocated.

RCON is disabled (`ENABLE_RCON: false` on the Java blueprint): the panel console
talks to the container's stdin over the attach stream (`direct-console.md`), so
an inbound RCON listener would be a second, password-gated way into the server
with no panel use case. Owners who want a port for a plugin's own listener use
the publish-a-port flow instead.

The identity mapping is also what makes server-to-server links simple
(`server-links.md`): a peer's published port number is valid on the internal
link network too, so the link address is just `container-name:port`.

## JVM tuning as owner-editable env

The Java blueprint marks the itzg image's JVM knobs `editable`:
`USE_AIKAR_FLAGS`, `USE_SIMD_FLAGS`, `JVM_OPTS`, `JVM_XX_OPTS`, `JVM_DD_OPTS`.
They render on the server's Settings tab and take effect on the next restart —
same machinery as every other editable env var (only keys the blueprint marks
`editable` are accepted by `PATCH /api/servers/:id/env`). Fields without a
stored value (e.g. `JVM_OPTS` was never set) are shown with an empty input; the
env route synthesizes them from the schema so there is always something to edit.
