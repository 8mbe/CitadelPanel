/**
 * Shared machinery behind both backup scopes.
 *
 * The division of labour with the agent is the one the rest of the system uses:
 * the agent does the work and holds no state; the panel holds the state and no
 * Docker socket. Concretely the panel owns the run row, the log, the repository
 * passwords, the S3 credentials, the limits and the schedules; the agent owns the
 * restic containers and an in-memory job whose progress the panel drains.
 *
 * That split is what makes an agent restart survivable: the row exists before the
 * agent is ever called, so a job that vanishes becomes a *failed run with a
 * reason* rather than one nobody can account for. It is also why the reconciler in
 * `nodes/backupScheduler.ts`, not the scope modules, advances a running backup:
 * the panel polls, because a node cannot call in.
 *
 * This module holds everything that does not care which scope it is serving:
 * repository passwords, S3 target assembly, run rows, logs, storage accounting,
 * and the reconciler's read/write helpers. `serverBackups.ts` and
 * `databaseBackups.ts` hold what does.
 */

import { randomBytes } from "node:crypto";

import { sql } from "../db/client";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { badRequest, notFound, serviceUnavailable } from "../lib/http";
import {
  getBackupSettings,
  isBackupConfigUsable,
  type StoredBackupSettings,
} from "./settings";
import type { AgentRepoTarget } from "../nodes/nodeBackupApi";

export type BackupScope = "server" | "node";
export type BackupKind = "backup" | "restore";
export type BackupStatus = "pending" | "running" | "succeeded" | "failed";
export type BackupTrigger = "manual" | "scheduled";

