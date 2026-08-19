/**
 * Server backups: the panel's half of the S3 backup feature.
 *
 * The division of labour with the agent is the same one the rest of the system
 * uses. The agent does the work and holds no state; the panel holds the state
 * and no Docker socket. Concretely:
 *
 *   - the panel owns the `server_backups` row, the log, the repository password,
 *     the S3 credentials, the retention policy and the schedule;
 *   - the agent owns the restic containers, the database dumps, and an in-memory
 *     job whose progress the panel drains.
 *
 * That split is what makes an agent restart survivable: the row exists before
 * the agent is ever called, so a job that vanishes becomes a *failed backup with
 * a reason* rather than a backup nobody can account for. It is also why the
 * reconciler in `nodes/backupScheduler.ts` — not this module — advances a running
 * backup: the panel polls, because a node cannot call in.
 *
 * The repository password is the one genuinely dangerous piece of state here.
 * It is minted per server on first backup, stored AES-256-GCM encrypted, and is
 * the only thing that can decrypt that server's snapshots — so rotating
 * `PANEL_ENCRYPTION_KEY` orphans the history, which the settings UI says out
 * loud.
 */

import { randomBytes } from "node:crypto";

import { sql } from "../db/client";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { conflict, notFound, badRequest, serviceUnavailable } from "../lib/http";
import {
  getBackupSettings,
  isBackupConfigUsable,
  type StoredBackupSettings,
} from "./settings";
import {
  checkNodeBackupRepository,
  forgetNodeSnapshot,
  listNodeSnapshots,
  startNodeBackup,
  startNodeRestore,
  type AgentDatabaseCredential,
  type AgentRepoTarget,
} from "../nodes/nodeBackupApi";
import { recordAudit } from "./auditLog";
import { getServerState, startServerContainer, stopServerContainer } from "../nodes/nodeServerApi";

export type BackupKind = "backup" | "restore";
export type BackupStatus = "pending" | "running" | "succeeded" | "failed";
export type BackupTrigger = "manual" | "scheduled";

