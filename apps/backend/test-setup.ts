/**
 * Test preload, wired via `bunfig.toml`.
 *
 * Config modules validate their environment at import time and throw when a
 * required variable is missing. Unit tests import modules that transitively pull
 * in that config, so deterministic dummy values are set here before any test
 * module is evaluated.
 *
 * These are not real credentials: the DATABASE_URL is never connected to by the
 * pure unit tests, and the keys exist only to satisfy validation.
 */

import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV ??= "test";
process.env.PANEL_ENCRYPTION_KEY ??=
  "test-encryption-key-that-is-long-enough-123456";
process.env.DATABASE_URL ??= "postgres://citadel:citadel@localhost:5432/citadel_test";
process.env.BETTER_AUTH_SECRET ??= "test-auth-secret-value-for-unit-tests-000000";

/**
 * The agent's data root for the whole test run.
 *
 * `src/config.ts` caches SERVER_DATA_ROOT at first import, and bun runs every
 * test file in one process with one module registry, so whichever file
 * imports config first would otherwise lock in the `.env` value, pointing
 * filesystem tests at the developer's real server data. Setting it here,
 * before any test module runs, gives every root-dependent test the same temp
 * directory via `testRoot`.
 *
 * Fixtures (per-server trees, outside-root canaries) are created in `beforeAll`
 * rather than at module scope, so test files stay independent of each other's
 * setup order. Cleanup happens once at process exit, because a per-file
 * afterAll would depend on file ordering.
 */
export const testRoot = await mkdtemp(join(tmpdir(), "citadel-agent-test-"));
process.env.SERVER_DATA_ROOT = testRoot;
process.env.AGENT_TOKEN ??= "test-agent-token-that-is-long-enough-0123456789";

process.on("exit", () => rmSync(testRoot, { recursive: true, force: true }));
