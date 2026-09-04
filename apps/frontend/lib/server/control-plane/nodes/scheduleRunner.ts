/**
 * The schedule runner: one timer that decides what is due and starts it.
 *
 * Structured like `backupScheduler.ts` on purpose, and worth reading alongside
 * it, but with one deliberate difference: **runs are started detached, not
 * awaited.** A schedule may contain a task that waits up to 15 minutes before
 * firing, so awaiting a run inside the tick would block every *other* server's
 * schedule behind one server's "warn the players, then restart in a minute".
 *
 * That trade is what the `running` run row pays for. Because the run is not on
 * the tick's stack, the row is the only thing that knows it exists:
 *
 *   - `listCandidateSchedules` excludes a schedule with a run in flight, which is
 *     what stops a later tick starting a second copy of a slow run;
 *   - `failInterruptedScheduleRuns` closes out rows whose owner is gone (the
 *     panel restarted) or overdue (their own tasks' budget has expired), which is
 *     what stops one lost run from silencing a schedule forever.
 *
 * So the sweep runs *before* the fire on every tick, the same ordering and for
 * the same reason as the backup scheduler's reconcile-then-fire.
 */

import { getTimezone } from "../services/settings";
import {
  executeSchedule,
  failInterruptedScheduleRuns,
  hasScheduledRunSince,
  listCandidateSchedules,
  type DueSchedule,
} from "../services/serverSchedules";
import { cronMatches, parseCron } from "@/lib/cron";

/**
 * How often the runner ticks.
 *
 * Must be well under a minute so an expression naming a specific minute is never
 * missed. 30 seconds gives every minute at least one evaluation, and matches the
 * backup scheduler so the two do not drift into different definitions of "due".
 */
const TICK_MS = 30_000;

/**
 * When this process started, as the boundary between "a run this process owns"
 * and "a run left behind by a previous one".
 *
 * Captured at module load rather than at `start()`, so it is the same value for
 * the boot sweep and for every later tick. Taking it at start time would make a
 * hot reload look like a fresh boot and fail runs that are genuinely in flight.
 */
const BOOTED_AT = Date.now();

/**
 * Whether a schedule's expression is due right now, in the panel's timezone.
 *
 * An expression that no longer parses is logged rather than silently never
 * running: the API validates on write, so reaching here means the row was
 * written by something else, and a schedule that quietly stops firing is the
 * worst way to find that out.
 */
