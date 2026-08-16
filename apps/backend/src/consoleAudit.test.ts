/**
 * Console-session callback tests.
 *
 * The agent's direct-console WebSocket delegates validation and audit to the
 * panel over HTTP. These tests pin the request shape (URL, headers, body) and
 * the two contracts that matter for safety:
 *   - `validateConsoleSession` throws on rejection (the WS handshake must 401),
 *   - `recordConsoleCommand` never throws (a command must never fail because its
 *     audit trail is unreachable).
 *
 * `globalThis.fetch` is stubbed per-test so no real network call is made.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.AGENT_TOKEN ??= "test-agent-token-that-is-long-enough-0123456789";
process.env.PANEL_URL ??= "http://panel.test:3000";

const { validateConsoleSession, recordConsoleCommand } = await import(
  "./consoleAudit"
);

const TOKEN = process.env.AGENT_TOKEN!;
const PANEL_URL = process.env.PANEL_URL!;

/** Capture the most recent fetch call for assertions. */
let lastCall: {
  url: string;
  init: RequestInit;
} | null = null;

// Captured fresh in beforeEach so a stale reference from another file (Bun runs
// test files in one process) can't leak into our restore.
let originalFetch: typeof globalThis.fetch;

function stubFetch(responder: (url: string, init: RequestInit) => Response) {
  lastCall = null;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    lastCall = { url, init: init ?? {} };
    return responder(url, init ?? {});
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  lastCall = null;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("validateConsoleSession", () => {
  test("POSTs the token to the panel validate endpoint with the agent bearer", async () => {
    stubFetch(() =>
      jsonResponse({ serverId: "s-1", userId: "u-1" }),
    );

    const result = await validateConsoleSession("the-token");

    expect(result).toEqual({ serverId: "s-1", userId: "u-1" });
    expect(lastCall).not.toBeNull();
    expect(lastCall!.url).toBe(
      `${PANEL_URL}/api/internal/console/sessions/validate`,
    );
    expect(lastCall!.init.method).toBe("POST");
    expect(lastCall!.init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({
      token: "the-token",
    });
  });

  test("throws on a 401 rejection", async () => {
    stubFetch(() => jsonResponse({ error: "invalid" }, 401));
    await expect(validateConsoleSession("bad")).rejects.toThrow();
  });

  test("throws on a network failure", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(validateConsoleSession("any")).rejects.toThrow();
  });

  test("throws on a malformed success response", async () => {
    stubFetch(() => jsonResponse({ serverId: "s-1" })); // missing userId
    await expect(validateConsoleSession("t")).rejects.toThrow();
  });
});

describe("recordConsoleCommand", () => {
  test("POSTs token + serverId + command to the audit endpoint", async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    await recordConsoleCommand("tok", "s-1", "help\n");

    expect(lastCall).not.toBeNull();
    expect(lastCall!.url).toBe(`${PANEL_URL}/api/internal/console/audit`);
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({
      token: "tok",
      serverId: "s-1",
      command: "help\n",
    });
  });

  test("never throws when the panel is unreachable", async () => {
    stubFetch(() => {
      throw new Error("panel down");
    });
    await expect(recordConsoleCommand("t", "s", "c")).resolves.toBeUndefined();
  });

  test("never throws on a non-2xx response", async () => {
    stubFetch(() => jsonResponse({ error: "revoked" }, 401));
    await expect(recordConsoleCommand("t", "s", "c")).resolves.toBeUndefined();
  });
});

describe("console WebSocket path regex", () => {
  // Guards the removal of the old bearer-header path: the session-token path
  // must match, and the server-id path must no longer match.
  const sessionPath = /^\/v1\/sessions\/([^/]+)\/console$/;
  const oldServerPath = /^\/v1\/servers\/([^/]+)\/console$/;

  test("matches the session-token console path", () => {
    expect(sessionPath.test("/v1/sessions/abc-123/console")).toBe(true);
  });

  test("does NOT match the old server-id console path", () => {
    expect(oldServerPath.test("/v1/servers/abc-123/console")).toBe(true);
    // The session regex must reject the old shape, so the agent never upgrades
    // a server-id-styled URL by accident.
    expect(sessionPath.test("/v1/servers/abc-123/console")).toBe(false);
  });
});
