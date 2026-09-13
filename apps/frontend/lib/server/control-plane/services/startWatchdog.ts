/**
 * Watch a start long enough to know whether it took, and keep the reason if it
 * did not.
 *
 * The problem this exists for: `docker start` answering "ok" means the
 * container's entrypoint was handed to the kernel, not that the server is
 * running. A container whose data directory is unwritable, whose port is
 * already bound, or whose config is malformed exits a second or two later. The
 * panel recorded `running`, the status reconciler later rewrote it to
 * `stopped`, and the operator was left with a server that "won't start" and no
 * explanation anywhere in the panel -- the explanation was in the container's
 * output, and by the time anyone went looking, that container had been
 * restarted or removed and taken `docker logs` with it.
 *
 * So the panel keeps watching after the start returns. If the container stops
 * holding within {@link START_WATCH_WINDOW_MS}, its last output is captured to
 * the server row *while it still exists*, and that is what the UI shows.
 *
 * Deliberately in-process and deliberately not durable, the same posture as
 * provisioning: a panel restart mid-watch loses it. The cost of that is a
 * failure that goes unexplained, which is exactly where things stood before, so
 * a lost watch is never worse than not having watched. It is never a reason to
 * fail or delay the start itself -- every path here swallows its own errors.
 */

import { sql } from "@/lib/server/control-plane/db/client";
import { notFound } from "@/lib/server/control-plane/lib/http";
import {
  getServerLogs,
  getServerState,
} from "@/lib/server/control-plane/nodes/nodeServerApi";
import type { ServerStatus } from "@/lib/server/control-plane/services/serverManager";

import { statusFromContainerState } from "./statusReconcile";
import {
  observeStart,
  START_POLL_INTERVAL_MS,
  START_WATCH_WINDOW_MS,
  startFailureReason,
} from "./startVerdict";

/**
 * How much of the container's output is kept.
 *
 * Generous, because the useful line is not always the last one: a Java stack
 * trace buries its cause dozens of lines up, and the panel gets one chance to
 * capture this before the container is gone.
 */
const CAPTURED_LOG_LINES = 500;

/** Cap on the stored text, so a server that fails loudly cannot bloat the row. */
const MAX_START_FAILURE_CHARS = 64_000;

/**
 * The watches running in this process, so a deliberate stop can call one off.
 *
 * Without this, pressing Stop during the window looks exactly like a crash:
 * the container is not running, which is the whole signal the watch has. The
 * cancel is what separates "it died" from "you killed it".
 *
 * Keyed by server id; a second start replaces the first, since only the newest
 * start is the one anybody is waiting on.
 */
const inFlightWatches = new Map<
  string,
  { promise: Promise<void>; controller: AbortController }
>();

/** Await a start watch running in this process, if there is one. */
export async function waitForStartWatch(serverId: string): Promise<void> {
  await inFlightWatches.get(serverId)?.promise;
}

/**
 * Call off the watch for a server, because its state is no longer the
 * watchdog's to interpret.
 *
 * Called by every deliberate transition away from running (stop, kill,
 * restart, delete, migrate). Note that the *status reconciler* must not call
 * this: a reconcile that notices the container exited is observing the very
 * crash the watch exists to explain, and cancelling there would race the
 * watchdog to the row and usually win, which is the bug this whole module is
 * fixing.
 */
export function cancelStartWatch(serverId: string): void {
  const watch = inFlightWatches.get(serverId);
  if (!watch) return;
  watch.controller.abort();
  inFlightWatches.delete(serverId);
}

/** Sleep that resolves early (and quietly) when the watch is called off. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Record a failed start on the row, with whatever the container managed to say.
 *
 * The log read is best-effort and comes *first* in importance but not in
 * consequence: a node that has gone unreachable is often itself the reason the
 * start failed, and the reason line alone is still worth storing. So a failed
 * log read degrades to a note rather than losing the whole record.
 */
async function recordStartFailure(
  serverId: string,
  nodeId: string,
  reason: string,
  status: ServerStatus,
): Promise<void> {
  let log: string;
  try {
    log = await getServerLogs(nodeId, serverId, CAPTURED_LOG_LINES);
  } catch (error) {
    log =
      "[panel] The node could not be asked for this container's output " +
      `(${error instanceof Error ? error.message : String(error)}).`;
  }

  const trimmed = log.trimEnd();
  try {
    // The status is corrected in the same statement as the explanation. The
    // reconciler would get there on its own, but only when somebody next reads
    // the server, so without this the panel keeps claiming `running` for a
    // container that is already gone -- which is half of what made the original
    // failure so hard to see.
    await sql`
      UPDATE servers
      SET status = ${status},
          updated_at = now(),
          start_failure_reason = ${reason},
          start_failure_log = ${
            trimmed.length > MAX_START_FAILURE_CHARS
              ? trimmed.slice(-MAX_START_FAILURE_CHARS)
              : trimmed
          },
          start_failed_at = now()
      WHERE id = ${serverId}
    `;
  } catch (error) {
    console.error(
      `[startWatchdog] could not record start failure for ${serverId}:`,
      error,
    );
  }
}

