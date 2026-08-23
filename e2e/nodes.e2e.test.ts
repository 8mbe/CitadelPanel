/**
 * E2E tests for the node-management surface (see routes/nodes.ts).
 *
 * Every node route is admin-only without exception: a node's agent token is
 * root-equivalent access to that machine. The suite exercises the admin-key
 * happy-path reads (list, detail, health, port pool) and the strict input
 * validation on create/update/probe. It never actually registers, drains,
 * or deletes a node, because those mutations would destabilize the dev panel
 * (the one seeded node hosts the one seeded server).
 *
 * `DELETE /api/admin/nodes/:id` is asserted at its safety gate: an active
 * node returns 409 ("drain first"), not a silent cleanup.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

describe("GET /api/admin/nodes (list)", () => {
  e2e("with a user key is 403 (admin-only)", async () => {
    const res = await api("/api/admin/nodes", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("without a credential is 401", async () => {
    const res = await api("/api/admin/nodes");
    expect(res.status).toBe(401);
  });

  e2e("with an admin key lists nodes with capacity + allocation", async () => {
    const res = await api("/api/admin/nodes", { key: config.adminKey });
    expectStatus(res, 200);
    const nodes = (res.body as { nodes?: Array<{ id?: string; allocation?: unknown }> }).nodes;
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes!.length).toBeGreaterThan(0);
    expect(nodes!.every((n) => n.allocation !== undefined)).toBe(true);
  });
});

describe("GET /api/admin/nodes/health (every active node)", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/nodes/health", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key returns a per-node reachability snapshot", async () => {
    const res = await api("/api/admin/nodes/health", { key: config.adminKey });
    expectStatus(res, 200);
    const nodes = (res.body as { nodes?: Array<{ nodeId?: string; reachable?: boolean }> }).nodes;
    expect(Array.isArray(nodes)).toBe(true);
  });
});

describe("GET /api/admin/nodes/:id (detail)", () => {
  e2e("with an admin key returns the node + servers + abuse + portPool", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}`, { key: config.adminKey });
    expectStatus(res, 200);
    const body = res.body as {
      node?: { id?: string; name?: string };
      allocation?: unknown;
      servers?: unknown[];
      abuse?: unknown;
      portPool?: unknown[];
    };
    expect(body.node?.id).toBe(nodeId);
    expect(body.allocation).toBeDefined();
    expect(Array.isArray(body.servers)).toBe(true);
    expect(body.abuse).toBeDefined();
    expect(Array.isArray(body.portPool)).toBe(true);
  });

  e2e("with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/nodes/not-a-uuid", { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with an unknown UUID is 404", async () => {
    const res = await api(`/api/admin/nodes/${UNKNOWN_UUID}`, { key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("with a user key is 403", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}`, { key: config.userKey });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/nodes/:id/health (live probe + heartbeat)", () => {
  e2e("with an admin key returns a reachability result", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}/health`, { key: config.adminKey });
    expectStatus(res, 200);
    const health = (res.body as { health?: { reachable?: boolean } }).health;
    expect(typeof health?.reachable).toBe("boolean");
  });

  e2e("with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/nodes/not-a-uuid/health", { key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/nodes/:id/ports (port pool)", () => {
  e2e("with an admin key returns the pool entries", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}/ports`, { key: config.adminKey });
    expectStatus(res, 200);
    expect(Array.isArray((res.body as { entries?: unknown[] }).entries)).toBe(true);
  });

  e2e("with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/nodes/not-a-uuid/ports", { key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/nodes/probe (reachability before registering)", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/nodes/probe", { method: "POST", key: config.userKey, body: { apiUrl: "http://x", token: "y" } });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key + missing apiUrl is 400", async () => {
    const res = await api("/api/admin/nodes/probe", { method: "POST", key: config.adminKey, body: { token: "y" } });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing token is 400", async () => {
    const res = await api("/api/admin/nodes/probe", {
      method: "POST",
      key: config.adminKey,
      body: { apiUrl: "http://localhost:8081" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-http(s) apiUrl is 400", async () => {
    const res = await api("/api/admin/nodes/probe", {
      method: "POST",
      key: config.adminKey,
      body: { apiUrl: "ftp://localhost", token: "some-token" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/nodes (register a node)", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/nodes", {
      method: "POST",
      key: config.userKey,
      body: { name: "x", hostname: "x", apiUrl: "http://x", diskTotalMb: 1024 },
    });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key + empty body is 400", async () => {
    const res = await api("/api/admin/nodes", { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing diskTotalMb is 400", async () => {
    const res = await api("/api/admin/nodes", {
      method: "POST",
      key: config.adminKey,
      body: { name: "e2e-probe-node", hostname: "localhost", apiUrl: "http://localhost:9999" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a too-short supplied token is 400", async () => {
    const res = await api("/api/admin/nodes", {
      method: "POST",
      key: config.adminKey,
      body: { name: "e2e-probe-node", hostname: "localhost", apiUrl: "http://localhost:9999", diskTotalMb: 1024, token: "short" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + partial DB config is 400", async () => {
    // dbAdminHost without dbAdminUser/dbAdminPassword. The route enforces
    // all-or-none on the shared-node DB credentials.
    const res = await api("/api/admin/nodes", {
      method: "POST",
      key: config.adminKey,
      body: {
        name: "e2e-probe-node",
        hostname: "localhost",
        apiUrl: "http://localhost:9999",
        diskTotalMb: 1024,
        dbAdminHost: "localhost",
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/admin/nodes/:id (activate/drain/edit)", () => {
  e2e("with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/nodes/not-a-uuid", { method: "PATCH", key: config.adminKey, body: { isActive: false } });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + empty body is 400 (must change something)", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}`, { method: "PATCH", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + an invalid apiUrl is 400", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}`, {
      method: "PATCH",
      key: config.adminKey,
      body: { apiUrl: "not-a-url" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + an out-of-range cpuReservePct is 400", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}`, {
      method: "PATCH",
      key: config.adminKey,
      body: { cpuReservePct: 999 },
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/admin/nodes/:id (safety gates)", () => {
  e2e("with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/nodes/not-a-uuid", { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with an unknown UUID is 404", async () => {
    const res = await api(`/api/admin/nodes/${UNKNOWN_UUID}`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key on the active seeded node is 409 (drain first)", async () => {
    // The dev panel's seeded node is active and hosts a server, so both safety
    // gates refuse. The route surfaces 409 (not a silent cleanup) so an admin
    // sees the count of servers they need to remove first.
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/nodes/:id/ports (port-pool entry)", () => {
  e2e("with a non-UUID id is 400", async () => {
    const res = await api("/api/admin/nodes/not-a-uuid/ports", {
      method: "POST",
      key: config.adminKey,
      body: { spec: "25565" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing spec is 400", async () => {
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}/ports`, { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + unparseable spec is 409", async () => {
    // A pool entry is a set of numbers and nothing else. There is no protocol
    // to get wrong, so a bad spec is the only rejectable input left.
    const { nodeId } = await loadFixtures();
    const res = await api(`/api/admin/nodes/${nodeId}/ports`, {
      method: "POST",
      key: config.adminKey,
      body: { spec: "25570-25565" },
    });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/admin/nodes/ports/:entryId", () => {
  e2e("with a non-UUID entryId is 400", async () => {
    const res = await api("/api/admin/nodes/ports/not-a-uuid", { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with an unknown UUID is 404", async () => {
    const res = await api(`/api/admin/nodes/ports/${UNKNOWN_UUID}`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(404);
  });
});
