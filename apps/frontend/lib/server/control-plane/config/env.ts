import "server-only";

import { loadRepositoryEnv } from "./load-repository-env";

loadRepositoryEnv();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function integer(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be an integer`);
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return value === "true" || value === "1";
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
const encryptionKey = required("PANEL_ENCRYPTION_KEY");
if (encryptionKey.length < 32) {
  throw new Error("PANEL_ENCRYPTION_KEY must be at least 32 characters long");
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  databaseUrl: required("DATABASE_URL"),
  encryptionKey,
  authSecret: required("BETTER_AUTH_SECRET"),
  authBaseUrl: frontendUrl,
  frontendUrl,
  firstUserBecomesAdmin: bool("FIRST_USER_BECOMES_ADMIN", true),
  nodeApiTimeoutMs: integer("NODE_API_TIMEOUT_MS", 15_000),
  /**
   * Cap on a single file uploaded through the file manager, in bytes. Enforced
   * BFF-side (so an oversized upload is rejected before it reaches the node)
   * and again agent-side. The agent's own `AGENT_MAX_UPLOAD_BYTES` must be >=
   * this for the two to agree; the default for both is 128 MB.
   */
  uploadMaxBytes: integer("UPLOAD_MAX_BYTES", 128 * 1024 * 1024),
  security: {
    watcherIntervalSeconds: integer("WATCHER_INTERVAL_SECONDS", 60),
    flagThreshold: integer("SUSPICION_FLAG_THRESHOLD", 60),
    autoSuspendEnabled: bool("SUSPICION_AUTO_SUSPEND", false),
    autoSuspendThreshold: integer("SUSPICION_AUTO_SUSPEND_THRESHOLD", 115),
  },
} as const;
