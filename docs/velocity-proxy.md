# Velocity proxy

The built-in blueprint for a Minecraft proxy (`velocity`), and the one place in
the panel where a server's listen port lives in a **config file** instead of an
environment variable. Covers how the panel keeps that port honest, what the
install step seeds and why, and how an owner wires backends to it.

Related: `server-links.md` (how the proxy reaches a backend), `ports.md` (the
identity-mapping model this blueprint has to satisfy the hard way),
`plugins.md` (the Plugins tab it gets).

## What it is

A proxy is not a game server — nothing plays on it. Players connect to it and
it hands them to one of the owner's *other* servers, which is what makes it the
front door of a network: one address for players, several backends behind it,
and no visible reconnect when they move between them.

The blueprint runs [`itzg/mc-proxy`](https://github.com/itzg/docker-mc-proxy)
with `TYPE=VELOCITY`. That image downloads the Velocity jar itself and
understands the same JVM/plugin env vars as the Minecraft images, so the
blueprint is mostly ordinary: data at `/server`, pinned to uid 1000, one
primary TCP port (25565 preferred), plugins from Modrinth.

Two things are not ordinary, and both are about `velocity.toml`.

## The bind port: patched, not injected

Velocity reads its listen address from `bind` in `velocity.toml`. There is no
`SERVER_PORT`-style variable — the one the image documents only steers its own
health check. But the panel publishes ports as identity mappings (`ports.md`):
the number Docker publishes on the host is the number the process must bind
inside the container, and the agent *refuses* a split mapping. A proxy that
binds Velocity's default while the pool handed out something else is a server
nobody can reach.

So the port reaches Velocity through the image's start-time config patcher
instead of through the process env:

- `Blueprint.primaryPortEnv` is **`CFG_PROXY_PORT`**. The panel writes the
  allocated port there at create time and re-syncs it on every container
  recreate, exactly as it does `SERVER_PORT` for the Minecraft blueprints.
- The install step writes a patch definition to
  `/server/.citadel/velocity-bind.json` that sets `$.bind` to
  `0.0.0.0:${CFG_PROXY_PORT}`, and `PATCH_DEFINITIONS` points the container at
  it. `mc-image-helper patch` expands the placeholder from the environment
  **on every start**, so the bind follows the allocation rather than a value
  frozen at provisioning time.
- The `CFG_` prefix is load-bearing: the patcher only substitutes placeholders
  for variables carrying its `--patch-env-prefix` (default `CFG_`). Renaming
  the variable without renaming the placeholder would silently stop the sync.

The price, stated plainly because owners see it: **the patcher re-serializes
`velocity.toml` on every start.** Values survive, formatting does not —
comments are dropped and `[section]` headers come back as dotted keys
(`servers.try = []`). Editing values is safe; expecting comments or layout to
persist is not. Ordinary TOML rules still apply to hand edits: a root-level key
written *after* a `[servers]` header belongs to that table, and Velocity will
reject the file on the next start.

## What the install step seeds

The patcher can only rewrite a `bind` that already exists, so the config cannot
be left to Velocity's own first-boot generation — the first bind has to be
right. The install step (a throwaway `alpine:3` container with the data dir
mounted) writes:

- **`velocity.toml`**, if absent: `config-version`, the allocated `bind`,
  `motd`, `show-max-players`, `online-mode`, `player-info-forwarding-mode =
  "modern"`, `forwarding-secret-file`, plus two keys that exist purely to stop
  Velocity from booting into its own examples — `servers = { try = [] }` and
  `forced-hosts = {}`. Absent keys fall back to the **packaged default config**,
  whose example forced hosts (`lobby.example.com` → `lobby`) and `try = ["lobby"]`
  name servers that don't exist; Velocity treats that as an invalid
  configuration and refuses to start. Empty *inline* tables are the form that
  survives the patcher's rewrite (an empty `[section]` header does not).
- **`forwarding.secret`**, if absent: 32 random alphanumerics, written with no
  trailing newline. The file's bytes *are* the secret, and the same string has
  to be pasted into each backend — a stray newline is a mismatch that shows up
  as an unexplained kick.
- **the bind patch**, unconditionally, so a re-provision repairs it.

The script runs as root, and — like every container the agent creates — under
`CapDrop: ALL`. Without `CAP_CHOWN` it cannot hand its files to the uid that
runs the proxy, so it sets `umask 0000` instead: root-owned, but writable by
uid 1000 and therefore by the container, the file editor and SFTP. The runtime
container is pinned to `1000:1000` with `SKIP_PRIVILEGE_DROP` /
`SKIP_CHOWN_DATA` set, for the same reason the Minecraft blueprints set
`SKIP_SUDO` — the image's own `runuser`/`chown` dance needs capabilities the
panel drops.

## Connecting backends

Two halves, and the panel only owns one of them:

1. **Reachability** is a server link (`server-links.md`): Settings →
   "Connect servers" on the proxy, then the address the panel shows —
   `citadel-<id12>:<port>` on the same node, `hostname:port` across nodes.
   Never a container IP; those change on every recreate.
2. **Configuration** is `velocity.toml`, edited in the Files tab: one
   `servers` entry per backend (`name = "address"`) and the names players may
   land on in `try`.

Each backend then needs Velocity's modern forwarding enabled on its side —
`online-mode=false` in `server.properties` plus the proxy's secret in
`config/paper-global.yml` under `proxies.velocity`. That combination is also
what keeps the published backend port from becoming a bypass: with modern
forwarding required, a client connecting to a backend directly is rejected
because it carries no forwarded player data.

## Plugins, versions, console

- **Plugins** resolve from a *static* profile rather than an env-driven one —
  a Velocity proxy only ever loads Velocity plugins from `plugins/`, so there
  is nothing to switch on (contrast minecraft-java's `TYPE`). Compatibility
  filtering reads `MINECRAFT_VERSION`, the image's own name for "which
  Minecraft version are the backends"; leave it on `LATEST` and filtering is
  simply unversioned (`plugins.md`).
- **`VELOCITY_VERSION` is pinned to a stable 3.x release, not `latest`.** The
  image resolves `latest` to the newest build PaperMC publishes, which is
  currently a 4.x development snapshot; practically every Velocity plugin still
  targets 3.x. The field is editable, so an owner can move a proxy to 4.x
  deliberately.
- **Stopping** sends `shutdown` — Velocity's console-only stop command, which
  disconnects players with a reason and lets plugins finish before exit. A
  pseudo-TTY is allocated (`tty: true`) so Velocity's JLine console emits the
  ANSI colour the panel's console renderer exists to render; without one it
  logs "Advanced terminal features are not available" and strips it.
- **Resource profile** is `steady-low`, not `bursty`: forwarding packets is
  flat work with no chunk-generation spikes to excuse a pegged core, so the
  abuse heuristics get a tighter baseline than a game server's
  (`security/watcher.ts`).

## Files

| Piece | Where |
| --- | --- |
| Blueprint + install script | `apps/frontend/lib/server/control-plane/blueprints/definitions/velocity.ts` |
| Tests (env/port/install couplings) | `.../definitions/velocity.test.ts` |
| Registration (boot sync, migrate seed) | `.../blueprints/registry.ts`, `apps/frontend/scripts/migrate.ts` |
