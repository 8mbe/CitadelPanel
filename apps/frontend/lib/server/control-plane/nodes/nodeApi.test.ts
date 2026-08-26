/**
 * One behaviour, pinned because losing it is silent and expensive:
 * `nodeRequestFor` must actually send `options.headers`.
 *
 * It did not. The option was documented on `NodeRequestOptions` and honoured by
 * `nodeRequestRaw` (the file-upload path), so it looked supported, and the first
 * JSON caller to use it — the node database's credential probe — had its headers
 * dropped on the floor. The agent then saw no credential, correctly answered
 * "not ready", and the admin card sat on "Starting" over a database that was up
 * and fine. Nothing threw, nothing logged, and the UI invented a first-boot
 * explanation for it.
 *
 * `server-only` is mocked because this module's env import pulls it in, and it
 * only resolves inside Next's bundler.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { nodeRequestFor, unregisteredNode } = await import("./nodeApi");

/** Headers of the last intercepted fetch. */
let sent: Record<string, string> = {};

beforeAll(() => {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = (init.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

const node = () => unregisteredNode("http://127.0.0.1:9", "t".repeat(40));

describe("nodeRequestFor headers", () => {
  test("sends caller-supplied headers", async () => {
    await nodeRequestFor(node(), "/v1/database/status?probe=1", {
      headers: { "X-Db-User": "citadel_abcd1234", "X-Db-Password": "pw-placeholder" },
    });

    expect(sent["X-Db-User"]).toBe("citadel_abcd1234");
    expect(sent["X-Db-Password"]).toBe("pw-placeholder");
  });

  test("still authenticates to the agent", async () => {
    await nodeRequestFor(node(), "/v1/health", {
      headers: { "X-Db-User": "root" },
    });

    expect(sent.authorization).toBe(`Bearer ${"t".repeat(40)}`);
  });

  test("keeps the JSON content-type for a body", async () => {
    await nodeRequestFor(node(), "/v1/database/setup", {
      method: "POST",
      body: { adminUser: "root" },
      headers: { "X-Trace": "1" },
    });

    expect(sent["content-type"]).toBe("application/json");
    expect(sent["X-Trace"]).toBe("1");
  });

  test("caller headers win over the defaults, being applied last", async () => {
    await nodeRequestFor(node(), "/v1/health", {
      headers: { authorization: "Bearer override" },
    });

    expect(sent.authorization).toBe("Bearer override");
  });
});
