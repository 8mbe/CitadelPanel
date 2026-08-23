/**
 * Agent configuration.
 *
 * Resolved and validated once at import time so a misconfigured node fails at
 * boot rather than at the first container operation — the same fail-fast
 * posture the panel backend uses in `config/env.ts`.
 */

import { resolve } from "node:path";

function required(key: string): string {
  const value = process.env[key];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required environment variable: ${key}. See apps/backend/README.md.`, 
    );
  }
  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.length > 0 ? value : fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got "${raw}".`);
  }
  return parsed;
}

/**
 * A runtime name is handed to the daemon verbatim, so the only validation that
 * makes sense here is shape: a plausible runtime identifier, not a flag or a
 * path with spaces. Whether the daemon actually has it is checked at boot.
 */
function validateRuntimeName(value: string): string {
  if (value === "") return value;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(
      `CONTAINER_RUNTIME must be a runtime name like "runsc" or "kata-runtime", got "${value}".`,
    );
  }
  return value;
}

/**
 * The shared secret the panel presents as a bearer token.
 *
 * This API is root-equivalent for this host (it drives the Docker socket), so a
 * short or guessable token is a host compromise. 32 characters is the same
 * floor the panel enforces on its own encryption key.
 */
const token = process.env.NODE_TOKEN?.trim() || required("AGENT_TOKEN");
if (token.length < 32) {
  throw new Error(
    "AGENT_TOKEN must be at least 32 characters. This token grants " +
      "root-equivalent control of this node; generate one with: openssl rand -base64 48",
  );
}

