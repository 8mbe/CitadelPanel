/**
 * Backup routes, for both scopes.
 *
 * **Server file backups** are gated on the `backups` subuser flag, which has been
 * a reserved grant since the initial schema and is wired up here. Within it:
 *
 *   - list, status, logs, create -> `backups`
 *   - restore, delete            -> owner or admin only, never delegable
 *
 * Restore overwrites a world and delete destroys the only copy of a point in time.
 * Neither is something to hand to a subuser on the strength of a flag that also
 * means "can press the backup button" — the same reasoning that keeps server
 * deletion off the `settings` grant.
 *
 * **Node database backups** are admin-only throughout. They read every database on
 * a node using its root-equivalent MariaDB admin credential, so there is no version
 * of this that a server owner should be able to trigger.
 *
 * Reads gate with writes, per the project rule: a subuser with only `console` must
 * not be able to enumerate a server's backup history.
 */

import { requireAdmin, requireServerOwner, requireServerPermission } from "../auth/middleware";
import {
  badRequest,
  conflict,
  isUuid,
  json,
  noContent,
  notFound,
  parseJsonBody,
  requireUuidParam,
} from "../lib/http";
import { sql } from "../db/client";
import { recordAuditFromRequest } from "../services/auditLog";
import {
  buildRepoTarget,
  getStorageReport,
  listRunLogs,
} from "../services/backupCore";
import {
  countServerBackups,
  deleteServerBackup,
  getServerBackup,
  getServerBackupsEnabled,
  listServerBackups,
  listServerRepositorySnapshots,
  setServerBackupsEnabled,
  startServerAfterRestore,
  startServerBackup,
  startServerRestore,
} from "../services/serverBackups";
import {
  deleteNodeDatabaseBackup,
  getNodeDatabaseBackup,
  listNodeDatabaseBackupSummaries,
  listNodeDatabaseBackups,
  listNodeRepositorySnapshots,
  setNodeDatabaseBackupsEnabled,
  startDatabaseBackup,
  startDatabaseRestore,
} from "../services/databaseBackups";
import { getBackupSettings, getPublicBackupSettings, getTimezone } from "../services/settings";
import { checkNodeBackupRepository } from "../nodes/nodeBackupApi";
import { runBackupTick } from "../nodes/backupScheduler";
import { describeCron, isValidCron, nextCronRun, parseCron } from "@/lib/cron";

// --- Server file backups --------------------------------------------------------------

/**
 * GET /api/servers/:id/backups — history plus the context the tab needs in one
 * round trip.
 *
 * Bundled rather than split across endpoints because the tab cannot draw anything
 * useful without all of it: whether backups are configured at all (otherwise it
 * shows an explanation, not an empty list), the schedule and its next run, the
 * quota and how much of it is used, and whether this server opts in.
 */
export async function handleListServerBackups(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "backups");

  const [backups, settings, enabled, timezone, used] = await Promise.all([
    listServerBackups(id),
    getPublicBackupSettings(),
    getServerBackupsEnabled(id),
    getTimezone(),
    countServerBackups(id),
  ]);

  // The next run is computed here rather than in the browser so it is in the
  // panel's timezone, which the browser has no reason to know.
  let nextRun: string | null = null;
  const schedule = settings.servers.schedule;
  if (settings.usable && schedule && isValidCron(schedule)) {
    nextRun = nextCronRun(parseCron(schedule), new Date(), timezone)?.toISOString() ?? null;
  }

  return json({
    backups,
    schedule: {
      // Never the credentials — only whether a destination exists and what the
      // schedule is. Everything secret stays in the admin-only settings view.
      configured: settings.usable,
      cron: schedule,
      nextRun,
      timezone,
      enabledForServer: enabled,
    },
    quota: {
      /** Completed backups kept for this server. */
      used,
      /** Most that will be kept; a new backup removes the oldest. 0 = unlimited. */
      max: settings.servers.maxPerServer,
    },
    active: backups.some((run) => run.status === "pending" || run.status === "running"),
  });
}

/** GET /api/servers/:id/backups/:runId — one run's current state. */
export async function handleGetServerBackup(
  request: Request,
  serverId: string,
  runId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const backupId = requireUuidParam(runId, "backupId");
  await requireServerPermission(request, id, "backups");

  return json({ backup: await getServerBackup(id, backupId) });
}

