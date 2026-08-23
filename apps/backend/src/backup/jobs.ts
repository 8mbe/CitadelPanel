/**
 * The async job registry behind every backup and restore.
 *
 * A backup of a 30 GB world takes minutes to hours. Doing that inside the
 * request that asked for it would mean a panel HTTP call held open for the whole
 * run. That fails on the first proxy idle timeout, cannot report progress, and
 * loses everything if either side reconnects. So the route starts a job, returns
 * its id immediately, and the panel polls.
 *
 * State lives in memory on the agent, not on disk, and that is deliberate: the
 * agent is stateless by design (see `servers.ts`), and the panel is the system's
 * durable record, and it has a `backup_runs` row before it ever calls here. An agent
 * restart therefore loses in-flight job *progress*, not the knowledge that a
 * backup was running; the panel reconciles a job that vanished into a failed
 * backup with a clear reason.
 *
 * Log lines are the other half of the contract. Each job holds an append-only,
 * sequence-numbered buffer, and the panel drains it incrementally with
 * `?afterSeq=`. Sequence numbers rather than timestamps because two lines
 * written in the same millisecond must still have a stable order, and because
 * they make the drain idempotent. A panel that retries a poll re-reads the same
 * window instead of skipping lines.
 *
 * Jobs are keyed by an opaque **subject** string (`server:<uuid>` or
 * `node:databases`) rather than a server id, because the two backup scopes are
 * different kinds of thing that need the same mutual exclusion: two restics on
 * one repository contend on its lock, and a node database backup must not run
 * twice at once either. A single string keeps `hasRunningJob` scope-agnostic
 * without the registry having to know what a server or a node is.
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
  | "preparing_repository"
  /** Deleting the oldest snapshots so the quota holds once one more is written. */
  | "enforcing_limit"
  | "dumping_databases"
  | "uploading"
  | "restoring_files"
  | "importing_databases"
  /** Measuring the repository so the panel can report storage use. */
  | "measuring"
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
  /** Databases included in this snapshot (node scope), by name. */
  databases?: string[];
  /** Databases that could not be dumped or restored, with the reason. */
  failedDatabases?: { name: string; error: string }[];
  /**
   * Snapshot ids deleted to keep the quota, so the panel can drop the matching
   * rows. The panel cannot infer these, since it would have to re-list the
   * repository and diff, so the job that did the deleting reports them.
   */
  forgotten?: string[];
  /**
   * Deduplicated bytes this repository occupies after the run.
   *
   * Measured here rather than polled separately: the index is already in the
   * local cache immediately after a backup, so it costs a metadata pass. Null
   * when the measurement failed, which is deliberately distinct from zero.
   */
  repoSizeBytes?: number | null;
}

interface Job {
  id: string;
  subject: string;
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
  subject: string;
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
 * it needs. The window exists so a panel that was restarted mid-backup can
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
  subject: string,
  kind: JobKind,
  work: (reporter: JobReporter) => Promise<JobResult | void>,
): string {
  pruneFinishedJobs();

  const job: Job = {
    id: randomUUID(),
    subject,
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
 * Throws 404 for an unknown id, which the panel reads as "this job is gone",
 * meaning it never existed or the agent restarted. That turns into a failed
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
    subject: job.subject,
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
 * Whether this subject already has a job in flight.
 *
 * Backups and restores for one subject must not overlap: two restics writing to
 * one repository contend on its lock, and a restore racing a backup would
 * snapshot half-restored data. Checked per subject rather than globally, so a
 * node backing up its databases can still back up its servers' files, and a busy
 * server does not block its neighbours.
 */
export function hasRunningJob(subject: string): boolean {
  for (const job of jobs.values()) {
    if (job.subject === subject && job.status === "running") return true;
  }
  return false;
}

/** The registry key for one server's file backups. */
export function serverSubject(serverId: string): string {
  return `server:${serverId}`;
}

/**
 * The registry key for this node's database backups.
 *
 * Constant, not per-node: an agent only ever serves the one node it runs on, so
 * there is exactly one database-backup subject per agent process.
 */
export const NODE_DATABASES_SUBJECT = "node:databases";

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
