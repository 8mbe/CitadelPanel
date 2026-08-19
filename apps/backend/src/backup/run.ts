/**
 * Backup and restore orchestration, for both scopes.
 *
 * This is the side-effecting half of the backup engine: it sequences the pure
 * argv builders in `restic.ts`, the dump containers in `dumps.ts`, and the job
 * registry in `jobs.ts` into the operations the panel asks for.
 *
 *   - `startServerBackup`   — a server's data directory. Owner-triggered.
 *   - `startDatabaseBackup` — every database on this node. Admin-triggered.
 *
 * ## The quota is enforced before the new snapshot, not after
 *
 * Both scopes are capped at a plain snapshot count. That cap is applied as the
 * job's *first* real phase — list the snapshots, delete the oldest ones that have
 * to go, and only then write the new one. Three reasons, in order of how much
 * they matter:
 *
 *   1. The limit is never briefly exceeded, so an operator near their storage
 *      ceiling frees space before asking for more rather than after.
 *   2. It is what "a new backup replaces the oldest" actually means.
 *   3. It happens inside the async job, so the request that started the backup
 *      stays fast — a `forget --prune` rewrites pack files and is not something
 *      to do inside an HTTP handler.
 *
 * The job reports which snapshot ids it deleted, because the panel cannot infer
 * them without re-listing and diffing the repository. That report is what keeps
 * the panel's rows and the bucket's contents in step.
 */

import { config } from "../config";
import { serverDataPath } from "../paths";
import { ensureServerDataDir } from "../dataRoot";
import {
  clearNodeStagingDir,
  dumpNodeDatabases,
  ensureNodeStagingDir,
  importNodeDatabases,
  type DbAdminCredential,
} from "./dumps";
import {
  backupArgs,
  CACHE_MOUNT,
  DATA_MOUNT,
  DUMPS_MOUNT,
  explainResticFailure,
  forgetSnapshotsArgs,
  initArgs,
  looksUninitialised,
  parseRepositorySize,
  parseResticOutput,
  parseSnapshots,
  probeArgs,
  repositoryEnv,
  restoreArgs,
  snapshotsArgs,
  snapshotsToForget,
  statsArgs,
  type RepoTarget,
  type SnapshotInfo,
} from "./restic";
import {
  NODE_DATABASES_SUBJECT,
  serverSubject,
  startJob,
  type JobReporter,
  type JobResult,
} from "./jobs";
import { runToolContainer, type ToolMount } from "./toolContainer";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** What the panel sends to back up a server's files. */
export interface ServerBackupRequest {
  repo: RepoTarget;
  /** Most snapshots to keep. 0 = unlimited. */
  keepMax: number;
  /** Recorded as a restic tag: "manual" or "scheduled". */
  reason: string;
  /** Data-directory-relative glob patterns to leave out. Admin-configured. */
  exclude: string[];
}

/** What the panel sends to restore a server's files. */
export interface ServerRestoreRequest {
  repo: RepoTarget;
  snapshotId: string;
}

/** What the panel sends to back up this node's databases. */
export interface DatabaseBackupRequest {
  repo: RepoTarget;
  /** Database names to dump. The panel knows which ones it provisioned. */
  databases: string[];
  admin: DbAdminCredential;
  keepMax: number;
  reason: string;
}

/** What the panel sends to restore this node's databases. */
export interface DatabaseRestoreRequest {
  repo: RepoTarget;
  snapshotId: string;
  /** Which databases to import from the snapshot. */
  databases: string[];
  admin: DbAdminCredential;
}

/** Ceilings on a single restic invocation. */
const LONG_TIMEOUT_MS = 6 * 60 * 60_000;
const QUICK_TIMEOUT_MS = 5 * 60_000;

/**
 * restic's chunk cache, kept per repository between runs.
 *
 * Without a persistent cache every incremental backup re-downloads the
 * repository index from S3 before it can decide what changed — which is both slow
 * and a real per-request bill. The cache holds no plaintext tenant data
 * (repository contents are encrypted), so it sits beside the staging area rather
 * than needing separate protection.
 */
function cachePath(target: RepoTarget): string {
  return join(config.backupStagingRoot, ".cache", target.scope, target.id);
}

/**
 * The mounts a restic invocation needs for a given scope.
 *
 * A server repository sees only the data directory; a node database repository
 * sees only the dump staging directory. Neither is given the other's, which is
 * what stops a server backup from ever containing another tenant's data.
 *
 * The data mount is read-only for everything except a restore — a backup has no
 * business being able to write into the world it is reading.
 */
