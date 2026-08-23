/**
 * End-to-end tests for the API-key surface (see docs/api-keys.md).
 *
 * Two real keys drive the suite, a non-admin owner's key and an admin's key,
 * read from `.env.e2e` (see `.env.e2e.example`). The suite covers:
 *
 *   - unauthenticated and bogus-credential requests are 401
 *   - the `x-api-key` and `Authorization: Bearer` conventions are equivalent
 *     (the panel aliases Bearer onto `x-api-key` in auth/middleware.ts)
 *   - a key resolves to its owner's session (role, email), so a key is its owner
 *   - a user key reaches user routes but every /api/admin/* is 403
 *   - an admin key reaches admin routes
 *   - the admin key lifecycle: mint → works → disable (401) → re-enable → revoke
 *   - the create/disable/revoke actions land in audit_logs with `viaApiKey` +
 *     `viaKeyPrefix` attribution
 *
 * The lifecycle test mints its own throwaway key using the admin key and
 * revokes it in `afterAll`, so the suite leaves no residue on success.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { api, config, configured } from "./_helpers";

/** A test that only runs when both E2E keys are configured. */
const e2e = (name: string, fn: () => Promise<unknown> | unknown) =>
  test.skipIf(!configured)(name, fn);

// --- Reachability (no keys needed) -------------------------------------------

describe("panel reachable", () => {
  test("GET /api/health returns 200 with database ok", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect((res.body as { status?: string }).status).toBe("ok");
  });
});

// --- Unauthenticated / invalid credentials -----------------------------------

describe("no credential", () => {
  test("GET /api/me is 401 without a credential", async () => {
    const res = await api("/api/me");
    expect(res.status).toBe(401);
  });

  test("GET /api/admin/api-keys is 401 without a credential", async () => {
    const res = await api("/api/admin/api-keys");
    expect(res.status).toBe(401);
  });
});

describe("invalid credential", () => {
  // The api-key plugin rejects any presented credential shorter than 64 chars
  // before it queries the database; a longer-but-nonexistent one hits the DB
  // and still resolves to 401. Both surface as 401 from the panel edge.
  test("a too-short Bearer token is rejected 401", async () => {
    const res = await api("/api/me", { key: "short" });
    expect(res.status).toBe(401);
  });

  test("a well-formed but nonexistent Bearer token is rejected 401", async () => {
    const res = await api("/api/me", { key: `cpl_${"x".repeat(80)}` });
    expect(res.status).toBe(401);
  });

  test("a bogus x-api-key header is rejected 401", async () => {
    const res = await api("/api/me", {
      key: `bogus_${"z".repeat(80)}`,
      header: "x-api-key",
    });
    expect(res.status).toBe(401);
  });
});

// --- User side ---------------------------------------------------------------

describe("user API key", () => {
  e2e("resolves to the owner's session with role=user", async () => {
    const res = await api("/api/me", { key: config.userKey });
    expect(res.status).toBe(200);
    const user = (res.body as { user?: { role?: string; email?: string } }).user;
    expect(user?.role).toBe("user");
    if (config.userEmail) expect(user?.email).toBe(config.userEmail);
  });

  e2e("x-api-key and Authorization: Bearer resolve to the same identity", async () => {
    const viaBearer = await api("/api/me", {
      key: config.userKey,
      header: "bearer",
    });
    const viaHeader = await api("/api/me", {
      key: config.userKey,
      header: "x-api-key",
    });
    expect(viaBearer.status).toBe(200);
    expect(viaHeader.status).toBe(200);
    const a = (viaBearer.body as { user?: { id?: string } }).user;
    const b = (viaHeader.body as { user?: { id?: string } }).user;
    expect(a?.id).toBe(b?.id);
  });

  e2e("can list its own servers", async () => {
    const res = await api("/api/servers", { key: config.userKey });
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { servers?: unknown }).servers)).toBe(
      true,
    );
  });

  e2e("can list blueprints", async () => {
    const res = await api("/api/blueprints", { key: config.userKey });
    expect(res.status).toBe(200);
  });
});

// --- User key must not reach admin -------------------------------------------

describe("user key cannot reach admin routes", () => {
  // requireAdmin short-circuits to 403 before any handler logic runs, so these
  // are fast and touch no agent.
  for (const path of [
    "/api/admin/api-keys",
    "/api/admin/users",
    "/api/admin/audit-logs",
    "/api/admin/nodes",
    "/api/admin/servers",
  ]) {
    e2e(`GET ${path} is 403`, async () => {
      const res = await api(path, { key: config.userKey });
      expect(res.status).toBe(403);
    });
  }

  e2e("POST /api/admin/api-keys is 403 (no mint into the admin surface)", async () => {
    const res = await api("/api/admin/api-keys", {
      method: "POST",
      key: config.userKey,
      body: { name: "e2e-should-not-create" },
    });
    expect(res.status).toBe(403);
  });
});

// --- Admin side --------------------------------------------------------------

