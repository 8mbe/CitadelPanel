import { describe, expect, test } from "bun:test";

import { DAEMON_READ_TIMEOUT_MS, daemonRead } from "./client";

describe("daemonRead", () => {
  test("passes the value through when the daemon answers", async () => {
    expect(await daemonRead("a thing", async () => 42)).toBe(42);
  });

  test("gives up on a daemon that accepts and then never answers", async () => {
    // The failure this exists for: dockerode has no timeout, so a stalled
    // daemon would hold the request (and the panel's) open indefinitely.
    const started = Date.now();
    const call = daemonRead(
      "stats for container abc",
      (abortSignal) =>
        new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener("abort", () =>
            reject(abortSignal.reason as Error),
          );
        }),
      50,
    );

    expect(call).rejects.toThrow(
      "Docker did not answer stats for container abc within 50ms.",
    );
    await call.catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a real Docker error keeps its own message and status code", async () => {
    // `sampleContainerStats` reads `statusCode` to tell a container that
    // vanished (404) from a fault, so the wrapper must not flatten it.
    const notFound = Object.assign(new Error("no such container"), {
      statusCode: 404,
    });

    await expect(
      daemonRead("stats", async () => {
        throw notFound;
      }),
    ).rejects.toBe(notFound);
  });

  test("the default ceiling is generous, not a budget", () => {
    expect(DAEMON_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