/**
 * GET /api/servers/:id/backups/:runId/logs?afterSeq=N — the run's log.
 *
 * `afterSeq` is what makes a live tail cheap: while a backup runs the browser polls
 * with the highest sequence number it has and receives only new lines rather than
 * re-downloading a growing log every couple of seconds.
 */
export async function handleGetServerBackupLogs(
  request: Request,
  serverId: string,
  runId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const backupId = requireUuidParam(runId, "backupId");
  await requireServerPermission(request, id, "backups");

  // Confirms the run belongs to this server before returning any of its log.
  const backup = await getServerBackup(id, backupId);

  const afterSeq = Number(new URL(request.url).searchParams.get("afterSeq") ?? "0");
  const logs = await listRunLogs(backupId, Number.isFinite(afterSeq) ? Math.max(0, afterSeq) : 0);

  return json({
    logs,
    status: backup.status,
    phase: backup.phase,
    percent: backup.percent,
    error: backup.error,
  });
}

/**
 * POST /api/servers/:id/backups — start a backup.
 *
 * 202, not 201: the work has been accepted, not completed. The response carries the
 * run so the UI can begin polling it immediately.
 *
 * One tick of the scheduler is forced before responding, which turns the row from
 * `pending` into `running` with real progress within a second instead of after the
 * tick interval. A latency optimisation, not a correctness requirement.
 */
export async function handleCreateServerBackup(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "backups");

  const backup = await startServerBackup({ serverId: id, actorId: user.id, trigger: "manual" });
  await runBackupTick().catch(() => undefined);

  return json({ backup }, 202);
}

/**
 * POST /api/servers/:id/backups/:runId/restore — restore a server's files.
 *
 * Owner or admin only. Stops the server, overwrites its data directory, and leaves
 * it stopped. Databases are not touched: they are not part of a server backup.
 */
export async function handleRestoreServerBackup(
  request: Request,
  serverId: string,
  runId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const backupId = requireUuidParam(runId, "backupId");
  const { user } = await requireServerOwner(request, id);

  const restore = await startServerRestore({ serverId: id, runId: backupId, actorId: user.id });
  await runBackupTick().catch(() => undefined);

  return json({ backup: restore }, 202);
}

/** POST /api/servers/:id/backups/start-server — start the server after a restore. */
export async function handleStartServerAfterRestore(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  const runs = await listServerBackups(id, 5);
  if (runs.some((run) => run.status === "pending" || run.status === "running")) {
    throw conflict(
      "A backup or restore is still running for this server. Wait for it to finish " +
        "before starting the server.",
    );
  }

  await startServerAfterRestore(id, user.id);
  return noContent();
}

/**
 * DELETE /api/servers/:id/backups/:runId — delete a backup.
 *
 * Owner or admin only: this destroys the only copy of that point in time.
 */
export async function handleDeleteServerBackup(
  request: Request,
  serverId: string,
  runId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const backupId = requireUuidParam(runId, "backupId");
  const { user } = await requireServerOwner(request, id);

  await deleteServerBackup(id, backupId, user.id);
  return noContent();
}

/**
 * PATCH /api/servers/:id/backups/settings — per-server schedule opt-out.
 *
 * Requires `settings` rather than `backups`: whether a server participates in the
 * fleet's schedule is a property of the server, alongside its resources and env,
 * not an action on its backups.
 */
export async function handleUpdateServerBackupSettings(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "settings");

  const body = await parseJsonBody(request);
  if (typeof body.enabled !== "boolean") {
    throw badRequest('"enabled" must be a boolean.');
  }

  await setServerBackupsEnabled(id, body.enabled, user.id);
  return json({ enabledForServer: body.enabled });
}

/**
 * GET /api/servers/:id/backups/snapshots — what S3 actually holds.
 *
 * Owner or admin: it reaches out to S3 on every call, which is not something a
 * subuser should be able to trigger in a loop.
 */
export async function handleListRepositorySnapshots(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerOwner(request, id);

  return json({ snapshots: await listServerRepositorySnapshots(id) });
}

// --- Node database backups (admin) ------------------------------------------------------

