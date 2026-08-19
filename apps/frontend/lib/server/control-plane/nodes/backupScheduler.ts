/**
 * The backup scheduler: one timer, two jobs.
 *
 *   1. **Reconcile.** Poll every in-flight run's agent job, drain its new log lines
 *      into Postgres, and record its outcome. The agent cannot call in — it has no
 *      panel credential and may be behind NAT — so the panel polls, the same way
 *      `security/watcher.ts` polls for stats.
 *
 *   2. **Fire.** Evaluate the operator's two cron expressions and start the runs
 *      that are due: server file backups, and node database backups.
 *
 * Reconciliation is what makes the whole feature durable. The agent's job state is
 * in memory; the panel's row is on disk. Every tick moves information from the
 * former to the latter, so the worst an agent restart costs is the progress
 * percentage of one run — and a job that has disappeared becomes a failed run with
 * that stated as the reason, rather than a row stuck at "running" forever.
 *
 * One timer rather than three because they must not race: firing a new backup for a
 * subject whose previous run has not been reconciled yet would start a second restic
 * against one repository. Doing everything in sequence on one tick makes that
 * impossible without a lock.
 */

import {
  getBackupSettings,
  getTimezone,
  isBackupConfigUsable,
} from "../services/settings";
import {
  appendLog,
  completeRun,
  dropForgottenRuns,
  failRun,
  hasScheduledRunSince,
  listActiveRuns,
  markRepositoryInitialized,
  recordRepositorySize,
  trimFailedRuns,
  updateRunProgress,
  type ActiveRun,
} from "../services/backupCore";
import { listServersDueForBackup, startServerBackup } from "../services/serverBackups";
import {
  listNodesDueForDatabaseBackup,
  startDatabaseBackup,
} from "../services/databaseBackups";
import { readNodeBackupJob } from "./nodeBackupApi";
import { cronMatches, parseCron } from "@/lib/cron";

/**
 * How often the scheduler ticks.
 *
 * Must be well under a minute so a cron expression that names a specific minute is
 * not missed, and long enough that polling in-flight jobs is not a load on the
 * agents. 30 seconds gives every minute at least one evaluation.
 */
const TICK_MS = 30_000;

/**
 * How long a run may sit with no job id before it is declared failed.
 *
 * A `pending` row with no job id means the panel died between writing the row and
 * calling the agent. Nothing will ever advance it, so it must not stay pending — a
 * stuck row blocks every later backup of that subject through the already-running
 * check.
 */
const PENDING_GRACE_MS = 5 * 60_000;

/**
 * How long a running job may go unreconciled before it is declared failed.
 *
 * Only reached when the node is unreachable for the whole window: a reachable agent
 * either reports the job or 404s it, and both are handled immediately. Six hours
 * matches the agent's own backup timeout, so the panel never gives up on a job the
 * node might still be working on.
 */
const STALE_RUNNING_MS = 6 * 60 * 60_000 + 30 * 60_000;

/** The subject id a run's repository is keyed by. */
function subjectIdOf(run: ActiveRun): string {
  return run.scope === "server" ? (run.serverId ?? run.nodeId) : run.nodeId;
}

/**
 * Poll one run's agent job and write what it says into the panel's row.
 *
 * Every failure mode here is turned into a *recorded* outcome rather than an
 * exception, because the caller is a timer with nobody to report to:
 *   - the job is gone (404)   -> failed, with the agent's own explanation;
 *   - the node is unreachable -> left alone until the stale window expires, since a
 *                                node rebooting mid-backup is normal and the restic
 *                                container survives it.
 */
