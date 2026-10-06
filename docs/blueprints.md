# Built-in blueprints

A blueprint is the reviewed container contract used by the panel when it builds
and recreates a server: image, persistent data directory, published ports,
environment fields, startup and stop behavior, and resource floor. Built-ins are
plain TypeScript data under
`apps/frontend/lib/server/control-plane/blueprints/definitions/`; the registry
syncs them into PostgreSQL at boot and `bun run migrate` seeds them for a fresh
installation.

## Game servers

- **Minecraft: Java Edition** keeps the existing TYPE-driven image and supports
  Vanilla, Paper, Purpur, Fabric, Forge and Spigot in one configurable entry.
- **Purpur**, **Forge**, and **Fabric** are fixed-type variants of that image.
  They keep the same `SERVER_PORT` identity wiring, JVM controls, and applicable
  Modrinth/Hangar content tabs while presenting one server flavor in the create
  form.
- **NanoLimbo** uses an Eclipse Temurin 21 runtime. Its installer downloads the
  latest NanoLimbo release into the panel data mount and seeds its upstream
  `settings.yml`. The installer and startup command patch `bind.port` from the
  panel-allocated `PORT`, preserving identity mapping after reallocations.
- **Velocity** and **BungeeCord** use `itzg/mc-proxy`. Their install steps seed
  the proxy configuration, and the allocated identity port is applied to the
  config before each start. Use server links to connect a proxy to its backend
  servers; see [server-links.md](server-links.md) and
  [velocity-proxy.md](velocity-proxy.md).
- **Counter-Strike 2** uses `joedwards32/cs2` and stores the SteamCMD-managed
  installation under `/home/steam/cs2-dedicated`. `SRCDS_TOKEN` is optional for
  private/LAN servers and should be supplied for public listing.
- **Rust** uses `didstopia/rust-server` and stores the SteamCMD installation at
  `/steamcmd/rust`. Its primary game port is injected through
  `RUST_SERVER_PORT`; web RCON is disabled by default because the panel's
  console uses the container console.

The panel publishes identity mappings (host N to container N) on TCP and UDP
for every declared port. A blueprint only declares a secondary game port when
it can remain correct after allocation; the CS2 and Rust images have additional
query/RCON ports that are intentionally left unpublished by default.

## Generic runtimes

Python, Node.js, Bun.js, Java, and Go are deliberately small application
blueprints rather than framework presets. Each uses `/app` as its persistent
data directory, injects the allocated port through `PORT`, and installs a tiny
HTTP starter when the expected entry file is missing:

| Blueprint | Image | Entry file | Startup |
| --- | --- | --- | --- |
| Python | `python:3.12-slim` | `main.py` | `python3 main.py` |
| Node.js | `node:22-bookworm-slim` | `server.js` | `node server.js` |
| Bun.js | `oven/bun:1` | `server.ts` | `bun run server.ts` |
| Java | `eclipse-temurin:21-jre` | `server.jar` | `java --add-modules jdk.httpserver -jar server.jar` |
| Go | `golang:1.23-alpine` | `main.go` | `go run main.go` |

Replace the starter through Files or SFTP. Reinstalling a server reruns its
installer, but each installer preserves an existing entry file so an ordinary
reinstall does not overwrite the application.

All built-ins run with the data directory's uid where the image supports it,
keep a writable root filesystem, and declare a minimum resource floor. The
security controls and lifecycle behavior around those choices are described in
[node-hardening.md](node-hardening.md) and [server-lifecycle.md](server-lifecycle.md).