/**
 * GET /api/admin/backups/databases — per-node database backup status.
 *
 * The admin page's database section: one row per node with its database count,
 * whether it is scheduled, and its last run.
 */
export async function handleListDatabaseBackupNodes(request: Request): Promise<Response> {
  await requireAdmin(request);

  const [nodes, settings, timezone] = await Promise.all([
    listNodeDatabaseBackupSummaries(),
    getPublicBackupSettings(),
    getTimezone(),
  ]);

  let nextRun: string | null = null;
  const schedule = settings.databases.schedule;
  if (settings.usable && schedule && isValidCron(schedule)) {
    nextRun = nextCronRun(parseCron(schedule), new Date(), timezone)?.toISOString() ?? null;
  }

  return json({
    nodes,
    schedule: {
      configured: settings.usable,
      cron: schedule,
      nextRun,
      timezone,
      maxPerNode: settings.databases.maxPerNode,
    },
  });
}

/** GET /api/admin/backups/databases/:nodeId — one node's database backup history. */
export async function handleListNodeDatabaseBackups(
  request: Request,
  nodeId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");
  return json({ backups: await listNodeDatabaseBackups(id) });
}

/** POST /api/admin/backups/databases/:nodeId — back up every database on a node. */
export async function handleCreateNodeDatabaseBackup(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const backup = await startDatabaseBackup({ nodeId: id, actorId: admin.id, trigger: "manual" });
  await runBackupTick().catch(() => undefined);

  return json({ backup }, 202);
}

/**
 * GET /api/admin/backups/databases/:nodeId/runs/:runId/logs — a run's log tail.
 *
 * Same cursor protocol as the server-scope logs, so the admin page can reuse the
 * live-tail component.
 */
export async function handleGetNodeDatabaseBackupLogs(
  request: Request,
  nodeId: string,
  runId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");
  const backupId = requireUuidParam(runId, "runId");

  const backup = await getNodeDatabaseBackup(id, backupId);
  const afterSeq = Number(new URL(request.url).searchParams.get("afterSeq") ?? "0");
  const logs = await listRunLogs(backupId, Number.isFinite(afterSeq) ? Math.max(0, afterSeq) : 0);

  return json({
    logs,
    status: backup.status,
    phase: backup.phase,
    percent: backup.percent,
    error: backup.error,
  });
}

/**
 * POST /api/admin/backups/databases/:nodeId/runs/:runId/restore — restore a node's
 * databases.
 *
 * The most destructive operation in the panel: it overwrites the live contents of
 * every database in the snapshot, across every tenant on that node.
 */
export async function handleRestoreNodeDatabaseBackup(
  request: Request,
  nodeId: string,
  runId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");
  const backupId = requireUuidParam(runId, "runId");

  const restore = await startDatabaseRestore({
    nodeId: id,
    runId: backupId,
    actorId: admin.id,
  });
  await runBackupTick().catch(() => undefined);

  return json({ backup: restore }, 202);
}

/** DELETE /api/admin/backups/databases/:nodeId/runs/:runId — delete a snapshot. */
export async function handleDeleteNodeDatabaseBackup(
  request: Request,
  nodeId: string,
  runId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");
  const backupId = requireUuidParam(runId, "runId");

  await deleteNodeDatabaseBackup(id, backupId, admin.id);
  return noContent();
}

/** PATCH /api/admin/backups/databases/:nodeId — include this node in the schedule. */
export async function handleUpdateNodeDatabaseBackupSettings(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const body = await parseJsonBody(request);
  if (typeof body.enabled !== "boolean") {
    throw badRequest('"enabled" must be a boolean.');
  }

  await setNodeDatabaseBackupsEnabled(id, body.enabled, admin.id);
  return json({ enabled: body.enabled });
}

/** GET /api/admin/backups/databases/:nodeId/snapshots — what S3 actually holds. */
export async function handleListNodeRepositorySnapshots(
  request: Request,
  nodeId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");
  return json({ snapshots: await listNodeRepositorySnapshots(id) });
}

// --- Storage, testing and schedule preview (admin) ---------------------------------------

