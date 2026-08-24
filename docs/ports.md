# Ports

How a server's published ports are allocated, forwarded, and kept in sync with
the game process. Covers the identity-mapping model, the dual-protocol claim,
the per-node port pools, and why nobody picks a port number.

## The model: one number, identity-mapped, TCP + UDP

A published port is **a single number**. Two things follow from that, and both
are deliberate:

- **Identity mapping.** Docker publishes host port N and the game binds port N
  inside the container (`host N → container N`). Nothing translates between the
  two sides, so the port a player connects to is also the port in every config
  file and plugin setting. There is no "internal port" to remember.
- **Both protocols.** Every published number is claimed on TCP *and* UDP. The
  panel never asks which one, because the answer was almost always "both" and
  the question produced real breakage: a Java server that later added a
  Geyser/voice-chat plugin needed the UDP half of a number it already owned, and
  a port pool an admin had reserved as UDP silently could not host a Java
  server. Worse, `25565/tcp` and `25565/udp` could be allocated to two
  *different* servers, two allocations that looked like one port to everybody
  reading the panel.

The agent's container spec is still per-protocol (`PortBinding` carries
`protocol`), so the panel expands each stored number into a tcp and a udp
binding at create/recreate time, in `portBindingsFor`
(`nodes/nodeServerApi.ts`). That is on purpose: collapsing it at the wire would
mean every node had to be upgraded in lockstep with the panel for allocation to
work at all.

Because the game must bind the allocated number itself, the blueprint declares
which env var carries the primary port to the game process
(`Blueprint.primaryPortEnv`, stored as `blueprints.primary_port_env`):

- `minecraft-java` → `SERVER_PORT` (the itzg image writes
  `server.properties`' `server-port` from it)
- `minecraft-bedrock` → `SERVER_PORT` (the itzg image rewrites
  `server.properties` from it, overriding manual edits, by design of the image)
- `velocity` → `CFG_PROXY_PORT` (Velocity's listen address lives in
  `velocity.toml`, not in any env var, so the proxy blueprint routes the number
  through the image's start-time config patcher, see `velocity-proxy.md`)

The panel sets that env var to the allocated primary port at create time and
**re-syncs it on every container recreate** (`recreateServerContainer` in
`services/serverManager.ts`), so a changed allocation can never leave the game
listening where nothing is forwarded. The key is deliberately absent from the
blueprint's `envSchema`, which means owners cannot edit it and create-time
requests cannot inject it. Only the panel writes it.

The node agent enforces the invariant at the far end: `docker/hardening.ts`
rejects any non-identity binding (`hostPort !== containerPort`) at container
create, so a confused or hostile panel cannot reintroduce split mappings.

`server_ports` still stores both `host_port` and `container_port` (the primary
key needs a port column and legacy rows predate the change; migration
`017_port_identity.sql` collapsed them onto the identity form), but
`container_port` is internal, and the API exposes a single `port`.
Migration `023_ports_dual_protocol.sql` is what dropped `protocol` from
`server_ports`, `node_port_pools` and blueprint port declarations; read its
header for what it does to rows that had the same number split across two
servers.

## Nobody picks a number: allocation is random

The panel chooses every port. There is no port field in the admin's provisioning
form, no port field on the owner's Ports tab, and no `preferredPort` in the
create API.

`allocateHostPort` (`nodes/scheduler.ts`) draws a **random** free number from
the node's pool. Walking the pool in ascending order, what it used to do, had
two costs: allocation was predictable from outside (the Nth server on a node got
the Nth port), and a freed port went straight back to the next server created,
inheriting whatever scanners and stale client entries the previous tenant had
attracted.

The one exception is a blueprint's own declared number
(`BlueprintPort.container`, e.g. 25565 for Minecraft Java). It is tried first,
because it is part of the game's definition rather than a user's pick and
players expect to type it; when it is not in the pool or not free, the draw is
random like everything else. That is also why the number stays in the blueprint
form: it says "this game's canonical port", not "give me this port".

Two freeness checks, layered:

- `server_ports` filters out what CitadelPanel has already allocated.
  `UNIQUE(node_id, host_port)`, now spanning both protocols at once, which is
  what makes the claim indivisible, is the real concurrency safety net; the
  scan is an optimisation.
- The node agent confirms the number is bindable on the host *right now, on both
  protocols* (`checkPortNumbersFree` expands each number into a tcp and a udp
  probe in one round trip). A number held on either half is not a candidate.

A batch of up to 8 candidates goes to the agent per allocation, so a handful of
host-occupied ports does not exhaust the attempt in a single round trip.

TOCTOU remains: between the agent's "free" answer and the container's bind, a
non-panel process can take the port. Panel-side races are caught by the DB
constraint (one INSERT wins on 23505); a lost race with a foreign process
surfaces as a container-create failure, which the create flow already records
as `error`.

## Where ports come from: per-node pools

Every published port is drawn from a **port pool an admin reserved on the node**
(`node_port_pools`, managed on the node page). A pool entry is a set of numbers
(`25565-25570`, `25565,25578`) reserved for both protocols; entries are verified
through the agent to be actually bindable on the host, on TCP and UDP, before
they are reserved, and overlaps between entries are rejected at add time so the
pool stays a clean disjoint set. See `nodes/portPool.ts` and
`nodes/scheduler.ts`.

There is no default range: a node with no pool cannot host servers until an
admin reserves one. Because that failure only shows up at the first
provisioning attempt, the setup wizard reserves the first range immediately
after registering a node rather than leaving it to be discovered later. See
[first-time-setup.md](first-time-setup.md).

## Adding and removing ports as the owner

The Ports tab (`components/server/ports-tab.tsx`) lists every published port as
a number badged `TCP + UDP`. Blueprint ports, including the primary player
port, are read-only (badged "Blueprint"/"Primary"); owner-added ports are badged
"Additional" and removable.

Publishing a port is one button: the owner supplies an optional label, the panel
allocates a random free number and the response names it (the tab says
"Port 25571 published (TCP and UDP)"). Asking the owner for a number only ever
produced failures that were not theirs to fix, like "not in the node's pool",
"already allocated to another server" or "held by a host process", for a number
that has no meaning until the panel has allocated it anyway. A plugin config is
pointed at the number *after* it exists.

Publishing a port requires the `settings` permission, so subusers need it too
(the reads-gate-with-writes rule from `subusers.md`). Docker port bindings are
fixed at container creation, so both add and remove **recreate the container**:
a running server is stopped, rebuilt with the new binding set, and restarted.
The owner experiences that as a brief restart, which the UI states inline. The
per-server cap (`maxAdditionalPortsPerServer` in admin general settings) is
enforced before anything is allocated, so a refused add never consumes a pool
port.

`POST /api/servers/:id/ports` takes `{ label? }` and
`DELETE /api/servers/:id/ports?port=N` identifies a port by number alone. A
stale client that still sends `port`/`protocol` is not rejected. The keys are
ignored, and the panel-chosen number comes back in the response.

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
They render on the server's Settings tab and take effect on the next restart,
on the same machinery as every other editable env var (only keys the blueprint
marks `editable` are accepted by `PATCH /api/servers/:id/env`). Fields without a
stored value (e.g. `JVM_OPTS` was never set) are shown with an empty input; the
env route synthesizes them from the schema so there is always something to edit.
