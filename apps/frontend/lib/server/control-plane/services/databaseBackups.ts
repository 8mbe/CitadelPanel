/**
 * Node database backups — the administrator-facing half of the feature.
 *
 * One snapshot per node, containing a SQL dump of every database provisioned on
 * that node's shared MariaDB. This is admin-only for a structural reason rather
 * than a policy one: dumping every database at once requires the node's MariaDB
 * admin credential, which is root-equivalent on that instance and which no server
 * owner holds. A per-server database backup would have meant the owner-triggered
 * path reaching into infrastructure shared by every other tenant.
 *
 * The dumps carry **data only** — no `mysql.user`, no grants. The panel is already
 * the source of truth for database credentials (it stores each scoped user's
 * password encrypted), so a restore re-imports the data and the panel can
 * re-provision the users. That also means a snapshot never contains another
 * tenant's password hashes.
 */

import { sql } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/http";
import { recordAudit } from "./auditLog";
import { getBackupSettings } from "./settings";
import { getNodeWithSecrets } from "../nodes/nodeRegistry";
import {
  appendLog,
  assertStorageAvailable,
  buildRepoTarget,
  createRun,
  failRun,
  getRun,
  hasActiveRun,
  markRepositoryInitialized,
  markRunAccepted,
  toRunView,
  trimFailedRuns,
  type BackupRunView,
  type RunRow,
} from "./backupCore";
import {
  forgetNodeSnapshot,
  listNodeSnapshots,
  startNodeDatabaseBackup,
  startNodeDatabaseRestore,
  type AgentDbAdmin,
} from "../nodes/nodeBackupApi";

/**
 * The node's MariaDB admin credential, or a clear refusal.
 *
 * A node without one configured cannot have its databases dumped — and the fix is
 * an operator action (`setup-db` plus re-registering the node), so the message says
 * that rather than surfacing a connection error later.
 */
async function requireDbAdmin(nodeId: string): Promise<{ name: string; admin: AgentDbAdmin }> {
  const node = await getNodeWithSecrets(nodeId);
  if (!node) throw notFound("Node not found.");

  if (!node.db.host || !node.db.user || !node.db.password) {
    throw conflict(
      `Node "${node.name}" has no database server configured, so its databases ` +
        `cannot be backed up. Run "bun run setup-db" on that node and set its DB ` +
        `admin credentials when registering it.`,
    );
  }
  return { name: node.name, admin: { user: node.db.user, password: node.db.password } };
}