function isDue(schedule: DueSchedule, now: Date, timezone: string): boolean {
  try {
    return cronMatches(parseCron(schedule.cron), now, timezone);
  } catch (error) {
    console.error(
      `[schedules] "${schedule.name}" on ${schedule.serverName} has an invalid ` +
        `expression "${schedule.cron}":`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Whether a schedule's `onlyWhenRunning` guard is satisfied.
 *
 * Read from the row the candidate query already returned rather than reconciled
 * against the node: this is a "should I bother?" check, not a safety check, and
 * a node round trip per schedule per minute is not worth it for a guard whose
 * whole purpose is to skip work. The tasks themselves still go through
 * `serverManager`, which does reconcile.
 */
function passesRunningGuard(schedule: DueSchedule): boolean {
  if (!schedule.onlyWhenRunning) return true;
  return schedule.serverStatus === "running";
}

/**
 * Start every schedule that is due.
 *
 * Each run is started detached and its promise deliberately dropped after a
 * `catch` that cannot fire in practice (`executeSchedule` records rather than
 * throws) but is there so a bug in it can never become an unhandled rejection
 * that takes the panel's process down.
 */
async function fireDue(): Promise<number> {
  const [candidates, timezone] = await Promise.all([
    listCandidateSchedules(),
    getTimezone(),
  ]);
  if (candidates.length === 0) return 0;

  const now = new Date();
  // Top of the current minute in real time: the window a duplicate would fall in.
  const minuteStart = new Date(now.getTime());
  minuteStart.setUTCSeconds(0, 0);

  let started = 0;

  for (const schedule of candidates) {
    if (!isDue(schedule, now, timezone)) continue;
    if (!passesRunningGuard(schedule)) continue;

    try {
      if (await hasScheduledRunSince(schedule.id, minuteStart)) continue;
    } catch (error) {
      console.error(`[schedules] could not check "${schedule.name}" for a recent run:`, error);
      continue;
    }

    void executeSchedule(schedule, "scheduled", schedule.createdBy).catch((error) => {
      console.error(`[schedules] run of "${schedule.name}" threw:`, error);
    });
    started += 1;
  }

  if (started > 0) {
    console.log(`[schedules] started ${started} run(s)`);
  }
  return started;
}

/**
 * The live interval, held on `globalThis` rather than in a module-level binding.
 *
 * Same reasoning as `backupScheduler.ts`: the runner is started once from
 * `instrumentation.ts`, which Next.js never re-runs, so a hot-replaced module
 * would leave the *old* instance's interval firing old code against a schema it
 * no longer matches. A global handle makes a reload replace the timer instead of
 * racing it.
 */
const TIMER_KEY = "__citadelScheduleRunnerTimer";

type TimerHolder = {
  [TIMER_KEY]?: ReturnType<typeof setInterval> | null;
};

const holder = globalThis as unknown as TimerHolder;

let tickInFlight = false;

/** Sweep abandoned runs, then start what is due. */
async function tick(): Promise<{ closed: number; started: number }> {
  const closed = await failInterruptedScheduleRuns(BOOTED_AT);
  if (closed > 0) {
    console.warn(`[schedules] closed out ${closed} abandoned run(s)`);
  }
  const started = await fireDue();
  return { closed, started };
}

/**
 * Start the runner, replacing any interval a previous module instance left
 * running.
 *
 * Overlapping ticks are skipped rather than queued, like the backup scheduler
 * and the abuse watcher: nothing here is a deadline, so a tick missed by one
 * interval fires on the next. Note that this bounds only the *decision* work;
 * the runs themselves are detached and are expected to outlive the tick that
 * started them.
 */
export function startScheduleRunner(): void {
  // Clear rather than bail: bailing would leave a stale interval from a
  // hot-replaced module as the only one running.
  if (holder[TIMER_KEY]) {
    clearInterval(holder[TIMER_KEY]!);
    holder[TIMER_KEY] = null;
  }

  holder[TIMER_KEY] = setInterval(async () => {
    if (tickInFlight) {
      console.warn("[schedules] previous tick still running, skipping this one");
      return;
    }

    tickInFlight = true;
    try {
      await tick();
    } catch (error) {
      console.error("[schedules] tick failed:", error);
    } finally {
      tickInFlight = false;
    }
  }, TICK_MS);

  console.log(`[schedules] runner started, ticking every ${TICK_MS / 1000}s`);
}

export function stopScheduleRunner(): void {
  if (!holder[TIMER_KEY]) return;
  clearInterval(holder[TIMER_KEY]!);
  holder[TIMER_KEY] = null;
  console.log("[schedules] runner stopped");
}

/**
 * Close out runs left behind by a previous process.
 *
 * Called from `instrumentation.ts` at boot, before the first request is served,
 * for the same reason `failInterruptedProvisions` is: those rows claim to be
 * running and nobody is working on them, and until they are closed their
 * schedules cannot fire.
 */
export async function failAbandonedScheduleRuns(): Promise<void> {
  try {
    const closed = await failInterruptedScheduleRuns(BOOTED_AT);
    if (closed > 0) {
      console.warn(`[schedules] closed out ${closed} run(s) interrupted by a restart`);
    }
  } catch (error) {
    // Boot must not fail over this. The next tick tries again.
    console.error("[schedules] could not sweep interrupted runs at boot:", error);
  }
}
