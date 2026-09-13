/**
 * The rule for deciding whether a start actually took.
 *
 * Pure and dependency-free for the same reason `statusReconcile.ts` is:
 * `serverManager` connects to the database at import time, so the part of this
 * worth testing lives where a test can import it. See
 * `services/startWatchdog.ts` for the caller that polls the node.
 */

import type { ContainerState } from "../nodes/nodeServerApi";

/**
 * How long a start is watched before it is called a success.
 *
 * Thirty seconds is not how long a game server takes to be *playable* -- a
 * large modpack can spend minutes generating a world. It is how long the panel
 * waits to see whether the process survives its own startup at all, which is a
 * different question and the one that has an answer this quickly. Everything
 * that makes a start fail outright (an unwritable data directory, a port
 * already bound, a malformed config, a missing jar) kills the process in the
 * first seconds; a server still running at thirty is one whose failures are now
 * the game's own to report, in a console that works.
 */
export const START_WATCH_WINDOW_MS = 30_000;

/** How often the node is asked what the container is doing. */
export const START_POLL_INTERVAL_MS = 2_000;

/**
 * What one observation of the container says about the start.
 *
 * `holding` is the only non-terminal answer: it means "no news", and the watch
 * keeps going until the window closes. Every other state is decisive on its
 * own, because a container that has stopped, vanished or gone into a restart
 * loop is not going to become a healthy server by being looked at again.
 */
export type StartObservation = "holding" | "failed";

/**
 * Why a start failed, in words for the person who pressed the button.
 *
 * Returns null while the start is still viable. The message names the
 * observable fact and what it implies, never the Docker state string on its
 * own: "exited" is not an explanation, and the operator reading this is
 * usually about to look at the captured output underneath it.
 */
export function startFailureReason(
  state: ContainerState,
  windowMs: number = START_WATCH_WINDOW_MS,
): string | null {
  const seconds = Math.round(windowMs / 1000);
  switch (state) {
    case "running":
      return null;
    case "restarting":
      // A restart policy hiding a crash loop. Without this case the watch would
      // keep seeing a container that is technically "coming up" and call the
      // start a success at the end of the window.
      return (
        "The container keeps restarting, which means the server is crashing " +
        "as it boots. The output below is from its most recent attempt."
      );
    case "missing":
      return (
        "The container is no longer on the node. It was removed after the " +
        "start, so there is nothing left running to connect to."
      );
    case "paused":
      return "The container was paused, so the server is not accepting players.";
    case "dead":
      return (
        "Docker reports the container as dead, which means it could not be " +
        "stopped or cleaned up normally. The node may need attention."
      );
    case "removing":
      return (
        "The container is being removed. Something deleted it while it was " +
        "starting, so the start could not complete."
      );
    case "created":
      return (
        "The container was created but never began running. It did not get " +
        "as far as executing the server."
      );
    default:
      // "exited" and anything a future Docker adds. This is the common one: the
      // process ran and quit, and its output is the whole explanation.
      return (
        `The server started and then stopped again within ${seconds} seconds. ` +
        "This usually means it failed during startup; the output below is " +
        "what it printed before exiting."
      );
  }
}

/** Whether an observed state means the start has failed. */
export function observeStart(state: ContainerState): StartObservation {
  return startFailureReason(state) === null ? "holding" : "failed";
}
