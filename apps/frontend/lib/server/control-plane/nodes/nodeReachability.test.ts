import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  backoffMsFor,
  isNodeInBackoff,
  noteNodeReachable,
  noteNodeUnreachable,
  resetNodeReachability,
} from "./nodeReachability";

const NODE = "node-1";
const T0 = 1_000_000;

/**
 * The module logs transitions, and a test that fails is easier to read without
 * them interleaved. Capturing also lets the log itself be asserted, since "does
 * not repeat the same line every tick" is the behaviour, not a side effect.
 */
let lines: string[] = [];
const realWarn = console.warn;
const realLog = console.log;

beforeEach(() => {
  resetNodeReachability();
  lines = [];
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
});

afterEach(() => {
  console.warn = realWarn;
  console.log = realLog;
  resetNodeReachability();
});

describe("backoffMsFor", () => {
  test("grows with consecutive failures and stops at the cap", () => {
    expect(backoffMsFor(1)).toBe(30_000);
    expect(backoffMsFor(2)).toBe(60_000);
    expect(backoffMsFor(3)).toBe(120_000);
    expect(backoffMsFor(4)).toBe(300_000);
    expect(backoffMsFor(99)).toBe(300_000);
  });
});

describe("isNodeInBackoff", () => {
  test("a node nobody has failed on is never skipped", () => {
    expect(isNodeInBackoff(NODE, T0)).toBe(false);
  });

  test("a failed node is skipped for its window, then tried again", () => {
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0);

    expect(isNodeInBackoff(NODE, T0 + 1)).toBe(true);
    expect(isNodeInBackoff(NODE, T0 + 29_999)).toBe(true);
    expect(isNodeInBackoff(NODE, T0 + 30_000)).toBe(false);
  });

  test("the window widens as failures accumulate", () => {
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0);
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0 + 30_000);

    // Second failure => the 60s step, not another 30s.
    expect(isNodeInBackoff(NODE, T0 + 60_000)).toBe(true);
    expect(isNodeInBackoff(NODE, T0 + 90_000)).toBe(false);
  });

  test("one node's outage does not skip another", () => {
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0);
    expect(isNodeInBackoff("node-2", T0 + 1)).toBe(false);
  });
});

describe("logging", () => {
  test("the same outage is announced once, not once per tick", () => {
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('node "testy" is unreachable');
    expect(lines[0]).toContain("skipping it for 30s");
    expect(lines[0]).toContain("timeout");

    // A second failure inside the same step is still the same news.
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0 + 30_000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("after 2 attempts");
    expect(lines[1]).toContain("skipping it for 1m");

    // At the cap the window stops growing, so there is nothing new to say.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      noteNodeUnreachable(
        "watcher",
        NODE,
        "testy",
        new Error("timeout"),
        T0 + 100_000 * attempt,
      );
    }
    expect(lines).toHaveLength(4);
  });

  test("recovery is announced, and clears the backoff", () => {
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0);
    lines = [];

    noteNodeReachable("watcher", NODE, "testy");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reachable again");
    expect(isNodeInBackoff(NODE, T0 + 1)).toBe(false);
  });

  test("a healthy node stays silent", () => {
    noteNodeReachable("watcher", NODE, "testy");
    expect(lines).toHaveLength(0);
  });

  test("recovery resets the window, so a later blip is short again", () => {
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0);
    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0 + 30_000);
    noteNodeReachable("watcher", NODE, "testy");

    noteNodeUnreachable("watcher", NODE, "testy", new Error("timeout"), T0 + 90_000);
    expect(isNodeInBackoff(NODE, T0 + 119_999)).toBe(true);
    expect(isNodeInBackoff(NODE, T0 + 120_000)).toBe(false);
  });
});
