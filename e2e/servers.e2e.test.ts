/**
 * E2E tests for the server routes (see routes/servers.ts).
 *
 * Every handler resolves through `auth/middleware.ts`:
 *   - viewing (GET)         -> any access (owner/subuser/admin)
 *   - start/stop/kill       -> "start_stop"
 *   - settings/env/ports/links -> "settings"
 *   - databases             -> "database"
 *   - delete / links-edit   -> owner-or-admin only (never delegable)
 *
 * The admin owns the only seeded server, so the admin key reaches every
 * happy-path read on it. The user key has no relationship to that server, so
 * the auth middleware returns 404 (not 403) — revealing that a server exists
 * to someone with no relationship to it is an information leak, by design.
 *
 * Destructive lifecycle actions (start/stop/restart/kill/delete) are NOT
 * exercised against the real server — they would mutate the dev panel's
 * state. The suite asserts their permission gates (404 for the user key) and
 * validation (400 for a bad serverId), not their side effects.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

// --- List + detail -----------------------------------------------------------

describe("GET /api/servers (the caller's own + subuser access)", () => {
  test("without a credential is 401", async () => {
    const res = await api("/api/servers");
    expect(res.status).toBe(401);
  });

  e2e("with an admin key returns the admin's own servers", async () => {
    const res = await api("/api/servers", { key: config.adminKey });
    expectStatus(res, 200);
    const servers = (res.body as { servers?: Array<{ id?: string }> }).servers;
    expect(Array.isArray(servers)).toBe(true);
    expect(servers!.length).toBeGreaterThan(0);
  });

  e2e("with a user key returns an empty list (user owns nothing)", async () => {
    const res = await api("/api/servers", { key: config.userKey });
    expectStatus(res, 200);
    expect((res.body as { servers?: unknown[] }).servers).toEqual([]);
  });
});

describe("GET /api/servers/:id (detail)", () => {
  e2e("with an admin key returns the server + the caller's viewer access", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}`, { key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as {
      server?: { id?: string; status?: string; blueprintKey?: string };
      viewer?: { kind?: string; permissions?: unknown };
    };
    expect(body.server?.id).toBe(serverId);
    expect(body.viewer?.kind).toBeTruthy();
  });

  e2e("with a user key is 404 (no access — info-leak prevention)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api("/api/servers/not-a-uuid", { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a well-formed but unknown UUID is 404", async () => {
    const res = await api(`/api/servers/${UNKNOWN_UUID}`, { key: config.adminKey });
    expect(res.status).toBe(404);
  });
});

// --- Lifecycle action gates (start/stop/restart/kill) ----------------------

describe("server lifecycle action gates", () => {
  for (const action of ["start", "stop", "restart", "kill"] as const) {
    e2e(`POST /api/servers/:id/${action} with a user key is 404 (no access)`, async () => {
      const { serverId } = await loadFixtures();
      const res = await api(`/api/servers/${serverId}/${action}`, { method: "POST", key: config.userKey });
      expect(res.status).toBe(404);
    });

    e2e(`POST /api/servers/:id/${action} with a non-UUID serverId is 400`, async () => {
      const res = await api(`/api/servers/not-a-uuid/${action}`, { method: "POST", key: config.adminKey });
      expect(res.status).toBe(400);
    });
  }
});

// --- Delete gate -------------------------------------------------------------

describe("DELETE /api/servers/:id (owner-or-admin only)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}`, { method: "DELETE", key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api("/api/servers/not-a-uuid", { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

// --- Env read/write ---------------------------------------------------------

describe("GET /api/servers/:id/env (settings permission)", () => {
  e2e("with an admin key returns the editable env view", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/env`, { key: config.adminKey });
    expectStatus(res, 200);
    const env = (res.body as { env?: Array<{ key?: string; isSecret?: boolean }> }).env;
    expect(Array.isArray(env)).toBe(true);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/env`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/servers/:id/env (settings permission)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/env`, { method: "PATCH", key: config.userKey, body: { env: {} } });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + missing env field is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/env`, { method: "PATCH", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + non-object env is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/env`, {
      method: "PATCH",
      key: config.adminKey,
      body: { env: "not-an-object" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + env containing a non-editable var is 400", async () => {
    // SERVER_PORT is set by the panel on the container; the blueprint schema
    // marks it non-editable, so the owner cannot change it on a running server.
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/env`, {
      method: "PATCH",
      key: config.adminKey,
      body: { env: { SERVER_PORT: "25566" } },
    });
    expect(res.status).toBe(400);
  });
});

// --- Logs / stats / activity (console permission) --------------------------

describe("GET /api/servers/:id/logs", () => {
  e2e("with an admin key returns logs (empty when stopped)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/logs`, { key: config.adminKey });
    expectStatus(res, 200);
    expect(typeof (res.body as { logs?: string }).logs).toBe("string");
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/logs`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/servers/:id/stats", () => {
  e2e("with an admin key returns stats (null when stopped)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/stats`, { key: config.adminKey });
    expectStatus(res, 200);
    expect((res.body as { stats?: unknown }).stats).toBeNull();
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/stats`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/servers/:id/activity", () => {
  e2e("with an admin key returns the per-server audit feed", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/activity`, { key: config.adminKey });
    expectStatus(res, 200);
    expect(Array.isArray((res.body as { entries?: unknown[] }).entries)).toBe(true);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/activity`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

// --- Ports (settings permission) -------------------------------------------

describe("GET /api/servers/:id/ports", () => {
  e2e("with an admin key returns the published ports", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports`, { key: config.adminKey });
    expectStatus(res, 200);
    expect(Array.isArray((res.body as { ports?: unknown[] }).ports)).toBe(true);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/servers/:id/ports (settings permission)", () => {
  // The caller cannot name a port: the panel allocates a random one from the
  // node's pool. So the only inputs left to reject are the label and access.
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports`, {
      method: "POST",
      key: config.userKey,
      body: {},
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + over-long label is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports`, {
      method: "POST",
      key: config.adminKey,
      body: { label: "x".repeat(65) },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a port number in the body is ignored, not honored", async () => {
    // A stale client sending `port` must not get that port. Either the request
    // succeeds with a panel-chosen number or it fails for a real reason (no
    // pool, node unreachable) — never 400 for the extra key.
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports`, {
      method: "POST",
      key: config.adminKey,
      body: { port: 25566, protocol: "tcp" },
    });
    expect(res.status).not.toBe(400);
  });
});

describe("DELETE /api/servers/:id/ports (settings permission)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports?port=25565`, {
      method: "DELETE",
      key: config.userKey,
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + missing port is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + out-of-range port is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/ports?port=99999`, {
      method: "DELETE",
      key: config.adminKey,
    });
    expect(res.status).toBe(400);
  });
});

// --- Links (settings view / owner edit) -----------------------------------

describe("GET /api/servers/:id/links", () => {
  e2e("with an admin key returns the link list", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/links`, { key: config.adminKey });
    expectStatus(res, 200);
    expect(Array.isArray((res.body as { links?: unknown[] }).links)).toBe(true);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/links`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/servers/:id/links (owner-or-admin on BOTH servers)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/links`, {
      method: "POST",
      key: config.userKey,
      body: { targetId: UNKNOWN_UUID },
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + a non-UUID targetId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/links`, {
      method: "POST",
      key: config.adminKey,
      body: { targetId: "not-a-uuid" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a missing targetId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/links`, { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/servers/:id/links/:linkId (owner-or-admin)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/links/${UNKNOWN_UUID}`, {
      method: "DELETE",
      key: config.userKey,
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + a non-UUID linkId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/links/not-a-uuid`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

// --- Databases (database permission) --------------------------------------

describe("GET /api/servers/:id/databases", () => {
  e2e("with an admin key returns the (empty) database list", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/databases`, { key: config.adminKey });
    expectStatus(res, 200);
    expect(Array.isArray((res.body as { databases?: unknown[] }).databases)).toBe(true);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/databases`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("server database action gates", () => {
  e2e("POST /api/servers/:id/databases with a user key is 404", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/databases`, { method: "POST", key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("DELETE /api/servers/:id/databases/:dbId with a non-UUID dbId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/databases/not-a-uuid`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("POST reset-password with a non-UUID dbId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/databases/not-a-uuid/reset-password`, {
      method: "POST",
      key: config.adminKey,
    });
    expect(res.status).toBe(400);
  });
});
