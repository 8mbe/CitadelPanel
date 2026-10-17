/**
 * Transport regressions: caller headers and token rotation, cancellation and
 * deadlines, and per-connection health probes that share only pending work.
 *
 * Caller headers were once documented on `NodeRequestOptions` and honoured by
 * `nodeRequestRaw` (the file-upload path), so they looked supported, and the first
 * JSON caller to use it — the node database's credential probe — had its headers
 * dropped on the floor. The agent then saw no credential, correctly answered
 * "not ready", and the admin card sat on "Starting" over a database that was up
 * and fine. Nothing threw, nothing logged, and the UI invented a first-boot
 * explanation for it.
 *
 * `server-only` is mocked because this module's env import pulls it in, and it
 * only resolves inside Next's bundler.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { checkNodeHealth, invalidateNodeConnection, nodeRequestFor, unregisteredNode } = await import("./nodeApi");

/** Headers of the last intercepted fetch. */
let sent: Record<string, string> = {};
const originalFetch = globalThis.fetch;
let calls = 0;
afterAll(() => { globalThis.fetch = originalFetch; });

beforeAll(() => {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls += 1;
    sent = (init.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

describe("drained node requests", () => {
  test.each([
    ["/v1/servers/test/start", "POST"],
    ["/v1/servers/test/restart", "POST"],
    ["/v1/servers/test/install", "POST"],
    ["/v1/backups/servers/test", "POST"],
    ["/v1/servers/test/files/content", "PUT"],
    ["/v1/servers/test/transfer/export", "GET"],
  ] as const)("rejects %s before contacting the agent", async (path, method) => {
    const before = calls;
    await expect(nodeRequestFor({ ...node(), isActive: false }, path, { method })).rejects.toThrow("drained for maintenance");
    expect(calls).toBe(before);
  });

  test.each([
    ["/v1/health", "GET"], ["/v1/maintenance", "POST"],
    ["/v1/states", "POST"], ["/v1/servers/test/stop", "POST"],
    ["/v1/backups/jobs/test", "GET"],
  ] as const)("permits %s for observation or recovery", async (path, method) => {
    const before = calls;
    await nodeRequestFor({ ...node(), isActive: false }, path, { method });
    expect(calls).toBe(before + 1);
  });
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

  test("uses a rotated token even when its length is unchanged", async () => {
    await nodeRequestFor(node(), "/v1/health");
    await nodeRequestFor({ ...node(), apiToken: "r".repeat(40) }, "/v1/health");
    expect(sent.authorization).toBe(`Bearer ${"r".repeat(40)}`);
  });
});

async function withFetch(fetch: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

describe("node request cancellation", () => {
  test("a stalled response fails within the supplied read budget", async () => {
    await withFetch((async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })) as typeof fetch, async () => {
      await expect(nodeRequestFor(node(), "/v1/servers/test/state", { timeoutMs: 25 }))
        .rejects.toMatchObject({ status: 502, message: expect.stringContaining("within 25ms") });
    });
  });

  test("a response that stalls after headers still obeys the deadline", async () => {
    await withFetch((async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
      },
    }))) as typeof fetch, async () => {
      await expect(nodeRequestFor(node(), "/v1/servers/test/state", { timeoutMs: 25 }))
        .rejects.toMatchObject({ status: 502, message: expect.stringContaining("within 25ms") });
    });
  });

  test("forwards caller cancellation without reporting an unreachable node", async () => {
    const abort = new AbortController();
    const reason = new DOMException("Viewer left", "AbortError");
    await withFetch((async (_url, init) => {
      expect(init!.signal!.aborted).toBe(false);
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    }) as typeof fetch, async () => {
      const result = nodeRequestFor(node(), "/v1/servers/test/state", { signal: abort.signal });
      abort.abort(reason);
      await expect(result).rejects.toBe(reason);
    });
  });

  test("an open caller signal does not disable the operation deadline", async () => {
    const caller = new AbortController();
    await withFetch((async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })) as typeof fetch, async () => {
      await expect(nodeRequestFor(node(), "/v1/servers/test/state", {
        signal: caller.signal,
        timeoutMs: 25,
      })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("within 25ms") });
      expect(caller.signal.aborted).toBe(false);
    });
  });
});

describe("node health overlap", () => {
  test("shares a pending probe while another node can answer independently", async () => {
    const pending = Promise.withResolvers<Response>();
    let count = 0;
    const blocked = { ...node(), id: "health-blocked" };
    const healthy = { ...node(), id: "health-healthy", apiUrl: "http://127.0.0.1:10" };
    await withFetch((async (url) => {
      count += 1;
      if (String(url).includes(":9/")) return pending.promise;
      return Response.json({ status: "ok" });
    }) as typeof fetch, async () => {
      const first = checkNodeHealth(blocked);
      const second = checkNodeHealth(blocked);
      expect((await checkNodeHealth(healthy)).reachable).toBe(true);
      expect(count).toBe(2);
      pending.resolve(Response.json({ status: "ok" }));
      expect((await first).reachable).toBe(true);
      expect(await second).toEqual(await first);
      expect(count).toBe(2);
    });
  });

  test("does not cache a failed probe across explicit retries", async () => {
    let count = 0;
    await withFetch((async () => {
      count += 1;
      if (count === 1) throw new TypeError("Connection refused");
      return Response.json({ status: "ok" });
    }) as typeof fetch, async () => {
      const target = { ...node(), id: "health-retry" };
      expect((await checkNodeHealth(target)).reachable).toBe(false);
      expect((await checkNodeHealth(target)).reachable).toBe(true);
      expect(count).toBe(2);
    });
  });

  test("reconfiguration isolates a new probe from the old credentials", async () => {
    const old = Promise.withResolvers<Response>();
    const fresh = Promise.withResolvers<Response>();
    const headers: string[] = [];
    const target = { ...node(), id: "health-rotated" };
    await withFetch((async (_url, init) => {
      const token = (init!.headers as Record<string, string>).authorization;
      headers.push(token);
      return headers.length === 1 ? old.promise : fresh.promise;
    }) as typeof fetch, async () => {
      const previous = checkNodeHealth(target);
      const rotated = { ...target, apiToken: "r".repeat(40) };
      const current = checkNodeHealth(rotated);
      expect(headers).toEqual([`Bearer ${"t".repeat(40)}`, `Bearer ${"r".repeat(40)}`]);
      old.resolve(Response.json({ status: "ok" }));
      await previous;
      const repeat = checkNodeHealth(rotated);
      expect(headers).toHaveLength(2);
      fresh.resolve(Response.json({ status: "ok" }));
      expect((await current).reachable).toBe(true);
      expect(await repeat).toEqual(await current);
    });
  });

  test("connection invalidation starts a fresh probe", async () => {
    const pending = Promise.withResolvers<Response>();
    let count = 0;
    await withFetch((async () => {
      count += 1;
      return count === 1 ? pending.promise : Response.json({ status: "ok" });
    }) as typeof fetch, async () => {
      const target = { ...node(), id: "health-invalidated" };
      const old = checkNodeHealth(target);
      invalidateNodeConnection(target.id);
      expect((await checkNodeHealth(target)).reachable).toBe(true);
      expect(count).toBe(2);
      pending.resolve(Response.json({ status: "ok" }));
      await old;
    });
  });
});
