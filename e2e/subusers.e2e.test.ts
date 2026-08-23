/**
 * E2E tests for the subuser routes (see routes/subusers.ts + docs/subusers.md).
 *
 * Subuser management is owner-or-admin only. A subuser can never invite
 * further subusers, which would let a delegated grant escalate itself. The
 * suite exercises the permission gates (404 for the user key, which has no
 * relationship to the admin's server) and the input validation (email
 * shape, non-empty permission grant). No subuser is actually invited,
 * updated, or removed. That would create a real grant row on the seeded
 * server.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

describe("GET /api/servers/:id/subusers", () => {
  e2e("with an admin key returns the subuser list + the available permissions", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, { key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as { subusers?: unknown[]; availablePermissions?: string[] };
    expect(Array.isArray(body.subusers)).toBe(true);
    expect(Array.isArray(body.availablePermissions)).toBe(true);
    expect(body.availablePermissions!.length).toBeGreaterThan(0);
  });

  e2e("with a user key is 404 (no access, not even a subuser)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/servers/:id/subusers (invite)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, {
      method: "POST",
      key: config.userKey,
      body: { email: "x@example.com", permissions: { console: true } },
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + missing email is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, {
      method: "POST",
      key: config.adminKey,
      body: { permissions: { console: true } },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-string email is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, {
      method: "POST",
      key: config.adminKey,
      body: { email: 123, permissions: { console: true } },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + an empty permission grant is 400", async () => {
    // Every permission false/absent. The route refuses a no-op grant.
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, {
      method: "POST",
      key: config.adminKey,
      body: { email: "x@example.com", permissions: { console: false } },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a missing permissions object is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, {
      method: "POST",
      key: config.adminKey,
      body: { email: "x@example.com" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-existent invitee email is 404", async () => {
    // The invitee must already have an account. There is no email-invite flow.
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers`, {
      method: "POST",
      key: config.adminKey,
      body: { email: "no-such-account@example.com", permissions: { console: true } },
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/servers/:id/subusers/:userId (update permissions)", () => {
  e2e("with a non-UUID userId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers/not-a-uuid`, {
      method: "PATCH",
      key: config.adminKey,
      body: { permissions: { console: true } },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-existent subuser is 404", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers/${UNKNOWN_UUID}`, {
      method: "PATCH",
      key: config.adminKey,
      body: { permissions: { console: true } },
    });
    expect(res.status).toBe(404);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers/${UNKNOWN_UUID}`, {
      method: "PATCH",
      key: config.userKey,
      body: { permissions: { console: true } },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/servers/:id/subusers/:userId (revoke)", () => {
  e2e("with a non-UUID userId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers/not-a-uuid`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-existent subuser is 404", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers/${UNKNOWN_UUID}`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/subusers/${UNKNOWN_UUID}`, { method: "DELETE", key: config.userKey });
    expect(res.status).toBe(404);
  });
});
