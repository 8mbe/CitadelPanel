import { describe, expect, test } from "bun:test";

import type { ContainerState } from "../nodes/nodeServerApi";
import {
  observeStart,
  START_WATCH_WINDOW_MS,
  startFailureReason,
} from "./startVerdict";

describe("startFailureReason", () => {
  test("a running container is the one state that is not a failure", () => {
    expect(startFailureReason("running")).toBeNull();
    expect(observeStart("running")).toBe("holding");
  });

  test("an exited container is the crash-on-boot case, named in seconds", () => {
    const reason = startFailureReason("exited");
    expect(reason).toContain("30 seconds");
    expect(observeStart("exited")).toBe("failed");
  });

  test("the window length is reflected in the message, not hardcoded", () => {
    expect(startFailureReason("exited", 10_000)).toContain("10 seconds");
  });

  test("a restart loop is a failure, not a container on its way up", () => {
    // The case that would otherwise pass the watch: Docker reports
    // `restarting` for a container a restart policy keeps reviving, so a naive
    // "is it not running?" check would see it flicker and call the start good.
    expect(observeStart("restarting")).toBe("failed");
    expect(startFailureReason("restarting")).toContain("crashing");
  });

  test("every non-running state the agent can report has its own explanation", () => {
    // Guards against a new ContainerState falling through to a message that
    // describes the wrong thing: each reason must be distinct, and none may be
    // the bare Docker word.
    const states: ContainerState[] = [
      "created",
      "paused",
      "restarting",
      "removing",
      "exited",
      "dead",
      "missing",
    ];
    const reasons = states.map((state) => startFailureReason(state));

    expect(reasons.every((reason) => typeof reason === "string")).toBe(true);
    expect(new Set(reasons).size).toBe(states.length);
    for (const reason of reasons) {
      expect(reason!.length).toBeGreaterThan(20);
    }
  });

  test("the watch window is long enough to outlast a slow boot, short enough to answer", () => {
    // Not an arbitrary constant: it has to exceed the seconds a crash takes
    // while staying well under the minutes a world generation takes, or the
    // watchdog either misses failures or invents them.
    expect(START_WATCH_WINDOW_MS).toBeGreaterThanOrEqual(15_000);
    expect(START_WATCH_WINDOW_MS).toBeLessThanOrEqual(60_000);
  });
});