export const config = {
  port: optionalInt("AGENT_PORT", 8081),

  /** Bearer token the panel must present on every request. */
  token,

  /**
   * Root directory for per-server data. Every path the agent touches is derived
   * from this plus a server id — the panel never supplies a host path, which is
   * what stops a compromised panel from bind-mounting `/` into a container.
   */
  serverDataRoot: resolve(optional("SERVER_DATA_ROOT", "/var/lib/citadel/servers")),

  /** Local Docker socket. The agent only ever talks to its own daemon. */
  dockerSocket: optional("DOCKER_SOCKET", "/var/run/docker.sock"),

  /**
   * OCI runtime for tenant containers (Docker `--runtime`), e.g. `runsc` for
   * gVisor or `kata-runtime`. Empty means the daemon default (`runc`).
   *
   * A per-node knob rather than a panel setting because it names a binary
   * installed on *this* host — the panel has no way to know what a node has.
   * Validated for shape here and against the daemon's runtime list at boot
   * (see `reportContainerSecurityAtBoot`), so a typo surfaces as one clear
   * line instead of a create-time error on every provision.
   */
  containerRuntime: validateRuntimeName(optional("CONTAINER_RUNTIME", "")),

  /**
   * Manual override for the userns-remap subordinate base (see
   * `docker/userns.ts`). -1 (the default) means auto-detect from the daemon;
   * set both only when detection fails on an exotic daemon configuration.
   */
  usernsUidOffset: optionalInt("USERNS_UID_OFFSET", -1),
  usernsGidOffset: optionalInt("USERNS_GID_OFFSET", -1),

  /** Cap on how large a file the file manager will read or write, in bytes. */
  maxFileBytes: optionalInt("AGENT_MAX_FILE_BYTES", 8 * 1024 * 1024),

  /**
   * Cap on a single uploaded file's size, in bytes. Distinct from
   * `maxFileBytes` because uploads carry arbitrary binary payloads (world
   * archives, plugin jars) that are legitimately far larger than the text
   * files the inline editor handles.
   */
  maxUploadBytes: optionalInt("AGENT_MAX_UPLOAD_BYTES", 128 * 1024 * 1024),

  /** Cap on directory listing size, so a huge world folder cannot stall the panel. */
  maxDirEntries: optionalInt("AGENT_MAX_DIR_ENTRIES", 2000),

  /**
   * Base URL of the panel, for the direct-console WebSocket's validate + audit
   * callbacks. Empty string disables the browser-direct console (the WS path
   * returns 503); the panel→agent lifecycle routes are unaffected either way.
   */
  panelUrl: optional("PANEL_URL", ""),

  /**
   * Optional TLS material for the HTTP/WS server. When both are set the agent
   * serves HTTPS/WSS — required when the panel is HTTPS and the browser connects
   * directly (a `ws://` URL from an `https://` page is blocked as mixed content).
   * Paths are resolved lazily via `Bun.file` at server start.
   */
  tlsCert: optional("AGENT_TLS_CERT", ""),
  tlsKey: optional("AGENT_TLS_KEY", ""),

  /**
   * Port for the custom SFTP server (ssh2). Runs in the same process as the HTTP
   * agent, on its own TCP listener. 8022 keeps it clear of the agent's 8081 and
   * of the game servers' own port range. Set to empty to disable SFTP entirely.
   */
  sftpPort: optionalInt("SFTP_PORT", 8022),

  /**
   * Path to the SFTP host key (RSA, PEM). Generated on first boot if missing and
   * persisted so clients see a stable fingerprint across restarts. Defaults to a
   * sibling of the data root so it survives alongside server data.
   */
  sftpHostKeyPath: optional(
    "SFTP_HOST_KEY_PATH",
    resolve(optional("SERVER_DATA_ROOT", "/var/lib/citadel/servers"), "../sftp_host_key"),
  ),

  /**
   * The shared per-node database network. Created by `scripts/setup-node-db.ts`,
   * which also starts the MariaDB container. The agent attaches a server's
   * container to this network when its owner provisions a database, so the game
   * server can reach MariaDB (and nothing else on that network — ICC is off).
   */
  nodeDbNetwork: optional("NODE_DB_NETWORK", "node_db_net"),

  /**
   * The MariaDB container name on the node DB network. The agent execs SQL
   * inside this container and resolves its IP to report back to the panel.
   */
  nodeDbContainer: optional("NODE_DB_CONTAINER", "citadel-node-db"),

  /**
   * Scratch space for backup work: database dumps on the way into a snapshot,
   * and on the way back out during a restore.
   *
   * Deliberately a *sibling* of the data root rather than a directory inside
   * it. A dump written under `<serverDataRoot>/<id>` would be visible in the
   * file manager and over SFTP — so a plaintext copy of the game's database
   * would be readable by every subuser with the `files` permission but not the
   * `database` one. It would also land inside the very tree restic is walking.
   */
  backupStagingRoot: resolve(
    optional(
      "BACKUP_STAGING_ROOT",
      resolve(optional("SERVER_DATA_ROOT", "/var/lib/citadel/servers"), "../backup-staging"),
    ),
  ),

  /**
   * The restic image the agent runs backups with.
   *
   * restic is the backup engine rather than a hand-rolled tar-to-S3 uploader
   * because snapshots, deduplication, compression and client-side encryption
   * are the parts of a backup system that are hard to get right — see
   * `docs/backups.md`. It runs in a throwaway container instead of being
   * installed on the host so a node needs nothing beyond the Docker socket the
   * agent already owns.
   *
   * Pinned, not `latest`: a repository written by one restic version and read
   * by another is a thing to opt into, not to discover after an upgrade.
   */
  resticImage: optional("RESTIC_IMAGE", "restic/restic:0.19.1"),

  /**
   * Network for the agent's own tooling containers (restic, database dumps).
   *
   * Its own bridge rather than the default one: these containers hold the
   * operator's S3 credentials and a server's database password, so no tenant
   * container should ever share a network with them.
   */
  backupNetwork: optional("BACKUP_NETWORK", "citadel_backup_net"),

  /**
   * Cap on how many log lines the agent retains per backup job. The panel
   * drains these as the job runs; the cap bounds a runaway restic's memory use
   * on the node.
   */
  maxBackupLogLines: optionalInt("AGENT_MAX_BACKUP_LOG_LINES", 2000),
} as const;

export type AgentConfig = typeof config;
