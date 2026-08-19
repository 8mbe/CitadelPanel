/**
 * Server backup routes.
 *
 * Permissions follow the `backups` flag, which has existed as a reserved subuser
 * grant since the initial schema and is finally wired up here. The split within
 * it is the one the rest of the panel uses for destructive actions:
 *
 *   - list, status, logs, create -> `backups`
 *   - restore, delete            -> owner or admin only, never delegable
 *
 * Restore overwrites a world and every database dump in the snapshot, and delete
 * destroys the only copy of a point in time. Neither is something to hand to a
 * subuser on the strength of a flag that also means "can press the backup
 * button" — the same reasoning that keeps server deletion off the `settings`
 * grant.
 *
 * Reads gate on the same permission as the mutations, per the project's
 * reads-gate-with-writes rule: a subuser with only `console` must not be able to
 * enumerate a server's backup history.
 */

import { requireAdmin, requireServerOwner, requireServerPermission } from "../auth/middleware";
import {
  badRequest,
  conflict,
  isUuid,
  json,
  noContent,
  notFound,
  requireUuidParam,
} from "../lib/http";
import { parseJsonBody } from "../lib/http";
import { sql } from "../db/client";
import { recordAuditFromRequest } from "../services/auditLog";
import {
  deleteBackup,
  getBackup,
  getServerBackupsEnabled,
  hasActiveBackup,
  listBackupLogs,
  listRepositorySnapshots,
  listServerBackups,
  setServerBackupsEnabled,
  startBackup,
  startRestore,
  startServerAfterRestore,
  testBackupDestination,
} from "../services/backupManager";
import { getPublicBackupSettings } from "../services/settings";
import { runBackupTick } from "../nodes/backupScheduler";
import { isValidCron, nextCronRun, parseCron } from "@/lib/cron";
import { getTimezone } from "../services/settings";

/**
 * GET /api/servers/:id/backups — the server's history, plus the context the UI
 * needs to render the tab in one round trip.
 *
 * Bundled rather than split across three endpoints because the tab cannot draw
 * anything useful without all of it: whether backups are configured at all
 * (otherwise it shows an explanation, not an empty list), the schedule and its
 * next run, and whether this server opts in.
 */
export async function handleListServerBackups(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "backups");

  const [backups, settings, enabled, timezone] = await Promise.all([
    listServerBackups(id),
    getPublicBackupSettings(),
    getServerBackupsEnabled(id),
    getTimezone(),
  ]);

  // The next run is computed here rather than in the browser so it is in the
  // panel's timezone, which the browser has no reason to know.
  let nextRun: string | null = null;
  if (settings.usable && settings.schedule && isValidCron(settings.schedule)) {
    nextRun = nextCronRun(parseCron(settings.schedule), new Date(), timezone)?.toISOString() ?? null;
  }

  return json({
    backups,
    schedule: {
      // Never the credentials — only whether a destination exists and what the
      // schedule is. Everything secret stays in the admin-only settings view.
      configured: settings.usable,
      cron: settings.schedule,
      nextRun,
      timezone,
      retention: settings.retention,
      enabledForServer: enabled,
    },
    active: await hasActiveBackup(id),
  });
}

/** GET /api/servers/:id/backups/:backupId — one run's current state. */
export async function handleGetServerBackup(
  request: Request,
  serverId: string,
  backupId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const runId = requireUuidParam(backupId, "backupId");
  await requireServerPermission(request, id, "backups");

  return json({ backup: await getBackup(id, runId) });
}

/**
 * GET /api/servers/:id/backups/:backupId/logs?afterSeq=N — the run's log.
 *
 * `afterSeq` is what makes a live tail cheap: while a backup runs the browser
 * polls with the highest sequence number it has and receives only new lines
 * rather than re-downloading a growing log every couple of seconds.
 */
export async function handleGetServerBackupLogs(
  request: Request,
  serverId: string,
  backupId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const runId = requireUuidParam(backupId, "backupId");
  await requireServerPermission(request, id, "backups");

  // Confirms the run belongs to this server before returning any of its log.
  const backup = await getBackup(id, runId);

  const afterSeq = Number(new URL(request.url).searchParams.get("afterSeq") ?? "0");
  const logs = await listBackupLogs(runId, Number.isFinite(afterSeq) ? Math.max(0, afterSeq) : 0);

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
 * 202, not 201: the work has been accepted, not completed. The response carries
 * the run so the UI can begin polling it immediately.
 *
 * One tick of the scheduler is forced before responding, which turns the row from
 * `pending` into `running` with real progress within a second instead of after
 * the tick interval. It is a latency optimisation, not a correctness requirement —
 * the timer would get there anyway.
 */
export async function handleCreateServerBackup(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "backups");

  const backup = await startBackup({ serverId: id, actorId: user.id, trigger: "manual" });

  // Best-effort: a failure here only costs a slower first progress update.
  await runBackupTick().catch(() => undefined);

  return json({ backup }, 202);
}