/**
 * Forget a previous failure, because this start worked.
 *
 * Only a *successful* start clears the record, never the beginning of a new
 * attempt. Someone who hits Start twice on a broken server should still be
 * looking at why it is broken, not at an empty panel that just cleared the
 * evidence for them.
 */
export async function clearStartFailure(serverId: string): Promise<void> {
  try {
    await sql`
      UPDATE servers
      SET start_failure_reason = NULL, start_failure_log = '', start_failed_at = NULL
      WHERE id = ${serverId} AND start_failed_at IS NOT NULL
    `;
  } catch (error) {
    console.error(
      `[startWatchdog] could not clear start failure for ${serverId}:`,
      error,
    );
  }
}

/**
 * Poll the node until the start is proved or disproved.
 *
 * Polling rather than waiting out the full window then looking once: a
 * container that dies two seconds in should be reported two seconds in, while
 * its output is fresh and the person who pressed Start is still watching. The
 * window is the limit on patience, not the unit of measurement.
 *
 * Never rejects. It is launched detached from the request that started the
 * server and reports through the row, exactly like provisioning.
 */
async function watchStart(serverId: string, nodeId: string, signal: AbortSignal) {
  const deadline = Date.now() + START_WATCH_WINDOW_MS;

  while (!signal.aborted) {
    await sleep(START_POLL_INTERVAL_MS, signal);
    if (signal.aborted) return;

    let state;
    try {
      state = await getServerState(nodeId, serverId);
    } catch {
      // An unreachable node is not a verdict. The start may well be fine; the
      // panel just cannot see it. Try again, and let the window run out --
      // which ends in the success branch, because refusing to call something
      // broken on the strength of a failed lookup is the safer default.
      if (Date.now() >= deadline) break;
      continue;
    }

    if (observeStart(state) === "failed") {
      const reason = startFailureReason(state);
      if (reason && !signal.aborted) {
        await recordStartFailure(
          serverId,
          nodeId,
          reason,
          statusFromContainerState(state),
        );
      }
      return;
    }

    if (Date.now() >= deadline) break;
  }

  if (signal.aborted) return;
  // Held for the whole window: this start worked, so any older failure on the
  // row is now history and would only mislead.
  await clearStartFailure(serverId);
}

/**
 * Begin watching a server that was just asked to start.
 *
 * Returns immediately; the caller hands the returned promise to the runtime
 * (`after()`) so the work outlives the response without the user waiting on it.
 * Replaces any watch already running for the server.
 */
export function beginStartWatch(serverId: string, nodeId: string): void {
  cancelStartWatch(serverId);

  const controller = new AbortController();
  const promise = watchStart(serverId, nodeId, controller.signal)
    .catch((error) => {
      console.error(`[startWatchdog] watch failed for ${serverId}:`, error);
    })
    .finally(() => {
      // Only clear the map if this watch is still the current one; a newer
      // start may already have replaced it.
      if (inFlightWatches.get(serverId)?.controller === controller) {
        inFlightWatches.delete(serverId);
      }
    });

  inFlightWatches.set(serverId, { promise, controller });
}

/** A recorded start failure, as the API returns it. */
export interface StartFailureView {
  reason: string;
  at: Date;
  /** The failed container's captured output. May be empty if none was read. */
  log: string;
}

/**
 * Read the stored failure for a server, or null if its last start worked.
 *
 * Reads only the row. The container this output came from is usually gone by
 * now -- that is the reason any of this is stored rather than fetched live.
 */
export async function readStartFailure(
  serverId: string,
): Promise<StartFailureView | null> {
  const rows = (await sql`
    SELECT start_failure_reason, start_failure_log, start_failed_at
    FROM servers WHERE id = ${serverId}
  `) as {
    start_failure_reason: string | null;
    start_failure_log: string;
    start_failed_at: Date | null;
  }[];

  const row = rows[0];
  if (!row) throw notFound("Server not found");
  if (!row.start_failed_at || !row.start_failure_reason) return null;

  return {
    reason: row.start_failure_reason,
    at: row.start_failed_at,
    log: row.start_failure_log,
  };
}