/** A backup or restore run, as the API returns it. */
export interface BackupView {
  id: string;
  serverId: string;
  kind: BackupKind;
  status: BackupStatus;
  trigger: BackupTrigger;
  phase: string | null;
  percent: number;
  snapshotId: string | null;
  bytesProcessed: number | null;
  /** Bytes actually uploaded after dedup and compression — the S3 cost. */
  bytesAdded: number | null;
  databases: string[];
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

interface BackupRow {
  id: string;
  server_id: string;
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

function toView(row: BackupRow): BackupView {
  return {
    id: row.id,
    serverId: row.server_id,
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

// --- Repository password ---------------------------------------------------------

/**
 * The restic repository password for a server, minted on first use.
 *
 * 48 random bytes, base64 — well past the point where the password is the weak
 * link, and generated per server so one leaked password reads one tenant's
 * snapshots.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read makes this safe under a race: two
 * concurrent first backups must end up with the *same* password, because the one
 * that lost the insert would otherwise write snapshots nothing can later decrypt.
 */
async function getOrCreateRepoPassword(serverId: string): Promise<string> {
  const existing = (await sql`
    SELECT repo_password_encrypted FROM server_backup_repos WHERE server_id = ${serverId}
  `) as { repo_password_encrypted: string }[];

  if (existing[0]) return decryptSecret(existing[0].repo_password_encrypted);

  const password = randomBytes(48).toString("base64");
  await sql`
    INSERT INTO server_backup_repos (server_id, repo_password_encrypted)
    VALUES (${serverId}, ${encryptSecret(password)})
    ON CONFLICT (server_id) DO NOTHING
  `;

  // Re-read rather than returning the generated value: if a concurrent request
  // won the insert, its password is the one the repository will be created with.
  const row = (await sql`
    SELECT repo_password_encrypted FROM server_backup_repos WHERE server_id = ${serverId}
  `) as { repo_password_encrypted: string }[];

  if (!row[0]) {
    throw serviceUnavailable("Could not store this server's backup repository key.");
  }
  return decryptSecret(row[0].repo_password_encrypted);
}

/** Record that the repository is known to exist in S3. */
export async function markRepositoryInitialized(serverId: string): Promise<void> {
  await sql`
    UPDATE server_backup_repos
    SET initialized_at = COALESCE(initialized_at, now())
    WHERE server_id = ${serverId}
  `;
}

// --- Assembling an agent request ------------------------------------------------

/**
 * Build the repository block for a server.
 *
 * Throws rather than returning null when backups are not configured, because
 * every caller's next move would be the same error — and the message names the
 * page the operator has to visit.
 */
async function buildRepoTarget(
  serverId: string,
  settings: StoredBackupSettings,
): Promise<AgentRepoTarget> {
  if (!isBackupConfigUsable(settings)) {
    throw badRequest(
      "Backups are not configured. An administrator needs to set an S3 " +
        "destination under Admin → Backups before servers can be backed up.",
    );
  }
  if (!settings.secretAccessKeyEncrypted) {
    throw badRequest("The S3 secret access key is missing from the backup settings.");
  }

  return {
    s3: {
      // Stripped here as well as validated agent-side: the operator may have
      // pasted a URL, and rejecting the whole backup over a scheme they cannot
      // see is worse than normalising it.
      endpoint: settings.endpoint!.replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
      bucket: settings.bucket!,
      prefix: settings.prefix,
      region: settings.region,
      accessKeyId: settings.accessKeyId!,
      secretAccessKey: decryptSecret(settings.secretAccessKeyEncrypted),
    },
    password: await getOrCreateRepoPassword(serverId),
  };
}

/**
 * The scoped credentials for every database this server owns.
 *
 * The *scoped* per-database user, not the node's DB admin: its grants cover one
 * database, so MariaDB itself bounds what the dump can read. This is the same
 * credential the database explorer runs on, decrypted the same way.
 */
async function loadDatabaseCredentials(serverId: string): Promise<AgentDatabaseCredential[]> {
  const rows = (await sql`
    SELECT db_name, db_user, db_password_encrypted
    FROM server_databases
    WHERE server_id = ${serverId}
    ORDER BY created_at ASC
  `) as { db_name: string; db_user: string; db_password_encrypted: string }[];

  return rows.map((row) => ({
    name: row.db_name,
    user: row.db_user,
    password: decryptSecret(row.db_password_encrypted),
  }));
}

/** The server fields a backup needs, or a 404. */
async function loadServerForBackup(serverId: string): Promise<{
  id: string;
  nodeId: string;
  name: string;
  status: string;
  backupsEnabled: boolean;
}> {
  const rows = (await sql`
    SELECT id, node_id, name, status, backups_enabled
    FROM servers WHERE id = ${serverId}
  `) as {
    id: string;
    node_id: string;
    name: string;
    status: string;
    backups_enabled: boolean;
  }[];

  const row = rows[0];
  if (!row) throw notFound("Server not found.");
  return {
    id: row.id,
    nodeId: row.node_id,
    name: row.name,
    status: row.status,
    backupsEnabled: row.backups_enabled,
  };
}

// --- Reads ----------------------------------------------------------------------

/** A server's backup history, newest first. */
export async function listServerBackups(
  serverId: string,
  limit = 50,
): Promise<BackupView[]> {
  const rows = (await sql`
    SELECT * FROM server_backups
    WHERE server_id = ${serverId}
    ORDER BY created_at DESC
    LIMIT ${Math.min(limit, 200)}
  `) as BackupRow[];
  return rows.map(toView);
}

/** One run, or a 404. */
export async function getBackup(serverId: string, backupId: string): Promise<BackupView> {
  const rows = (await sql`
    SELECT * FROM server_backups
    WHERE id = ${backupId} AND server_id = ${serverId}
  `) as BackupRow[];

  const row = rows[0];
  if (!row) throw notFound("Backup not found.");
  return toView(row);
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
export async function listBackupLogs(
  backupId: string,
  afterSeq = 0,
  limit = 500,
): Promise<BackupLogLine[]> {
  const rows = (await sql`
    SELECT seq, level, message, created_at
    FROM server_backup_logs
    WHERE backup_id = ${backupId} AND seq > ${afterSeq}
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

/** Whether this server already has a run in flight, panel-side. */
export async function hasActiveBackup(serverId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM server_backups
    WHERE server_id = ${serverId} AND status IN ('pending', 'running')
    LIMIT 1
  `) as { 1: number }[];
  return rows.length > 0;
}

// --- Starting a run --------------------------------------------------------------

export interface StartBackupInput {
  serverId: string;
  actorId: string | null;
  trigger: BackupTrigger;
}

/**
 * Start a backup and return its row.
 *
 * The row is written *before* the agent is called, and that ordering is the
 * whole design: if the agent call fails, there is a durable `failed` record
 * saying so. Doing it the other way round loses every failure that happened
 * before the panel learned a job id.
 *
 * A suspended server is refused. Its container is stopped and its owner is under
 * review; quietly continuing to bill an operator's bucket for it is not the
 * behaviour anyone configured.
 */
export async function startBackup(input: StartBackupInput): Promise<BackupView> {
  const server = await loadServerForBackup(input.serverId);

  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be backed up.",
    );
  }
  if (await hasActiveBackup(input.serverId)) {
    throw conflict("A backup or restore is already running for this server.");
  }

  const settings = await getBackupSettings();
  const repo = await buildRepoTarget(input.serverId, settings);
  const databases = await loadDatabaseCredentials(input.serverId);

  const inserted = (await sql`
    INSERT INTO server_backups (server_id, node_id, kind, status, trigger, requested_by, phase)
    VALUES (
      ${input.serverId}, ${server.nodeId}, 'backup', 'pending',
      ${input.trigger}, ${input.actorId}, 'starting'
    )
    RETURNING *
  `) as BackupRow[];

  const row = inserted[0]!;
  await appendLog(
    row.id,
    0,
    "info",
    databases.length > 0
      ? `Backup requested. ${databases.length} database${databases.length === 1 ? "" : "s"} ` +
          `will be dumped into the same snapshot as the files.`
      : "Backup requested. This server has no databases, so files only.",
  );

  try {
    const { jobId } = await startNodeBackup(server.nodeId, input.serverId, {
      repo,
      databases,
      retention: settings.retention,
      reason: input.trigger,
      exclude: settings.exclude,
    });

    await sql`
      UPDATE server_backups
      SET status = 'running', job_id = ${jobId}, updated_at = now()
      WHERE id = ${row.id}
    `;
    // The agent creates the repository on first backup, so reaching this point
    // means S3 accepted the credentials.
    await markRepositoryInitialized(input.serverId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failBackup(row.id, `The node did not accept the backup: ${message}`);
    // Rethrow so the caller's HTTP response says what went wrong, rather than
    // returning a row the user has to go and look at to discover it failed.
    throw error;
  }

  await recordAudit({
    userId: input.actorId,
    action: "server.backup.create",
    targetType: "server",
    targetId: input.serverId,
    metadata: {
      backupId: row.id,
      trigger: input.trigger,
      databases: databases.map((database) => database.name),
      bucket: settings.bucket,
    },
  });

  return await getBackup(input.serverId, row.id);
}

export interface StartRestoreInput {
  serverId: string;
  backupId: string;
  actorId: string | null;
}

/**
 * Restore a server from one of its backups.
 *
 * The server is stopped first and left stopped. Restoring under a running game
 * would have restic writing world files the server has open and cached in
 * memory, and the server would then overwrite half of them on its next save —
 * so the stop is not a courtesy, it is what makes the restore mean anything.
 *
 * Leaving it stopped afterwards is also deliberate: the owner should look at the
 * restored server before players reconnect to it. The UI says so.
 */
export async function startRestore(input: StartRestoreInput): Promise<BackupView> {
  const server = await loadServerForBackup(input.serverId);
  const source = await getBackup(input.serverId, input.backupId);

  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be restored.",
    );
  }
  if (source.kind !== "backup" || source.status !== "succeeded" || !source.snapshotId) {
    throw badRequest("Only a completed backup can be restored.");
  }
  if (await hasActiveBackup(input.serverId)) {
    throw conflict("A backup or restore is already running for this server.");
  }

  const settings = await getBackupSettings();
  const repo = await buildRepoTarget(input.serverId, settings);
  const databases = await loadDatabaseCredentials(input.serverId);

  const inserted = (await sql`
    INSERT INTO server_backups (
      server_id, node_id, kind, status, trigger, requested_by, phase, snapshot_id, databases
    )
    VALUES (
      ${input.serverId}, ${server.nodeId}, 'restore', 'pending', 'manual',
      ${input.actorId}, 'starting', ${source.snapshotId},
      ${sql.json(source.databases as never)}
    )
    RETURNING *
  `) as BackupRow[];

  const row = inserted[0]!;

  try {
    // Stop first. A container that is already stopped is a no-op agent-side, and
    // a node that cannot be reached fails the restore here rather than halfway
    // through overwriting the world.
    const state = await getServerState(server.nodeId, input.serverId).catch(() => null);
    if (state === "running" || state === "restarting") {
      await appendLog(row.id, 0, "info", "Stopping the server before restoring its data…");
      await stopServerContainer(server.nodeId, input.serverId);
      await sql`
        UPDATE servers SET status = 'stopped', updated_at = now() WHERE id = ${input.serverId}
      `;
    }

    await appendLog(
      row.id,
      1,
      "info",
      `Restoring snapshot ${source.snapshotId.slice(0, 8)}` +
        (source.databases.length > 0
          ? `, including ${source.databases.length} database dump${source.databases.length === 1 ? "" : "s"} ` +
            `which will overwrite the current contents of ${source.databases.join(", ")}.`
          : "."),
    );

    const { jobId } = await startNodeRestore(server.nodeId, input.serverId, {
      repo,
      snapshotId: source.snapshotId,
      databases,
    });

    await sql`
      UPDATE server_backups
      SET status = 'running', job_id = ${jobId}, log_cursor = 1, updated_at = now()
      WHERE id = ${row.id}
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failBackup(row.id, `The node did not accept the restore: ${message}`);
    throw error;
  }

  await recordAudit({
    userId: input.actorId,
    action: "server.backup.restore",
    targetType: "server",
    targetId: input.serverId,
    metadata: {
      backupId: row.id,
      sourceBackupId: source.id,
      snapshotId: source.snapshotId,
      databases: source.databases,
    },
  });

  return await getBackup(input.serverId, row.id);
}

/**
 * Bring a server back up after a restore, on request.
 *
 * Separate from the restore itself so the owner decides when players reconnect —
 * and so a restore that half-worked is not immediately handed back to a live
 * game.
 */
export async function startServerAfterRestore(
  serverId: string,
  actorId: string | null,
): Promise<void> {
  const server = await loadServerForBackup(serverId);
  await startServerContainer(server.nodeId, serverId);
  await sql`
    UPDATE servers SET status = 'running', updated_at = now() WHERE id = ${serverId}
  `;
  await recordAudit({
    userId: actorId,
    action: "server.start",
    targetType: "server",
    targetId: serverId,
    metadata: { afterRestore: true },
  });
}

// --- Deleting --------------------------------------------------------------------

/**
 * Delete a backup: drop its snapshot from S3, then its panel row.
 *
 * S3 first. If the panel row went first and the prune then failed, the snapshot
 * would be orphaned — paid for forever with nothing in the UI referencing it.
 * A snapshot the agent reports as already gone is success, so a retried delete
 * completes.
 */
export async function deleteBackup(
  serverId: string,
  backupId: string,
  actorId: string | null,
): Promise<void> {
  const server = await loadServerForBackup(serverId);
  const backup = await getBackup(serverId, backupId);

  if (backup.status === "pending" || backup.status === "running") {
    throw conflict("This backup is still running. Wait for it to finish before deleting it.");
  }

  if (backup.snapshotId) {
    const settings = await getBackupSettings();
    const repo = await buildRepoTarget(serverId, settings);
    await forgetNodeSnapshot(server.nodeId, serverId, repo, backup.snapshotId);
  }

  await sql`DELETE FROM server_backups WHERE id = ${backupId} AND server_id = ${serverId}`;

  await recordAudit({
    userId: actorId,
    action: "server.backup.delete",
    targetType: "server",
    targetId: serverId,
    metadata: { backupId, snapshotId: backup.snapshotId },
  });
}

// --- Per-server schedule opt-out ---------------------------------------------------

/** Whether the cron schedule includes this server. */
export async function setServerBackupsEnabled(
  serverId: string,
  enabled: boolean,
  actorId: string | null,
): Promise<void> {
  const updated = (await sql`
    UPDATE servers SET backups_enabled = ${enabled}, updated_at = now()
    WHERE id = ${serverId}
    RETURNING id
  `) as { id: string }[];

  if (updated.length === 0) throw notFound("Server not found.");

  await recordAudit({
    userId: actorId,
    action: "server.backup.settings",
    targetType: "server",
    targetId: serverId,
    metadata: { backupsEnabled: enabled },
  });
}

/** Whether this server is included in the schedule. */
export async function getServerBackupsEnabled(serverId: string): Promise<boolean> {
  const server = await loadServerForBackup(serverId);
  return server.backupsEnabled;
}

// --- Reconciliation helpers (used by nodes/backupScheduler.ts) ---------------------

/** Append one log line. Idempotent on `(backup_id, seq)`. */
export async function appendLog(
  backupId: string,
  seq: number,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  await sql`
    INSERT INTO server_backup_logs (backup_id, seq, level, message)
    VALUES (${backupId}, ${seq}, ${level}, ${message.slice(0, 4000)})
    ON CONFLICT (backup_id, seq) DO NOTHING
  `;
}

/** Mark a run failed, with the reason the operator will read. */
export async function failBackup(backupId: string, error: string): Promise<void> {
  await sql`
    UPDATE server_backups
    SET status = 'failed', error = ${error.slice(0, 4000)}, phase = 'finished',
        job_id = NULL, finished_at = now(), updated_at = now()
    WHERE id = ${backupId} AND status IN ('pending', 'running')
  `;
  // The failure goes in the log too, so the tail the UI shows ends with the
  // reason rather than trailing off mid-progress.
  const rows = (await sql`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM server_backup_logs WHERE backup_id = ${backupId}
  `) as { next: number }[];
  await appendLog(backupId, rows[0]?.next ?? 1, "error", error);
}

/** Runs the reconciler still needs to poll. */
export async function listActiveBackups(): Promise<
  { id: string; serverId: string; nodeId: string | null; jobId: string | null; logCursor: number; createdAt: Date }[]
> {
  const rows = (await sql`
    SELECT id, server_id, node_id, job_id, log_cursor, created_at
    FROM server_backups
    WHERE status IN ('pending', 'running')
    ORDER BY created_at ASC
  `) as {
    id: string;
    server_id: string;
    node_id: string | null;
    job_id: string | null;
    log_cursor: number;
    created_at: Date;
  }[];

  return rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    nodeId: row.node_id,
    jobId: row.job_id,
    logCursor: row.log_cursor,
    createdAt: row.created_at,
  }));
}

/** Store a poll's progress reading. */
export async function updateBackupProgress(
  backupId: string,
  phase: string,
  percent: number,
  logCursor: number,
): Promise<void> {
  await sql`
    UPDATE server_backups
    SET phase = ${phase}, percent = ${percent}, log_cursor = ${logCursor}, updated_at = now()
    WHERE id = ${backupId}
  `;
}

/** Store a finished job's outcome. */
export async function completeBackup(
  backupId: string,
  result: {
    snapshotId?: string;
    bytesProcessed?: number;
    bytesAdded?: number;
    databases?: string[];
  },
  logCursor: number,
): Promise<void> {
  await sql`
    UPDATE server_backups
    SET status = 'succeeded', phase = 'finished', percent = 100,
        snapshot_id = COALESCE(${result.snapshotId ?? null}, snapshot_id),
        bytes_processed = ${result.bytesProcessed ?? null},
        bytes_added = ${result.bytesAdded ?? null},
        databases = ${sql.json((result.databases ?? []) as never)},
        job_id = NULL, log_cursor = ${logCursor},
        finished_at = now(), updated_at = now()
    WHERE id = ${backupId}
  `;
}

/**
 * Servers the schedule should back up, with their nodes.
 *
 * Filtered here rather than in the scheduler so the "which servers?" rule has
 * one home: not suspended (their containers are stopped pending review), not
 * still installing (there is nothing to snapshot yet), opted in, and not already
 * running a backup.
 */
export async function listServersDueForBackup(): Promise<
  { id: string; name: string; nodeId: string }[]
> {
  const rows = (await sql`
    SELECT s.id, s.name, s.node_id
    FROM servers s
    WHERE s.backups_enabled = TRUE
      AND s.status NOT IN ('suspended', 'installing', 'error')
      AND NOT EXISTS (
        SELECT 1 FROM server_backups b
        WHERE b.server_id = s.id AND b.status IN ('pending', 'running')
      )
    ORDER BY s.created_at ASC
  `) as { id: string; name: string; node_id: string }[];

  return rows.map((row) => ({ id: row.id, name: row.name, nodeId: row.node_id }));
}

/**
 * Whether a server already has a scheduled backup for the current cron tick.
 *
 * Guards against a double fire: the scheduler runs more often than any schedule,
 * so the same due minute is evaluated on several ticks. Keyed on a time window
 * rather than a stored "last run" marker so a panel restart cannot lose it.
 */
export async function hasScheduledBackupSince(
  serverId: string,
  since: Date,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM server_backups
    WHERE server_id = ${serverId}
      AND trigger = 'scheduled'
      AND created_at >= ${since}
    LIMIT 1
  `) as { 1: number }[];
  return rows.length > 0;
}

// --- Admin connection test ---------------------------------------------------------

/**
 * Verify the S3 destination from a real node.
 *
 * Runs against a node rather than from the panel because the node is what has to
 * reach S3 — a panel that can see the bucket proves nothing about a node behind
 * a different egress path. It probes a *repository* path, not just the bucket,
 * because the credential that can list but not write is the one operators
 * actually misconfigure.
 */
export async function testBackupDestination(
  nodeId: string,
  probeServerId: string,
): Promise<{ reachable: boolean; initialised: boolean; detail: string }> {
  const settings = await getBackupSettings();
  if (!settings.endpoint || !settings.bucket || !settings.accessKeyId) {
    throw badRequest("Enter an endpoint, bucket, region and access key before testing.");
  }
  if (!settings.secretAccessKeyEncrypted) {
    throw badRequest("Enter the S3 secret access key before testing.");
  }

  const repo = await buildRepoTarget(probeServerId, {
    ...settings,
    // The destination may be complete but not yet switched on; a test that
    // required `enabled` would make the button useless exactly when it is needed.
    enabled: true,
  });
  return checkNodeBackupRepository(nodeId, probeServerId, repo);
}

/**
 * Snapshots actually present in a server's repository.
 *
 * The panel's rows are its own record; this is the ground truth. Exposed so an
 * operator can see whether S3 holds something the panel does not know about
 * (a restore from a rebuilt panel, say) rather than having to trust the table.
 */
export async function listRepositorySnapshots(
  serverId: string,
): Promise<{ id: string; time: string; tags: string[] }[]> {
  const server = await loadServerForBackup(serverId);
  const settings = await getBackupSettings();
  const repo = await buildRepoTarget(serverId, settings);
  return listNodeSnapshots(server.nodeId, serverId, repo);
}