/** A backup or restore run, as the API returns it. */
export interface BackupRunView {
  id: string;
  scope: BackupScope;
  serverId: string | null;
  nodeId: string;
  kind: BackupKind;
  status: BackupStatus;
  trigger: BackupTrigger;
  phase: string | null;
  percent: number;
  snapshotId: string | null;
  bytesProcessed: number | null;
  /** Bytes actually uploaded after dedup and compression, the S3 cost. */
  bytesAdded: number | null;
  /** Databases inside a node-scope snapshot. Always empty for server runs. */
  databases: string[];
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface RunRow {
  id: string;
  scope: BackupScope;
  server_id: string | null;
  node_id: string;
  kind: BackupKind;
  status: BackupStatus;
  trigger: BackupTrigger;
  phase: string | null;
  percent: number;
  snapshot_id: string | null;
  bytes_processed: string | number | null;
  bytes_added: string | number | null;
  databases: string[];
  error: string | null;
  requested_by: string | null;
  created_at: Date;
  finished_at: Date | null;
}

/** BIGINT arrives as a string from postgres.js; a byte count fits a JS number. */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toRunView(row: RunRow): BackupRunView {
  return {
    id: row.id,
    scope: row.scope,
    serverId: row.server_id,
    nodeId: row.node_id,
    kind: row.kind,
    status: row.status,
    trigger: row.trigger,
    phase: row.phase,
    percent: row.percent,
    snapshotId: row.snapshot_id,
    bytesProcessed: toNumber(row.bytes_processed),
    bytesAdded: toNumber(row.bytes_added),
    databases: Array.isArray(row.databases) ? row.databases : [],
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

// --- Repository passwords ----------------------------------------------------------

/**
 * The repository password for a subject, minted on first use.
 *
 * 48 random bytes, base64. Well past the point where the password is the weak
 * link, and generated per subject so one leaked password reads one server's
 * files or one node's databases, never the fleet.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read makes this safe under a race: two
 * concurrent first backups must end up with the *same* password, because the one
 * that lost the insert would otherwise write snapshots nothing can later decrypt.
 *
 * The two scopes use separate tables so each keeps a real foreign key, which is
 * why this takes a table name rather than being one polymorphic query.
 */
async function getOrCreateRepoPassword(
  scope: BackupScope,
  id: string,
): Promise<string> {
  const read = async (): Promise<string | null> => {
    const rows =
      scope === "server"
        ? ((await sql`
            SELECT repo_password_encrypted FROM server_backup_repos WHERE server_id = ${id}
          `) as { repo_password_encrypted: string }[])
        : ((await sql`
            SELECT repo_password_encrypted FROM node_backup_repos WHERE node_id = ${id}
          `) as { repo_password_encrypted: string }[]);
    return rows[0] ? decryptSecret(rows[0].repo_password_encrypted) : null;
  };

  const existing = await read();
  if (existing) return existing;

  const encrypted = encryptSecret(randomBytes(48).toString("base64"));
  if (scope === "server") {
    await sql`
      INSERT INTO server_backup_repos (server_id, repo_password_encrypted)
      VALUES (${id}, ${encrypted})
      ON CONFLICT (server_id) DO NOTHING
    `;
  } else {
    await sql`
      INSERT INTO node_backup_repos (node_id, repo_password_encrypted)
      VALUES (${id}, ${encrypted})
      ON CONFLICT (node_id) DO NOTHING
    `;
  }

  // Re-read rather than returning the generated value: if a concurrent request won
  // the insert, its password is the one the repository will be created with.
  const settled = await read();
  if (!settled) {
    throw serviceUnavailable("Could not store the backup repository key.");
  }
  return settled;
}

/** Record that a repository is known to exist in S3. */
export async function markRepositoryInitialized(
  scope: BackupScope,
  id: string,
): Promise<void> {
  if (scope === "server") {
    await sql`
      UPDATE server_backup_repos SET initialized_at = COALESCE(initialized_at, now())
      WHERE server_id = ${id}
    `;
  } else {
    await sql`
      UPDATE node_backup_repos SET initialized_at = COALESCE(initialized_at, now())
      WHERE node_id = ${id}
    `;
  }
}

/** Store a repository's measured size, for the storage report. */
export async function recordRepositorySize(
  scope: BackupScope,
  id: string,
  sizeBytes: number,
): Promise<void> {
  if (scope === "server") {
    await sql`
      UPDATE server_backup_repos SET size_bytes = ${sizeBytes}, size_measured_at = now()
      WHERE server_id = ${id}
    `;
  } else {
    await sql`
      UPDATE node_backup_repos SET size_bytes = ${sizeBytes}, size_measured_at = now()
      WHERE node_id = ${id}
    `;
  }
}

// --- Assembling an agent request ----------------------------------------------------

/**
 * Build the repository block for a subject.
 *
 * Throws rather than returning null when backups are not configured, because every
 * caller's next move would be the same error, and the message names the page the
 * operator has to visit.
 *
 * `allowDisabled` exists for the admin connection test: the destination may be
 * complete but not yet switched on, and a test that required `enabled` would be
 * useless exactly when it is needed.
 */
export async function buildRepoTarget(
  scope: BackupScope,
  id: string,
  settings: StoredBackupSettings,
  options: { allowDisabled?: boolean } = {},
): Promise<AgentRepoTarget> {
  const effective = options.allowDisabled ? { ...settings, enabled: true } : settings;

  if (!isBackupConfigUsable(effective)) {
    throw badRequest(
      "Backups are not configured. An administrator needs to set an S3 destination " +
        "under Admin → Backups first.",
    );
  }
  if (!effective.secretAccessKeyEncrypted) {
    throw badRequest("The S3 secret access key is missing from the backup settings.");
  }

  return {
    s3: {
      // Stripped here as well as validated agent-side: the operator may have pasted
      // a console URL, and rejecting the whole backup over a scheme they cannot see
      // is worse than normalising it.
      endpoint: effective.endpoint!.replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
      bucket: effective.bucket!,
      prefix: effective.prefix,
      region: effective.region,
      accessKeyId: effective.accessKeyId!,
      secretAccessKey: decryptSecret(effective.secretAccessKeyEncrypted),
      useTls: effective.useTls,
    },
    password: await getOrCreateRepoPassword(scope, id),
  };
}

// --- Storage accounting --------------------------------------------------------------

/** What the admin page's storage line reports. */
export interface BackupStorageReport {
  /**
   * Deduplicated bytes across every repository, as restic last measured them.
   * Refreshed on every backup, so it is at most one backup interval stale.
   */
  usedBytes: number;
  /** Enforced ceiling. 0 = unlimited. */
  quotaBytes: number;
  /** Operator-declared bucket capacity, display only. 0 = unknown. */
  capacityBytes: number;
  /** Repositories contributing to `usedBytes`. */
  repositories: number;
  /** Repositories that have never been measured, so `usedBytes` understates. */
  unmeasured: number;
  /** True when the quota is set and reached. */
  overQuota: boolean;
}

/**
 * Total storage the fleet's backups occupy.
 *
 * Summed from the per-repository sizes recorded after each backup rather than
 * measured on demand: measuring means one `restic stats` container per repository,
 * which on a fleet of two hundred servers is two hundred container starts for a
 * page load. Recording it when the index is already cached (immediately after a
 * backup) costs a metadata pass instead.
 *
 * `unmeasured` is reported alongside so the number is honest: a repository whose
 * size has never been read contributes nothing to the total, and the UI says so
 * rather than presenting an understated figure as complete.
 */
export async function getStorageReport(): Promise<BackupStorageReport> {
  const settings = await getBackupSettings();

  const rows = (await sql`
    SELECT
      COALESCE(SUM(size_bytes), 0)::bigint AS used,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE size_bytes IS NULL)::int AS unmeasured
    FROM (
      SELECT size_bytes FROM server_backup_repos
      UNION ALL
      SELECT size_bytes FROM node_backup_repos
    ) AS repos
  `) as { used: string | number; total: number; unmeasured: number }[];

  const row = rows[0];
  const usedBytes = toNumber(row?.used ?? 0) ?? 0;
  const quotaBytes = settings.storage.quotaBytes;

  return {
    usedBytes,
    quotaBytes,
    capacityBytes: settings.storage.capacityBytes,
    repositories: row?.total ?? 0,
    unmeasured: row?.unmeasured ?? 0,
    overQuota: quotaBytes > 0 && usedBytes >= quotaBytes,
  };
}

/**
 * Refuse a new backup when the fleet is at its storage limit.
 *
 * Checked before the agent is called, so an operator hits a clear refusal instead
 * of an invoice. Deliberately a *pre*-check on the total rather than a projection
 * of what this backup will add: restic deduplicates, so how much a snapshot will
 * actually cost is unknowable in advance, and refusing on a guess would block
 * backups that would have fitted.
 *
 * The quota is a ceiling on starting new work, never on deleting: a run already in
 * flight is allowed to finish, and pruning always works, so an operator over quota
 * can always get back under it.
 */
export async function assertStorageAvailable(): Promise<void> {
  const report = await getStorageReport();
  if (!report.overQuota) return;

  throw badRequest(
    `Backups are using ${formatBytes(report.usedBytes)} of the ` +
      `${formatBytes(report.quotaBytes)} allowed, so no new backup can be started. ` +
      `Delete some backups, lower the per-server or per-node limit, or raise the ` +
      `storage limit under Admin → Backups.`,
  );
}

// --- Run rows ------------------------------------------------------------------------

export interface CreateRunInput {
  scope: BackupScope;
  serverId: string | null;
  nodeId: string;
  kind: BackupKind;
  trigger: BackupTrigger;
  requestedBy: string | null;
  snapshotId?: string | null;
  databases?: string[];
}

/**
 * Write a run row in `pending`.
 *
 * Always called *before* the agent, so a failure to reach the node still leaves a
 * durable record saying so. The other order loses every failure that happened
 * before a job id existed.
 */
export async function createRun(input: CreateRunInput): Promise<BackupRunView> {
  const rows = (await sql`
    INSERT INTO backup_runs (
      scope, server_id, node_id, kind, status, trigger, requested_by, phase,
      snapshot_id, databases
    ) VALUES (
      ${input.scope}, ${input.serverId}, ${input.nodeId}, ${input.kind}, 'pending',
      ${input.trigger}, ${input.requestedBy}, 'starting',
      ${input.snapshotId ?? null}, ${sql.json((input.databases ?? []) as never)}
    )
    RETURNING *
  `) as RunRow[];
  return toRunView(rows[0]!);
}

/** Attach the agent's job id and move the run to `running`. */
export async function markRunAccepted(
  runId: string,
  jobId: string,
  logCursor = 0,
): Promise<void> {
  await sql`
    UPDATE backup_runs
    SET status = 'running', job_id = ${jobId}, log_cursor = ${logCursor}, updated_at = now()
    WHERE id = ${runId}
  `;
}

/** One run, or a 404. */
export async function getRun(runId: string): Promise<BackupRunView> {
  const rows = (await sql`SELECT * FROM backup_runs WHERE id = ${runId}`) as RunRow[];
  if (!rows[0]) throw notFound("Backup not found.");
  return toRunView(rows[0]);
}

/** Append one log line. Idempotent on `(run_id, seq)`. */
export async function appendLog(
  runId: string,
  seq: number,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  await sql`
    INSERT INTO backup_run_logs (run_id, seq, level, message)
    VALUES (${runId}, ${seq}, ${level}, ${message.slice(0, 4000)})
    ON CONFLICT (run_id, seq) DO NOTHING
  `;
}

export interface BackupLogLine {
  seq: number;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: Date;
}

/**
 * A run's log, from a cursor.
 *
 * `afterSeq` is what makes the UI's live tail cheap: while a backup runs the
 * browser polls with the last sequence number it saw and gets only what is new,
 * rather than re-downloading a growing log every two seconds.
 */
export async function listRunLogs(
  runId: string,
  afterSeq = 0,
  limit = 500,
): Promise<BackupLogLine[]> {
  const rows = (await sql`
    SELECT seq, level, message, created_at
    FROM backup_run_logs
    WHERE run_id = ${runId} AND seq > ${afterSeq}
    ORDER BY seq ASC
    LIMIT ${Math.min(limit, 2000)}
  `) as { seq: number; level: "info" | "warn" | "error"; message: string; created_at: Date }[];

  return rows.map((row) => ({
    seq: row.seq,
    level: row.level,
    message: row.message,
    createdAt: row.created_at,
  }));
}

/** Mark a run failed, with the reason the operator will read. */
export async function failRun(runId: string, error: string): Promise<void> {
  await sql`
    UPDATE backup_runs
    SET status = 'failed', error = ${error.slice(0, 4000)}, phase = 'finished',
        job_id = NULL, finished_at = now(), updated_at = now()
    WHERE id = ${runId} AND status IN ('pending', 'running')
  `;
  // The failure goes in the log too, so the tail the UI shows ends with the reason
  // rather than trailing off mid-progress.
  const rows = (await sql`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM backup_run_logs WHERE run_id = ${runId}
  `) as { next: number }[];
  await appendLog(runId, rows[0]?.next ?? 1, "error", error);
}

/** Store a poll's progress reading. */
export async function updateRunProgress(
  runId: string,
  phase: string,
  percent: number,
  logCursor: number,
): Promise<void> {
  await sql`
    UPDATE backup_runs
    SET phase = ${phase}, percent = ${percent}, log_cursor = ${logCursor}, updated_at = now()
    WHERE id = ${runId}
  `;
}

/** Store a finished job's outcome. */
export async function completeRun(
  runId: string,
  result: {
    snapshotId?: string;
    bytesProcessed?: number;
    bytesAdded?: number;
    databases?: string[];
  },
  logCursor: number,
): Promise<void> {
  await sql`
    UPDATE backup_runs
    SET status = 'succeeded', phase = 'finished', percent = 100,
        snapshot_id = COALESCE(${result.snapshotId ?? null}, snapshot_id),
        bytes_processed = ${result.bytesProcessed ?? null},
        bytes_added = ${result.bytesAdded ?? null},
        databases = ${sql.json((result.databases ?? []) as never)},
        job_id = NULL, log_cursor = ${logCursor},
        finished_at = now(), updated_at = now()
    WHERE id = ${runId}
  `;
}

/**
 * Drop the rows for snapshots the agent deleted to keep the quota.
 *
 * The agent reports the ids because the panel cannot infer them without re-listing
 * and diffing the repository. This is what keeps the panel's history and the
 * bucket's contents in step: the snapshot is gone, so the row that pointed at it
 * goes too, along with its log.
 *
 * Scoped to the same subject as the run that reported them, so a snapshot id
 * colliding across repositories (astronomically unlikely, but the query is no
 * harder to write correctly) cannot delete another subject's row.
 */
export async function dropForgottenRuns(
  scope: BackupScope,
  subjectId: string,
  snapshotIds: string[],
): Promise<number> {
  if (snapshotIds.length === 0) return 0;

  const deleted =
    scope === "server"
      ? ((await sql`
          DELETE FROM backup_runs
          WHERE scope = 'server' AND server_id = ${subjectId}
            AND snapshot_id = ANY(${snapshotIds}) AND kind = 'backup'
          RETURNING id
        `) as { id: string }[])
      : ((await sql`
          DELETE FROM backup_runs
          WHERE scope = 'node' AND node_id = ${subjectId}
            AND snapshot_id = ANY(${snapshotIds}) AND kind = 'backup'
          RETURNING id
        `) as { id: string }[]);

  return deleted.length;
}

/**
 * Trim old *failed* runs for a subject.
 *
 * Successful runs are bounded by the snapshot quota, but failures produce no
 * snapshot and would otherwise accumulate forever. A node whose S3 credentials
 * are wrong writes one failed row per server per schedule tick. The most recent
 * failures are the diagnostic ones, so the oldest go.
 */
export async function trimFailedRuns(
  scope: BackupScope,
  subjectId: string,
  keep = 20,
): Promise<void> {
  if (scope === "server") {
    await sql`
      DELETE FROM backup_runs
      WHERE scope = 'server' AND server_id = ${subjectId} AND status = 'failed'
        AND id NOT IN (
          SELECT id FROM backup_runs
          WHERE scope = 'server' AND server_id = ${subjectId} AND status = 'failed'
          ORDER BY created_at DESC LIMIT ${keep}
        )
    `;
  } else {
    await sql`
      DELETE FROM backup_runs
      WHERE scope = 'node' AND node_id = ${subjectId} AND status = 'failed'
        AND id NOT IN (
          SELECT id FROM backup_runs
          WHERE scope = 'node' AND node_id = ${subjectId} AND status = 'failed'
          ORDER BY created_at DESC LIMIT ${keep}
        )
    `;
  }
}

/** Whether this subject already has a run in flight, panel-side. */
export async function hasActiveRun(
  scope: BackupScope,
  subjectId: string,
): Promise<boolean> {
  const rows =
    scope === "server"
      ? ((await sql`
          SELECT 1 FROM backup_runs
          WHERE scope = 'server' AND server_id = ${subjectId}
            AND status IN ('pending', 'running')
          LIMIT 1
        `) as { 1: number }[])
      : ((await sql`
          SELECT 1 FROM backup_runs
          WHERE scope = 'node' AND node_id = ${subjectId}
            AND status IN ('pending', 'running')
          LIMIT 1
        `) as { 1: number }[]);
  return rows.length > 0;
}

/** Runs the reconciler still needs to poll, of either scope. */
export interface ActiveRun {
  id: string;
  scope: BackupScope;
  serverId: string | null;
  nodeId: string;
  jobId: string | null;
  logCursor: number;
  createdAt: Date;
}

export async function listActiveRuns(): Promise<ActiveRun[]> {
  const rows = (await sql`
    SELECT id, scope, server_id, node_id, job_id, log_cursor, created_at
    FROM backup_runs
    WHERE status IN ('pending', 'running')
    ORDER BY created_at ASC
  `) as {
    id: string;
    scope: BackupScope;
    server_id: string | null;
    node_id: string;
    job_id: string | null;
    log_cursor: number;
    created_at: Date;
  }[];

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    serverId: row.server_id,
    nodeId: row.node_id,
    jobId: row.job_id,
    logCursor: row.log_cursor,
    createdAt: row.created_at,
  }));
}

/** Whether a subject already has a scheduled run in the current cron minute. */
export async function hasScheduledRunSince(
  scope: BackupScope,
  subjectId: string,
  since: Date,
): Promise<boolean> {
  const rows =
    scope === "server"
      ? ((await sql`
          SELECT 1 FROM backup_runs
          WHERE scope = 'server' AND server_id = ${subjectId}
            AND trigger = 'scheduled' AND created_at >= ${since}
          LIMIT 1
        `) as { 1: number }[])
      : ((await sql`
          SELECT 1 FROM backup_runs
          WHERE scope = 'node' AND node_id = ${subjectId}
            AND trigger = 'scheduled' AND created_at >= ${since}
          LIMIT 1
        `) as { 1: number }[]);
  return rows.length > 0;
}

/** Byte formatting for operator-facing messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
