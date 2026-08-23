/**
 * Server file backups, the owner-facing half of the feature.
 *
 * A server backup is a restic snapshot of that server's data directory, and
 * **nothing else**. Its databases are not in it: they live on a MariaDB instance
 * shared with every other server on the node, and reading them needs a
 * root-equivalent credential no server owner holds. Those are backed up at node
 * scope by an administrator (`databaseBackups.ts`). Keeping the two apart is what
 * lets an owner press "back up now" without the panel touching shared
 * infrastructure on everyone else's behalf.
 *
 * Retention is a plain count, `maxPerServer`, default 5, enforced by the agent
 * *before* it writes the new snapshot, so the limit is never briefly exceeded. The
 * agent reports which snapshots it deleted and the reconciler drops the matching
 * rows, which is what keeps this table and the bucket in step.
 */

import { sql } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/http";
import { recordAudit } from "./auditLog";
import { getBackupSettings } from "./settings";
import {
  assertStorageAvailable,
  buildRepoTarget,
  createRun,
  getRun,
  hasActiveRun,
  markRepositoryInitialized,
  markRunAccepted,
  appendLog,
  failRun,
  trimFailedRuns,
  toRunView,
  type BackupRunView,
  type RunRow,
} from "./backupCore";
import {
  forgetNodeSnapshot,
  listNodeSnapshots,
  startNodeServerBackup,
  startNodeServerRestore,
} from "../nodes/nodeBackupApi";
import {
  getServerState,
  startServerContainer,
  stopServerContainer,
} from "../nodes/nodeServerApi";

