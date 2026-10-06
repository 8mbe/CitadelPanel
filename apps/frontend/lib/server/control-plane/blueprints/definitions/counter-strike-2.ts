/** Counter-Strike 2 dedicated server blueprint. */
import type { Blueprint } from "../types";

export const counterStrike2: Blueprint = {
  key: "counter-strike-2",
  name: "Counter-Strike 2",
  description:
    "Counter-Strike 2 dedicated server using SteamCMD. The server token is optional for LAN/private use and required for public matchmaking listing.",
  dockerImage: "joedwards32/cs2:latest",
  defaultPorts: [{ container: 27015, primary: true }],
  primaryPortEnv: "CS2_PORT",
  envSchema: {
    // The image accepts an empty token for local/private servers. Keep it
    // secret when supplied because Steam identifies the operator with it.
    SRCDS_TOKEN: {
      required: false,
      secret: true,
      description:
        "Steam Game Server Login Token (GSLT), required for public listing.",
      editable: true,
    },
    CS2_SERVERNAME: {
      required: false,
      default: "CitadelPanel CS2 Server",
      description: "Name shown in the server browser.",
      editable: true,
    },
    CS2_PW: {
      required: false,
      secret: true,
      description: "Optional password required to join.",
      editable: true,
    },
    CS2_RCONPW: {
      required: false,
      default: "",
      secret: true,
      description: "RCON password. Leave empty to disable the image's RCON setup.",
      editable: true,
    },
    CS2_MAXPLAYERS: {
      required: false,
      default: "10",
      description: "Maximum concurrent players.",
      editable: true,
    },
    CS2_STARTMAP: {
      required: false,
      default: "de_inferno",
      description: "Map loaded on startup.",
      editable: true,
    },
    CS2_MAPGROUP: {
      required: false,
      default: "mg_active",
      description: "Map group used by the selected game mode.",
      editable: true,
    },
    CS2_GAMEALIAS: {
      required: false,
      description: "Optional game alias such as casual, competitive, or deathmatch.",
      editable: true,
    },
    CS2_CHEATS: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Enable cheats (not recommended for public servers).",
      editable: true,
    },
    CS2_LAN: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Run in LAN mode.",
      editable: true,
    },
    CS2_SERVER_HIBERNATE: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Hibernate while empty (the image notes this can trigger crashes).",
      editable: true,
    },
    TV_ENABLE: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Enable SourceTV. Its secondary port is not published by this blueprint.",
      editable: true,
    },
  },
  expectedResourceProfile: "steady-high",
  // The image runs its `steam` service as uid 1000 and documents that the
  // mounted directory must be writable by that account.
  user: "1000:1000",
  dataPath: "/home/steam/cs2-dedicated",
  minimums: {
    cpuLimit: 2,
    memoryLimitMb: 2048,
    diskLimitMb: 61440,
  },
  supportsReadOnlyRoot: false,
};
