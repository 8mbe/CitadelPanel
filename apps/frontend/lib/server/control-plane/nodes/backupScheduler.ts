/**
 * The backup scheduler: one timer, two jobs.
 *
 *   1. **Reconcile.** Poll every in-flight run's agent job, drain its new log
 *      lines into Postgres, and record its outcome. The agent cannot call in —
 *      it has no panel credential and may be behind NAT — so the panel polls,
 *      the same way `security/watcher.ts` polls for stats.
 *
 *   2. **Fire.** Evaluate the operator's cron expression and start backups for
 *      the servers that are due.
 *
 * Reconciliation is what makes the whole feature durable. The agent's job state
 * is in memory; the panel's row is on disk. Every tick moves information from
 * the former to the latter, so the worst an agent restart costs is the progress
 * percentage of one run — and a job that has disappeared becomes a failed backup
 * with that stated as the reason, rather than a row stuck at "running" forever.
 *
 * One timer rather than two because the two must not race: firing a new backup
 * for a server whose previous run has not been reconciled yet would start a
 * second restic against one repository. Doing both in sequence on one tick makes
 * that impossible without a lock.
 */

import {
  getBackupSettings,
  getTimezone,
  isBackupConfigUsable,
} from "../services/settings";
import {
  appendLog,
  completeBackup,
  failBackup,
  hasScheduledBackupSince,
  listActiveBackups,
  listServersDueForBackup,
  markRepositoryInitialized,
  startBackup,
  updateBackupProgress,
} from "../services/backupManager";
import { readNodeBackupJob } from "./nodeBackupApi";
import { cronMatches, parseCron } from "@/lib/cron";

/**
 * How often the scheduler ticks.
 *
 * Must be well under a minute so a cron expression that names a specific minute
 * is not missed, and long enough that polling in-flight jobs is not a load on the
 * agents. 30 seconds gives every minute at least one evaluation.
 */
const TICK_MS = 30_000;

/**
 * How long a run may sit with no job id before it is declared failed.
 *
 * A `pending` row with no job id means the panel died between writing the row and
 * calling the agent. Nothing will ever advance it, so it must not stay pending —
 * a stuck row blocks every later backup of that server through the
 * already-running check.
 */
const PENDING_GRACE_MS = 5 * 60_000;

/**
 * How long a running job may go unreconciled before it is declared failed.
 *
 * Only reached when the node is unreachable for the whole window: a reachable
 * agent either reports the job or 404s it, and both are handled immediately. Six
 * hours matches the agent's own backup timeout, so the panel never gives up on a
 * job the node might still be working on.
 */
const STALE_RUNNING_MS = 6 * 60 * 60_000 + 30 * 60_000;

/** Map an agent phase onto the wording the UI shows. */
const PHASE_LABELS: Record<string, string> = {
  starting: "starting",
  dumping_databases: "dumping_databases",
  preparing_repository: "preparing_repository",
  uploading: "uploading",
  restoring_files: "restoring_files",
  importing_databases: "importing_databases",
  applying_retention: "applying_retention",
  finished: "finished",
};

/**
 * Poll one run's agent job and write what it says into the panel's row.
 *
 * Every failure mode here is turned into a *recorded* outcome rather than an
 * exception, because the caller is a timer with nobody to report to:
 *   - the job is gone (404)      -> failed, with the agent's own explanation;
 *   - the node is unreachable    -> left alone until the stale window expires,
 *                                   since a node rebooting mid-backup is normal
 *                                   and the restic container survives it.
 */
