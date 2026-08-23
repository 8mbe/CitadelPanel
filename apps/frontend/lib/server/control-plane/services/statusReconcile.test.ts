import { describe, expect, test } from "bun:test";

import {
  reconcileStatus,
  statusFromContainerState,
  TRANSITION_TRUSTED_FOR_MS,
} from "./statusReconcile";

const FRESH = 1_000;
const STALE = TRANSITION_TRUSTED_FOR_MS + 1;

describe("statusFromContainerState", () => {
  test("a restarting container is up as far as the panel is concerned", () => {
    expect(statusFromContainerState("running")).toBe("running");
    expect(statusFromContainerState("restarting")).toBe("running");
  });

  test("a container that is gone or dead is an error, not a clean stop", () => {
    expect(statusFromContainerState("missing")).toBe("error");
    expect(statusFromContainerState("dead")).toBe("error");
  });

  test("everything else settles as stopped", () => {
    expect(statusFromContainerState("created")).toBe("stopped");
    expect(statusFromContainerState("exited")).toBe("stopped");
    expect(statusFromContainerState("paused")).toBe("stopped");
    expect(statusFromContainerState("removing")).toBe("stopped");
  });
});

describe("reconcileStatus", () => {
  test("a crashed server does not keep claiming to be running", () => {
    expect(reconcileStatus("running", "exited", FRESH)).toBe("stopped");
    expect(reconcileStatus("running", "missing", FRESH)).toBe("error");
    expect(reconcileStatus("stopped", "running", FRESH)).toBe("running");
  });

  test("suspension is an administrative decision, never an observation", () => {
    expect(reconcileStatus("suspended", "running", FRESH)).toBe("suspended");
    expect(reconcileStatus("suspended", "exited", STALE)).toBe("suspended");
  });

  // The bug this rule exists for: docker reports `running` for the whole grace
  // period of a graceful stop, so believing it turned every in-flight stop back
  // into "running" and took the Kill button away with it.
  test("an in-flight stop survives a node that still reports the container up", () => {
    expect(reconcileStatus("stopping", "running", FRESH)).toBe("stopping");
  });

  test("an in-flight start survives a container that has not moved yet", () => {
    expect(reconcileStatus("starting", "exited", FRESH)).toBe("starting");
    expect(reconcileStatus("starting", "created", FRESH)).toBe("starting");
  });

  test("the transition is settled by the container actually moving", () => {
    expect(reconcileStatus("stopping", "exited", FRESH)).toBe("stopped");
    expect(reconcileStatus("starting", "running", FRESH)).toBe("running");
  });

  test("a container that vanished mid-transition is an error either way", () => {
    expect(reconcileStatus("stopping", "missing", FRESH)).toBe("error");
    expect(reconcileStatus("starting", "dead", FRESH)).toBe("error");
  });

  test("a transition that outlived any possible action hands the node back control", () => {
    expect(reconcileStatus("stopping", "running", STALE)).toBe("running");
    expect(reconcileStatus("starting", "exited", STALE)).toBe("stopped");
  });

  test("a settled status is never held open by the window", () => {
    expect(reconcileStatus("running", "running", FRESH)).toBe("running");
    expect(reconcileStatus("error", "running", FRESH)).toBe("running");
  });
});
