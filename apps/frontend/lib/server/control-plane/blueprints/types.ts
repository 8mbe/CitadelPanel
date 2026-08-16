/**
 * Blueprint contract (formerly "game preset", plan.md section 10).
 *
 * A blueprint is the reusable definition of how a server is built and run:
 *   - the runtime image and the command that launches the server every time;
 *   - an optional one-time install step that provisions the data directory
 *     before first launch (download server files, unpack, accept a licence);
 *   - the env schema, ports and the resource floor.
 *
 * Built-in blueprints are defined in code (reviewable, type-checked) and synced
 * into the `blueprints` table on boot. The table is the complete store, so the
 * node agent can be handed everything it needs from the database at create
 * time — see `registry.ts`.
 *
 * Adding a new built-in game is one new file in `definitions/` plus one entry
 * in the registry — no changes to core orchestration code.
 */

import type { BlueprintPluginSupport } from "./plugins";

export interface BlueprintPort {
  /**
   * The port this blueprint prefers for its game traffic (e.g. 25565 for
   * Minecraft Java). Allocation from the node's pool is best-effort — it is
   * honored when the port is in the pool and free, otherwise another pool port
   * is drawn. Whatever port lands, it is published as an identity mapping:
   * host port and container port are the same number.
   */
  container: number;
  protocol: "tcp" | "udp";
  /** The port players connect to. Exactly one port per blueprint is primary. */
  primary?: boolean;
}

export interface BlueprintEnvField {
  required: boolean;
  default?: string;
  description?: string;
  /** Values the user may pick from; also validated server-side. */
  options?: string[];
  /** Secret values are encrypted at rest and masked in API responses. */
  secret?: boolean;
  /**
   * When true, the server owner (and subusers with `settings`) may override this
   * value after creation. When unset/false the value is locked to whatever the
   * blueprint resolved at create time — admins can still change it by editing the
   * blueprint or the `server_env` row directly.
   */
  editable?: boolean;
}

/**
 * One-time provisioning run before a server first starts.
 *
 * Executed as a run-to-completion container by the node agent, with the
 * server's data volume mounted at the blueprint's `dataPath`. The image is
 * often a lighter installer than the runtime one (e.g. an `alpine` with curl),
 * which is why it is specified separately.
 */
export interface BlueprintInstall {
  /** Image the install step runs in. May differ from the runtime image. */
  image: string;
  /** Shell script run once, with the data volume mounted and env available. */
  script: string;
  /**
   * Entrypoint for the install container. The script is passed as its argument.
   * Defaults to `["/bin/sh", "-c"]` when unset.
   */
  entrypoint?: string[];
}

/**
 * How a healthy instance of this blueprint is expected to behave, which gives
 * the abuse heuristics a baseline to compare against (plan.md section 9.1). A
 * "steady-high" game legitimately pegs the CPU, so sustained high CPU is far
 * weaker evidence of mining there than it is for a "bursty" game.
 */
export type ResourceProfile = "bursty" | "steady-low" | "steady-high";

