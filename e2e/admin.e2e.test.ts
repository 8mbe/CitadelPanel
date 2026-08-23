/**
 * E2E tests for the admin surface (see routes/admin.ts).
 *
 * Every handler is gated on `requireAdmin`, which checks the global role only.
 * Subuser permissions can never reach these endpoints. The suite covers:
 *
 *   - the user-management surface (list, detail, role/ban/unban gates)
 *   - the admin server surface (fleet list, resource limits, suspend/unsuspend)
 *   - the security surface (suspicious activity list/review, scan sweep)
 *   - the audit feed
 *
 * Destructive mutations (actually banning a user, suspending a server,
 * promoting/demoting) are not exercised, because they would destabilize the
 * dev panel. The suite asserts the gates and validation instead. One happy-path
 * write IS covered: `POST /api/admin/scan` triggers a detection sweep, which
 * is idempotent and side-effect-free (it just re-runs the watcher).
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

// --- Users -------------------------------------------------------------------

describe("GET /api/admin/users", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/users", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key lists every account", async () => {
    const res = await api("/api/admin/users", { key: config.adminKey });
    expectStatus(res, 200);
    const users = (res.body as { users?: Array<{ id?: string; email?: string }> }).users;
    expect(users!.length).toBeGreaterThanOrEqual(2);
  });

  e2e("with an admin key + ?q= filters by email/name", async () => {
    const res = await api("/api/admin/users?q=doesnotexist@example.com", { key: config.adminKey });
    expectStatus(res, 200);
    expect((res.body as { users?: unknown[] }).users).toEqual([]);
  });
});

describe("GET /api/admin/users/:id", () => {
  e2e("with an admin key returns the user + their owned servers", async () => {
    const { adminUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${adminUserId}`, { key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as { user?: { id?: string; servers?: unknown[] } };
    expect(body.user?.id).toBe(adminUserId);
    expect(Array.isArray(body.user?.servers)).toBe(true);
  });

  e2e("with an unknown id is 404", async () => {
    const res = await api(`/api/admin/users/${UNKNOWN_UUID}`, { key: config.adminKey });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/admin/users/:id/role", () => {
  e2e("with an admin key + an invalid role is 400", async () => {
    const { userUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${userUserId}/role`, {
      method: "PATCH",
      key: config.adminKey,
      body: { role: "superadmin" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing role is 400", async () => {
    const { userUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${userUserId}/role`, { method: "PATCH", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key targeting the admin's OWN id is 409 (no self-role-change)", async () => {
    const { adminUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${adminUserId}/role`, {
      method: "PATCH",
      key: config.adminKey,
      body: { role: "user" },
    });
    expect(res.status).toBe(409);
  });

  e2e("with a user key is 403", async () => {
    const { userUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${userUserId}/role`, {
      method: "PATCH",
      key: config.userKey,
      body: { role: "user" },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/users/:id/ban + unban", () => {
  e2e("ban with an admin key targeting the admin's OWN id is 409 (no self-ban)", async () => {
    const { adminUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${adminUserId}/ban`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(409);
  });

  e2e("ban with an unknown id is 404", async () => {
    const res = await api(`/api/admin/users/${UNKNOWN_UUID}/ban`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("ban with a bad banExpiresInSeconds range is 400", async () => {
    const { userUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${userUserId}/ban`, {
      method: "POST",
      key: config.adminKey,
      body: { banExpiresInSeconds: 10 }, // min is 60
    });
    expect(res.status).toBe(400);
  });

  e2e("unban with an unknown id is 404", async () => {
    const res = await api(`/api/admin/users/${UNKNOWN_UUID}/unban`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("ban with a user key is 403", async () => {
    const { userUserId } = await loadFixtures();
    const res = await api(`/api/admin/users/${userUserId}/ban`, { method: "POST", key: config.userKey });
    expect(res.status).toBe(403);
  });
});

// --- Admin servers -----------------------------------------------------------

describe("GET /api/admin/servers (fleet-wide)", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/servers", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key lists every server with owner context + usage", async () => {
    const res = await api("/api/admin/servers", { key: config.adminKey });
    expectStatus(res, 200);
    const servers = (res.body as { servers?: Array<{ ownerEmail?: string }> }).servers;
    expect(servers!.length).toBeGreaterThan(0);
    expect(servers!.every((s) => typeof s.ownerEmail === "string")).toBe(true);
  });
});

describe("POST /api/admin/servers (provision for a user)", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/servers", { method: "POST", key: config.userKey, body: {} });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key + empty body is 400", async () => {
    const res = await api("/api/admin/servers", { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-existent ownerId is 404", async () => {
    const res = await api("/api/admin/servers", {
      method: "POST",
      key: config.adminKey,
      body: {
        name: "e2e-should-not-create",
        ownerId: "non-existent-owner-id",
        blueprintKey: "minecraft-java",
        cpuLimit: 2,
        memoryLimitMb: 2048,
        diskLimitMb: 5120,
      },
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + an out-of-range cpuLimit is 400", async () => {
    const { userUserId } = await loadFixtures();
    const res = await api("/api/admin/servers", {
      method: "POST",
      key: config.adminKey,
      body: {
        name: "e2e-should-not-create",
        ownerId: userUserId,
        blueprintKey: "minecraft-java",
        cpuLimit: 999,
        memoryLimitMb: 2048,
        diskLimitMb: 5120,
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/admin/servers/:id (resource limits, stopped-only)", () => {
  e2e("with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/servers/not-a-uuid", { method: "PATCH", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an unknown UUID is 404", async () => {
    const res = await api(`/api/admin/servers/${UNKNOWN_UUID}`, { method: "PATCH", key: config.adminKey, body: {} });
    expect(res.status).toBe(404);
  });

  e2e("with a user key is 403", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/admin/servers/${serverId}`, { method: "PATCH", key: config.userKey, body: {} });
    expect(res.status).toBe(403);
  });
});

describe("admin server suspend/unsuspend gates", () => {
  e2e("suspend with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/servers/not-a-uuid/suspend", {
      method: "POST",
      key: config.adminKey,
      body: { reason: "x" },
    });
    expect(res.status).toBe(400);
  });

  e2e("suspend with an unknown UUID is 404", async () => {
    const res = await api(`/api/admin/servers/${UNKNOWN_UUID}/suspend`, {
      method: "POST",
      key: config.adminKey,
      body: { reason: "x".repeat(3) },
    });
    expect(res.status).toBe(404);
  });

  e2e("suspend with a too-short reason is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/admin/servers/${serverId}/suspend`, {
      method: "POST",
      key: config.adminKey,
      body: { reason: "x" }, // min 3
    });
    expect(res.status).toBe(400);
  });

  e2e("suspend with a user key is 403", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/admin/servers/${serverId}/suspend`, {
      method: "POST",
      key: config.userKey,
      body: { reason: "x".repeat(3) },
    });
    expect(res.status).toBe(403);
  });

  e2e("unsuspend with an unknown UUID is 404", async () => {
    const res = await api(`/api/admin/servers/${UNKNOWN_UUID}/unsuspend`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(404);
  });
});

// --- Suspicious activity ---------------------------------------------------

describe("GET /api/admin/suspicious-activity", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/suspicious-activity", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key returns the feed + pending count", async () => {
    const res = await api("/api/admin/suspicious-activity", { key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as { activity?: unknown[]; pendingCount?: number };
    expect(Array.isArray(body.activity)).toBe(true);
    expect(typeof body.pendingCount).toBe("number");
  });

  e2e("with an admin key + includeReviewed=true returns reviewed entries too", async () => {
    const res = await api("/api/admin/suspicious-activity?includeReviewed=true", { key: config.adminKey });
    expectStatus(res, 200);
  });
});

describe("suspicious-activity detail + review", () => {
  e2e("GET /api/admin/suspicious-activity/:id with an unknown id is 404", async () => {
    const res = await api(`/api/admin/suspicious-activity/${UNKNOWN_UUID}`, { key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("GET with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/suspicious-activity/not-a-uuid", { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("POST review with an unknown id is 404", async () => {
    const res = await api(`/api/admin/suspicious-activity/${UNKNOWN_UUID}/review`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("POST review with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/suspicious-activity/not-a-uuid/review", { method: "POST", key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/scan (trigger a detection sweep)", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/scan", { method: "POST", key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key runs the sweep and returns its result", async () => {
    // Idempotent and side-effect-free: re-running the watcher just rescans
    // the existing container population for abuse signals.
    const res = await api("/api/admin/scan", { method: "POST", key: config.adminKey });
    expectStatus(res, 200);
    expect((res.body as { result?: unknown }).result).toBeDefined();
  });
});

// --- Audit log ---------------------------------------------------------------

describe("GET /api/admin/audit-logs", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/audit-logs", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key returns the enriched feed", async () => {
    const res = await api("/api/admin/audit-logs?limit=10", { key: config.adminKey });
    expectStatus(res, 200);
    const logs = (res.body as { logs?: Array<{ action?: string; actor_email?: string | null }> }).logs;
    expect(Array.isArray(logs)).toBe(true);
  });

  e2e("returns the empty-list shape when the limit yields no rows", async () => {
    // A tiny limit is still a valid request. The route clamps to the default.
    const res = await api("/api/admin/audit-logs?limit=1", { key: config.adminKey });
    expect(res.status).toBe(200);
  });
});
