/**
 * BungeeCord proxy blueprint.
 *
 * The itzg proxy image defaults BungeeCord to port 25577. CitadelPanel uses
 * identity port mappings (the allocated host number is also the container
 * number), so the install step seeds a config with a CFG_ placeholder and the
 * image replaces it on every boot. Existing config files are preserved for
 * owners who customise the proxy after first launch.
 */
import type { Blueprint } from "../types";

const PORT_ENV = "CFG_PROXY_PORT";
const installScript = [
  "set -eu",
  "cd /server",
  "",
  "# Seed a valid, intentionally empty BungeeCord configuration. The image's",
  "# REPLACE_ENV_VARIABLES pass expands ${" + PORT_ENV + "} before Bungee starts.",
  "if [ ! -f config.yml ]; then",
  "  cat > config.yml <<'YAML'",
  "listeners:",
  "- query_enabled: false",
  "  motd: '&1A CitadelPanel BungeeCord proxy'",
  "  max_players: 100",
  "  host: 0.0.0.0:${" + PORT_ENV + "}",
  "  force_default_server: false",
  "  ping_passthrough: false",
  "  priorities: []",
  "  bind_local_address: true",
  "  tab_size: 60",
  "  tab_list: GLOBAL_PING",
  "  forced_hosts: {}",
  "servers: {}",
  "ip_forward: false",
  "online_mode: true",
  "forge_support: false",
  "network_compression_threshold: 256",
  "connection_throttle: 4000",
  "connection_throttle_limit: 3",
  "timeout: 30000",
  "YAML",
  "fi",
  "",
].join("\n");

export const bungeecord: Blueprint = {
  key: "bungeecord",
  name: "BungeeCord",
  description:
    "BungeeCord Minecraft proxy via itzg/mc-proxy. Connect backend servers with server links and customise config.yml in the Files tab.",
  dockerImage: "itzg/mc-proxy:latest",
  defaultPorts: [{ container: 25577, primary: true }],
  primaryPortEnv: PORT_ENV,
  envSchema: {
    TYPE: {
      required: true,
      default: "BUNGEECORD",
      options: ["BUNGEECORD"],
      description: "Proxy software. This blueprint is BungeeCord-only.",
    },
    BUNGEE_JOB_ID: {
      required: false,
      default: "lastStableBuild",
      description: "BungeeCord CI job stream to download.",
      editable: true,
    },
    BUNGEE_JAR_REVISION: {
      required: false,
      description:
        "Optional revision marker; changing it forces the image to fetch a new jar.",
      editable: true,
    },
    MEMORY: {
      required: false,
      default: "512m",
      description: "JVM heap size for the proxy.",
      editable: true,
    },
    JVM_OPTS: {
      required: false,
      description: "Extra JVM options appended to the java command.",
      editable: true,
    },
    JVM_XX_OPTS: {
      required: false,
      description: "Extra -XX JVM options.",
      editable: true,
    },
    REPLACE_ENV_VARIABLES: {
      required: false,
      default: "true",
      options: ["true", "false"],
      description: "Expand panel-owned CFG_ placeholders in config.yml.",
    },
    ENABLE_RCON: {
      required: false,
      default: "false",
      options: ["true", "false"],
      description:
        "RCON is disabled; the panel console uses the container console.",
    },
    SKIP_PRIVILEGE_DROP: {
      required: false,
      default: "true",
      options: ["true", "false"],
      description:
        "Skip the image's internal privilege drop (the container runs as the data owner).",
    },
    SKIP_CHOWN_DATA: {
      required: false,
      default: "true",
      options: ["true", "false"],
      description:
        "Skip chowning /server on startup (the container runs as the data owner).",
    },
  },
  install: {
    image: "alpine:3.20",
    script: installScript,
  },
  stopCommand: "end",
  user: "1000:1000",
  expectedResourceProfile: "steady-low",
  dataPath: "/server",
  minimums: {
    cpuLimit: 0.5,
    memoryLimitMb: 512,
    diskLimitMb: 1024,
  },
  supportsReadOnlyRoot: false,
  tty: true,
};