async function reconcileOne(run: {
  id: string;
  serverId: string;
  nodeId: string | null;
  jobId: string | null;
  logCursor: number;
  createdAt: Date;
}): Promise<void> {
  const age = Date.now() - run.createdAt.getTime();

  if (!run.jobId) {
    if (age > PENDING_GRACE_MS) {
      await failBackup(
        run.id,
        "The panel never received a job id for this run — it most likely restarted " +
          "between recording the request and reaching the node. Start a new backup.",
      );
    }
    return;
  }
  if (!run.nodeId) {
    await failBackup(
      run.id,
      "This run's node has been removed from the panel, so its progress can no " +
        "longer be followed.",
    );
    return;
  }

  let job;
  try {
    job = await readNodeBackupJob(run.nodeId, run.serverId, run.jobId, run.logCursor);
  } catch (error) {
    const status = (error as { status?: number }).status;

    // 404: the agent does not know this job. Either it restarted (losing its
    // in-memory registry) or the job aged out of it. Neither can be recovered
    // from, so the run is failed with that said plainly.
    if (status === 404) {
      await failBackup(
        run.id,
        "The node is no longer tracking this run. The agent was most likely " +
          "restarted while it was in progress. Any partial upload is unreferenced " +
          "and will be reclaimed by the next prune; start a new backup.",
      );
      return;
    }

    // Anything else is a transport problem. Wait it out — a node rebooting does
    // not stop the restic container it started.
    if (age > STALE_RUNNING_MS) {
      await failBackup(
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
    // Only mentioned once per drain rather than per line, and not as an error:
    // a truncated log is a very long log, not a failure.
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
    await updateBackupProgress(
      run.id,
      PHASE_LABELS[job.phase] ?? job.phase,
      job.percent,
      cursor,
    );
    return;
  }

  if (job.status === "succeeded") {
    await completeBackup(run.id, job.result, cursor);
    // A successful run proves the repository exists, which is also true for the
    // very first backup a server ever takes.
    await markRepositoryInitialized(run.serverId);
    return;
  }

  await failBackup(run.id, job.error ?? "The node reported the run as failed without a reason.");
}

/** Poll every in-flight run. One run's failure must not stop the others. */
async function reconcileAll(): Promise<number> {
  const active = await listActiveBackups();

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
 * Fire scheduled backups for servers that are due.
 *
 * The double-fire guard is a time window rather than a stored "last run at"
 * marker: the tick interval is shorter than a minute, so the same due minute is
 * evaluated more than once, and a marker would have to be written transactionally
 * with the backup to be trustworthy. Asking "has a scheduled run started for this
 * server since the top of this minute?" needs no extra state and survives a panel
 * restart mid-minute.
 *
 * `concurrency` caps how many servers start per tick. Every concurrent backup is
 * a restic reading a disk and saturating a node's upstream, so on a fleet of a
 * hundred servers the schedule deliberately trickles rather than stampedes.
 */
async function fireScheduled(): Promise<number> {
  const settings = await getBackupSettings();
  if (!isBackupConfigUsable(settings) || settings.schedule.trim().length === 0) return 0;

  let expression;
  try {
    expression = parseCron(settings.schedule);
  } catch (error) {
    // A schedule that no longer parses is an operator error the settings form
    // would have caught; log once per tick rather than silently never running.
    console.error(
      `[backups] the configured schedule "${settings.schedule}" is not valid:`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }

  const timezone = await getTimezone();
  const now = new Date();
  if (!cronMatches(expression, now, timezone)) return 0;

  // Top of the current minute, in real time — the window a duplicate would fall in.
  const minuteStart = new Date(now.getTime());
  minuteStart.setUTCSeconds(0, 0);

  const due = await listServersDueForBackup();
  let started = 0;

  for (const server of due) {
    if (started >= Math.max(1, settings.concurrency)) break;
    if (await hasScheduledBackupSince(server.id, minuteStart)) continue;

    try {
      await startBackup({ serverId: server.id, actorId: null, trigger: "scheduled" });
      started += 1;
    } catch (error) {
      // A single server's failure (an unreachable node, a suspended server that
      // changed state mid-sweep) must not stop the rest of the fleet. The failed
      // row already carries the reason.
      console.error(`[backups] scheduled backup for ${server.name} failed to start:`, error);
    }
  }

  if (started > 0) {
    console.log(`[backups] schedule fired: started ${started} backup(s)`);
  }
  return started;
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Start the scheduler.
 *
 * Overlapping ticks are skipped rather than queued — the same reasoning as the
 * abuse watcher: a slow node would otherwise cause ticks to pile up and hammer
 * every agent. Skipping is safe because nothing here is a deadline; a schedule
 * missed by one tick fires on the next.
 */
export function startBackupScheduler(): void {
  if (timer) return;

  timer = setInterval(async () => {
    if (tickInFlight) {
      console.warn("[backups] previous tick still running, skipping this one");
      return;
    }

    tickInFlight = true;
    try {
      // Reconcile before firing: a run that has just finished must be closed out
      // before its server is considered for a new one.
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
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("[backups] scheduler stopped");
}

/**
 * Run one tick immediately.
 *
 * Exposed so a route can force reconciliation after starting a run, which is
 * what makes a manual backup show real progress within a second or two instead
 * of waiting out the tick interval.
 */
export async function runBackupTick(): Promise<{ reconciled: number; started: number }> {
  const reconciled = await reconcileAll();
  const started = await fireScheduled();
  return { reconciled, started };
}
