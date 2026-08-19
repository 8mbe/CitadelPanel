/**
 * Backup and restore orchestration.
 *
 * This is the side-effecting half of the backup engine: it sequences the pure
 * argv builders in `restic.ts`, the dump containers in `dumps.ts`, and the job
 * registry in `jobs.ts` into the two operations the panel actually asks for.
 *
 * The ordering in a backup is load-bearing. Databases are dumped *before* the
 * file walk begins, so the SQL in the snapshot and the world files in the same
 * snapshot describe one moment. Doing it the other way round — files first, then
 * a dump — captures a database that is minutes newer than the world it belongs
 * to, which is the subtle kind of restore corruption that only shows up when
 * someone notices their inventory does not match their balance.
 *
 * Retention runs last and its failure is non-fatal: a snapshot that exists but
 * was not pruned is a successful backup with a housekeeping problem, and failing
 * the whole run would be reporting a lie.
 */

import { config } from "../config";
import { serverDataPath } from "../paths";
import { ensureServerDataDir } from "../dataRoot";
import {
  clearStagingDir,
  dumpDatabases,
  ensureStagingDir,
  importDatabases,
  type DatabaseCredential,
} from "./dumps";
import {
  backupArgs,
  CACHE_MOUNT,
  DATA_MOUNT,
  DUMPS_MOUNT,
  explainResticFailure,
  forgetArgs,
  forgetSnapshotArgs,
  initArgs,
  looksUninitialised,
  parseResticOutput,
  parseSnapshots,
  probeArgs,
  repositoryEnv,
  restoreArgs,
  retainsAnything,
  snapshotsArgs,
  type RepoTarget,
  type RetentionPolicy,
  type SnapshotInfo,
} from "./restic";
import { startJob, type JobReporter } from "./jobs";
import { runToolContainer, type ToolMount } from "./toolContainer";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** What the panel sends to start a backup. */
export interface BackupRequest {
  repo: RepoTarget;
  /** Scoped credentials for every database to include. May be empty. */
  databases: DatabaseCredential[];
  retention: RetentionPolicy;
  /** Recorded as a restic tag: "manual" or "scheduled". */
  reason: string;
  /** Data-directory-relative glob patterns to leave out. */
  exclude: string[];
}

/** What the panel sends to start a restore. */
export interface RestoreRequest {
  repo: RepoTarget;
  snapshotId: string;
  databases: DatabaseCredential[];
}

/** Ceilings on a single restic invocation. */
const BACKUP_TIMEOUT_MS = 6 * 60 * 60_000;
const RESTORE_TIMEOUT_MS = 6 * 60 * 60_000;
const QUICK_TIMEOUT_MS = 5 * 60_000;

/**
 * restic's chunk cache, kept per server between runs.
 *
 * Without a persistent cache every incremental backup re-downloads the
 * repository index from S3 before it can decide what changed — which is both
 * slow and a real per-request bill. The cache holds no plaintext tenant data
 * (repository contents are encrypted), so it sits beside the staging area
 * rather than needing separate protection.
 */
function cachePath(serverId: string): string {
  return join(config.backupStagingRoot, ".cache", serverId);
}

/**
 * Run one restic invocation for a server.
 *
 * Mounts are the same for every subcommand so a snapshot's absolute paths mean
 * the same thing at restore time as they did at backup time. The data mount is
 * read-only for everything except a restore — a backup has no business being
 * able to write into the world it is reading.
 */
async function runRestic(
  serverId: string,
  target: RepoTarget,
  args: string[],
  options: {
    timeoutMs: number;
    writableData?: boolean;
    onProgress?: (output: string) => void;
  },
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const dataPath = serverDataPath(serverId);
  const stagingDir = await ensureStagingDir(serverId);
  const cacheDir = cachePath(serverId);
  await mkdir(cacheDir, { recursive: true });

  const mounts: ToolMount[] = [
    { hostPath: dataPath, containerPath: DATA_MOUNT, readOnly: options.writableData !== true },
    { hostPath: stagingDir, containerPath: DUMPS_MOUNT },
    { hostPath: cacheDir, containerPath: CACHE_MOUNT },
  ];

  return runToolContainer({
    image: config.resticImage,
    // The restic image's entrypoint is already `restic`, so the command is just
    // the subcommand and its flags.
    command: args,
    env: repositoryEnv(target, serverId),
    mounts,
    timeoutMs: options.timeoutMs,
    onProgress: options.onProgress,
  });
}

/**
 * Make sure the server's repository exists, creating it on first use.
 *
 * Probe-then-init rather than "init and ignore the already-exists error": an
 * init that fails for any *other* reason (bad credentials, unreachable endpoint)
 * must not be mistaken for a repository that was already there, because the next
 * step would then fail with a far less useful message.
 */