/** The server fields a backup needs, or a 404. */
async function loadServer(serverId: string): Promise<{
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

// --- Reads ------------------------------------------------------------------------

/** A server's backup history, newest first. */
export async function listServerBackups(
  serverId: string,
  limit = 50,
): Promise<BackupRunView[]> {
  const rows = (await sql`
    SELECT * FROM backup_runs
    WHERE scope = 'server' AND server_id = ${serverId}
    ORDER BY created_at DESC
    LIMIT ${Math.min(limit, 200)}
  `) as RunRow[];
  return rows.map(toRunView);
}

/** One of a server's runs, or a 404. Verifies the run belongs to the server. */
export async function getServerBackup(
  serverId: string,
  runId: string,
): Promise<BackupRunView> {
  const run = await getRun(runId);
  if (run.scope !== "server" || run.serverId !== serverId) {
    throw notFound("Backup not found.");
  }
  return run;
}

/** How many completed backups this server currently has, against its limit. */
export async function countServerBackups(serverId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM backup_runs
    WHERE scope = 'server' AND server_id = ${serverId}
      AND kind = 'backup' AND status = 'succeeded'
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

// --- Starting a run ----------------------------------------------------------------

export interface StartServerBackupInput {
  serverId: string;
  actorId: string | null;
  trigger: "manual" | "scheduled";
}

/**
 * Start a backup of a server's files.
 *
 * The row is written before the agent is called, so an unreachable node leaves a
 * durable `failed` record rather than nothing at all.
 *
 * A suspended server is refused: its container is stopped and its owner is under
 * review, and continuing to bill the operator's bucket for it is not what anyone
 * configured.
 */
export async function startServerBackup(
  input: StartServerBackupInput,
): Promise<BackupRunView> {
  const server = await loadServer(input.serverId);

  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be backed up.",
    );
  }
  if (await hasActiveRun("server", input.serverId)) {
    throw conflict("A backup or restore is already running for this server.");
  }

  // Refuse before touching the node, so an operator at their storage limit gets a
  // clear message instead of an invoice.
  await assertStorageAvailable();

  const settings = await getBackupSettings();
  const repo = await buildRepoTarget("server", input.serverId, settings);
  const keepMax = settings.servers.maxPerServer;

  const run = await createRun({
    scope: "server",
    serverId: input.serverId,
    nodeId: server.nodeId,
    kind: "backup",
    trigger: input.trigger,
    requestedBy: input.actorId,
  });

  const existing = await countServerBackups(input.serverId);
  await appendLog(
    run.id,
    0,
    "info",
    keepMax > 0 && existing >= keepMax
      ? `Backup requested. This server is at its limit of ${keepMax} backups, so the ` +
          `oldest will be removed to make room for this one.`
      : `Backup requested (files only; databases are backed up by an administrator ` +
          `at node level).`,
  );

  try {
    const { jobId } = await startNodeServerBackup(server.nodeId, input.serverId, {
      repo,
      keepMax,
      reason: input.trigger,
      exclude: settings.servers.exclude,
    });

    await markRunAccepted(run.id, jobId);
    // The agent creates the repository on first backup, so reaching this point
    // means S3 accepted the credentials.
    await markRepositoryInitialized("server", input.serverId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRun(run.id, `The node did not accept the backup: ${message}`);
    await trimFailedRuns("server", input.serverId);
    // Rethrow so the caller's HTTP response says what went wrong, rather than
    // returning a row the user has to go and look at to discover it failed.
    throw error;
  }

  await recordAudit({
    userId: input.actorId,
    action: "server.backup.create",
    targetType: "server",
    targetId: input.serverId,
    metadata: { runId: run.id, trigger: input.trigger, keepMax, bucket: settings.bucket },
  });

  return getServerBackup(input.serverId, run.id);
}

export interface StartServerRestoreInput {
  serverId: string;
  runId: string;
  actorId: string | null;
}

/**
 * Restore a server's files from one of its backups.
 *
 * The server is stopped first and left stopped. Restoring under a running game
 * would have restic writing world files the server has open and cached in memory,
 * and the server would then overwrite half of them on its next save. The stop is
 * not a courtesy, it is what makes the restore mean anything.
 *
 * Leaving it stopped afterwards is also deliberate: the owner should look at the
 * restored server before players reconnect. The UI says so and offers a start
 * button.
 */
export async function startServerRestore(
  input: StartServerRestoreInput,
): Promise<BackupRunView> {
  const server = await loadServer(input.serverId);
  const source = await getServerBackup(input.serverId, input.runId);

  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be restored.",
    );
  }
  if (source.kind !== "backup" || source.status !== "succeeded" || !source.snapshotId) {
    throw badRequest("Only a completed backup can be restored.");
  }
  if (await hasActiveRun("server", input.serverId)) {
    throw conflict("A backup or restore is already running for this server.");
  }

  const settings = await getBackupSettings();
  const repo = await buildRepoTarget("server", input.serverId, settings);

  const run = await createRun({
    scope: "server",
    serverId: input.serverId,
    nodeId: server.nodeId,
    kind: "restore",
    trigger: "manual",
    requestedBy: input.actorId,
    snapshotId: source.snapshotId,
  });

  try {
    // Stop first. An already-stopped container is a no-op agent-side, and a node
    // that cannot be reached fails the restore here rather than halfway through
    // overwriting the world.
    const state = await getServerState(server.nodeId, input.serverId).catch(() => null);
    if (state === "running" || state === "restarting") {
      await appendLog(run.id, 0, "info", "Stopping the server before restoring its files…");
      await stopServerContainer(server.nodeId, input.serverId);
      await sql`
        UPDATE servers SET status = 'stopped', updated_at = now() WHERE id = ${input.serverId}
      `;
    }

    await appendLog(
      run.id,
      1,
      "info",
      `Restoring files from the backup taken ${source.createdAt.toISOString()}. ` +
        `Databases are not part of a server backup and are left untouched.`,
    );

    const { jobId } = await startNodeServerRestore(server.nodeId, input.serverId, {
      repo,
      snapshotId: source.snapshotId,
    });

    await markRunAccepted(run.id, jobId, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRun(run.id, `The node did not accept the restore: ${message}`);
    throw error;
  }

  await recordAudit({
    userId: input.actorId,
    action: "server.backup.restore",
    targetType: "server",
    targetId: input.serverId,
    metadata: {
      runId: run.id,
      sourceRunId: source.id,
      snapshotId: source.snapshotId,
    },
  });

  return getServerBackup(input.serverId, run.id);
}

