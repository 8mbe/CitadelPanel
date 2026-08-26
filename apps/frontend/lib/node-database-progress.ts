import * as React from "react";

import type { NodeDatabaseStatus } from "@/lib/types";

/**
 * What a node database setup is doing right now, derived from the node's real
 * state rather than from a timer.
 *
 * Setting up a database is one blocking call that takes about a minute on a cold
 * node: Docker pulls MariaDB, MariaDB initialises its system tables, then the
 * panel's account is created. A spinner for that long reads as a hang, and a
 * fake progress bar would be a lie, so both UIs poll `GET .../database` while
 * the setup call is in flight and report what the node actually shows.
 *
 * The phases are exactly the transitions the status endpoint can distinguish:
 *
 * - no container yet ⇒ Docker is still pulling the image (the slowest step, and
 *   the one where a stalled network looks identical to a slow one);
 * - container exists but is not running ⇒ it is being started;
 * - running but not answering as the panel's account ⇒ MariaDB's first boot, or
 *   the account is not created yet. These two are deliberately one phase: they
 *   are indistinguishable from outside, and both mean "wait".
 * - running and *refusing* the account ⇒ not a stage of starting at all. Saying
 *   "initialising" here (which this did, once) is a lie the logs contradict:
 *   the database is up and denying access, and no amount of waiting fixes it.
 * - answering ⇒ done.
 */
export type NodeDatabasePhase =
  | "pulling"
  | "starting"
  | "initialising"
  | "denied"
  | "ready";

/** Classify a polled status. `null` (not asked yet) counts as pulling. */
export function nodeDatabasePhase(
  status: NodeDatabaseStatus | null | undefined,
): NodeDatabasePhase {
  if (!status || !status.exists) return "pulling";
  if (status.state !== "running") return "starting";
  if (status.ready) return "ready";
  return status.probe === "denied" ? "denied" : "initialising";
}

/**
 * The sentence shown beside the spinner.
 *
 * Each one says what is happening *and* roughly how long it should take, because
 * "is this stuck?" is the only question an operator has during a long wait. The
 * elapsed seconds are appended by the caller, which is what actually proves the
 * page is alive.
 */
export function nodeDatabasePhaseLabel(phase: NodeDatabasePhase): string {
  switch (phase) {
    case "pulling":
      return "Downloading MariaDB on the node. This is the slow part, usually 30-60s.";
    case "starting":
      return "Starting the database container.";
    case "initialising":
      return "MariaDB is initialising its system tables. About 20s.";
    case "denied":
      return "The database is up but refusing this credential. Not a wait: it needs a decision.";
    case "ready":
      return "Database is up. Finishing.";
  }
}

/**
 * Run a slow database setup while reporting what the node is doing.
 *
 * Shared by both places that can start one (the register form and the node's
 * admin card) because they had the same problem: one blocking call, up to a
 * minute, and nothing on screen but a spinner.
 *
 * One timer drives both halves. The second counter is what proves the page is
 * alive; the phase poll (every third second, so a slow node cannot queue polls
 * behind each other) is what makes the message true rather than a guess. A
 * failed poll is swallowed: the work itself owns the outcome, and a missed tick
 * is not news.
 */
export function useNodeDatabaseProgress(
  poll: () => Promise<NodeDatabaseStatus | null>,
) {
  const [running, setRunning] = React.useState(false);
  const [phase, setPhase] = React.useState<NodeDatabasePhase>("pulling");
  const [elapsed, setElapsed] = React.useState(0);

  const run = React.useCallback(async function run<T>(
    work: () => Promise<T>,
  ): Promise<T> {
    setRunning(true);
    setPhase("pulling");
    setElapsed(0);

    let seconds = 0;
    const timer = setInterval(() => {
      seconds += 1;
      setElapsed(seconds);
      if (seconds % 3 !== 0) return;
      void (async () => {
        try {
          setPhase(nodeDatabasePhase(await poll()));
        } catch {
          // A missed poll changes nothing; the work call reports the real result.
        }
      })();
    }, 1000);

    try {
      return await work();
    } finally {
      clearInterval(timer);
      setRunning(false);
    }
    // Call sites pass an inline closure, so this is rebuilt each render. That is
    // fine and deliberate: `run` is only ever invoked from an event handler,
    // never from a dependency array, and capturing the latest `poll` is what
    // keeps the polled URL/token in step with the form above it.
  }, [poll]);

  return { running, phase, elapsed, run };
}