export interface Blueprint {
  key: string;
  name: string;
  description?: string;
  dockerImage: string;
  defaultPorts: BlueprintPort[];
  envSchema: Record<string, BlueprintEnvField>;
  /**
   * Env var that receives the primary port's number (e.g. SERVER_PORT for the
   * itzg Minecraft images), so the game binds inside the container exactly
   * where Docker published it — published ports are identity mappings, so the
   * game must listen on the host port it was allocated. The panel sets this
   * value at create time and re-syncs it on every container recreate; it is
   * deliberately absent from `envSchema` so owners cannot desync it.
   */
  primaryPortEnv?: string;
  /**
   * Command that launches the server, run every start. `{{VAR}}` placeholders
   * are interpolated with the server's resolved env at create time. When unset
   * the image's own entrypoint/command is used unchanged.
   */
  startupCommand?: string;
  /** Console command for a graceful shutdown (e.g. "stop"), before SIGKILL. */
  stopCommand?: string;
  /**
   * Pin the container to run as this `uid` or `uid:gid` (Docker `--user`).
   *
   * Use when an image drops privileges internally (e.g. itzg/minecraft-server
   * runs as root then `gosu`s to `minecraft` and `chown`s `/data`). Such a drop
   * needs setuid/chown capabilities the panel deliberately drops, so pinning
   * the run-as user to the data dir's owner lets the image run non-root with no
   * capability escalation. When unset, the image's default USER is used.
   */
  user?: string;
  /** Optional first-launch provisioning. */
  install?: BlueprintInstall;
  /**
   * Optional plugin/mod support: declares the provider that knows how to
   * search and download them, the tab label, the install directory and the
   * provider's search facets. Servers whose resolved env yields no profile
   * (e.g. vanilla Minecraft) simply don't get the tab. See `plugins.ts`.
   */
  plugins?: BlueprintPluginSupport;
  expectedResourceProfile: ResourceProfile;
  /** Where the server stores its world/config inside the container. */
  dataPath: string;
  /** Minimum viable resources; server creation is rejected below these. */
  minimums: {
    cpuLimit: number;
    memoryLimitMb: number;
    diskLimitMb: number;
  };
  /** True only if the image is verified to run with a read-only rootfs. */
  supportsReadOnlyRoot?: boolean;
  /**
   * Allocate a pseudo-TTY for the container's primary process.
   *
   * Some server software gates colored console output on detecting a real
   * terminal: the itzg/minecraft-server image uses JLine3's
   * TerminalConsoleAppender, which emits ANSI color (log levels AND Minecraft's
   * own § chat-formatting codes) only when stdout is a TTY — without one it
   * strips all color. The panel's ANSI renderer then has nothing to render.
   *
   * TTY mode changes the attach stream from Docker's 8-byte multiplexed framing
   * to a raw byte stream (stdout and stderr are merged), which the attach layer
   * detects per-container. It also makes the server's own log4j `§`→ANSI
   * conversion work, giving full terminal color rather than just log-level
   * highlighting. Off by default because most game servers don't need it and
   * non-TTY keeps stdout/stderr cleanly separated.
   */
  tty?: boolean;
}

/** The primary (player-facing) port of a blueprint. */
export function primaryPort(blueprint: Blueprint): BlueprintPort {
  const explicit = blueprint.defaultPorts.find((port) => port.primary);
  if (explicit) return explicit;

  const first = blueprint.defaultPorts[0];
  if (!first) {
    throw new Error(`Blueprint "${blueprint.key}" declares no ports`);
  }
  return first;
}

/**
 * Interpolate `{{VAR}}` placeholders in a startup command with resolved env.
 *
 * Unknown placeholders are left intact rather than blanked, so a typo in a
 * blueprint surfaces as a visible `{{TYPO}}` in the command instead of a
 * silently truncated one.
 */
export function interpolateCommand(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (match, key: string) =>
    key in values ? values[key]! : match,
  );
}

export interface ResolvedEnv {
  values: Record<string, string>;
  /** Keys whose values must be encrypted before storage. */
  secretKeys: string[];
}

/**
 * Merge user-supplied env vars with the blueprint schema.
 *
 * Rules, in order of importance:
 *  - Unknown keys are DROPPED, never passed to the container. A user must not
 *    be able to inject arbitrary environment variables into their container,
 *    since some images treat env as configuration for privileged behaviour.
 *  - Missing required fields without a default are an error.
 *  - `options` are enforced, so a constrained field cannot be given a free-form
 *    value.
 */
export function resolveEnv(
  blueprint: Blueprint,
  userInput: Record<string, unknown>,
): ResolvedEnv {
  const values: Record<string, string> = {};
  const secretKeys: string[] = [];
  const errors: string[] = [];

  for (const [key, field] of Object.entries(blueprint.envSchema)) {
    const raw = userInput[key];
    const provided = typeof raw === "string" ? raw.trim() : undefined;
    const value = provided && provided.length > 0 ? provided : field.default;

    if (value === undefined || value.length === 0) {
      if (field.required) {
        errors.push(`Missing required environment variable "${key}"`);
      }
      continue;
    }

    if (field.options && !field.options.includes(value)) {
      errors.push(
        `"${key}" must be one of: ${field.options.join(", ")} (got "${value}")`,
      );
      continue;
    }

    values[key] = value;
    if (field.secret) secretKeys.push(key);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return { values, secretKeys };
}
