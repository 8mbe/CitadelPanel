/** Rust (Facepunch) dedicated server blueprint. */
import type { Blueprint } from "../types";

export const rust: Blueprint = {
  key: "rust",
  name: "Rust",
  description:
    "Rust dedicated server using the didstopia image. SteamCMD installs and updates Rust on startup.",
  dockerImage: "didstopia/rust-server:latest",
  defaultPorts: [{ container: 28015, primary: true }],
  primaryPortEnv: "RUST_SERVER_PORT",
  envSchema: {
    RUST_SERVER_IDENTITY: {
      required: false,
      default: "citadel",
      description: "Save identity used for the world directory.",
      editable: true,
    },
    RUST_SERVER_NAME: {
      required: false,
      default: "CitadelPanel Rust Server",
      description: "Name shown in the Rust server browser.",
      editable: true,
    },
    RUST_SERVER_DESCRIPTION: {
      required: false,
      default: "A Rust server hosted by CitadelPanel.",
      description: "Description shown in the server browser.",
      editable: true,
    },
    RUST_SERVER_MAXPLAYERS: {
      required: false,
      default: "50",
      description: "Maximum concurrent players.",
      editable: true,
    },
    RUST_SERVER_SEED: {
      required: false,
      default: "12345",
      description: "Procedural map seed.",
      editable: true,
    },
    RUST_SERVER_WORLDSIZE: {
      required: false,
      default: "3500",
      description: "Procedural map world size.",
      editable: true,
    },
    RUST_SERVER_LEVELURL: {
      required: false,
      description: "Optional custom map URL; overrides seed and world size.",
      editable: true,
    },
    RUST_SERVER_SAVE_INTERVAL: {
      required: false,
      default: "600",
      description: "Automatic save interval in seconds.",
      editable: true,
    },
    RUST_SERVER_STARTUP_ARGUMENTS: {
      required: false,
      default: "-batchmode -load -nographics +server.secure 1",
      description: "Additional RustDedicated startup arguments.",
      editable: true,
    },
    RUST_RCON_WEB: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Enable the web RCON endpoint (disabled by default; the panel console uses stdin).",
      editable: true,
    },
    RUST_RCON_PASSWORD: {
      required: false,
      secret: true,
      description: "Web RCON password. Set a strong value before enabling RCON.",
      editable: true,
    },
    RUST_OXIDE_ENABLED: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Install/update the Oxide mod framework.",
      editable: true,
    },
    RUST_UPDATE_CHECKING: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Check for Rust updates and restart automatically.",
      editable: true,
    },
  },
  expectedResourceProfile: "steady-high",
  dataPath: "/steamcmd/rust",
  minimums: {
    cpuLimit: 2,
    memoryLimitMb: 4096,
    diskLimitMb: 16384,
  },
  supportsReadOnlyRoot: false,
};
