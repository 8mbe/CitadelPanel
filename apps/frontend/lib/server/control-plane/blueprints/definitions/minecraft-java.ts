/**
 * Minecraft: Java Edition blueprint.
 *
 * Uses the widely-used `itzg/minecraft-server` image, which handles server jar
 * download, EULA acceptance and server type selection (Vanilla/Paper/Fabric...)
 * through environment variables — so no separate install step is needed.
 */

import { MODRINTH_PROVIDER_SPEC } from "@/lib/modrinth-preset";
import type { Blueprint } from "../types";

export const minecraftJava: Blueprint = {
  key: "minecraft-java",
  name: "Minecraft: Java Edition",
  description:
    "Vanilla, Paper, Purpur, Fabric, Forge or Spigot via the itzg image. Type and version are selected with environment variables.",
  dockerImage: "itzg/minecraft-server:latest",

  defaultPorts: [
    { container: 25565, protocol: "tcp", primary: true },
  ],

  // The published primary port is an identity mapping, so the image is told to
  // bind that exact port inside the container (it writes server.properties'
  // server-port from it).
  primaryPortEnv: "SERVER_PORT",

  envSchema: {
    // The image refuses to start without explicit EULA acceptance. Defaulted to
    // TRUE because creating a server through the panel IS the acceptance step.
    EULA: {
      required: true,
      default: "TRUE",
      description: "Accept the Minecraft EULA",
    },
    // RCON stays off: the panel console talks to the container's stdin over the
    // attach stream, so an inbound RCON listener would be a second,
    // password-gated way into the server with no panel use case.
    ENABLE_RCON: {
      required: false,
      default: "FALSE",
      description: "RCON is disabled; the panel console uses the container console.",
    },
    TYPE: {
      required: false,
      default: "PAPER",
      description: "Server software",
      options: ["VANILLA", "PAPER", "PURPUR", "FABRIC", "FORGE", "SPIGOT"],
      editable: true,
    },
    VERSION: {
      required: false,
      default: "LATEST",
      description: "Minecraft version, or LATEST",
      editable: true,
    },
    MEMORY: {
      required: false,
      description:
        "JVM heap size (e.g. 2G). Derived from the server's memory limit when unset.",
    },
    MOTD: {
      required: false,
      default: "A CitadelPanel server",
      description: "Message of the day shown in the server list",
      editable: true,
    },
    DIFFICULTY: {
      required: false,
      default: "normal",
      options: ["peaceful", "easy", "normal", "hard"],
      editable: true,
    },
    MAX_PLAYERS: {
      required: false,
      default: "20",
      description: "Maximum concurrent players",
      editable: true,
    },
    ONLINE_MODE: {
      required: false,
      default: "TRUE",
      options: ["TRUE", "FALSE"],
      description:
        "Verify players against Mojang auth. Disabling allows cracked clients.",
      editable: true,
    },
    // The image's /start script runs as root, then `gosu`s to `minecraft` and
    // `chown`s /data. Both need capabilities the panel drops (CapDrop: ALL +
    // no-new-privileges), so the container is pinned to run as uid 1000 (the
    // data dir's owner) and these flags skip the now-redundant privilege drop.
    SKIP_SUDO: {
      required: false,
      default: "true",
      description:
        "Skip the image's internal gosu privilege drop (the container already runs as the data owner).",
    },
    SKIP_CHOWN_DATA: {
      required: false,
      default: "true",
      description:
        "Skip chowning /data on startup (the container runs as the uid that owns it).",
    },
    // --- Owner-tunable JVM options (all editable, applied on next restart) ---
    USE_AIKAR_FLAGS: {
      required: false,
      default: "false",
      options: ["true", "false"],
      description: "Use Aikar's recommended JVM garbage-collection flags.",
      editable: true,
    },
    USE_SIMD_FLAGS: {
      required: false,
      default: "false",
      options: ["true", "false"],
      description:
        "Enable the JVM's SIMD instructions (useful on supported CPU/JVM combos).",
      editable: true,
    },
    JVM_OPTS: {
      required: false,
      description:
        "Extra JVM options appended to the java command, e.g. -Xss1M.",
      editable: true,
    },
    JVM_XX_OPTS: {
      required: false,
      description:
        "Extra -XX JVM options, e.g. -XX:MaxGCPauseMillis=50.",
      editable: true,
    },
    JVM_DD_OPTS: {
      required: false,
      description:
        "System properties passed to the JVM as -D flags, e.g. my.mod.flag=true.",
      editable: true,
    },
  },

  // The itzg image manages its own jar download and startup, so the blueprint
  // relies on the image entrypoint rather than a custom startup command.

  // Plugin/mod support via Modrinth, declared entirely as data (the panel's
  // fetch engine interprets it — see plugins/engine.ts). The active profile
  // follows the TYPE env: Paper/Purpur/Spigot load Bukkit-style plugins from
  // /plugins, Fabric/Forge load mods from /mods, and vanilla (VANILLA) has no
  // variant — those servers simply don't get the tab. Purpur also lists
  // paper/spigot loaders because many plugin projects only tag one of the
  // compatible loaders.
  plugins: {
    envField: "TYPE",
    variants: {
      PAPER: {
        label: "Plugins",
        directory: "plugins",
        projectType: "plugin",
        loaders: ["paper"],
        gameVersionEnv: "VERSION",
      },
      PURPUR: {
        label: "Plugins",
        directory: "plugins",
        projectType: "plugin",
        loaders: ["purpur", "paper", "spigot"],
        gameVersionEnv: "VERSION",
      },
      SPIGOT: {
        label: "Plugins",
        directory: "plugins",
        projectType: "plugin",
        loaders: ["spigot", "paper"],
        gameVersionEnv: "VERSION",
      },
      FABRIC: {
        label: "Mods",
        directory: "mods",
        projectType: "mod",
        loaders: ["fabric"],
        gameVersionEnv: "VERSION",
      },
      FORGE: {
        label: "Mods",
        directory: "mods",
        projectType: "mod",
        loaders: ["forge"],
        gameVersionEnv: "VERSION",
      },
    },
    provider: MODRINTH_PROVIDER_SPEC,
  },

  // The image traps SIGTERM and saves the world on stop, but sending an
  // explicit "stop" through the console is the cleaner shutdown path.
  stopCommand: "stop",

  // Run as the data directory's owner (uid 1000) so the image needs no
  // setuid/chown capabilities — see SKIP_SUDO/SKIP_CHOWN_DATA above.
  user: "1000:1000",

  // A Minecraft server is bursty: chunk generation and player joins spike CPU,
  // but a steady 100% pegged core is not normal behaviour.
  expectedResourceProfile: "bursty",

  dataPath: "/data",

  minimums: {
    cpuLimit: 0.5,
    memoryLimitMb: 1024, // below ~1GB the JVM struggles to start
    diskLimitMb: 2048,
  },

  // The image writes server jars and config into /data but also needs a
  // writable rootfs for its startup scripts.
  supportsReadOnlyRoot: false,

  // Allocate a pseudo-TTY so the image's JLine3 TerminalConsoleAppender emits
  // ANSI color. Without a TTY JLine strips all color — both log levels (the
  // %highlightError pattern) and Minecraft's own § chat-formatting codes, which
  // it converts to ANSI only when stdout is a real terminal. The panel's ANSI
  // console renderer then has nothing to render. The attach layer detects a TTY
  // container and reads its raw (unframed) stream so the codes pass through.
  tty: true,
};
