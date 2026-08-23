/**
 * Velocity proxy blueprint.
 *
 * A proxy is not a game server: nothing plays on it. Players connect to it and
 * it hands them to one of the owner's *other* servers, which is what makes it
 * the front door of a network (`docs/server-links.md` is the other half, since
 * a link is how the proxy reaches a backend).
 *
 * Uses `itzg/mc-proxy` with `TYPE=VELOCITY`, which downloads and runs the
 * Velocity jar and understands the same JVM/plugin env vars as the Minecraft
 * images. Two things make this blueprint different from the game ones:
 *
 *  - **Velocity's listen port lives in a config file, not an env var.** There
 *    is no `SERVER_PORT` equivalent, so the panel's identity-mapping invariant
 *    (`docs/ports.md`) is upheld through the image's start-time config patcher
 *    instead: `primaryPortEnv` is `CFG_PROXY_PORT`, and a patch definition
 *    written at install time re-asserts `bind` from that variable on every
 *    start. See `docs/velocity-proxy.md` for why it is done this way.
 *  - **It needs a config file to exist before the first start**, because the
 *    patcher can only rewrite a `bind` that is already there. The install step
 *    seeds `velocity.toml` (and the per-server `forwarding.secret`) rather than
 *    letting Velocity generate them on first boot with the wrong port.
 */

import { MODRINTH_PROVIDER_SPEC } from "@/lib/modrinth-preset";
import type { Blueprint } from "../types";

/**
 * Where the install step writes the bind patch, and what the runtime container
 * is pointed at. One constant so the two can't drift apart.
 */
const BIND_PATCH_FILE = "/server/.citadel/velocity-bind.json";

/**
 * The env var carrying the allocated primary port.
 *
 * The `CFG_` prefix is not decoration: `mc-image-helper patch` only expands
 * `${...}` placeholders for variables with that prefix (its
 * `--patch-env-prefix` default), so the bind patch can only read the port
 * through a `CFG_`-named variable. Like every `primaryPortEnv` it is
 * deliberately absent from `envSchema`. Only the panel writes it.
 */
const PORT_ENV = "CFG_PROXY_PORT";

/**
 * First-launch provisioning.
 *
 * Runs in a throwaway alpine container with the server's data dir mounted at
 * `/server`, as the uid that owns that directory rather than as root. The
 * agent pins it there, because a hardened container's uid 0 has no
 * `CAP_DAC_OVERRIDE` to write into someone else's directory and no `CAP_CHOWN`
 * to give the result away afterwards. So the files this writes are already
 * owned by the account the proxy, the file editor and SFTP use: no `chown`, no
 * permissive umask, nothing to clean up.
 */
const installScript = `set -eu
cd /server

# Velocity's modern forwarding needs a shared secret, and a well-known default
# would let anyone spoof a backend connection, so each server gets its own.
# Written without a trailing newline: the file's bytes ARE the secret, and the
# same string has to be pasted into each backend's paper-global.yml.
if [ ! -f forwarding.secret ]; then
  tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32 > forwarding.secret
fi

# Seeded rather than left to Velocity's own first-boot generation, because the
# port has to be right the first time the proxy binds, and because the patcher
# below can only rewrite a bind that already exists.
#
# Deliberately comment-free: the patcher re-serializes this file on every start,
# so any comment written here would vanish at the first restart. Absent keys
# keep Velocity's documented defaults, with two exceptions that must be stated
# explicitly, or Velocity refuses to boot: it otherwise falls back to the
# example forced-hosts from its packaged default config (which point at servers
# that don't exist) and to a "try" list naming a "lobby" backend.
# Empty inline tables are the form that survives the patcher's rewrite.
if [ ! -f velocity.toml ]; then
  cat > velocity.toml <<TOML
config-version = "2.8"
bind = "0.0.0.0:$${PORT_ENV}"
motd = "<#09add3>A CitadelPanel network"
show-max-players = 500
online-mode = true
player-info-forwarding-mode = "modern"
forwarding-secret-file = "forwarding.secret"
servers = { try = [] }
forced-hosts = {}
TOML
fi

# Re-applied by the image on every start, which is what keeps the bind in step
# with the panel's allocation. The placeholder is expanded by the patcher, not
# by this shell, so it stays a placeholder in the file.
mkdir -p .citadel
cat > ${BIND_PATCH_FILE} <<'JSON'
{
  "file": "/server/velocity.toml",
  "ops": [
    { "$set": { "path": "$.bind", "value": "0.0.0.0:\${${PORT_ENV}}" } }
  ]
}
JSON
`;

