/**
 * Test preload, wired via `bunfig.toml`.
 *
 * `src/config/env.ts` validates configuration at import time and throws when a
 * required variable is missing. Unit tests import modules that transitively pull
 * in that config, so deterministic dummy values are set here before any test
 * module is evaluated.
 *
 * These are not real credentials: the DATABASE_URL is never connected to by the
 * pure unit tests, and the keys exist only to satisfy validation.
 */

process.env.NODE_ENV ??= "test";
process.env.PANEL_ENCRYPTION_KEY ??=
  "test-encryption-key-that-is-long-enough-123456";
process.env.DATABASE_URL ??= "postgres://citadel:citadel@localhost:5432/citadel_test";
process.env.BETTER_AUTH_SECRET ??= "test-auth-secret-value-for-unit-tests-000000";