describe("admin API key", () => {
  e2e("resolves to the owner's session with role=admin", async () => {
    const res = await api("/api/me", { key: config.adminKey });
    expect(res.status).toBe(200);
    const user = (res.body as { user?: { role?: string; email?: string } }).user;
    expect(user?.role).toBe("admin");
    if (config.adminEmail) expect(user?.email).toBe(config.adminEmail);
  });

  e2e("lists every API key in the panel", async () => {
    const res = await api("/api/admin/api-keys", { key: config.adminKey });
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { keys?: unknown }).keys)).toBe(true);
  });

  e2e("lists users", async () => {
    const res = await api("/api/admin/users", { key: config.adminKey });
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { users?: unknown }).users)).toBe(true);
  });

  e2e("reads audit logs", async () => {
    const res = await api("/api/admin/audit-logs?limit=10", {
      key: config.adminKey,
    });
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { logs?: unknown }).logs)).toBe(true);
  });
});

// --- Admin key lifecycle: mint → disable → re-enable → revoke --------------

describe("admin API-key lifecycle (a key is its owner)", () => {
  interface Created {
    id: string;
    token: string;
    name: string;
  }
  let created: Created | null = null;
  // Captured in the create test; used by the audit-attribution test so the
  // assertion is independent of the created row.
  let adminId: string | null = null;

  afterAll(async () => {
    // Best-effort cleanup: if a test failed mid-lifecycle the key would leak.
    // Revoke it (hard delete) so the suite leaves no residue.
    if (!created || !configured) return;
    try {
      await api(`/api/admin/api-keys/${created.id}`, {
        method: "DELETE",
        key: config.adminKey,
      });
    } catch {
      /* swallowed, cleanup must not fail the suite */
    }
  });

  e2e("admin mints a key that resolves to the admin's own identity", async () => {
    const meRes = await api("/api/me", { key: config.adminKey });
    adminId = (meRes.body as { user?: { id?: string } }).user?.id ?? null;

    const name = `e2e-${Date.now()}`;
    const res = await api("/api/admin/api-keys", {
      method: "POST",
      key: config.adminKey,
      body: { name },
    });
    expect(res.status).toBe(201);
    const body = res.body as {
      key?: { id?: string };
      token?: string;
    };
    expect(body.token).toBeTruthy();
    expect(body.key?.id).toBeTruthy();
    created = { id: body.key!.id!, token: body.token!, name };

    // Session synthesis: the freshly-minted key authenticates as the admin
    // owner. A key carries no permissions of its own, it is its owner.
    const viaNewKey = await api("/api/me", { key: created.token });
    expect(viaNewKey.status).toBe(200);
    const newUser = (viaNewKey.body as { user?: { role?: string } }).user;
    expect(newUser?.role).toBe("admin");
  });

  e2e("the create action is audited with viaApiKey attribution", async () => {
    expect(created).not.toBeNull();
    const res = await api("/api/admin/audit-logs?limit=50", {
      key: config.adminKey,
    });
    expect(res.status).toBe(200);
    const logs = (res.body as {
      logs?: Array<{
        action?: string;
        target_id?: string | null;
        metadata?: Record<string, unknown>;
      }>;
    }).logs;
    const entry = (logs ?? []).find(
      (l) => l.action === "apikey.create" && l.target_id === created!.id,
    );
    expect(entry).toBeDefined();
    const meta = entry!.metadata ?? {};
    // The actor authenticated with the admin's key, stamped onto the entry.
    expect(meta.viaApiKey).toBe(true);
    expect(meta.viaKeyPrefix).toBe(config.adminKey.slice(0, 8));
    // The handler-supplied description of the key being acted on.
    expect(meta.keyName).toBe(created!.name);
    // ownerId ties the key to the minting admin's account.
    expect(meta.ownerId).toBe(adminId);
  });

  e2e("disabling the key blocks it; re-enabling restores it", async () => {
    expect(created).not.toBeNull();
    const off = await api(`/api/admin/api-keys/${created!.id}`, {
      method: "PATCH",
      key: config.adminKey,
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect(
      (off.body as { key?: { enabled?: boolean } }).key?.enabled,
    ).toBe(false);

    // A disabled key is rejected at session synthesis → 401.
    const meOff = await api("/api/me", { key: created!.token });
    expect(meOff.status).toBe(401);

    const on = await api(`/api/admin/api-keys/${created!.id}`, {
      method: "PATCH",
      key: config.adminKey,
      body: { enabled: true },
    });
    expect(on.status).toBe(200);
    const meOn = await api("/api/me", { key: created!.token });
    expect(meOn.status).toBe(200);
  });

  e2e("revoking the key blocks it and removes it from the list", async () => {
    expect(created).not.toBeNull();
    const del = await api(`/api/admin/api-keys/${created!.id}`, {
      method: "DELETE",
      key: config.adminKey,
    });
    expect(del.status).toBe(200);

    const meAfter = await api("/api/me", { key: created!.token });
    expect(meAfter.status).toBe(401);

    // The row is gone from the fleet-wide listing.
    const list = await api("/api/admin/api-keys", { key: config.adminKey });
    expect(list.status).toBe(200);
    const keys = (list.body as { keys?: Array<{ id?: string }> }).keys ?? [];
    expect(keys.find((k) => k.id === created!.id)).toBeUndefined();

    created = null; // already revoked, afterAll should not try again
  });
});