async function reconcileOne(run: ActiveRun): Promise<void> {
  const age = Date.now() - run.createdAt.getTime();
  const subjectId = subjectIdOf(run);

  if (!run.jobId) {
    if (age > PENDING_GRACE_MS) {
      await failRun(
        run.id,
        "The panel never received a job id for this run — it most likely restarted " +
          "between recording the request and reaching the node. Start a new backup.",
      );
    }
    return;
  }

  let job;
  try {
    job = await readNodeBackupJob(run.nodeId, run.jobId, run.logCursor);
  } catch (error) {
    const status = (error as { status?: number }).status;

    // 404: the agent does not know this job. Either it restarted (losing its
    // in-memory registry) or the job aged out of it. Neither can be recovered from,
    // so the run is failed with that said plainly.
    if (status === 404) {
      await failRun(
        run.id,
        "The node is no longer tracking this run. The agent was most likely restarted " +
          "while it was in progress. Any partial upload is unreferenced and will be " +
          "reclaimed by the next prune; start a new backup.",
      );
      return;
    }

    // Anything else is a transport problem. Wait it out — a node rebooting does not
    // stop the restic container it started.
    if (age > STALE_RUNNING_MS) {
      await failRun(
        run.id,
        `This node has been unreachable for too long to keep waiting on this run: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  // Drain the log first, so a run that finishes on this same tick still has its
  // final lines recorded before the row is closed out.
  let cursor = run.logCursor;
  for (const line of job.logs) {
    await appendLog(run.id, line.seq, line.level, line.message);
    cursor = Math.max(cursor, line.seq);
  }
  if (job.droppedLines > 0 && job.logs.length > 0) {
    // Mentioned once per drain rather than per line, and not as an error: a
    // truncated log is a very long log, not a failure.
    await appendLog(
      run.id,
      cursor + 1,
      "warn",
      `${job.droppedLines} earlier log line${job.droppedLines === 1 ? "" : "s"} were ` +
        `dropped by the node to bound memory use.`,
    );
    cursor += 1;
  }

  if (job.status === "running") {
    await updateRunProgress(run.id, job.phase, job.percent, cursor);
    return;
  }

  if (job.status === "succeeded") {
    // Order matters: drop the rows for snapshots the quota deleted *before*
    // recording this one, so a reader never briefly sees more backups than the
    // limit allows.
    if (job.result.forgotten && job.result.forgotten.length > 0) {
      const dropped = await dropForgottenRuns(run.scope, subjectId, job.result.forgotten);
      if (dropped > 0) {
        console.log(
          `[backups] quota removed ${dropped} older backup(s) for ${run.scope} ${subjectId}`,
        );
      }
    }

    await completeRun(run.id, job.result, cursor);
    await markRepositoryInitialized(run.scope, subjectId);

    // Null is "could not measure", which must not be recorded as zero — that would
    // understate the fleet's storage, the one number the report exists to get right.
    if (typeof job.result.repoSizeBytes === "number") {
      await recordRepositorySize(run.scope, subjectId, job.result.repoSizeBytes);
    }
    return;
  }

  await failRun(run.id, job.error ?? "The node reported the run as failed without a reason.");
  await trimFailedRuns(run.scope, subjectId);
}

/** Poll every in-flight run. One run's failure must not stop the others. */
async function reconcileAll(): Promise<number> {
  const active = await listActiveRuns();

  for (const run of active) {
    try {
      await reconcileOne(run);
    } catch (error) {
      console.error(`[backups] could not reconcile run ${run.id}:`, error);
    }
  }
  return active.length;
}

/**
 * Whether a cron expression is due right now, in the panel's timezone.
 *
 * An expression that no longer parses is logged rather than silently never
 * running — the settings form would have caught it, so reaching here means the
 * stored value was written by something else.
 */
async function isDue(schedule: string, label: string, now: Date): Promise<boolean> {
  if (schedule.trim().length === 0) return false;

  try {
    const expression = parseCron(schedule);
    return cronMatches(expression, now, await getTimezone());
  } catch (error) {
    console.error(
      `[backups] the ${label} schedule "${schedule}" is not valid:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Fire scheduled server file backups.
 *
 * The double-fire guard is a **time window**, not a stored "last run at" marker:
 * the tick interval is shorter than a minute, so the same due minute is evaluated
 * more than once, and a marker would have to be written transactionally with the
 * backup to be trustworthy. Asking "has a scheduled run started for this subject
 * since the top of this minute?" needs no extra state and survives a panel restart
 * mid-minute.
 *
 * `concurrency` caps how many servers start per tick. Every concurrent backup reads
 * a disk and saturates a node's upstream, so on a fleet of a hundred servers the
 * schedule deliberately trickles rather than stampedes.
 */
async function fireServerBackups(minuteStart: Date, concurrency: number): Promise<number> {
  const due = await listServersDueForBackup();
  let started = 0;

  for (const server of due) {
    if (started >= Math.max(1, concurrency)) break;
    if (await hasScheduledRunSince("server", server.id, minuteStart)) continue;

    try {
      await startServerBackup({ serverId: server.id, actorId: null, trigger: "scheduled" });
      started += 1;
    } catch (error) {
      // A single server's failure (an unreachable node, a storage quota reached, a
      // server that changed state mid-sweep) must not stop the rest of the fleet.
      // The failed row already carries the reason.
      console.error(`[backups] scheduled backup for ${server.name} failed to start:`, error);
    }
  }
  return started;
}

/**
 * Fire scheduled node database backups.
 *
 * Not throttled by `concurrency`: that setting is about how many *servers* read
 * their disks at once, and there is one database backup per node — a node cannot
 * contend with itself, and the dumps within one run are already sequential.
 */
async function fireDatabaseBackups(minuteStart: Date): Promise<number> {
  const due = await listNodesDueForDatabaseBackup();
  let started = 0;

  for (const node of due) {
    if (await hasScheduledRunSince("node", node.id, minuteStart)) continue;

    try {
      await startDatabaseBackup({ nodeId: node.id, actorId: null, trigger: "scheduled" });
      started += 1;
    } catch (error) {
      console.error(
        `[backups] scheduled database backup for node ${node.name} failed to start:`,
        error,
      );
    }
  }
  return started;
}

/** Evaluate both schedules and start what is due. */
async function fireScheduled(): Promise<number> {
  const settings = await getBackupSettings();
  if (!isBackupConfigUsable(settings)) return 0;

  const now = new Date();
  // Top of the current minute, in real time — the window a duplicate would fall in.
  const minuteStart = new Date(now.getTime());
  minuteStart.setUTCSeconds(0, 0);

  let started = 0;

  if (await isDue(settings.servers.schedule, "server backup", now)) {
    started += await fireServerBackups(minuteStart, settings.servers.concurrency);
  }
  if (await isDue(settings.databases.schedule, "database backup", now)) {
    started += await fireDatabaseBackups(minuteStart);
  }

  if (started > 0) {
    console.log(`[backups] schedule fired: started ${started} run(s)`);
  }
  return started;
}

/**
 * The live interval, held on `globalThis` rather than in a module-level binding.
 *
 * This is about dev-mode hot reloading, and it is worth the ugliness. The
 * scheduler is started once from `instrumentation.ts`, which Next.js runs at boot
 * and never re-runs. When this module is then hot-replaced, a module-level `timer`
 * would be `null` in the new instance while the *old* instance's interval kept
 * firing — still executing the previous version of the code, against whatever
 * schema and tables that version knew about. The symptom is a tick failing on a
 * table a migration has since renamed, from a stack frame in a file that no longer
 * exists, which is a genuinely baffling thing to debug.
 *
 * A global handle makes a reload *replace* the timer instead of racing it: the
 * fresh module sees the old one, clears it, and installs its own.
 */
const TIMER_KEY = "__citadelBackupSchedulerTimer";

type TimerHolder = {
  [TIMER_KEY]?: ReturnType<typeof setInterval> | null;
};

const holder = globalThis as unknown as TimerHolder;

let tickInFlight = false;

/**
 * Start the scheduler, replacing any interval a previous module instance left
 * running.
 *
 * Overlapping ticks are skipped rather than queued — the same reasoning as the
 * abuse watcher: a slow node would otherwise cause ticks to pile up and hammer
 * every agent. Skipping is safe because nothing here is a deadline; a schedule
 * missed by one tick fires on the next.
 */
export function startBackupScheduler(): void {
  // Clear rather than bail out. Bailing would leave a stale interval from a
  // hot-replaced module as the only one running.
  if (holder[TIMER_KEY]) {
    clearInterval(holder[TIMER_KEY]!);
    holder[TIMER_KEY] = null;
  }

  holder[TIMER_KEY] = setInterval(async () => {
    if (tickInFlight) {
      console.warn("[backups] previous tick still running, skipping this one");
      return;
    }

    tickInFlight = true;
    try {
      // Reconcile before firing: a run that has just finished must be closed out
      // before its subject is considered for a new one.
      await reconcileAll();
      await fireScheduled();
    } catch (error) {
      console.error("[backups] tick failed:", error);
    } finally {
      tickInFlight = false;
    }
  }, TICK_MS);

  console.log(`[backups] scheduler started, ticking every ${TICK_MS / 1000}s`);
}

export function stopBackupScheduler(): void {
  if (!holder[TIMER_KEY]) return;
  clearInterval(holder[TIMER_KEY]!);
  holder[TIMER_KEY] = null;
  console.log("[backups] scheduler stopped");
}

/**
 * Run one tick immediately.
 *
 * Exposed so a route can force reconciliation after starting a run, which is what
 * makes a manual backup show real progress within a second or two instead of
 * waiting out the tick interval.
 */
export async function runBackupTick(): Promise<{ reconciled: number; started: number }> {
  const reconciled = await reconcileAll();
  const started = await fireScheduled();
  return { reconciled, started };
}
