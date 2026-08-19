/**
 * The async job registry behind every backup and restore.
 *
 * A backup of a 30 GB world takes minutes to hours. Doing that inside the
 * request that asked for it would mean a panel HTTP call held open for the whole
 * run — which fails on the first proxy idle timeout, cannot report progress, and
 * loses everything if either side reconnects. So the route starts a job, returns
 * its id immediately, and the panel polls.
 *
 * State lives in memory on the agent, not on disk, and that is deliberate: the
 * agent is stateless by design (see `servers.ts`), and the panel is the system's
 * durable record — it has a `server_backups` row before it ever calls here. An
 * agent restart therefore loses in-flight job *progress*, not the knowledge that
 * a backup was running; the panel reconciles a job that vanished into a failed
 * backup with a clear reason.
 *
 * Log lines are the other half of the contract. Each job holds an append-only,
 * sequence-numbered buffer, and the panel drains it incrementally with
 * `?afterSeq=`. Sequence numbers rather than timestamps because two lines
 * written in the same millisecond must still have a stable order, and because
 * they make the drain idempotent — a panel that retries a poll re-reads the same
 * window instead of skipping lines.
 */

import { randomUUID } from "node:crypto";
import { config } from "../config";
import { notFound } from "../http";

export type JobKind = "backup" | "restore";

export type JobStatus = "running" | "succeeded" | "failed";

/**
 * Coarse stage of a job, for a UI that wants to say what is happening rather
 * than only how far along it is. `percent` only moves during `uploading`, so the
 * phase is what distinguishes "stuck at 0%" from "dumping a large database".
 */
export type JobPhase =
  | "starting"
  | "dumping_databases"
  | "preparing_repository"
  | "uploading"
  | "restoring_files"
  | "importing_databases"
  | "applying_retention"
  | "finished";

export type JobLogLevel = "info" | "warn" | "error";

export interface JobLogLine {
  seq: number;
  level: JobLogLevel;
  message: string;
  at: string;
}

/** The totals a completed backup reports back to the panel. */
export interface JobResult {
  /** restic snapshot id, for a backup. */
  snapshotId?: string;
  /** Bytes read from disk. */
  bytesProcessed?: number;
  /** Bytes actually uploaded after dedup and compression. */
  bytesAdded?: number;
  /** Databases included in this snapshot, by name. */
  databases?: string[];
}

interface Job {
  id: string;
  serverId: string;
  kind: JobKind;
  status: JobStatus;
  phase: JobPhase;
  percent: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: JobResult;
  logs: JobLogLine[];
  nextSeq: number;
  /** Lines dropped to stay under the retention cap, reported once. */
  droppedLines: number;
}

/** A job's state as the panel reads it. */
export interface JobSnapshot {
  id: string;
  serverId: string;
  kind: JobKind;
  status: JobStatus;
  phase: JobPhase;
  percent: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: JobResult;
  /** Log lines after the requested sequence number, oldest first. */
  logs: JobLogLine[];
  /** Highest sequence number assigned so far, for the next poll's cursor. */
  latestSeq: number;
  droppedLines: number;
}

const jobs = new Map<string, Job>();

/**
 * How long a finished job's state is kept so the panel can read its outcome.
 *
 * The panel polls every few seconds, so an hour is orders of magnitude more than
 * it needs — the window exists so a panel that was restarted mid-backup can
 * still find out how the job ended rather than reporting a false failure.
 */
const FINISHED_TTL_MS = 60 * 60_000;

/** Handle a running job uses to report what it is doing. */
export interface JobReporter {
  log(message: string, level?: JobLogLevel): void;
  phase(phase: JobPhase): void;
  progress(percent: number): void;
}

/**
 * Start a job and return its id immediately.
 *
 * `work` runs detached. Its rejection is captured onto the job rather than
 * escaping: an unhandled rejection from a fire-and-forget promise would take
 * down the agent process, and the whole point of this registry is that a failed
 * backup is a reportable state, not a crash.
 */
export function startJob(
  serverId: string,
  kind: JobKind,
  work: (reporter: JobReporter) => Promise<JobResult | void>,
): string {
  pruneFinishedJobs();

  const job: Job = {
    id: randomUUID(),
    serverId,
    kind,
    status: "running",
    phase: "starting",
    percent: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: {},
    logs: [],
    nextSeq: 1,
    droppedLines: 0,
  };
  jobs.set(job.id, job);

  const reporter: JobReporter = {
    log: (message, level = "info") => appendLog(job, message, level),
    phase: (phase) => {
      job.phase = phase;
    },
    progress: (percent) => {
      job.percent = Math.max(0, Math.min(100, Math.round(percent)));
    },
  };

  void (async () => {
    try {
      const result = (await work(reporter)) ?? {};
      job.result = result;
      job.status = "succeeded";
      job.phase = "finished";
      job.percent = 100;
      appendLog(job, `${labelFor(kind)} completed.`, "info");
    } catch (error) {
      job.status = "failed";
      job.phase = "finished";
      job.error = error instanceof Error ? error.message : String(error);
      appendLog(job, `${labelFor(kind)} failed: ${job.error}`, "error");
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return job.id;
}

/**
 * Read a job's state, returning only log lines after `afterSeq`.
 *
 * Throws 404 for an unknown id, which the panel reads as "this job is gone" —
 * either it never existed or the agent restarted — and turns into a failed
 * backup with that reason rather than polling forever.
 */
export function readJob(jobId: string, afterSeq = 0): JobSnapshot {
  const job = jobs.get(jobId);
  if (!job) {
    throw notFound(
      "No such backup job on this node. It either finished long enough ago to " +
        "be forgotten, or the agent restarted while it was running.",
    );
  }

  return {
    id: job.id,
    serverId: job.serverId,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
    error: job.error,
    result: job.result,
    logs: job.logs.filter((line) => line.seq > afterSeq),
    latestSeq: job.nextSeq - 1,
    droppedLines: job.droppedLines,
  };
}

/**
 * Whether this server already has a job in flight.
 *
 * Backups and restores for one server must not overlap: two restics writing to
 * one repository contend on its lock, and a restore racing a backup would
 * snapshot a half-restored world. Checked per server rather than globally so a
 * busy node can still back up its other servers.
 */
export function hasRunningJob(serverId: string): boolean {
  for (const job of jobs.values()) {
    if (job.serverId === serverId && job.status === "running") return true;
  }
  return false;
}

/**
 * Append a log line, dropping the oldest when the cap is reached.
 *
 * Oldest-first eviction rather than refusing new lines: the end of a failed
 * job's log is where the error is, and that is the part an operator needs. The
 * drop count travels to the panel so a truncated log says so.
 */
function appendLog(job: Job, message: string, level: JobLogLevel): void {
  job.logs.push({
    seq: job.nextSeq,
    level,
    // A single restic error can carry a whole stack of S3 detail; keep it
    // readable and keep one line from dominating the buffer.
    message: message.slice(0, 2000),
    at: new Date().toISOString(),
  });
  job.nextSeq += 1;

  const overflow = job.logs.length - config.maxBackupLogLines;
  if (overflow > 0) {
    job.logs.splice(0, overflow);
    job.droppedLines += overflow;
  }
}

/** Forget jobs that finished long enough ago that nobody is waiting on them. */
function pruneFinishedJobs(): void {
  const cutoff = Date.now() - FINISHED_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && job.finishedAt < cutoff) jobs.delete(id);
  }
}

function labelFor(kind: JobKind): string {
  return kind === "backup" ? "Backup" : "Restore";
}

/** Exposed for tests: drop all job state. */
export function resetJobs(): void {
  jobs.clear();
}
