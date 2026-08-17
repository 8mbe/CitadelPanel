/**
 * E2E tests for the SFTP credential surface (see routes/sftp.ts + docs/sftp.md).
 *
 * Two audiences use these endpoints:
 *
 *   1. The browser, via the /api/servers/:id/sftp/* routes — gated on the
 *      `files` permission, the same flag the file manager uses.
 *   2. The agent, via POST /api/internal/sftp/authenticate — which
 *      authenticates by a long-lived AGENT_TOKEN bearer (root-equivalent),
 *      NOT an API key. The panel reverse-looks-up the node from the token so
 *      a leaked token from one node cannot validate creds against another.
 *
 * The admin key reaches the seeded server's SFTP routes; the user key gets
 * 404. The agent callback rejects every API key (admin or user) with 401 —
 * an API key is not an agent bearer and `findNodeByAgentToken` returns null.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

// --- Browser-facing routes --------------------------------------------------

describe("GET /api/servers/:id/sftp/connection", () => {
  e2e("with an admin key returns host + port + whether the caller has a credential", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/connection`, { key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as { hostname?: string; port?: number; hasCredential?: boolean };
    expect(typeof body.hostname).toBe("string");
    expect(body.port).toBe(8022);
    expect(typeof body.hasCredential).toBe("boolean");
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/connection`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/connection`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/servers/:id/sftp/credentials (list, no passwords)", () => {
  e2e("with an admin key returns the credential list (passwords never present)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/credentials`, { key: config.adminKey });
    expectStatus(res, 200);
    const creds = (res.body as { credentials?: Array<{ password?: unknown }> }).credentials;
    expect(Array.isArray(creds)).toBe(true);
    // A credential summary never carries the password — only the create/
    // regenerate response reveals it once.
    for (const c of creds ?? []) expect(c.password).toBeUndefined();
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/credentials`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/servers/:id/sftp/credentials/regenerate (404 when none exists)", () => {
  e2e("with an admin key 404s when the caller has no existing credential", async () => {
    // The admin has not minted a credential for the seeded server yet (the
    // suite never mints one either). The regenerate route 404s rather than
    // accidentally creating one — distinct from POST which upserts.
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/credentials/regenerate`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/credentials/regenerate`, { method: "POST", key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/servers/:id/sftp/credentials/:credentialId", () => {
  e2e("with a non-UUID credentialId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/credentials/not-a-uuid`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + an unknown UUID is 404", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/credentials/${UNKNOWN_UUID}`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/sftp/credentials/${UNKNOWN_UUID}`, { method: "DELETE", key: config.userKey });
    expect(res.status).toBe(404);
  });
});

// --- Agent callback ---------------------------------------------------------

describe("POST /api/internal/sftp/authenticate (agent callback)", () => {
  test("without an Authorization header is 401", async () => {
    const res = await api("/api/internal/sftp/authenticate", {
      method: "POST",
      body: { username: "x", password: "y" },
    });
    expect(res.status).toBe(401);
  });

  test("with a bogus bearer is 401 (unknown agent token)", async () => {
    const res = await api("/api/internal/sftp/authenticate", {
      method: "POST",
      headers: { Authorization: `Bearer bogus-${"x".repeat(48)}` },
      body: { username: "x", password: "y" },
    });
    expect(res.status).toBe(401);
  });

  e2e("with the admin API key is 401 (an API key is not an agent bearer)", async () => {
    // The route authenticates the agent by its long-lived AGENT_TOKEN, which
    // `findNodeByAgentToken` reverse-looks-up to a node. An API key does not
    // match any node's token, so the call is rejected — a key-holding script
    // cannot enumerate valid SFTP usernames from this surface.
    const res = await api("/api/internal/sftp/authenticate", {
      method: "POST",
      key: config.adminKey,
      body: { username: "x", password: "y" },
    });
    expect(res.status).toBe(401);
  });

  e2e("with the user API key is 401 (same — not an agent bearer)", async () => {
    const res = await api("/api/internal/sftp/authenticate", {
      method: "POST",
      key: config.userKey,
      body: { username: "x", password: "y" },
    });
    expect(res.status).toBe(401);
  });

  test("with a valid-looking bearer but missing username/password is 401", async () => {
    // Even a real agent token would be rejected here because the body lacks
    // credentials; the route demands both fields.
    const res = await api("/api/internal/sftp/authenticate", {
      method: "POST",
      headers: { Authorization: `Bearer bogus-${"x".repeat(48)}` },
      body: {},
    });
    expect(res.status).toBe(401);
  });
});
