import { describe, expect, test } from "bun:test";

import {
  consumeEcho,
  ECHO_WINDOW_MS,
  expectEcho,
  type PendingEcho,
} from "./console-echo";

describe("console echo", () => {
  test("drops the echo of a submitted command once", () => {
    const queue: PendingEcho[] = [];
    expectEcho(queue, "list", 0);
    expect(consumeEcho(queue, "list", 10)).toBe(true);
    expect(consumeEcho(queue, "list", 20)).toBe(false);
  });

  test("keeps the entry when log output arrives before the echo", () => {
    const queue: PendingEcho[] = [];
    expectEcho(queue, "list", 0);
    expect(consumeEcho(queue, "[18:35:43 INFO]: Done", 5)).toBe(false);
    expect(consumeEcho(queue, "list", 10)).toBe(true);
  });

  test("matches echoes in submit order", () => {
    const queue: PendingEcho[] = [];
    expectEcho(queue, "list", 0);
    expectEcho(queue, "help", 1);
    expect(consumeEcho(queue, "help", 5)).toBe(false);
    expect(consumeEcho(queue, "list", 6)).toBe(true);
    expect(consumeEcho(queue, "help", 7)).toBe(true);
  });

  test("tolerates the trailing carriage return of a PTY line", () => {
    const queue: PendingEcho[] = [];
    expectEcho(queue, "say hi", 0);
    expect(consumeEcho(queue, "say hi ", 5)).toBe(true);
  });

  test("forgets a command that was never echoed", () => {
    const queue: PendingEcho[] = [];
    expectEcho(queue, "list", 0);
    expect(consumeEcho(queue, "list", ECHO_WINDOW_MS)).toBe(false);
    expect(queue).toHaveLength(0);
  });
});
