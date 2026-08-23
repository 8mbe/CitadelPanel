/**
 * The rule for turning "what the node sees" into "what the panel records".
 *
 * Pure and dependency-free on purpose: `serverManager` connects to the database
 * at import time, so the one piece of this worth testing lives here instead.
 * See `reconcileServerStatus` for the caller.
 */

// Both imports are type-only, and deliberately so: serverManager connects to
// the database at import time and nodeServerApi reaches it through nodeApi, so
// erasing these at compile time is what keeps this module importable and
// testable on its own.
import type { ContainerState } from "../nodes/nodeServerApi";
import type { ServerStatus } from "./serverManager";

/**
 * How long a stored transition is trusted over the node's own view.
 *
 * A power action either settles its status or writes `error`, both within its
 * own timeouts, so this is a backstop rather than a schedule: it bounds how long
 * a transition survives the panel process dying mid-action. Sized off the
 * longest of them: the graceful stop's grace period plus the slack the panel
 * allows on top of it (`stopServerContainer`, 30s + 30s), rounded up.
 */
export const TRANSITION_TRUSTED_FOR_MS = 75_000;

/** Map a container state to the status it means on its own. */
export function statusFromContainerState(state: ContainerState): ServerStatus {
  if (state === "running" || state === "restarting") return "running";
  if (state === "missing" || state === "dead") return "error";
  return "stopped";
}

/**
 * Whether a container state is compatible with a transition already in
 * progress, i.e. tells us nothing we did not already know.
 *
 * Docker has no "shutting down" or "about to come up" state, so each transition
 * has exactly one observation it cannot distinguish itself from:
 *
 * - `stopping`: from the SIGTERM until the process exits, `docker inspect` still
 *   reports `running`. That window is the whole point of a graceful stop, and
 *   many seconds of it for a game server saving a world.
 * - `starting`: the panel does real work before the container moves (the plugin
 *   auto-updater, see plugins.md), and throughout it the container is still
 *   sitting there `exited`.
 *
 * Believing the node in either case rewrites a live transition into its
 * opposite. That was how the Kill button, which the UI offers for exactly as
 * long as the status is `stopping`, disappeared mid-stop, and never appeared
 * at all on a page opened during one.
 *
 * Any *other* observation is real news and settles the status: a container that
 * exited has finished stopping, one that is up has finished starting, one that
 * is gone is an error.
 */
function observationIsAmbiguous(
  transition: "starting" | "stopping",
  observed: ServerStatus,
): boolean {
  return transition === "stopping"
    ? observed === "running"
    : observed === "stopped";
}

/**
 * The status a server should be recorded as, given what the node reports.
 *
 * `statusAgeMs` is how long the stored status has been in place, the age of the
 * row's `updated_at`, which `setStatus` bumps on every transition.
 *
 * Returns the stored status unchanged when the node's view adds nothing, so the
 * caller can skip the write.
 */
export function reconcileStatus(
  stored: ServerStatus,
  state: ContainerState,
  statusAgeMs: number,
): ServerStatus {
  // An administrative decision, not an observation of the node.
  if (stored === "suspended") return "suspended";

  const observed = statusFromContainerState(state);

  if (
    (stored === "starting" || stored === "stopping") &&
    statusAgeMs < TRANSITION_TRUSTED_FOR_MS &&
    observationIsAmbiguous(stored, observed)
  ) {
    return stored;
  }

  return observed;
}
