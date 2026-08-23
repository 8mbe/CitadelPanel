/**
 * E2E tests for the blueprint surface.
 *
 * Two audiences hit blueprints:
 *
 *   - GET /api/blueprints: any authenticated user, the list they choose from
 *     when (hypothetically) creating a server. Internal hints (install
 *     scripts, resource profile) are stripped server-side.
 *   - /api/admin/blueprints/*: admin-only CRUD on the full blueprint row.
 *
 * The admin CRUD happy-path writes (create/update/delete) are not exercised
 * here: they would mutate the seeded blueprints (minecraft-java/bedrock) and
 * their effects cascade onto servers. Instead the suite asserts the
 * permission gates and the strict input validation that guards the install
 * script + ports + env schema. A malformed blueprint never reaches
 * {@link blueprintManager} because the parser rejects it here.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures } from "./_helpers";

// --- User surface -----------------------------------------------------------

describe("GET /api/blueprints (user surface)", () => {
  test("without a credential is 401", async () => {
    const res = await api("/api/blueprints");
    expect(res.status).toBe(401);
  });

  e2e("with a user key returns the public blueprint view", async () => {
    const res = await api("/api/blueprints", { key: config.userKey });
    expectStatus(res, 200);
    const bps = (res.body as { blueprints?: Array<{ key?: string; name?: string }> }).blueprints;
    expect(Array.isArray(bps)).toBe(true);
    expect(bps!.length).toBeGreaterThan(0);
    expect(bps!.every((bp) => typeof bp.key === "string")).toBe(true);
  });

  e2e("does not leak install scripts or the resource profile", async () => {
    // The route deliberately strips internal hints, so verify they are absent.
    const res = await api("/api/blueprints", { key: config.adminKey });
    const bps = (res.body as Array<{ install?: unknown; expectedResourceProfile?: unknown }>).blueprints ?? [];
    for (const bp of bps) {
      expect(bp.install).toBeUndefined();
      expect(bp.expectedResourceProfile).toBeUndefined();
    }
  });
});

// --- Admin surface ----------------------------------------------------------

describe("admin blueprint CRUD gates", () => {
  e2e("GET /api/admin/blueprints with a user key is 403", async () => {
    const res = await api("/api/admin/blueprints", { key: config.userKey });
    expect(res.status).toBe(403);
  });

  e2e("GET /api/admin/blueprints with an admin key lists every blueprint", async () => {
    const res = await api("/api/admin/blueprints", { key: config.adminKey });
    expectStatus(res, 200);
    const bps = (res.body as { blueprints?: Array<{ id?: string; key?: string }> }).blueprints;
    expect(Array.isArray(bps)).toBe(true);
    expect(bps!.length).toBeGreaterThan(0);
  });

  e2e("GET /api/admin/blueprints/:id with an admin key returns full detail", async () => {
    const { blueprintId } = await loadFixtures();
    const res = await api(`/api/admin/blueprints/${blueprintId}`, { key: config.adminKey });
    expectStatus(res, 200);
    const bp = (res.body as { blueprint?: { id?: string; key?: string; dockerImage?: string } }).blueprint;
    expect(bp?.id).toBe(blueprintId);
    expect(typeof bp?.dockerImage).toBe("string");
  });

  e2e("GET /api/admin/blueprints/not-a-uuid is 400", async () => {
    const res = await api("/api/admin/blueprints/not-a-uuid", { key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

describe("blueprint input validation (POST /api/admin/blueprints)", () => {
  e2e("with a user key is 403", async () => {
    const res = await api("/api/admin/blueprints", { method: "POST", key: config.userKey, body: {} });
    expect(res.status).toBe(403);
  });

  e2e("with an admin key + empty body is 400", async () => {
    const res = await api("/api/admin/blueprints", { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + invalid key pattern is 400", async () => {
    // The key must be lowercase letters/digits/dashes, 2-63 chars.
    const res = await api("/api/admin/blueprints", {
      method: "POST",
      key: config.adminKey,
      body: { key: "UPPER CASE", name: "bad", dockerImage: "img", ports: [{ container: 25565 }] },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + no ports is 400 (needs at least one)", async () => {
    const res = await api("/api/admin/blueprints", {
      method: "POST",
      key: config.adminKey,
      body: { key: "valid-key", name: "bad", dockerImage: "img", ports: [] },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + duplicate port number is 400", async () => {
    // Ports have no protocol any more, so the number alone must be unique:
    // 25565 twice used to be legal as tcp + udp.
    const res = await api("/api/admin/blueprints", {
      method: "POST",
      key: config.adminKey,
      body: {
        key: "valid-key",
        name: "bad",
        dockerImage: "img",
        ports: [{ container: 25565 }, { container: 25565 }],
      },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + invalid expectedResourceProfile is 400", async () => {
    const res = await api("/api/admin/blueprints", {
      method: "POST",
      key: config.adminKey,
      body: {
        key: "valid-key",
        name: "bad",
        dockerImage: "img",
        ports: [{ container: 25565 }],
        expectedResourceProfile: "not-a-profile",
      },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + dataPath not absolute is 400", async () => {
    const res = await api("/api/admin/blueprints", {
      method: "POST",
      key: config.adminKey,
      body: {
        key: "valid-key",
        name: "bad",
        dockerImage: "img",
        ports: [{ container: 25565 }],
        dataPath: "relative/path",
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("blueprint import-from-url validation", () => {
  e2e("with an admin key + a non-URL is 400", async () => {
    const res = await api("/api/admin/blueprints/import-url", {
      method: "POST",
      key: config.adminKey,
      body: { url: "not a url" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-http(s) URL is 400", async () => {
    const res = await api("/api/admin/blueprints/import-url", {
      method: "POST",
      key: config.adminKey,
      body: { url: "ftp://example.com/blueprint.json" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + no url is 400", async () => {
    const res = await api("/api/admin/blueprints/import-url", {
      method: "POST",
      key: config.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});
