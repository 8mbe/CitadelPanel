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

  /** Cap on how large a file the file manager will read or write, in bytes. */
  maxFileBytes: optionalInt("AGENT_MAX_FILE_BYTES", 8 * 1024 * 1024),

  /** Cap on directory listing size, so a huge world folder cannot stall the panel. */
  maxDirEntries: optionalInt("AGENT_MAX_DIR_ENTRIES", 2000),
} as const;

export type AgentConfig = typeof config;
