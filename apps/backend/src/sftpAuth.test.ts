/**
 * Tests for the SFTP auth callback.
 *
 * Mirrors `consoleAudit.test.ts`: env is set before import, `globalThis.fetch`
 * is stubbed per-test, and the two contracts pinned are (1) validate throws on
 * any rejection and (2) the request carries the agent bearer + panel URL
 * exactly. There is no "audit never throws" contract here because SFTP auth is
 * synchronous with the connection — a failure rejects the SSH login.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

process.env.AGENT_TOKEN ??= "test-agent-token-that-is-long-enough-0123456789";
process.env.PANEL_URL ??= "http://panel.test:3000";

const { validateSftpCredentials } = await import("./sftpAuth");

const TOKEN = process.env.AGENT_TOKEN!;
const PANEL_URL = process.env.PANEL_URL!;

let lastCall: { url: string; init: RequestInit } | null = null;
let originalFetch: typeof globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: string, init: RequestInit) => {
    lastCall = { url, init };
    return responder(url, init);
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  // Captured fresh each file — Bun runs all test files in one process, so a
  // stale reference from another file could leak.
  originalFetch = globalThis.fetch;
  lastCall = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("validates credentials and returns serverId/userId", async () => {
  stubFetch(() =>
    jsonResponse({ serverId: "11111111-1111-1111-1111-111111111111", userId: "user-1" }),
  );

  const result = await validateSftpCredentials("alice-a1b2c3d4", "hunter2");

  expect(result).toEqual({
    serverId: "11111111-1111-1111-1111-111111111111",
    userId: "user-1",
  });
  expect(lastCall).not.toBeNull();
  expect(lastCall!.url).toBe(`${PANEL_URL}/api/internal/sftp/authenticate`);
  expect(lastCall!.init.method).toBe("POST");
  expect(lastCall!.init.headers).toMatchObject({
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  expect(JSON.parse(lastCall!.init.body as string)).toEqual({
    username: "alice-a1b2c3d4",
    password: "hunter2",
  });
});

test("throws on 401 (bad password / unknown user)", async () => {
  stubFetch(() => jsonResponse({ error: "Invalid credentials" }, 401));
  await expect(validateSftpCredentials("alice-a1b2c3d4", "wrong")).rejects.toThrow(
    "panel rejected sftp credentials (status 401)",
  );
});

test("throws on network failure", async () => {
  stubFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  await expect(validateSftpCredentials("alice-a1b2c3d4", "hunter2")).rejects.toThrow(
    "panel sftp auth callback failed: ECONNREFUSED",
  );
});

test("throws on malformed success response", async () => {
  stubFetch(() => jsonResponse({ serverId: "ok" /* userId missing */ }));
  await expect(validateSftpCredentials("alice-a1b2c3d4", "hunter2")).rejects.toThrow(
    "panel sftp auth response was malformed",
  );
});

test("throws on malformed success response (wrong types)", async () => {
  stubFetch(() => jsonResponse({ serverId: 123, userId: "user-1" }));
  await expect(validateSftpCredentials("alice-a1b2c3d4", "hunter2")).rejects.toThrow(
    "panel sftp auth response was malformed",
  );
});