/** Every database name provisioned on a node. */
async function listNodeDatabaseNames(nodeId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT db_name FROM server_databases WHERE node_id = ${nodeId}
    ORDER BY db_name ASC
  `) as { db_name: string }[];
  return rows.map((row) => row.db_name);
}

// --- Reads --------------------------------------------------------------------------

/** One node's database-backup history, newest first. */
export async function listNodeDatabaseBackups(
  nodeId: string,
  limit = 50,
): Promise<BackupRunView[]> {
  const rows = (await sql`
    SELECT * FROM backup_runs
    WHERE scope = 'node' AND node_id = ${nodeId}
    ORDER BY created_at DESC
    LIMIT ${Math.min(limit, 200)}
  `) as RunRow[];
  return rows.map(toRunView);
}

/** One node-scope run, or a 404. Verifies the run belongs to the node. */
export async function getNodeDatabaseBackup(
  nodeId: string,
  runId: string,
): Promise<BackupRunView> {
  const run = await getRun(runId);
  if (run.scope !== "node" || run.nodeId !== nodeId) {
    throw notFound("Backup not found.");
  }
  return run;
}

/** Per-node summary for the admin page: is it configured, how many DBs, last run. */
export interface NodeDatabaseBackupSummary {
  nodeId: string;
  nodeName: string;
  /** Whether the node has DB admin credentials at all. */
  hasDatabaseServer: boolean;
  /** Whether the schedule includes this node. */
  enabled: boolean;
  databaseCount: number;
  lastRun: BackupRunView | null;
  /** Completed snapshots currently kept for this node. */
  backupCount: number;
}

export async function listNodeDatabaseBackupSummaries(): Promise<NodeDatabaseBackupSummary[]> {
  const nodes = (await sql`
    SELECT
      n.id, n.name, n.database_backups_enabled,
      (n.db_admin_host IS NOT NULL AND n.db_admin_user IS NOT NULL) AS has_db,
      (SELECT COUNT(*)::int FROM server_databases d WHERE d.node_id = n.id) AS db_count,
      (
        SELECT COUNT(*)::int FROM backup_runs b
        WHERE b.scope = 'node' AND b.node_id = n.id
          AND b.kind = 'backup' AND b.status = 'succeeded'
      ) AS backup_count
    FROM nodes n
    ORDER BY n.name ASC
  `) as {
    id: string;
    name: string;
    database_backups_enabled: boolean;
    has_db: boolean;
    db_count: number;
    backup_count: number;
  }[];

  // One query per node for the last run rather than a lateral join: the node count
  // is small (tens at most), and this keeps the SQL legible.
  return Promise.all(
    nodes.map(async (node) => {
      const runs = (await sql`
        SELECT * FROM backup_runs
        WHERE scope = 'node' AND node_id = ${node.id}
        ORDER BY created_at DESC LIMIT 1
      `) as RunRow[];

      return {
        nodeId: node.id,
        nodeName: node.name,
        hasDatabaseServer: node.has_db,
        enabled: node.database_backups_enabled,
        databaseCount: node.db_count,
        lastRun: runs[0] ? toRunView(runs[0]) : null,
        backupCount: node.backup_count,
      };
    }),
  );
}

// --- Starting a run -----------------------------------------------------------------

export interface StartDatabaseBackupInput {
  nodeId: string;
  actorId: string | null;
  trigger: "manual" | "scheduled";
}

/**
 * Back up every database on a node.
 *
 * A node with no databases is refused up front rather than producing an empty
 * snapshot: "backup complete" when nothing was captured is worse than an error.
 */
export async function startDatabaseBackup(
  input: StartDatabaseBackupInput,
): Promise<BackupRunView> {
  const { name, admin } = await requireDbAdmin(input.nodeId);

  if (await hasActiveRun("node", input.nodeId)) {
    throw conflict(`A database backup or restore is already running on node "${name}".`);
  }

  const databases = await listNodeDatabaseNames(input.nodeId);
  if (databases.length === 0) {
    throw badRequest(
      `Node "${name}" has no provisioned databases, so there is nothing to back up.`,
    );
  }

  await assertStorageAvailable();

  const settings = await getBackupSettings();
  const repo = await buildRepoTarget("node", input.nodeId, settings);
  const keepMax = settings.databases.maxPerNode;

  const run = await createRun({
    scope: "node",
    serverId: null,
    nodeId: input.nodeId,
    kind: "backup",
    trigger: input.trigger,
    requestedBy: input.actorId,
    databases,
  });

  await appendLog(
    run.id,
    0,
    "info",
    `Database backup requested for node "${name}": ${databases.length} database` +
      `${databases.length === 1 ? "" : "s"}.`,
  );

  try {
    const { jobId } = await startNodeDatabaseBackup(input.nodeId, {
      repo,
      databases,
      admin,
      keepMax,
      reason: input.trigger,
    });

    await markRunAccepted(run.id, jobId);
    await markRepositoryInitialized("node", input.nodeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRun(run.id, `The node did not accept the database backup: ${message}`);
    await trimFailedRuns("node", input.nodeId);
    throw error;
  }

  await recordAudit({
    userId: input.actorId,
    action: "node.database.backup",
    targetType: "node",
    targetId: input.nodeId,
    metadata: {
      runId: run.id,
      trigger: input.trigger,
      databaseCount: databases.length,
      keepMax,
    },
  });

  return getNodeDatabaseBackup(input.nodeId, run.id);
}

export interface StartDatabaseRestoreInput {
  nodeId: string;
  runId: string;
  actorId: string | null;
}

/**
 * Restore a node's databases from one of its backups.
 *
 * The most destructive operation in the panel: it overwrites the live contents of
 * every database in the snapshot, across every tenant on that node. The route
 * gates it on admin and the UI demands an explicit confirmation; there is nothing
 * more this layer can usefully add beyond refusing to run it concurrently with
 * anything else on the same node.
 *
 * Servers are **not** stopped first. Unlike a file restore — where restic and a
 * running game would fight over the same files — a database import goes through
 * MariaDB, which serialises it correctly. A game holding stale rows in memory is a
 * reason to restart it afterwards, which the UI says, not a reason for the panel to
 * stop every server on the node on its own initiative.
 */
export async function startDatabaseRestore(
  input: StartDatabaseRestoreInput,
): Promise<BackupRunView> {
  const { name, admin } = await requireDbAdmin(input.nodeId);
  const source = await getNodeDatabaseBackup(input.nodeId, input.runId);

  if (source.kind !== "backup" || source.status !== "succeeded" || !source.snapshotId) {
    throw badRequest("Only a completed database backup can be restored.");
  }
  if (await hasActiveRun("node", input.nodeId)) {
    throw conflict(`A database backup or restore is already running on node "${name}".`);
  }

  const settings = await getBackupSettings();
  const repo = await buildRepoTarget("node", input.nodeId, settings);

  const run = await createRun({
    scope: "node",
    serverId: null,
    nodeId: input.nodeId,
    kind: "restore",
    trigger: "manual",
    requestedBy: input.actorId,
    snapshotId: source.snapshotId,
    databases: source.databases,
  });

  await appendLog(
    run.id,
    0,
    "warn",
    `Restoring ${source.databases.length} database` +
      `${source.databases.length === 1 ? "" : "s"} on node "${name}" from the backup ` +
      `taken ${source.createdAt.toISOString()}. Current contents will be overwritten. ` +
      `Restart the affected servers afterwards so they do not keep serving stale rows.`,
  );

  try {
    const { jobId } = await startNodeDatabaseRestore(input.nodeId, {
      repo,
      snapshotId: source.snapshotId,
      databases: source.databases,
      admin,
    });
    await markRunAccepted(run.id, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRun(run.id, `The node did not accept the database restore: ${message}`);
    throw error;
  }

  await recordAudit({
    userId: input.actorId,
    action: "node.database.restore",
    targetType: "node",
    targetId: input.nodeId,
    metadata: {
      runId: run.id,
      sourceRunId: source.id,
      snapshotId: source.snapshotId,
      databases: source.databases,
    },
  });

  return getNodeDatabaseBackup(input.nodeId, run.id);
}

// --- Deleting -----------------------------------------------------------------------

/** Delete a node database backup: snapshot from S3 first, then the panel row. */
export async function deleteNodeDatabaseBackup(
  nodeId: string,
  runId: string,
  actorId: string | null,
): Promise<void> {
  const run = await getNodeDatabaseBackup(nodeId, runId);

  if (run.status === "pending" || run.status === "running") {
    throw conflict("This backup is still running. Wait for it to finish before deleting it.");
  }

  if (run.snapshotId) {
    const settings = await getBackupSettings();
    const repo = await buildRepoTarget("node", nodeId, settings);
    await forgetNodeSnapshot(nodeId, { scope: "node", id: nodeId }, repo, run.snapshotId);
  }

  await sql`DELETE FROM backup_runs WHERE id = ${runId}`;

  await recordAudit({
    userId: actorId,
    action: "node.database.backup.delete",
    targetType: "node",
    targetId: nodeId,
    metadata: { runId, snapshotId: run.snapshotId },
  });
}

// --- Per-node schedule opt-out --------------------------------------------------------

export async function setNodeDatabaseBackupsEnabled(
  nodeId: string,
  enabled: boolean,
  actorId: string | null,
): Promise<void> {
  const updated = (await sql`
    UPDATE nodes SET database_backups_enabled = ${enabled} WHERE id = ${nodeId}
    RETURNING id
  `) as { id: string }[];

  if (updated.length === 0) throw notFound("Node not found.");

  await recordAudit({
    userId: actorId,
    action: "node.update",
    targetType: "node",
    targetId: nodeId,
    metadata: { databaseBackupsEnabled: enabled },
  });
}

/** Snapshots actually present in a node's database repository. */
export async function listNodeRepositorySnapshots(
  nodeId: string,
): Promise<{ id: string; time: string; tags: string[] }[]> {
  const settings = await getBackupSettings();
  const repo = await buildRepoTarget("node", nodeId, settings);
  return listNodeSnapshots(nodeId, { scope: "node", id: nodeId }, repo);
}

// --- Scheduler support ----------------------------------------------------------------

/**
 * Nodes the database-backup schedule should cover.
 *
 * A node needs admin credentials, at least one database, an opt-in, and no run
 * already in flight. Filtered in SQL so the rule lives in one place rather than
 * being re-derived by the scheduler.
 */
export async function listNodesDueForDatabaseBackup(): Promise<
  { id: string; name: string }[]
> {
  const rows = (await sql`
    SELECT n.id, n.name
    FROM nodes n
    WHERE n.database_backups_enabled = TRUE
      AND n.is_active = TRUE
      AND n.db_admin_host IS NOT NULL
      AND n.db_admin_user IS NOT NULL
      AND EXISTS (SELECT 1 FROM server_databases d WHERE d.node_id = n.id)
      AND NOT EXISTS (
        SELECT 1 FROM backup_runs b
        WHERE b.scope = 'node' AND b.node_id = n.id
          AND b.status IN ('pending', 'running')
      )
    ORDER BY n.name ASC
  `) as { id: string; name: string }[];

  return rows.map((row) => ({ id: row.id, name: row.name }));
}