async function mountsFor(
  target: RepoTarget,
  options: { writable?: boolean },
): Promise<ToolMount[]> {
  const cacheDir = cachePath(target);
  await mkdir(cacheDir, { recursive: true });
  const mounts: ToolMount[] = [{ hostPath: cacheDir, containerPath: CACHE_MOUNT }];

  if (target.scope === "server") {
    mounts.push({
      hostPath: serverDataPath(target.id),
      containerPath: DATA_MOUNT,
      readOnly: options.writable !== true,
    });
  } else {
    mounts.push({
      hostPath: await ensureNodeStagingDir(),
      containerPath: DUMPS_MOUNT,
      readOnly: options.writable !== true,
    });
  }
  return mounts;
}

/** Run one restic invocation against a repository. */
async function runRestic(
  target: RepoTarget,
  args: string[],
  options: {
    timeoutMs: number;
    writable?: boolean;
    onProgress?: (output: string) => void;
  },
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return runToolContainer({
    image: config.resticImage,
    // The restic image's entrypoint is already `restic`, so the command is just
    // the subcommand and its flags.
    command: args,
    env: repositoryEnv(target),
    mounts: await mountsFor(target, { writable: options.writable }),
    timeoutMs: options.timeoutMs,
    onProgress: options.onProgress,
  });
}

/**
 * Make sure the repository exists, creating it on first use.
 *
 * Probe-then-init rather than "init and ignore the already-exists error": an init
 * that fails for any *other* reason (bad credentials, unreachable endpoint) must
 * not be mistaken for a repository that was already there, because the next step
 * would then fail with a far less useful message.
 */
async function ensureRepository(
  target: RepoTarget,
  reporter: JobReporter,
): Promise<void> {
  reporter.phase("preparing_repository");

  const probe = await runRestic(target, probeArgs(), { timeoutMs: QUICK_TIMEOUT_MS });
  if (probe.exitCode === 0) return;

  if (!looksUninitialised(probe.output)) {
    throw new Error(explainResticFailure(probe.exitCode, probe.output));
  }

  reporter.log("No repository in S3 for this yet — creating one.");
  const init = await runRestic(target, initArgs(), { timeoutMs: QUICK_TIMEOUT_MS });
  if (init.exitCode !== 0) {
    throw new Error(explainResticFailure(init.exitCode, init.output));
  }
  reporter.log("Repository created, encrypted with its own key.");
}