/**
 * Bring a server back up after a restore, on request.
 *
 * Separate from the restore so the owner decides when players reconnect, and so
 * a restore that only half-worked is not immediately handed back to a live game.
 */
export async function startServerAfterRestore(
  serverId: string,
  actorId: string | null,
): Promise<void> {
  const server = await loadServer(serverId);
  await startServerContainer(server.nodeId, serverId);
  await sql`UPDATE servers SET status = 'running', updated_at = now() WHERE id = ${serverId}`;
  await recordAudit({
    userId: actorId,
    action: "server.start",
    targetType: "server",
    targetId: serverId,
    metadata: { afterRestore: true },
  });
}

// --- Deleting ----------------------------------------------------------------------

/**
 * Delete a backup: drop its snapshot from S3, then its panel row.
 *
 * S3 first. If the panel row went first and the prune then failed, the snapshot
 * would be orphaned, paid for forever with nothing in the UI referencing it. A
 * snapshot the agent reports as already gone is success, so a retried delete
 * completes.
 */
export async function deleteServerBackup(
  serverId: string,
  runId: string,
  actorId: string | null,
): Promise<void> {
  const server = await loadServer(serverId);
  const run = await getServerBackup(serverId, runId);

  if (run.status === "pending" || run.status === "running") {
    throw conflict("This backup is still running. Wait for it to finish before deleting it.");
  }

  if (run.snapshotId) {
    const settings = await getBackupSettings();
    const repo = await buildRepoTarget("server", serverId, settings);
    await forgetNodeSnapshot(
      server.nodeId,
      { scope: "server", id: serverId },
      repo,
      run.snapshotId,
    );
  }

  await sql`DELETE FROM backup_runs WHERE id = ${runId}`;

  await recordAudit({
    userId: actorId,
    action: "server.backup.delete",
    targetType: "server",
    targetId: serverId,
    metadata: { runId, snapshotId: run.snapshotId },
  });
}

// --- Per-server schedule opt-out ------------------------------------------------------

/** Whether the file-backup schedule includes this server. */
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

export async function getServerBackupsEnabled(serverId: string): Promise<boolean> {
  return (await loadServer(serverId)).backupsEnabled;
}

/**
 * Snapshots actually present in a server's repository.
 *
 * The panel's rows are its own record; this is the repository's. Exposed so an
 * operator can see a snapshot the panel does not know about, for instance after
 * rebuilding a panel from scratch, instead of having to take the table on faith.
 */
export async function listServerRepositorySnapshots(
  serverId: string,
): Promise<{ id: string; time: string; tags: string[] }[]> {
  const server = await loadServer(serverId);
  const settings = await getBackupSettings();
  const repo = await buildRepoTarget("server", serverId, settings);
  return listNodeSnapshots(server.nodeId, { scope: "server", id: serverId }, repo);
}

// --- Scheduler support -----------------------------------------------------------------

/**
 * Servers the file-backup schedule should cover.
 *
 * Filtered here rather than in the scheduler so the "which servers?" rule has one
 * home: not suspended (their containers are stopped pending review), not still
 * installing (there is nothing to snapshot yet), opted in, and not already running
 * a backup.
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
        SELECT 1 FROM backup_runs b
        WHERE b.scope = 'server' AND b.server_id = s.id
          AND b.status IN ('pending', 'running')
      )
    ORDER BY s.created_at ASC
  `) as { id: string; name: string; node_id: string }[];

  return rows.map((row) => ({ id: row.id, name: row.name, nodeId: row.node_id }));
}