async function ensureRepository(
  serverId: string,
  target: RepoTarget,
  reporter: JobReporter,
): Promise<void> {
  reporter.phase("preparing_repository");

  const probe = await runRestic(serverId, target, probeArgs(), {
    timeoutMs: QUICK_TIMEOUT_MS,
  });
  if (probe.exitCode === 0) return;

  if (!looksUninitialised(probe.output)) {
    throw new Error(explainResticFailure(probe.exitCode, probe.output));
  }

  reporter.log("No repository in S3 for this server yet — creating one.");
  const init = await runRestic(serverId, target, initArgs(), {
    timeoutMs: QUICK_TIMEOUT_MS,
  });
  if (init.exitCode !== 0) {
    throw new Error(explainResticFailure(init.exitCode, init.output));
  }
  reporter.log("Repository created and encrypted with this server's own key.");
}

/**
 * Start a backup job and return its id.
 *
 * Returns as soon as the job is registered — the work runs detached and is
 * observed by polling `readJob`.
 */
export function startBackup(serverId: string, request: BackupRequest): string {
  return startJob(serverId, "backup", async (reporter) => {
    // The data directory may legitimately not exist yet for a server that was
    // created but never installed; an empty snapshot is a better outcome than a
    // failure the owner has to interpret.
    await ensureServerDataDir(serverId);

    const databaseNames: string[] = [];

    if (request.databases.length > 0) {
      reporter.phase("dumping_databases");
      reporter.log(
        `Dumping ${request.databases.length} database` +
          `${request.databases.length === 1 ? "" : "s"} before the file snapshot, ` +
          `so both describe the same moment.`,
      );
      const dumps = await dumpDatabases(serverId, request.databases, (message) =>
        reporter.log(message),
      );
      databaseNames.push(...dumps.map((dump) => dump.name));
    } else {
      // Still reset the staging area: a dump left from when this server did have
      // a database would otherwise ride along into the snapshot forever.
      await clearStagingDir(serverId);
      reporter.log("This server has no provisioned databases; backing up files only.");
    }

    await ensureRepository(serverId, request.repo, reporter);

    reporter.phase("uploading");
    reporter.log("Scanning for changes and uploading to S3…");

    // Progress arrives by re-parsing the container's log tail; only the newest
    // status line matters, so each poll overwrites the last reading.
    let lastPercent = -1;
    const result = await runRestic(
      serverId,
      request.repo,
      backupArgs({
        serverId,
        reason: request.reason,
        includeDumps: databaseNames.length > 0,
        exclude: request.exclude,
      }),
      {
        timeoutMs: BACKUP_TIMEOUT_MS,
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

    const parsed = parseResticOutput(result.output);

    if (result.timedOut) {
      throw new Error(
        `The backup exceeded the ${formatDuration(BACKUP_TIMEOUT_MS / 1000)} limit ` +
          `and was stopped. The partial upload is not a snapshot and costs nothing ` +
          `beyond storage restic will reclaim on the next prune.`,
      );
    }

    // Exit code 3 means "completed, but some files could not be read" — a
    // snapshot exists and is usable, so this is a warning, not a failure.
    if (result.exitCode !== 0 && result.exitCode !== 3) {
      throw new Error(explainResticFailure(result.exitCode, result.output));
    }
    for (const error of parsed.errors.slice(0, 20)) {
      reporter.log(`Could not read: ${error}`, "warn");
    }
    if (result.exitCode === 3) {
      reporter.log(
        "Some files could not be read and were skipped. The snapshot is usable; " +
          "the skipped paths are listed above.",
        "warn",
      );
    }

    if (!parsed.summary) {
      throw new Error(
        "restic finished without reporting a summary, so the snapshot could not " +
          `be identified. Output: ${result.output.trim().slice(-800)}`,
      );
    }

    reporter.log(
      `Snapshot ${parsed.summary.snapshotId.slice(0, 8)} written: ` +
        `${formatBytes(parsed.summary.bytesProcessed)} read, ` +
        `${formatBytes(parsed.summary.bytesAdded)} newly uploaded after ` +
        `deduplication and compression.`,
    );

    // Dumps are only staging: they are inside the snapshot now, and leaving
    // plaintext SQL on the node's disk between backups is a needless exposure.
    await clearStagingDir(serverId);

    await applyRetention(serverId, request.repo, request.retention, reporter);

    reporter.phase("finished");
    return {
      snapshotId: parsed.summary.snapshotId,
      bytesProcessed: parsed.summary.bytesProcessed,
      bytesAdded: parsed.summary.bytesAdded,
      databases: databaseNames,
    };
  });
}

/**
 * Apply the retention policy.
 *
 * Never throws: pruning is housekeeping, and a snapshot that was written
 * successfully must not be reported as a failed backup because the tidy-up
 * afterwards hit a transient S3 error. The next backup retries it.
 */
async function applyRetention(
  serverId: string,
  target: RepoTarget,
  policy: RetentionPolicy,
  reporter: JobReporter,
): Promise<void> {
  if (!retainsAnything(policy)) {
    // `restic forget` with no keep rule would delete every snapshot, including
    // the one just written. An empty policy means "keep everything".
    reporter.log("No retention rules configured — every snapshot is kept.");
    return;
  }

  reporter.phase("applying_retention");
  reporter.log("Applying the retention policy and reclaiming unreferenced data…");

  try {
    const result = await runRestic(serverId, target, forgetArgs(policy), {
      timeoutMs: BACKUP_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      reporter.log(
        `Retention did not run cleanly; the new snapshot is unaffected and this ` +
          `will be retried on the next backup. ${explainResticFailure(result.exitCode, result.output)}`,
        "warn",
      );
      return;
    }
    reporter.log("Retention applied.");
  } catch (error) {
    reporter.log(
      `Retention could not run: ${error instanceof Error ? error.message : String(error)}. ` +
        `The new snapshot is unaffected.`,
      "warn",
    );
  }
}

/**
 * Start a restore job and return its id.
 *
 * The panel is responsible for stopping the server first and starting it again
 * afterwards — it owns the container lifecycle and the status the owner sees.
 * The agent refuses nothing here on that basis: restoring under a running server
 * is the caller's mistake to avoid, and the agent has no way to know whether a
 * stop is in flight.
 */
export function startRestore(serverId: string, request: RestoreRequest): string {
  return startJob(serverId, "restore", async (reporter) => {
    await ensureServerDataDir(serverId);
    // Start from an empty staging directory so a dump from a *previous* restore
    // cannot be mistaken for one this snapshot contained.
    await clearStagingDir(serverId);
    await ensureStagingDir(serverId);

    reporter.phase("restoring_files");
    reporter.log(`Restoring snapshot ${request.snapshotId.slice(0, 8)} from S3…`);

    let lastPercent = -1;
    const result = await runRestic(serverId, request.repo, restoreArgs(request.snapshotId), {
      timeoutMs: RESTORE_TIMEOUT_MS,
      // The one case where restic must be able to write into the data directory.
      writableData: true,
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
          "directory is partially restored — retry the restore before starting the server.",
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(explainResticFailure(result.exitCode, result.output));
    }

    reporter.log("Files restored.");

    if (request.databases.length > 0) {
      reporter.phase("importing_databases");
      await importDatabases(serverId, request.databases, (message) => reporter.log(message));
    }

    await clearStagingDir(serverId);
    reporter.phase("finished");
    return { snapshotId: request.snapshotId };
  });
}

/**
 * List a server's snapshots.
 *
 * Synchronous (not a job): this is a metadata read against the repository index,
 * measured in seconds, and the panel wants it inside one request. It is also the
 * reconciliation source — the panel's `server_backups` rows are its own record,
 * and this is the ground truth they are checked against.
 */
export async function listSnapshots(
  serverId: string,
  target: RepoTarget,
): Promise<SnapshotInfo[]> {
  const result = await runRestic(serverId, target, snapshotsArgs(), {
    timeoutMs: QUICK_TIMEOUT_MS,
  });

  // An uninitialised repository has no snapshots — that is an empty list, not an
  // error the owner should see before their first backup.
  if (result.exitCode !== 0) {
    if (looksUninitialised(result.output)) return [];
    throw new Error(explainResticFailure(result.exitCode, result.output));
  }
  return parseSnapshots(result.output);
}

/**
 * Delete one snapshot and reclaim its unreferenced chunks.
 *
 * Synchronous for the same reason as listing: `forget --prune` of a single
 * snapshot rewrites only the pack files that snapshot uniquely referenced.
 * A missing snapshot is treated as already deleted so a retried delete succeeds.
 */
export async function deleteSnapshot(
  serverId: string,
  target: RepoTarget,
  snapshotId: string,
): Promise<void> {
  const result = await runRestic(serverId, target, forgetSnapshotArgs(snapshotId), {
    timeoutMs: BACKUP_TIMEOUT_MS,
  });

  if (result.exitCode === 0) return;
  if (looksUninitialised(result.output) || /no snapshot|not found/i.test(result.output)) {
    return;
  }
  throw new Error(explainResticFailure(result.exitCode, result.output));
}

/**
 * Check that the configured S3 target is reachable and usable from this node.
 *
 * Backs the admin settings page's "test connection" button. Deliberately probes
 * a *real* repository path rather than merely listing the bucket, because the
 * failure operators actually hit is a credential that can list but not write.
 * An uninitialised repository counts as success — it is the expected state
 * before the first backup, and initialising one as a side effect of a test would
 * leave debris in the bucket.
 */
export async function checkRepository(
  serverId: string,
  target: RepoTarget,
): Promise<{ reachable: boolean; initialised: boolean; detail: string }> {
  const result = await runRestic(serverId, target, probeArgs(), {
    timeoutMs: QUICK_TIMEOUT_MS,
  });

  if (result.exitCode === 0) {
    return {
      reachable: true,
      initialised: true,
      detail: "Connected to the existing repository for this server.",
    };
  }
  if (looksUninitialised(result.output)) {
    return {
      reachable: true,
      initialised: false,
      detail:
        "S3 is reachable and the credentials work. No repository exists for this " +
        "server yet — the first backup will create one.",
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
