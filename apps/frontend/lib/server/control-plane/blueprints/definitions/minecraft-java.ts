/**
 * Minecraft: Java Edition blueprint.
 *
 * Uses the widely-used `itzg/minecraft-server` image, which handles server jar
 * download, EULA acceptance and server type selection (Vanilla/Paper/Fabric...)
 * through environment variables — so no separate install step is needed.
 */

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

  envSchema: {
    // The image refuses to start without explicit EULA acceptance. Defaulted to
    // TRUE because creating a server through the panel IS the acceptance step.
    EULA: {
      required: true,
      default: "TRUE",
      description: "Accept the Minecraft EULA",
    },
    TYPE: {
      required: false,
      default: "PAPER",
      description: "Server software",
      options: ["VANILLA", "PAPER", "PURPUR", "FABRIC", "FORGE", "SPIGOT"],
    },
    VERSION: {
      required: false,
      default: "LATEST",
      description: "Minecraft version, or LATEST",
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
    },
    DIFFICULTY: {
      required: false,
      default: "normal",
      options: ["peaceful", "easy", "normal", "hard"],
    },
    MAX_PLAYERS: {
      required: false,
      default: "20",
      description: "Maximum concurrent players",
    },
    ONLINE_MODE: {
      required: false,
      default: "TRUE",
      options: ["TRUE", "FALSE"],
      description:
        "Verify players against Mojang auth. Disabling allows cracked clients.",
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
  },

  // The itzg image manages its own jar download and startup, so the blueprint
  // relies on the image entrypoint rather than a custom startup command.

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
};
