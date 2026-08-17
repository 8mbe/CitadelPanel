/**
 * E2E tests for the direct-console capability-token surface
 * (see routes/console.ts + docs/direct-console.md).
 *
 * The live console is a browser → agent WebSocket with no panel-held
 * connection. Because a browser cannot set headers on a WS handshake, the
 * panel mints a short-lived, single-use capability token. Four endpoints
 * cooperate:
 *
 *   1. `POST /api/servers/:id/console/session` — browser mints a token
 *      (gated on the `console` permission; does NOT contact the agent).
 *   2. `POST /api/servers/:id/console/revoke` — browser gives up a session
 *      (gated on `console`; idempotent — revoking an unknown/already-revoked
 *      token is a no-op 204).
 *   3. `POST /api/internal/console/sessions/validate` — agent callback at WS
 *      open (gated on the long-lived AGENT_TOKEN bearer; an API key is NOT
 *      an agent bearer and is rejected with 401).
 *   4. `POST /api/internal/console/audit` — agent callback on each typed
 *      command (same agent-bearer gate; the panel resolves the user from
 *      the token so the agent cannot spoof attribution).
 *
 * The admin key reaches #1 and #2 on the seeded server (it mints + revokes
 * a real token). The user key gets 404 (no access — info-leak prevention).
 * The agent callbacks #3/#4 reject every API key with 401 — a key-holding
 * script cannot enumerate or validate console tokens.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

// --- Browser-facing routes --------------------------------------------------

describe("POST /api/servers/:id/console/session (mint a capability token)", () => {
  e2e("with an admin key returns {token, url, tty}", async () => {
    // The mint does NOT contact the agent — it queries the server+node,
    // checks the mixed-content guard, and inserts a console_sessions row.
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/console/session`, { method: "POST", key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as { token?: string; url?: string; tty?: boolean };
    expect(typeof body.token).toBe("string");
    expect(typeof body.url).toBe("string");
    expect(typeof body.tty).toBe("boolean");
  });

  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api("/api/servers/not-a-uuid/console/session", { method: "POST", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with an unknown UUID is 404", async () => {
    const res = await api(`/api/servers/${UNKNOWN_UUID}/console/session`, { method: "POST", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/console/session`, { method: "POST", key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/console/session`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/servers/:id/console/revoke (give up a session)", () => {
  e2e("with an admin key + a just-minted token is 204", async () => {
    // Mint then revoke — the revoke is scoped to the caller's user_id and
    // idempotent, so the just-minted token is successfully revoked.
    const { serverId } = await loadFixtures();
    const mint = await api(`/api/servers/${serverId}/console/session`, { method: "POST", key: config.adminKey });
    const token = (mint.body as { token?: string }).token;
    expect(token).toBeDefined();

    const res = await api(`/api/servers/${serverId}/console/revoke`, {
      method: "POST",
      key: config.adminKey,
      body: { token },
    });
    expect(res.status).toBe(204);
  });

  e2e("with an admin key + an unknown token is 204 (idempotent)", async () => {
    // Revoking a token that never existed is a no-op 204 — the caller's
    // intent ("this token is done") is already satisfied.
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/console/revoke`, {
      method: "POST",
      key: config.adminKey,
      body: { token: UNKNOWN_UUID },
    });
    expect(res.status).toBe(204);
  });

  e2e("with an admin key + missing token is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/console/revoke`, { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api("/api/servers/not-a-uuid/console/revoke", {
      method: "POST",
      key: config.adminKey,
      body: { token: "x" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/console/revoke`, {
      method: "POST",
      key: config.userKey,
      body: { token: "x" },
    });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/console/revoke`, { method: "POST", body: { token: "x" } });
    expect(res.status).toBe(401);
  });
});

// --- Agent callbacks ---------------------------------------------------------

describe("POST /api/internal/console/sessions/validate (agent callback at WS open)", () => {
  test("without an Authorization header is 401", async () => {
    const res = await api("/api/internal/console/sessions/validate", { method: "POST", body: { token: "x" } });
    expect(res.status).toBe(401);
  });

  test("with a bogus bearer is 401 (unknown agent token)", async () => {
    const res = await api("/api/internal/console/sessions/validate", {
      method: "POST",
      headers: { Authorization: `Bearer bogus-${"x".repeat(48)}` },
      body: { token: "x" },
    });
    expect(res.status).toBe(401);
  });

  e2e("with the admin API key is 401 (an API key is not an agent bearer)", async () => {
    // The route authenticates the agent by its long-lived AGENT_TOKEN, which
    // `findNodeByAgentToken` reverse-looks-up to a node. An API key does not
    // match any node's token, so the call is rejected — a key-holding script
    // cannot validate (consume) console tokens from this surface.
    const res = await api("/api/internal/console/sessions/validate", {
      method: "POST",
      key: config.adminKey,
      body: { token: "x" },
    });
    expect(res.status).toBe(401);
  });

  e2e("with the user API key is 401 (same — not an agent bearer)", async () => {
    const res = await api("/api/internal/console/sessions/validate", {
      method: "POST",
      key: config.userKey,
      body: { token: "x" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/internal/console/audit (agent callback on each command)", () => {
  test("without an Authorization header is 401", async () => {
    const res = await api("/api/internal/console/audit", {
      method: "POST",
      body: { token: "x", serverId: "x", command: "x" },
    });
    expect(res.status).toBe(401);
  });

  test("with a bogus bearer is 401 (unknown agent token)", async () => {
    const res = await api("/api/internal/console/audit", {
      method: "POST",
      headers: { Authorization: `Bearer bogus-${"x".repeat(48)}` },
      body: { token: "x", serverId: "x", command: "x" },
    });
    expect(res.status).toBe(401);
  });

  e2e("with the admin API key is 401 (an API key is not an agent bearer)", async () => {
    // Same gate as /validate: the agent is authenticated by its AGENT_TOKEN,
    // not by any API key. A key-holding script cannot forge console command
    // audit rows from this surface.
    const res = await api("/api/internal/console/audit", {
      method: "POST",
      key: config.adminKey,
      body: { token: "x", serverId: "x", command: "x" },
    });
    expect(res.status).toBe(401);
  });

  e2e("with the user API key is 401 (same — not an agent bearer)", async () => {
    const res = await api("/api/internal/console/audit", {
      method: "POST",
      key: config.userKey,
      body: { token: "x", serverId: "x", command: "x" },
    });
    expect(res.status).toBe(401);
  });
});
