/**
 * E2E tests for the current-user routes (see routes/users.ts).
 *
 * Two endpoints:
 *
 *   - GET /api/me: the caller's identity + role + server counts. This is the
 *     single chokepoint the api-key synthesizes a session through, so it is the
 *     fastest way to assert "a key is its owner" for both keys.
 *   - POST /api/account/delete: password-confirmed self-deletion. The gate
 *     (0 owned servers, valid password) is exercised, but no account is ever
 *     actually deleted: the user key owns 0 servers and supplies a wrong
 *     password, which the Better Auth delete-user endpoint rejects as 400.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus } from "./_helpers";

describe("GET /api/me", () => {
  test("without a credential is 401", async () => {
    const res = await api("/api/me");
    expect(res.status).toBe(401);
  });

  e2e("with the user key resolves to role=user and the owner's email", async () => {
    const res = await api("/api/me", { key: config.userKey });
    expectStatus(res, 200);
    const user = (res.body as { user?: { role?: string; email?: string; id?: string } }).user;
    expect(user?.role).toBe("user");
    if (config.userEmail) expect(user?.email).toBe(config.userEmail);
    expect(user?.id).toBeTruthy();
  });

  e2e("with the admin key resolves to role=admin (and gets the review badge)", async () => {
    const res = await api("/api/me", { key: config.adminKey });
    expectStatus(res, 200);
    const user = (res.body as {
      user?: { role?: string; email?: string; ownedServers?: number; pendingReviews?: number };
    }).user;
    expect(user?.role).toBe("admin");
    if (config.adminEmail) expect(user?.email).toBe(config.adminEmail);
    // Only admins get the suspicious-activity review queue badge.
    expect(user?.pendingReviews).toBeTypeOf("number");
  });

  e2e("reports the caller's server counts", async () => {
    const res = await api("/api/me", { key: config.adminKey });
    const user = (res.body as { user?: { ownedServers?: number; subuserServers?: number } }).user;
    expect(typeof user?.ownedServers).toBe("number");
    expect(typeof user?.subuserServers).toBe("number");
  });
});

describe("POST /api/account/delete (password-confirmed self-deletion)", () => {
  test("without a credential is 401", async () => {
    const res = await api("/api/account/delete", { method: "POST", body: { password: "x" } });
    expect(res.status).toBe(401);
  });

  e2e("with a user key + missing password is 400", async () => {
    const res = await api("/api/account/delete", {
      method: "POST",
      key: config.userKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key + a wrong password is 400 (BA's delete-user verifies it)", async () => {
    // The user owns 0 servers, so the panel-side gate (no owned servers) is
    // cleared and the request reaches Better Auth's delete-user endpoint,
    // which verifies the password and rejects with a 400 on a mismatch.
    // No account is actually deleted.
    const res = await api("/api/account/delete", {
      method: "POST",
      key: config.userKey,
      body: { password: "definitely-not-the-users-password-2025" },
    });
    expect(res.status).toBe(400);
  });
});
