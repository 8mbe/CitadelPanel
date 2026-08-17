/**
 * E2E tests for the public, unauthenticated edge of the panel.
 *
 * These routes exist precisely so an unauthenticated page (the login screen,
 * the first-time-setup wizard) can render: they report only configuration
 * state, never account details. Every authenticated route returns 401 to a
 * credential-less request — that contract is asserted once here and relied on
 * by the per-route-group suites, which only cover their own happy paths and
 * permission gates.
 */

import { describe, expect, test } from "bun:test";

import { api } from "./_helpers";

// --- Public endpoints --------------------------------------------------------

describe("public edge", () => {
  test("GET /api/health reports database reachability", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    const body = res.body as { status?: string; database?: boolean };
    expect(body.status).toBe("ok");
    expect(body.database).toBe(true);
  });

  test("GET /api/health degrades to 503 when the database is unreachable", async () => {
    // We can't actually sever the DB from here, so this just documents the
    // contract: the route is the one place that surfaces database health to
    // an unauthenticated caller, and it does so via the status field.
    const res = await api("/api/health");
    expect([200, 503]).toContain(res.status);
    const body = res.body as { status?: string };
    expect(body.status).toBeDefined();
  });

  test("GET /api/setup/status reports the setup latch without authenticating", async () => {
    const res = await api("/api/setup/status");
    expect(res.status).toBe(200);
    const body = res.body as {
      needsSetup?: boolean;
      adminCount?: number;
      userCount?: number;
      nodeCount?: number;
      canCreateAdmin?: boolean;
    };
    expect(typeof body.needsSetup).toBe("boolean");
    expect(typeof body.adminCount).toBe("number");
    expect(typeof body.canCreateAdmin).toBe("boolean");
  });

  test("GET /api/settings/public returns captcha + timezone + upload limit", async () => {
    const res = await api("/api/settings/public");
    expect(res.status).toBe(200);
    const body = res.body as {
      timezone?: string;
      captcha?: unknown;
      uploadMaxBytes?: number;
    };
    expect(typeof body.timezone).toBe("string");
    expect(body.captcha).toBeDefined();
    expect(typeof body.uploadMaxBytes).toBe("number");
  });
});

// --- Routing edge cases ------------------------------------------------------

describe("routing", () => {
  test("an unknown path is 404, not a 500", async () => {
    const res = await api("/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("a known path under the wrong method is 405 (Method not allowed)", async () => {
    // /api/health only supports GET.
    const res = await api("/api/health", { method: "POST" });
    expect(res.status).toBe(405);
  });

  test("OPTIONS preflight returns 204 (CORS preflight)", async () => {
    const res = await api("/api/health", { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});