/**
 * GET /api/admin/backups/storage — used / allowed / total, for the one-line report.
 *
 * `used` is summed from per-repository sizes recorded after each backup rather than
 * measured live: measuring means one `restic stats` container per repository, which
 * on a large fleet is hundreds of container starts for a page load. `unmeasured`
 * travels with it so the figure is honest about being a floor rather than being
 * presented as complete.
 */
export async function handleGetBackupStorage(request: Request): Promise<Response> {
  await requireAdmin(request);
  return json(await getStorageReport());
}

/**
 * POST /api/admin/backups/test — verify the S3 destination from a real node.
 *
 * Runs on a node rather than from the panel because the node is what has to reach
 * S3; a panel that can see the bucket proves nothing about a node behind a
 * different egress path. It probes a *repository* path rather than merely listing
 * the bucket, because the credential that can list but not write is the one
 * operators actually misconfigure.
 *
 * The probe borrows a subject to address a repository path: the caller may name a
 * node, otherwise the oldest active one is used. Node scope rather than server
 * scope so a panel with no servers yet can still be tested — configuring backups
 * before creating servers is the sensible order.
 */
export async function handleTestBackupDestination(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const body = await parseJsonBody(request);

  let probeNodeId: string | null = null;
  if (typeof body.nodeId === "string" && body.nodeId.length > 0) {
    if (!isUuid(body.nodeId)) throw badRequest('"nodeId" must be a UUID.');
    probeNodeId = body.nodeId;
  }

  const rows = (await sql`
    SELECT id, name FROM nodes
    WHERE (${probeNodeId}::uuid IS NULL OR id = ${probeNodeId}::uuid)
    ORDER BY is_active DESC, created_at ASC
    LIMIT 1
  `) as { id: string; name: string }[];

  const probe = rows[0];
  if (!probe) {
    throw notFound(
      "There is no node to test the destination against. The test runs on a node, " +
        "because the node is what has to reach S3 — register a node first.",
    );
  }

  // `allowDisabled` so the button works while the destination is entered but not
  // yet switched on, which is exactly when an operator wants to test it.
  const settings = await getBackupSettings();
  if (!settings.endpoint || !settings.bucket || !settings.accessKeyId) {
    throw badRequest("Enter an endpoint, bucket, region and access key before testing.");
  }
  if (!settings.secretAccessKeyEncrypted) {
    throw badRequest("Enter and save the S3 secret access key before testing.");
  }

  const repo = await buildRepoTarget("node", probe.id, settings, { allowDisabled: true });
  const result = await checkNodeBackupRepository(
    probe.id,
    { scope: "node", id: probe.id },
    repo,
  );

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "settings.update",
    targetType: "settings",
    targetId: "backups",
    metadata: {
      test: "s3-destination",
      viaNode: probe.name,
      reachable: result.reachable,
      useTls: settings.useTls,
    },
  });

  return json({ ...result, viaNode: probe.name });
}

/**
 * POST /api/admin/backups/preview-schedule — validate a cron expression and show
 * the next few runs.
 *
 * Server-side rather than in the form's own JavaScript so the preview is computed in
 * the panel's timezone with the same parser the scheduler uses — a schedule can
 * never preview one thing and then do another.
 */
export async function handlePreviewBackupSchedule(request: Request): Promise<Response> {
  await requireAdmin(request);
  const body = await parseJsonBody(request);

  if (typeof body.cron !== "string") {
    throw badRequest('"cron" must be a string.');
  }

  const timezone = await getTimezone();

  if (body.cron.trim().length === 0) {
    return json({
      valid: true,
      description: "Manual backups only — no automatic schedule.",
      nextRuns: [],
      timezone,
    });
  }

  let expression;
  try {
    expression = parseCron(body.cron);
  } catch (error) {
    // The parser's messages are written for the operator who typed the expression,
    // so they pass straight through as the 400 body.
    throw badRequest(error instanceof Error ? error.message : "Invalid schedule.");
  }

  const nextRuns: string[] = [];
  let cursor = new Date();
  for (let index = 0; index < 5; index += 1) {
    const next = nextCronRun(expression, cursor, timezone);
    if (!next) break;
    nextRuns.push(next.toISOString());
    cursor = next;
  }

  return json({
    valid: true,
    description: describeCron(expression),
    nextRuns,
    timezone,
  });
}
