/**
 * Backoff and one-line reporting for nodes the panel's unattended sweeps
 * cannot reach.
 *
 * Two timers talk to every active node: the abuse watcher
 * (`security/watcher.ts`) and the status sweeper (`services/statusSweeper.ts`).
 * A node that is down answers neither, and without this module each of them
 * paid the same price on every single tick:
 *
 *   - **time.** A dead agent is not a refused connection. A host that drops
 *     packets (a rebooted machine, a firewall rule, a suspended VM) is only
 *     discovered when the request's timeout expires, and that whole timeout is
 *     spent again on the next tick, and the next. Once it approaches the sweep
 *     interval, sweeps start outliving their own tick and the following one is
 *     skipped, so one dead node stops the sweep from looking at the live ones.
 *     That is a cheap way to blind the watcher, which is exactly what section 9
 *     of the plan says a sweep must not allow.
 *   - **log.** The same "unreachable" line, forever, at the sweep's cadence. A
 *     log that repeats a known fact every 30 seconds is a log nobody reads, and
 *     it buries the lines that do mean something (a flag, a correction).
 *
 * So a node that fails is skipped for a growing window, capped, and the
 * *transitions* are what gets logged: once when it goes away with the reason,
 * once when it comes back. State is per-process and in memory on purpose: it is
 * a rate limiter for a timer, not a record of anything, and a panel restart
 * should re-check the whole fleet immediately rather than inherit a backoff.
 *
 * Deliberately not applied to operator-initiated calls. An admin opening the
 * nodes page, provisioning a server, or pressing Scan now asks the agent and
 * gets today's answer (`checkNodeHealth`, `runSweep({ force: true })`). Only the
 * unattended timers back off, because only they repeat on their own.
 */

/**
 * The skip window, by consecutive failure count; the last entry is the cap.
 *
 * Starts at one status-sweep interval (the shorter of the two timers) so a node
 * that blipped is re-checked almost immediately, and tops out at five minutes:
 * long enough that a node which has been dead for an hour costs one request
 * every five, short enough that a node coming back is noticed without an
 * operator doing anything.
 */
const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000] as const;

interface NodeFailureState {
  /** Consecutive failures, reset by the first success. */
  failures: number;
  /** No sweep should call this node before this timestamp. */
  skipUntil: number;
  /** Backoff window already announced, so growth is logged once per step. */
  announcedWindowMs: number;
}

const failures = new Map<string, NodeFailureState>();

/** The skip window for a given number of consecutive failures. */
export function backoffMsFor(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(consecutiveFailures, 1),
    BACKOFF_STEPS_MS.length,
  ) - 1;
  return BACKOFF_STEPS_MS[index]!;
}

/**
 * Should an unattended sweep leave this node alone for now?
 *
 * Cheap and synchronous, so it is checked before the request is built rather
 * than after it fails.
 */
export function isNodeInBackoff(nodeId: string, now = Date.now()): boolean {
  const state = failures.get(nodeId);
  return state !== undefined && now < state.skipUntil;
}

/** "30s" / "2m", for a log line an operator reads once. */
function formatWindow(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

/**
 * Record that a sweep could not reach a node, and extend its skip window.
 *
 * Logs on the first failure and whenever the window grows, which is what an
 * operator needs to see: the node went away, and the panel is checking it less
 * often now. The reason comes from the error's message; the stack is dropped
 * because "the node did not answer" has no interesting stack, and printing one
 * every tick was most of the noise this replaces.
 */
export function noteNodeUnreachable(
  sweep: string,
  nodeId: string,
  nodeName: string,
  error: unknown,
  now = Date.now(),
): void {
  const previous = failures.get(nodeId);
  const count = (previous?.failures ?? 0) + 1;
  const windowMs = backoffMsFor(count);

  failures.set(nodeId, {
    failures: count,
    skipUntil: now + windowMs,
    announcedWindowMs: windowMs,
  });

  const grew = windowMs !== previous?.announcedWindowMs;
  if (!grew) return;

  const reason = error instanceof Error ? error.message : String(error);
  const attempts = count === 1 ? "" : ` after ${count} attempts`;
  console.warn(
    `[${sweep}] node "${nodeName}" is unreachable${attempts}; ` +
      `skipping it for ${formatWindow(windowMs)}: ${reason}`,
  );
}

/**
 * Record that a sweep reached a node.
 *
 * A no-op for a node that was never failing, which is every node on a healthy
 * panel, so the happy path stays silent.
 */
export function noteNodeReachable(
  sweep: string,
  nodeId: string,
  nodeName: string,
): void {
  const previous = failures.get(nodeId);
  if (!previous) return;

  failures.delete(nodeId);
  console.log(
    `[${sweep}] node "${nodeName}" is reachable again ` +
      `(after ${previous.failures} failed attempt${previous.failures === 1 ? "" : "s"})`,
  );
}

/** Exposed for tests: forget every node's failure state. */
export function resetNodeReachability(): void {
  failures.clear();
}
