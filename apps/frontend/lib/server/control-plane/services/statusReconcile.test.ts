import { describe, expect, test } from "bun:test";

import {
  reconcileStatus,
  statusCorrections,
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

describe("statusCorrections", () => {
  const NOW = 1_700_000_000_000;
  const settled = (id: string, status: Parameters<typeof reconcileStatus>[0]) => ({
    id,
    status,
    updatedAt: new Date(NOW - STALE),
  });

  // The reason the sweeper exists: containers carry no restart policy, so a
  // node that rebooted answers "exited" for every server whose row says
  // "running".
  test("a node that came back with nothing running corrects every row", () => {
    const corrections = statusCorrections(
      [settled("a", "running"), settled("b", "running")],
      { a: "exited", b: "exited" },
      NOW,
    );

    expect(corrections).toEqual([
      { id: "a", from: "running", to: "stopped" },
      { id: "b", from: "running", to: "stopped" },
    ]);
  });

  test("rows the node agrees with produce no write at all", () => {
    expect(
      statusCorrections(
        [settled("a", "running"), settled("b", "stopped")],
        { a: "running", b: "exited" },
        NOW,
      ),
    ).toEqual([]);
  });

  // An unanswered id means the sweep learned nothing about that server, which
  // is not the same as learning its container is gone.
  test("a server the node said nothing about is left alone", () => {
    expect(statusCorrections([settled("a", "running")], {}, NOW)).toEqual([]);
  });

  test("suspension and in-flight transitions survive a batch sweep", () => {
    const corrections = statusCorrections(
      [
        settled("suspended", "suspended"),
        { id: "stopping", status: "stopping", updatedAt: new Date(NOW - FRESH) },
      ],
      { suspended: "running", stopping: "running" },
      NOW,
    );

    expect(corrections).toEqual([]);
  });
});
