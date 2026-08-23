/**
 * E2E tests for the server plugin/mod routes (see routes/plugins.ts + docs/plugins.md).
 *
 * All of these require the `files` permission. Installing, removing, or
 * toggling a plugin is a filesystem write, so the same grant that lets a
 * subuser manage files lets them manage plugins. Catalog calls (search,
 * version lists) are proxied through the panel so the browser never learns
 * the catalog's address; they require a blueprint with a plugin spec, which
 * the seeded minecraft-java blueprint may or may not declare.
 *
 * The admin key reaches the seeded server's plugin routes; the user key gets
 * 404, since hiding existence prevents an info leak. Mutations
 * (install/remove/toggle) are gated + validated, not exercised against real
 * plugin state.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

describe("GET /api/servers/:id/plugins (installed plugins, reconciled with disk)", () => {
  e2e("with an admin key returns the installed-plugin list", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins`, { key: config.adminKey });
    expectStatus(res, 200);
    // The shape is owned by the plugin manager; the panel forwards it. An
    // empty server reports no plugins, which is a valid response.
    expect(res.body).toBeDefined();
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/servers/:id/plugins/search (catalog proxy)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/search?q=x`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/search?q=x`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/servers/:id/plugins/versions/:projectId", () => {
  e2e("with an invalid projectId is 400", async () => {
    const { serverId } = await loadFixtures();
    // The project-id pattern is `/^[A-Za-z0-9_-]{1,64}$/`, so a slash is rejected.
    const res = await api(`/api/servers/${serverId}/plugins/versions/bad%2Fid`, { key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/servers/:id/plugins/install", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/install`, {
      method: "POST",
      key: config.userKey,
      body: { projectId: "x", versionId: "y" },
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + missing projectId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/install`, {
      method: "POST",
      key: config.adminKey,
      body: { versionId: "y" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing versionId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/install`, {
      method: "POST",
      key: config.adminKey,
      body: { projectId: "x" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a malformed projectId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/install`, {
      method: "POST",
      key: config.adminKey,
      body: { projectId: "bad/id", versionId: "y" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/servers/:id/plugins/:pluginId/toggle", () => {
  e2e("with a non-UUID pluginId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/not-a-uuid/toggle`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/${UNKNOWN_UUID}/toggle`, { method: "POST", key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/servers/:id/plugins/:pluginId", () => {
  e2e("with a non-UUID pluginId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/not-a-uuid`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins/${UNKNOWN_UUID}`, { method: "DELETE", key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/servers/:id/plugins (auto-update setting)", () => {
  e2e("with an admin key + non-boolean autoUpdate is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins`, {
      method: "PATCH",
      key: config.adminKey,
      body: { autoUpdate: "yes" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing autoUpdate is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins`, { method: "PATCH", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/plugins`, { method: "PATCH", key: config.userKey, body: { autoUpdate: true } });
    expect(res.status).toBe(404);
  });
});
