/**
 * Server migration routes (see `docs/server-migration.md`).
 *
 * **Admin-only, all of them, including the reads.** Everything else in the
 * panel that acts on a server is gated on the owner or a subuser flag, and this
 * deliberately is not. A migration is an operator decision about the fleet, not
 * a server setting: it decides which machine's disk and CPU somebody's game
 * runs on, it can be refused for reasons about other tenants' capacity, and its
 * log names nodes, host paths and free space that are none of an owner's
 * business. There is no `migrate` subuser flag and there should not be one.
 *
 * The owner is not kept in the dark, though. While a migration runs their
 * server sits in `migrating`, the shell says so, and every action is refused
 * with a reason (`assertNotMigrating` in `services/serverManager.ts`).
 */

import { requireAdmin } from "../auth/middleware";
import {
  badRequest,
  json,
  parseJsonBody,
  requireUuidParam,
} from "../lib/http";
import {
  cancelServerMigration,
  getActiveMigration,
  getServerMigration,
  listMigrationLogs,
  listServerMigrations,
  preflightMigration,
  startServerMigration,
} from "../services/serverMigration";

/**
 * GET /api/admin/servers/:id/migrations. History plus whatever is in flight.
 *
 * One round trip, because the dialog cannot draw anything without both: an
 * active migration is what it follows, and the history is what tells an
 * operator whether this server has been moved before and how that went.
 */
export async function handleListServerMigrations(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireAdmin(request);

  const [migrations, active] = await Promise.all([
    listServerMigrations(id),
    getActiveMigration(id),
  ]);

  return json({ migrations, active });
}

/**
 * POST /api/admin/servers/:id/migrations/preflight. Body: `{ destinationNodeId }`.
 *
 * Runs every check without changing anything, so the dialog can show the
 * verdict before the admin commits. Deliberately a POST rather than a GET with
 * a query parameter: it talks to two agents, measures a directory and probes
 * ports, which is not a request anything should be free to repeat from a
 * prefetch or a browser's address bar.
 */
export async function handlePreflightServerMigration(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireAdmin(request);

  const body = await parseJsonBody(request);
  if (typeof body.destinationNodeId !== "string") {
    throw badRequest('"destinationNodeId" is required.');
  }
  const destinationNodeId = requireUuidParam(
    body.destinationNodeId,
    "destinationNodeId",
  );

  return json({ preflight: await preflightMigration(id, destinationNodeId) });
}

/**
 * POST /api/admin/servers/:id/migrations. Starts one.
 *
 * 202, not 201: the migration has been accepted, not completed. The response
 * carries the row so the dialog can start polling it immediately, which is the
 * only way an admin sees what is happening — the work outlives this request by
 * minutes or hours.
 */
export async function handleStartServerMigration(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const user = await requireAdmin(request);

  const body = await parseJsonBody(request);
  if (typeof body.destinationNodeId !== "string") {
    throw badRequest('"destinationNodeId" is required.');
  }
  const destinationNodeId = requireUuidParam(
    body.destinationNodeId,
    "destinationNodeId",
  );

  const migration = await startServerMigration({
    serverId: id,
    destinationNodeId,
    actorId: user.id,
    acknowledgeNoBackup: body.acknowledgeNoBackup === true,
    compress: body.compress === true,
  });

  // No audit entry here: `startServerMigration` writes `server.migrate` itself,
  // on acceptance, with the nodes and the data size. A second entry from the
  // route would put two rows in the activity feed for one action.
  return json({ migration }, 202);
}

/** GET /api/admin/servers/:id/migrations/:migrationId. One migration's state. */
export async function handleGetServerMigration(
  request: Request,
  serverId: string,
  migrationId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const runId = requireUuidParam(migrationId, "migrationId");
  await requireAdmin(request);

  return json({ migration: await getServerMigration(id, runId) });
}

/**
 * GET /api/admin/servers/:id/migrations/:migrationId/logs?afterSeq=N.
 *
 * `afterSeq` is what makes the live tail cheap: the browser polls with the
 * highest sequence number it already has and receives only what is new, rather
 * than re-downloading an hour-long log every two seconds. Same contract as the
 * backup log tail.
 *
 * The migration's own state comes back alongside the lines, so the dialog does
 * not need a second poll to know whether the thing it is tailing has finished.
 */
export async function handleGetServerMigrationLogs(
  request: Request,
  serverId: string,
  migrationId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const runId = requireUuidParam(migrationId, "migrationId");
  await requireAdmin(request);

  // Confirms the migration belongs to this server before any of its log is
  // returned, and gives the caller the state in the same round trip.
  const migration = await getServerMigration(id, runId);

  const afterSeq = Number(new URL(request.url).searchParams.get("afterSeq") ?? "0");
  const logs = await listMigrationLogs(
    runId,
    Number.isFinite(afterSeq) ? Math.max(0, afterSeq) : 0,
  );

  return json({
    logs,
    status: migration.status,
    phase: migration.phase,
    percent: migration.percent,
    bytesTotal: migration.bytesTotal,
    bytesTransferred: migration.bytesTransferred,
    error: migration.error,
    failedPhase: migration.failedPhase,
    rollback: migration.rollback,
    destinationPorts: migration.destinationPorts,
  });
}

/**
 * POST /api/admin/servers/:id/migrations/:migrationId/cancel.
 *
 * Cooperative: it asks, the run unwinds at its next safe point through the same
 * rollback a failure uses. Refused once the cutover has started, because past
 * that the server is on the destination and "stop half way" is not one of the
 * available outcomes.
 */
export async function handleCancelServerMigration(
  request: Request,
  serverId: string,
  migrationId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const runId = requireUuidParam(migrationId, "migrationId");
  const user = await requireAdmin(request);

  return json({ migration: await cancelServerMigration(id, runId, user.id) });
}