/**
 * POST /api/servers/:id/backups/:backupId/restore — restore from a backup.
 *
 * Owner or admin only. This overwrites the server's data directory and every
 * database in the snapshot, so it is not delegable to a subuser holding the
 * `backups` flag.
 *
 * The server is stopped as part of the restore and left stopped — see
 * `backupManager.startRestore` for why.
 */
export async function handleRestoreServerBackup(
  request: Request,
  serverId: string,
  backupId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const runId = requireUuidParam(backupId, "backupId");
  const { user } = await requireServerOwner(request, id);

  const restore = await startRestore({ serverId: id, backupId: runId, actorId: user.id });
  await runBackupTick().catch(() => undefined);

  return json({ backup: restore }, 202);
}

/**
 * POST /api/servers/:id/backups/start-server — bring the server back up after a
 * restore.
 *
 * Separate from the restore so the owner decides when players reconnect, and so
 * a restore that only half-worked is not immediately handed to a live game.
 */
export async function handleStartServerAfterRestore(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  if (await hasActiveBackup(id)) {
    throw conflict(
      "A backup or restore is still running for this server. Wait for it to finish " +
        "before starting the server.",
    );
  }

  await startServerAfterRestore(id, user.id);
  return noContent();
}

/**
 * DELETE /api/servers/:id/backups/:backupId — delete a backup.
 *
 * Owner or admin only: this destroys the only copy of that point in time. The
 * snapshot is removed from S3 before the panel row, so a failure leaves a row
 * pointing at real data rather than an orphaned snapshot billed forever.
 */
export async function handleDeleteServerBackup(
  request: Request,
  serverId: string,
  backupId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const runId = requireUuidParam(backupId, "backupId");
  const { user } = await requireServerOwner(request, id);

  await deleteBackup(id, runId, user.id);
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
 * The panel's rows are its own record; this is the repository's. Exposed so an
 * operator can see a snapshot the panel does not know about — after rebuilding a
 * panel from scratch, say — instead of having to take the table on faith.
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

  return json({ snapshots: await listRepositorySnapshots(id) });
}

/**
 * POST /api/admin/backups/test — verify the S3 destination from a real node.
 *
 * Admin only. Runs on a node rather than from the panel because the node is what
 * has to reach S3; a panel that can see the bucket proves nothing about a node
 * behind a different egress path.
 *
 * The probe needs a server id to address a repository path, so it borrows one:
 * the caller may name a server, otherwise the oldest one is used. A panel with no
 * servers cannot be tested this way and is told so, which is fine — there is
 * nothing to back up yet either.
 */
export async function handleTestBackupDestination(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const body = await parseJsonBody(request);

  let probeServerId: string | null = null;
  if (typeof body.serverId === "string" && body.serverId.length > 0) {
    if (!isUuid(body.serverId)) throw badRequest('"serverId" must be a UUID.');
    probeServerId = body.serverId;
  }

  const rows = (await sql`
    SELECT s.id, s.node_id
    FROM servers s
    WHERE (${probeServerId}::uuid IS NULL OR s.id = ${probeServerId}::uuid)
      AND s.status NOT IN ('installing', 'error')
    ORDER BY s.created_at ASC
    LIMIT 1
  `) as { id: string; node_id: string }[];

  const probe = rows[0];
  if (!probe) {
    throw notFound(
      "There is no server available to test the destination against. The test runs " +
        "on a node, because the node is what has to reach S3 — create a server first.",
    );
  }

  const result = await testBackupDestination(probe.node_id, probe.id);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "settings.update",
    targetType: "settings",
    targetId: "backups",
    metadata: {
      test: "s3-destination",
      viaNode: probe.node_id,
      reachable: result.reachable,
    },
  });

  return json(result);
}

/**
 * POST /api/admin/backups/preview-schedule — validate a cron expression and show
 * the next few runs.
 *
 * Server-side rather than in the form's own JavaScript so the preview is computed
 * in the panel's timezone with the same parser the scheduler uses — a schedule can
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
    // The parser's messages are written for the operator who typed the
    // expression, so they pass straight through as the 400 body.
    throw badRequest(error instanceof Error ? error.message : "Invalid schedule.");
  }

  const { describeCron } = await import("@/lib/cron");
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
