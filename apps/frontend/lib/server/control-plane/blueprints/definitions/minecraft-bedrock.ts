/**
 * Minecraft: Bedrock Edition blueprint.
 *
 * Bedrock uses UDP (RakNet) rather than TCP. That distinction no longer shows
 * up here: a published port is claimed on both protocols, so the declaration
 * is the number alone.
 */

import type { Blueprint } from "../types";

export const minecraftBedrock: Blueprint = {
  key: "minecraft-bedrock",
  name: "Minecraft: Bedrock Edition",
  description:
    "Bedrock dedicated server (itzg image). Connects over UDP; version and gameplay options are set with environment variables.",
  dockerImage: "itzg/minecraft-bedrock-server:latest",

  defaultPorts: [{ container: 19132, primary: true }],

  // Identity port mapping: the image is told to bind the allocated port inside
  // the container (it rewrites server.properties' server-port from this env,
  // overriding manual edits — by design of the image).
  primaryPortEnv: "SERVER_PORT",

  envSchema: {
    EULA: {
      required: true,
      default: "TRUE",
      description: "Accept the Minecraft EULA",
    },
    VERSION: {
      required: false,
      default: "LATEST",
      description: "Bedrock server version, or LATEST",
      editable: true,
    },
    SERVER_NAME: {
      required: false,
      default: "CitadelPanel Server",
      description: "Name shown in the server list",
      editable: true,
    },
    GAMEMODE: {
      required: false,
      default: "survival",
      options: ["survival", "creative", "adventure"],
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
      default: "10",
      description: "Maximum concurrent players",
      editable: true,
    },
    ONLINE_MODE: {
      required: false,
      default: "true",
      options: ["true", "false"],
      description: "Require Xbox Live authentication",
      editable: true,
    },
    ALLOW_CHEATS: {
      required: false,
      default: "false",
      options: ["true", "false"],
      editable: true,
    },
    // Same privilege-drop model as the Java image: /start runs as root, `gosu`s
    // to `minecraft`, and `chown`s /data. The container is pinned to uid 1000
    // (the data dir's owner) so those steps are skipped and no capabilities are
    // needed under the panel's CapDrop: ALL.
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

  expectedResourceProfile: "bursty",

  // Run as the data directory's owner (uid 1000) so the image needs no
  // setuid/chown capabilities — see SKIP_SUDO/SKIP_CHOWN_DATA above.
  user: "1000:1000",

  dataPath: "/data",

  minimums: {
    cpuLimit: 0.5,
    // The Bedrock server is a native binary and lighter than the JVM.
    memoryLimitMb: 512,
    diskLimitMb: 1024,
  },

  supportsReadOnlyRoot: false,
};
