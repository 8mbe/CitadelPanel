/**
 * E2E tests for the first-time-setup surface (see routes/setup.ts + docs/first-time-setup.md).
 *
 * The setup wizard's design hinges on one narrow unauthenticated window that
 * closes the moment an admin exists. These tests assert that contract:
 *
 *   - GET /api/setup/status is public and reports the latch
 *   - POST /api/setup/admin refuses with 409 once an admin exists (the window
 *     is closed; the count is derived from real accounts, not the writable
 *     latch, see the route comment)
 *   - PATCH /api/setup/settings (== PATCH /api/admin/settings) is admin-only
 *     and validates its nested input
 *   - POST /api/setup/complete is idempotent, and re-running on a completed
 *     install returns the existing timestamp rather than erroring
 *
 * No setup action actually mutates panel state: the suite asserts the refusal
 * and validation paths, not the success paths, because the wizard was already
 * completed on the dev panel.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus } from "./_helpers";

describe("setup status (public)", () => {
  test("GET /api/setup/status is reachable without a credential", async () => {
    const res = await api("/api/setup/status");
    expect(res.status).toBe(200);
    const body = res.body as { needsSetup?: boolean; canCreateAdmin?: boolean };
    expect(body.needsSetup).toBe(false);
    // An admin already exists on the dev panel, so the bootstrap window is closed.
    expect(body.canCreateAdmin).toBe(false);
  });
});

describe("first-admin bootstrap is closed once an admin exists", () => {
  test("POST /api/setup/admin refuses with 409 (an admin already exists)", async () => {
    // The body would create an admin if the window were open; the route refuses
    // before touching Better Auth, so the account is never created.
    const res = await api("/api/setup/admin", {
      method: "POST",
      body: { email: "e2e-should-not-create@example.com", name: "e2e", password: "x".repeat(12) },
    });
    expect(res.status).toBe(409);
  });

  test("POST /api/setup/admin with a malformed body is 400 even before the gate", async () => {
    // Missing required fields, so the body parser rejects before the admin-count
    // gate is checked. (Both 400 and 409 are acceptable refusals; what matters
    // is that no account is created.)
    const res = await api("/api/setup/admin", { method: "POST", body: {} });
    expect([400, 409]).toContain(res.status);
  });
});

describe("setup/settings (admin-only, shared with /api/admin/settings)", () => {
  test("PATCH without a credential is 401", async () => {
    const res = await api("/api/setup/settings", { method: "PATCH", body: { timezone: "UTC" } });
    expect(res.status).toBe(401);
  });

  e2e("PATCH with a user key is 403 (admin-only)", async () => {
    const res = await api("/api/setup/settings", {
      method: "PATCH",
      key: config.userKey,
      body: { timezone: "UTC" },
    });
    expect(res.status).toBe(403);
  });

  e2e("PATCH with an admin key + empty body is 400 (must change something)", async () => {
    const res = await api("/api/setup/settings", { method: "PATCH", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("PATCH with an admin key + an invalid timezone is 400", async () => {
    const res = await api("/api/setup/settings", {
      method: "PATCH",
      key: config.adminKey,
      body: { timezone: "Not/A/Real/Zone" },
    });
    expect(res.status).toBe(400);
  });

  e2e("PATCH with an admin key + an invalid captcha provider is 400", async () => {
    const res = await api("/api/setup/settings", {
      method: "PATCH",
      key: config.adminKey,
      body: { captcha: { enabled: true, provider: "not-a-real-provider" } },
    });
    expect(res.status).toBe(400);
  });

  e2e("PATCH with an admin key + a non-boolean captcha.enabled is 400", async () => {
    const res = await api("/api/setup/settings", {
      method: "PATCH",
      key: config.adminKey,
      body: { captcha: { enabled: "yes" } },
    });
    expect(res.status).toBe(400);
  });

  e2e("PATCH with an admin key + an invalid mail provider is 400", async () => {
    const res = await api("/api/setup/settings", {
      method: "PATCH",
      key: config.adminKey,
      body: { mail: { enabled: true, provider: "not-a-real-provider" } },
    });
    expect(res.status).toBe(400);
  });

  e2e("PATCH with an admin key + a serverLimits out of range is 400", async () => {
    const res = await api("/api/setup/settings", {
      method: "PATCH",
      key: config.adminKey,
      body: { serverLimits: { maxAdditionalPortsPerServer: 999 } },
    });
    expect(res.status).toBe(400);
  });
});

describe("setup completion (idempotent)", () => {
  e2e("POST /api/setup/complete with a user key is 403", async () => {
    const res = await api("/api/setup/complete", { method: "POST", key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("POST /api/setup/complete with an admin key returns the existing timestamp", async () => {
    // Idempotent: re-running on a completed install returns the existing
    // `completedAt` rather than refusing, so a double-submit from the wizard
    // is not an error the operator has to interpret.
    const res = await api("/api/setup/complete", { method: "POST", key: config.adminKey });
    expect(res.status).toBe(200);
    const body = res.body as { completedAt?: string; alreadyComplete?: boolean };
    expect(body.completedAt).toBeTruthy();
    expect(body.alreadyComplete).toBe(true);
  });
});

describe("admin settings read + test-email", () => {
  e2e("GET /api/admin/settings with a user key is 403", async () => {
    const res = await api("/api/admin/settings", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("GET /api/admin/settings with an admin key returns the full settings view", async () => {
    const res = await api("/api/admin/settings", { key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as {
      timezone?: string;
      captcha?: unknown;
      mail?: unknown;
      verification?: unknown;
      serverLimits?: unknown;
      setup?: unknown;
    };
    expect(typeof body.timezone).toBe("string");
    expect(body.captcha).toBeDefined();
    expect(body.mail).toBeDefined();
    expect(body.verification).toBeDefined();
    expect(body.serverLimits).toBeDefined();
    expect(body.setup).toBeDefined();
  });

  e2e("POST /api/admin/settings/test-email with a non-email 'to' is 400", async () => {
    const res = await api("/api/admin/settings/test-email", {
      method: "POST",
      key: config.adminKey,
      body: { to: "not-an-email" },
    });
    expect(res.status).toBe(400);
  });

  e2e("POST /api/admin/settings/test-email with a missing 'to' is 400", async () => {
    const res = await api("/api/admin/settings/test-email", {
      method: "POST",
      key: config.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});