/** List a repository's snapshots. An uninitialised repository has none. */
async function readSnapshots(target: RepoTarget): Promise<SnapshotInfo[]> {
  const result = await runRestic(target, snapshotsArgs(), { timeoutMs: QUICK_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    if (looksUninitialised(result.output)) return [];
    throw new Error(explainResticFailure(result.exitCode, result.output));
  }
  return parseSnapshots(result.output);
}

/**
 * Delete the oldest snapshots so `keepMax` still holds after one more is written.
 *
 * Returns the ids actually removed. Failure here **does** fail the run, unlike
 * most housekeeping: the entire point of the quota is that storage does not grow
 * without bound, so quietly writing snapshot six when the limit is five would
 * defeat it. Better to refuse the backup and say the old one could not be removed.
 */
async function enforceLimit(
  target: RepoTarget,
  keepMax: number,
  reporter: JobReporter,
): Promise<string[]> {
  if (keepMax <= 0) {
    reporter.log("No snapshot limit configured — every backup is kept.");
    return [];
  }

  reporter.phase("enforcing_limit");
  const existing = await readSnapshots(target);
  const doomed = snapshotsToForget(existing, keepMax);

  if (doomed.length === 0) {
    reporter.log(
      `${existing.length} of ${keepMax} snapshots kept — room for this one without ` +
        `removing any.`,
    );
    return [];
  }

  reporter.log(
    `At the ${keepMax}-snapshot limit. Removing the oldest ` +
      `${doomed.length === 1 ? "backup" : `${doomed.length} backups`} ` +
      `(${doomed.map((s) => s.id.slice(0, 8)).join(", ")}) to make room.`,
  );

  const result = await runRestic(target, forgetSnapshotsArgs(doomed.map((s) => s.id)), {
    timeoutMs: LONG_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "Could not remove the oldest backup to stay within the limit, so this " +
        `backup was not taken. ${explainResticFailure(result.exitCode, result.output)}`,
    );
  }

  reporter.log("Oldest backup removed and its space reclaimed.");
  return doomed.map((s) => s.id);
}

/**
 * Measure the repository, for the panel's storage accounting.
 *
 * Never throws: a repository whose size could not be read is reported as unknown
 * (null), and failing a successful backup over a statistics call would be absurd.
 */
async function measureRepository(
  target: RepoTarget,
  reporter: JobReporter,
): Promise<number | null> {
  reporter.phase("measuring");
  try {
    const result = await runRestic(target, statsArgs(), { timeoutMs: QUICK_TIMEOUT_MS });
    if (result.exitCode !== 0) return null;
    const size = parseRepositorySize(result.output);
    if (size !== null) {
      reporter.log(`This repository now occupies ${formatBytes(size)} in S3.`);
    }
    return size;
  } catch {
    return null;
  }
}

/**
 * Run `restic backup` and turn its output into a result.
 *
 * Shared by both scopes: the only differences are the paths, the tags and the
 * excludes, all of which are arguments.
 */
async function runBackup(
  target: RepoTarget,
  options: { paths: string[]; reason: string; exclude: string[] },
  reporter: JobReporter,
): Promise<{ snapshotId: string; bytesProcessed: number; bytesAdded: number }> {
  reporter.phase("uploading");
  reporter.log("Scanning for changes and uploading to S3…");

  // Progress arrives by re-parsing the container's log tail; only the newest
  // status line matters, so each poll overwrites the last reading.
  let lastPercent = -1;
  const result = await runRestic(
    target,
    backupArgs({
      scope: target.scope,
      id: target.id,
      paths: options.paths,
      reason: options.reason,
      exclude: options.exclude,
    }),
    {
      timeoutMs: LONG_TIMEOUT_MS,
      onProgress: (output) => {
        const { progress } = parseResticOutput(output);
        if (!progress) return;
        reporter.progress(progress.percent);
        // Only log on a whole-percent change, so a long backup produces a
        // readable log rather than one line per poll.
        if (progress.percent !== lastPercent) {
          lastPercent = progress.percent;
          reporter.log(
            `${progress.percent}% — ${formatBytes(progress.bytesDone)} read` +
              (progress.secondsRemaining !== null
                ? `, ~${formatDuration(progress.secondsRemaining)} remaining`
                : ""),
          );
        }
      },
    },
  );

  if (result.timedOut) {
    throw new Error(
      `The backup exceeded the ${formatDuration(LONG_TIMEOUT_MS / 1000)} limit and ` +
        `was stopped. The partial upload is not a snapshot and costs nothing beyond ` +
        `storage restic will reclaim on the next prune.`,
    );
  }

  const parsed = parseResticOutput(result.output);

  // Exit code 3 means "completed, but some files could not be read" — a snapshot
  // exists and is usable, so this is a warning, not a failure.
  if (result.exitCode !== 0 && result.exitCode !== 3) {
    throw new Error(explainResticFailure(result.exitCode, result.output));
  }
  for (const error of parsed.errors.slice(0, 20)) {
    reporter.log(`Could not read: ${error}`, "warn");
  }
  if (result.exitCode === 3) {
    reporter.log(
      "Some files could not be read and were skipped. The snapshot is usable; the " +
        "skipped paths are listed above.",
      "warn",
    );
  }

  if (!parsed.summary) {
    throw new Error(
      "restic finished without reporting a summary, so the snapshot could not be " +
        `identified. Output: ${result.output.trim().slice(-800)}`,
    );
  }

  reporter.log(
    `Snapshot ${parsed.summary.snapshotId.slice(0, 8)} written: ` +
      `${formatBytes(parsed.summary.bytesProcessed)} read, ` +
      `${formatBytes(parsed.summary.bytesAdded)} newly uploaded after deduplication ` +
      `and compression.`,
  );

  return {
    snapshotId: parsed.summary.snapshotId,
    bytesProcessed: parsed.summary.bytesProcessed,
    bytesAdded: parsed.summary.bytesAdded,
  };
}

// --- Server files ----------------------------------------------------------------

/**
 * Start a backup of a server's data directory and return the job id.
 *
 * Files only. A server's databases live on a MariaDB instance shared with every
 * other server on the node, and reading them all needs a root-equivalent
 * credential — so they are backed up at node scope by an administrator instead
 * (`startDatabaseBackup`).
 */
export function startServerBackup(serverId: string, request: ServerBackupRequest): string {
  return startJob(serverSubject(serverId), "backup", async (reporter): Promise<JobResult> => {
    // The data directory may legitimately not exist yet for a server that was
    // created but never installed; an empty snapshot is a better outcome than a
    // failure the owner has to interpret.
    await ensureServerDataDir(serverId);

    await ensureRepository(request.repo, reporter);
    const forgotten = await enforceLimit(request.repo, request.keepMax, reporter);

    const summary = await runBackup(
      request.repo,
      { paths: [DATA_MOUNT], reason: request.reason, exclude: request.exclude },
      reporter,
    );

    const repoSizeBytes = await measureRepository(request.repo, reporter);

    reporter.phase("finished");
    return { ...summary, forgotten, repoSizeBytes };
  });
}

/**
 * Start a restore of a server's files and return the job id.
 *
 * The panel stops the server before calling and starts it again afterwards: it
 * owns the container lifecycle and the status the owner sees. The agent refuses
 * nothing on that basis — it has no way to know whether a stop is in flight.
 */
export function startServerRestore(
  serverId: string,
  request: ServerRestoreRequest,
): string {
  return startJob(serverSubject(serverId), "restore", async (reporter): Promise<JobResult> => {
    await ensureServerDataDir(serverId);

    reporter.phase("restoring_files");
    reporter.log(`Restoring snapshot ${request.snapshotId.slice(0, 8)} from S3…`);

    let lastPercent = -1;
    const result = await runRestic(request.repo, restoreArgs(request.snapshotId), {
      timeoutMs: LONG_TIMEOUT_MS,
      // The one case where restic must be able to write into the data directory.
      writable: true,
      onProgress: (output) => {
        const { progress } = parseResticOutput(output);
        if (!progress) return;
        reporter.progress(progress.percent);
        if (progress.percent !== lastPercent) {
          lastPercent = progress.percent;
          reporter.log(`${progress.percent}% — ${formatBytes(progress.bytesDone)} written`);
        }
      },
    });

    if (result.timedOut) {
      throw new Error(
        "The restore exceeded its time limit and was stopped. The server's data " +
          "directory is partially restored — retry before starting the server.",
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(explainResticFailure(result.exitCode, result.output));
    }

    reporter.log("Files restored.");
    reporter.phase("finished");
    return { snapshotId: request.snapshotId };
  });
}

// --- Node databases ----------------------------------------------------------------

/**
 * Start a backup of every database on this node and return the job id.
 *
 * Dumps run before the snapshot, and the staging directory is wiped afterwards —
 * plaintext SQL for every tenant on the node is not something to leave on disk
 * between backups.
 *
 * A run with zero successful dumps still fails rather than writing an empty
 * snapshot: an admin who is told "backup complete" when nothing was captured has
 * been actively misled.
 */
export function startDatabaseBackup(request: DatabaseBackupRequest): string {
  return startJob(NODE_DATABASES_SUBJECT, "backup", async (reporter): Promise<JobResult> => {
    reporter.phase("dumping_databases");
    reporter.log(
      `Dumping ${request.databases.length} database` +
        `${request.databases.length === 1 ? "" : "s"} on this node.`,
    );

    const { dumped, failed } = await dumpNodeDatabases(
      request.databases,
      request.admin,
      (message, level) => reporter.log(message, level),
    );

    try {
      if (dumped.length === 0) {
        throw new Error(
          request.databases.length === 0
            ? "This node has no provisioned databases, so there was nothing to back up."
            : `None of the ${request.databases.length} databases on this node could be ` +
              `dumped, so no snapshot was written. See the log for each failure.`,
        );
      }

      await ensureRepository(request.repo, reporter);
      const forgotten = await enforceLimit(request.repo, request.keepMax, reporter);

      const summary = await runBackup(
        request.repo,
        // No excludes: the staging directory contains exactly the dumps we just
        // wrote, and the admin's exclude list is about *server files*.
        { paths: [DUMPS_MOUNT], reason: request.reason, exclude: [] },
        reporter,
      );

      const repoSizeBytes = await measureRepository(request.repo, reporter);

      if (failed.length > 0) {
        reporter.log(
          `${failed.length} database${failed.length === 1 ? "" : "s"} could not be ` +
            `dumped and ${failed.length === 1 ? "is" : "are"} missing from this ` +
            `snapshot: ${failed.map((f) => f.name).join(", ")}.`,
          "warn",
        );
      }

      reporter.phase("finished");
      return {
        ...summary,
        databases: dumped.map((dump) => dump.name),
        failedDatabases: failed,
        forgotten,
        repoSizeBytes,
      };
    } finally {
      // Always, including on failure: a failed run must not leave every tenant's
      // data lying in plaintext on the node's disk.
      await clearNodeStagingDir();
    }
  });
}

/**
 * Start a restore of this node's databases and return the job id.
 *
 * Restores the dumps out of the snapshot, then imports each one with
 * `CREATE DATABASE IF NOT EXISTS` first — because the reason to run this is
 * usually that the databases are gone. The panel re-provisions the scoped users
 * and grants separately from its own encrypted records.
 */
export function startDatabaseRestore(request: DatabaseRestoreRequest): string {
  return startJob(NODE_DATABASES_SUBJECT, "restore", async (reporter): Promise<JobResult> => {
    // Start from an empty staging directory so a dump from a *previous* restore
    // cannot be mistaken for one this snapshot contained.
    await clearNodeStagingDir();
    await ensureNodeStagingDir();

    try {
      reporter.phase("restoring_files");
      reporter.log(`Fetching snapshot ${request.snapshotId.slice(0, 8)} from S3…`);

      const result = await runRestic(request.repo, restoreArgs(request.snapshotId), {
        timeoutMs: LONG_TIMEOUT_MS,
        writable: true,
        onProgress: (output) => {
          const { progress } = parseResticOutput(output);
          if (progress) reporter.progress(progress.percent);
        },
      });

      if (result.timedOut) {
        throw new Error("The restore exceeded its time limit and was stopped.");
      }
      if (result.exitCode !== 0) {
        throw new Error(explainResticFailure(result.exitCode, result.output));
      }

      reporter.phase("importing_databases");
      const { restored, failed } = await importNodeDatabases(
        request.databases,
        request.admin,
        (message, level) => reporter.log(message, level),
      );

      if (restored.length === 0) {
        throw new Error(
          "No database could be restored from this snapshot. See the log for each " +
            "failure; nothing was changed for the ones that were skipped.",
        );
      }

      reporter.phase("finished");
      return {
        snapshotId: request.snapshotId,
        databases: restored,
        failedDatabases: failed,
      };
    } finally {
      await clearNodeStagingDir();
    }
  });
}

// --- Synchronous metadata operations ------------------------------------------------

/**
 * List a repository's snapshots.
 *
 * Synchronous (not a job): a metadata read against the repository index, measured
 * in seconds, and the panel wants it inside one request. It is also the
 * reconciliation source — the panel's rows are its own record, and this is the
 * ground truth they can be checked against.
 */
export async function listSnapshots(target: RepoTarget): Promise<SnapshotInfo[]> {
  return readSnapshots(target);
}

/**
 * Delete one snapshot and reclaim its unreferenced chunks.
 *
 * A missing snapshot is treated as already deleted so a retried delete succeeds.
 */
export async function deleteSnapshot(
  target: RepoTarget,
  snapshotId: string,
): Promise<void> {
  const result = await runRestic(target, forgetSnapshotsArgs([snapshotId]), {
    timeoutMs: LONG_TIMEOUT_MS,
  });

  if (result.exitCode === 0) return;
  if (looksUninitialised(result.output) || /no snapshot|not found/i.test(result.output)) {
    return;
  }
  throw new Error(explainResticFailure(result.exitCode, result.output));
}

/**
 * Measure a repository on demand, for the storage report.
 *
 * Returns null when the repository does not exist yet, which is not an error —
 * a subject that has never been backed up occupies nothing.
 */
export async function repositorySize(target: RepoTarget): Promise<number | null> {
  const result = await runRestic(target, statsArgs(), { timeoutMs: QUICK_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    if (looksUninitialised(result.output)) return 0;
    return null;
  }
  return parseRepositorySize(result.output);
}

/**
 * Check that the configured S3 target is reachable and usable from this node.
 *
 * Backs the admin settings page's "test connection" button. Deliberately probes a
 * *real* repository path rather than merely listing the bucket, because the
 * failure operators actually hit is a credential that can list but not write. An
 * uninitialised repository counts as success — it is the expected state before
 * the first backup, and initialising one as a side effect of a test would leave
 * debris in the bucket.
 */
export async function checkRepository(
  target: RepoTarget,
): Promise<{ reachable: boolean; initialised: boolean; detail: string }> {
  const result = await runRestic(target, probeArgs(), { timeoutMs: QUICK_TIMEOUT_MS });

  if (result.exitCode === 0) {
    return {
      reachable: true,
      initialised: true,
      detail: "Connected to the existing repository.",
    };
  }
  if (looksUninitialised(result.output)) {
    return {
      reachable: true,
      initialised: false,
      detail:
        "S3 is reachable and the credentials work. No repository exists here yet — " +
        "the first backup will create one.",
    };
  }
  return {
    reachable: false,
    initialised: false,
    detail: explainResticFailure(result.exitCode, result.output),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