export const velocity: Blueprint = {
  key: "velocity",
  name: "Velocity (Minecraft proxy)",
  description:
    "Velocity proxy via the itzg/mc-proxy image. Fronts the owner's other Minecraft servers on one port with modern player forwarding; backends are reached through server links and listed in velocity.toml.",
  dockerImage: "itzg/mc-proxy:latest",

  defaultPorts: [
    // Velocity's own default, and the port players expect to type. Allocation
    // is best-effort, which is exactly why the bind is patched from the env
    // rather than assumed.
    { container: 25565, primary: true },
  ],

  primaryPortEnv: PORT_ENV,

  envSchema: {
    // Locked to VELOCITY: this blueprint's install step writes a velocity.toml,
    // so pointing the image at BungeeCord/Waterfall would leave it configured
    // by a file that software doesn't read.
    TYPE: {
      required: true,
      default: "VELOCITY",
      options: ["VELOCITY"],
      description: "Proxy software. This blueprint is Velocity-only.",
    },
    // Pinned to the current stable 3.x rather than `latest`: the image resolves
    // `latest` to the newest build PaperMC publishes, which today is a 4.x
    // development snapshot. Practically every Velocity plugin on the catalogs
    // still targets 3.x, so that is the sane default for a shared panel. It
    // stays editable, for an owner who wants to move a proxy to 4.x.
    VELOCITY_VERSION: {
      required: false,
      default: "3.5.1",
      description: "Velocity version to download. `latest` includes snapshots.",
      editable: true,
    },
    VELOCITY_BUILD_ID: {
      required: false,
      default: "latest",
      description: "Build within the chosen Velocity version, or latest",
      editable: true,
    },
    // The image's own name for "which Minecraft version are the backends",
    // which also drives plugin-compatibility filtering (see `plugins` below).
    MINECRAFT_VERSION: {
      required: false,
      default: "LATEST",
      description:
        "Minecraft version of the servers behind the proxy. Set a concrete version (e.g. 1.21.1) to filter plugins by compatibility.",
      editable: true,
    },
    MEMORY: {
      required: false,
      default: "512m",
      description:
        "JVM heap size. A proxy is network-bound rather than memory-hungry; 512m suits most networks.",
      editable: true,
    },
    JVM_OPTS: {
      required: false,
      description: "Extra JVM options appended to the java command.",
      editable: true,
    },
    JVM_XX_OPTS: {
      required: false,
      description: "Extra -XX JVM options, e.g. -XX:MaxGCPauseMillis=50.",
      editable: true,
    },
    // Velocity prefers this over the config's forwarding-secret-file, so an
    // owner running several proxies can share one secret across them. Left
    // empty, the per-server secret the install step generated is used.
    VELOCITY_FORWARDING_SECRET: {
      required: false,
      secret: true,
      description:
        "Overrides the generated forwarding.secret file. Leave empty to keep this server's own secret.",
      editable: true,
    },
    // Points the image's config patcher at the bind patch the install step
    // wrote. Not editable: dropping it would let a reallocated port leave the
    // proxy listening where nothing is forwarded.
    PATCH_DEFINITIONS: {
      required: true,
      default: BIND_PATCH_FILE,
      description:
        "Panel-owned: re-applies the allocated port to velocity.toml on every start.",
    },
    // Same reasoning as the Minecraft blueprints: the panel console talks to
    // the container's stdin, so an inbound RCON listener would be a second,
    // password-gated way in with no panel use case.
    ENABLE_RCON: {
      required: false,
      default: "false",
      description:
        "RCON is disabled; the panel console uses the container console.",
    },
    // The image runs as root and `runuser`s to `bungeecord` after `chown`ing
    // /server, and both need capabilities the panel drops. The container is
    // pinned to uid 1000 (the data dir's owner) instead, so those steps are
    // skipped rather than failed.
    SKIP_PRIVILEGE_DROP: {
      required: false,
      default: "true",
      description:
        "Skip the image's internal privilege drop (the container already runs as the data owner).",
    },
    SKIP_CHOWN_DATA: {
      required: false,
      default: "true",
      description:
        "Skip chowning /server on startup (the container runs as the uid that owns it).",
    },
  },

  install: {
    // No downloads to do, because the runtime image fetches Velocity itself,
    // so the installer is a plain busybox shell.
    image: "alpine:3",
    script: installScript,
  },

  // Velocity plugins are a static profile, not an env-driven one: unlike
  // minecraft-java's TYPE there is nothing to switch on, since a Velocity proxy
  // only ever loads Velocity plugins from `plugins/`.
  plugins: {
    default: {
      label: "Plugins",
      directory: "plugins",
      projectType: "plugin",
      loaders: ["velocity"],
      gameVersionEnv: "MINECRAFT_VERSION",
    },
    provider: MODRINTH_PROVIDER_SPEC,
  },

  // Console-only in Velocity, and it disconnects players with a reason and
  // lets plugins finish before exiting, which is cleaner than SIGTERM.
  stopCommand: "shutdown",

  // Run as the data directory's owner. See SKIP_PRIVILEGE_DROP above.
  user: "1000:1000",

  // A proxy forwards packets: low, flat CPU with no chunk-generation spikes to
  // excuse a pegged core. The tighter baseline is the point. It makes abuse
  // stand out more than it does on a game server.
  expectedResourceProfile: "steady-low",

  dataPath: "/server",

  minimums: {
    cpuLimit: 0.5,
    // 512m of heap plus JVM overhead; below this the proxy is OOM-killed under
    // load rather than merely slow.
    memoryLimitMb: 768,
    diskLimitMb: 1024,
  },

  // The image writes its jar, config and logs under /server but also needs a
  // writable rootfs for its startup scripts.
  supportsReadOnlyRoot: false,

  // Velocity's console is a JLine terminal like Paper's: without a pty it
  // strips the ANSI color the panel's console renderer exists to render.
  tty: true,
};
