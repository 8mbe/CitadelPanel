/**
 * Archiving a server: its files go to S3, the node keeps nothing, the panel
 * keeps everything else.
 *
 * See `docs/archive.md` for the whole picture. The short version is that this is
 * the third answer to "this server is not being used", between the two that
 * already existed and unlike either:
 *
 *   - **Stopping** frees the CPU and the memory and keeps the disk, which is the
 *     resource an idle game server actually holds. A world sits there for months.
 *   - **Deleting** frees the disk and destroys the server: the row goes, and with
 *     it the ports, the env, the databases, the subusers and the address players
 *     had bookmarked.
 *   - **Archiving** frees the disk and keeps the server. The files move to the
 *     backup destination, the container and the data directory are removed from
 *     the node, and the row stays exactly as it was, holding the same ports on
 *     the same node, ready to be put back.
 *
 * That last property is what makes automatic archiving safe enough to run on a
 * timer, which is the point of the idle sweep at the bottom of this file. An
 * operator can reclaim a node's disk from servers nobody has started in a
 * fortnight without anybody losing a world, an address, or a subuser grant.
 *
 * ## The commit point
 *
 * Both directions run detached from the request that asked for them, for the
 * reason provisioning does (`serverManager.provisionServer`): an upload of a
 * 30 GB world is minutes to hours of work that no HTTP request should hold open.
 * A detached task dies with the process, so the ordering has to make every
 * interruption recoverable from the row alone.
 *
 * The archive is therefore two phases with one durable commit point between
 * them, and the commit point is **`servers.archive_snapshot_id`**:
 *
 * ```
 *   stop -> snapshot -> [record the snapshot id] -> wipe the node -> 'archived'
 *                        ^^^^^^^^^^^^^^^^^^^^^^
 * ```
 *
 * Before it, nothing on the node has been touched beyond a stop, so a crash is
 * recovered by putting the row back to `stopped`. After it, the files are proved
 * to be in S3, so a crash is recovered by *finishing*: re-running the wipe (the
 * agent treats an already-removed container and an already-deleted directory as
 * done) and writing `archived`. There is no window in which the recovery has to
 * guess, and no window in which it could delete something that is not already
 * safely uploaded. {@link recoverInterruptedArchives} is that recovery, and it
 * runs at boot next to `failInterruptedProvisions`.
 *
 * The unarchive has the same shape with the pointer held rather than written:
 * `archived_at` and `archive_snapshot_id` are cleared **last**, after the files
 * are back and the container is built, so an interrupted unarchive recovers to
 * `archived` and can simply be retried.
 */

import { sql } from "../db/client";
import { badRequest, conflict, HttpError, notFound } from "../lib/http";
import { assertNodeReadyToProvision } from "../nodes/nodeApi";
import {
  deleteServerContainer,
  getServerState,
  stopServerContainer,
} from "../nodes/nodeServerApi";
import { reconcileBackupRuns } from "../nodes/backupScheduler";
import { recordAudit } from "./auditLog";
import { assertStorageAvailable, hasActiveRun } from "./backupCore";
import {
  getServerBackup,
  startArchiveRestore,
  startServerBackup,
} from "./serverBackups";
import {
  getServer,
  isProvisioning,
  recreateServerContainer,
  type ServerStatus,
  type ServerSummary,
} from "./serverManager";
import { getBackupSettings, isBackupConfigUsable } from "./settings";

/** What asked for an archive. Mirrors `servers.archive_trigger`. */
export type ArchiveTrigger = "manual" | "idle";

/**
 * How long the archive's snapshot, or the unarchive's restore, may take.
 *
 * Six hours, matching the agent's own backup timeout, so the panel never gives
 * up on a job the node is still working on. The wait is bounded at all only
 * because a task that waits forever is a task that holds a server in a
 * transitional status forever.
 */
const TRANSFER_WAIT_MS = 6 * 60 * 60_000;

/** How often the wait re-reads the run row. */
const POLL_MS = 5_000;

/**
 * In-flight archive and unarchive tasks, keyed by server id.
 *
 * The same device `serverManager` uses for provisions, and for the same two
 * jobs: it keeps the promise reachable so a route can hand it to Next's
 * `after()`, and it makes a second archive of the same server impossible while
 * the first is running, including in the window after the request has been
 * accepted but before the status write has landed.
 */
const inFlight = new Map<string, Promise<void>>();

/** The task for a server, for a route's `after()` handoff. */
export async function waitForArchive(serverId: string): Promise<void> {
  await inFlight.get(serverId)?.catch(() => undefined);
}

interface ArchiveRow {
  id: string;
  name: string;
  node_id: string;
  container_id: string | null;
  status: ServerStatus;
  archived_at: Date | null;
  archive_snapshot_id: string | null;
  archive_run_id: string | null;
  archive_trigger: ArchiveTrigger | null;
}

async function loadRow(serverId: string): Promise<ArchiveRow> {
  const rows = (await sql`
    SELECT id, name, node_id, container_id, status,
           archived_at, archive_snapshot_id, archive_run_id, archive_trigger
    FROM servers WHERE id = ${serverId}
  `) as ArchiveRow[];
  const row = rows[0];
  if (!row) throw notFound("Server not found.");
  return row;
}

/**
 * Refuse before anything is touched when there is nowhere to put the files.
 *
 * Checked up front rather than discovered by the agent, because the failure
 * would otherwise arrive after the server had been stopped, which is a worse
 * outcome than a refusal: the owner asked to archive a server and got an
 * unexplained outage instead.
 */
async function assertDestinationUsable(): Promise<void> {
  const settings = await getBackupSettings();
  if (!isBackupConfigUsable(settings)) {
    throw badRequest(
      "Archiving stores the server's files in S3, and no backup destination is " +
        "configured. An administrator needs to set one under Admin → Backups first.",
    );
  }
}

// --- Archiving ---------------------------------------------------------------------

export interface ArchiveServerInput {
  serverId: string;
  actorId: string | null;
  trigger: ArchiveTrigger;
}

/**
 * Archive a server: snapshot its files to S3, then take them off the node.
 *
 * Every reason to refuse is checked here, synchronously and before the server is
 * stopped, so a rejected archive costs the owner nothing at all. That includes
 * the destination being configured and the fleet being inside its storage quota:
 * both are certain to fail later, and failing later means having stopped a
 * running game to find out.
 *
 * Returns as soon as the row is in `archiving`. The transfer reports through the
 * status and through its backup run's log, the same contract a provision has.
 */
export async function archiveServer(
  input: ArchiveServerInput,
): Promise<ServerSummary> {
  const server = await loadRow(input.serverId);

  if (server.status === "archived" || server.archived_at) {
    throw conflict("This server is already archived.");
  }
  if (server.status === "archiving" || inFlight.has(input.serverId)) {
    throw conflict("This server is already being archived.");
  }
  if (server.status === "restoring") {
    throw conflict("This server is being restored from its archive.");
  }
  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be archived.",
    );
  }
  if (server.status === "migrating") {
    throw conflict(
      "This server is being moved to another node. Wait for the migration to " +
        "finish before archiving it.",
    );
  }
  if (server.status === "deleting") {
    throw conflict("This server is being deleted.");
  }
  if (isProvisioning(server.status)) {
    throw conflict(
      "This server is still being built. It can be archived once that finishes.",
    );
  }
  // A row that never got a container never had files to archive, and the
  // unarchive would have nothing to rebuild from. Deleting it is the right
  // action, not archiving it.
  if (!server.container_id) {
    throw conflict(
      "This server has no container, so its first install never finished and " +
        "there is nothing to archive. Delete it instead.",
    );
  }
  if (await hasActiveRun("server", input.serverId)) {
    throw conflict(
      "A backup or restore is already running for this server. Wait for it to " +
        "finish before archiving.",
    );
  }

  await assertDestinationUsable();
  await assertStorageAvailable();

  const previousStatus = server.status;

  await sql`
    UPDATE servers
    SET status = 'archiving', archive_error = NULL, archive_trigger = ${input.trigger},
        last_active_at = now(), updated_at = now()
    WHERE id = ${input.serverId}
  `;

  // Audited on acceptance, like `server.create` and `server.reinstall`: the
  // decision was made and taken. Whether the transfer then completed is the
  // task's story, told by the status and the run's log.
  await recordAudit({
    userId: input.actorId,
    action: "server.archive",
    targetType: "server",
    targetId: input.serverId,
    metadata: { trigger: input.trigger, nodeId: server.node_id },
  });

  const task = runArchive(input.serverId, previousStatus, input.actorId).finally(
    () => {
      inFlight.delete(input.serverId);
    },
  );
  inFlight.set(input.serverId, task);

  return getServer(input.serverId);
}

/**
 * The archive's background half.
 *
 * Like `provisionServer` it never rejects: the row's status and `archive_error`
 * are how it reports, because by the time it finishes the request that started
 * it is long gone.
 */
async function runArchive(
  serverId: string,
  previousStatus: ServerStatus,
  actorId: string | null,
): Promise<void> {
  try {
    const server = await loadRow(serverId);

    // The stop is what makes the snapshot mean anything, and unlike the one in
    // `reinstallServer` it is **not** best-effort. A reinstall is about to delete
    // the files whatever happens, so a failed stop costs it nothing; here a
    // failed stop would put a live game's half-written world into the only copy
    // that is going to survive, and then delete the original.
    const state = await getServerState(server.node_id, serverId).catch(() => null);
    if (state === "running" || state === "restarting") {
      await stopServerContainer(server.node_id, serverId, 30);
    }

    // One ordinary server file backup, tagged as the archive's. Going through
    // the same path as every other backup is deliberate: the snapshot an archive
    // leaves behind has to be readable by the ordinary restore, because that is
    // what brings it back.
    const run = await startServerBackup({
      serverId,
      actorId,
      trigger: "archive",
    });

    await sql`
      UPDATE servers SET archive_run_id = ${run.id}, updated_at = now()
      WHERE id = ${serverId}
    `;

    const snapshotId = await waitForRun(
      serverId,
      run.id,
      "The archive's snapshot",
    );

    // **The commit point.** Past this line the files are proved to be in S3, so
    // the wipe below is safe to redo after a crash; before it, nothing had been
    // removed. See this module's header.
    await sql`
      UPDATE servers
      SET archive_snapshot_id = ${snapshotId}, updated_at = now()
      WHERE id = ${serverId}
    `;

    await finishArchive(serverId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[archive] archiving ${serverId} failed:`, error);

    // Back to where it started, except that a server which was running is now
    // stopped: the stop is the one thing above that is not undone, because
    // starting a game again on the strength of a failed archive is a decision for
    // whoever reads the reason.
    //
    // `last_active_at` is bumped, which is what keeps a failing archive from
    // becoming a loop. The idle sweep picks servers by that column, so a failed
    // automatic archive drops back out of the candidate window for another full
    // idle period instead of being retried on every tick and writing a failed
    // backup run each time.
    await sql`
      UPDATE servers
      SET status = ${previousStatus === "running" ? "stopped" : previousStatus},
          archive_error = ${`The archive did not finish: ${reason}`.slice(0, 2000)},
          archive_trigger = NULL, last_active_at = now(), updated_at = now()
      WHERE id = ${serverId} AND status = 'archiving'
    `;
  }
}

/**
 * The half of the archive that happens after the snapshot is proved: take the
 * container and the files off the node, and settle the row.
 *
 * Split out because it is also the whole of the recovery path. A panel that died
 * between the commit point and the `archived` write comes back, sees a row with
 * a snapshot id, and calls this. Everything in it is idempotent: the agent
 * treats a missing container, a missing network and a missing directory as
 * already done, so a second run finishes what the first one started.
 *
 * The wipe is the one step here that must not be best-effort. An archived server
 * whose files are still on the node is the exact failure this feature exists to
 * avoid: the operator is told the disk was reclaimed and it was not.
 */
async function finishArchive(serverId: string): Promise<void> {
  const server = await loadRow(serverId);
  if (!server.archive_snapshot_id) {
    throw new Error(
      "Refusing to remove the server's files: no archive snapshot is recorded.",
    );
  }

  // `true` is the data directory. This is the whole point of the feature, and
  // the reason the snapshot above had to be proved first.
  await deleteServerContainer(server.node_id, serverId, true);

  await sql`
    UPDATE servers
    SET status = 'archived', container_id = NULL, archived_at = now(),
        archive_error = NULL, last_active_at = now(), updated_at = now()
    WHERE id = ${serverId}
  `;

  console.log(
    `[archive] ${serverId} archived to snapshot ${server.archive_snapshot_id}`,
  );
}

// --- Unarchiving --------------------------------------------------------------------

/**
 * Bring an archived server back: restore its files onto its node, rebuild its
 * container, and hand it back stopped.
 *
 * Stopped rather than running, for the reason a restore leaves a server stopped
 * (`serverBackups.startServerRestore`): the owner should look at what came back
 * before players reconnect.
 *
 * The node is checked for readiness up front, because the server is about to
 * need a data directory and a container on it. The ports do not need checking:
 * an archived server never gave them up, which is the property that lets it come
 * back to the address it had.
 */
export async function unarchiveServer(
  serverId: string,
  actorId: string | null,
): Promise<ServerSummary> {
  const server = await loadRow(serverId);

  if (server.status === "restoring" || inFlight.has(serverId)) {
    throw conflict("This server is already being restored from its archive.");
  }
  if (server.status === "archiving") {
    throw conflict(
      "This server is still being archived. Wait for that to finish first.",
    );
  }
  if (server.status !== "archived" || !server.archived_at) {
    throw conflict("This server is not archived.");
  }
  if (!server.archive_snapshot_id) {
    // Only reachable if the column were cleared by hand: the status is written
    // in the same statement that keeps it. Said plainly rather than crashing,
    // because the recovery (restore a snapshot from the backups tab) is
    // something an operator can actually do.
    throw conflict(
      "This server is archived but the panel has no record of which snapshot " +
        "holds its files, so it cannot be restored automatically. An administrator " +
        "can list the repository's snapshots from the backups tab.",
    );
  }

  await assertDestinationUsable();
  await assertNodeReadyToProvision(server.node_id);

  if (await hasActiveRun("server", serverId)) {
    throw conflict("A backup or restore is already running for this server.");
  }

  await sql`
    UPDATE servers
    SET status = 'restoring', archive_error = NULL, last_active_at = now(),
        updated_at = now()
    WHERE id = ${serverId}
  `;

  await recordAudit({
    userId: actorId,
    action: "server.unarchive",
    targetType: "server",
    targetId: serverId,
    metadata: {
      snapshotId: server.archive_snapshot_id,
      archivedAt: server.archived_at,
      nodeId: server.node_id,
    },
  });

  const task = runUnarchive(serverId, server.archive_snapshot_id, actorId).finally(
    () => {
      inFlight.delete(serverId);
    },
  );
  inFlight.set(serverId, task);

  return getServer(serverId);
}

/**
 * The unarchive's background half: files first, container second.
 *
 * That order is the mirror of the archive's commit point, and it is chosen for
 * the same reason. A restore that fails leaves nothing on the node except
 * partial files, which the next attempt simply overlays (restic restores are an
 * overlay, never a sync). Building the container first and then failing the
 * restore would leave a container on a node for a row that says `archived`,
 * which is drift nothing reconciles.
 *
 * The archive pointers are cleared **last**, in the same statement that settles
 * the status, so an interruption anywhere above leaves a server that is still
 * honestly archived and can simply be retried.
 */
async function runUnarchive(
  serverId: string,
  snapshotId: string,
  actorId: string | null,
): Promise<void> {
  try {
    const run = await startArchiveRestore({ serverId, snapshotId, actorId });
    await waitForRun(serverId, run.id, "The archive's restore");

    // Rebuilds the container from the row: same image, env, resource limits,
    // startup command, published ports and networks it had before. It settles
    // the status at `stopped` itself, which is where an unarchived server
    // belongs.
    await recreateServerContainer(serverId);

    await sql`
      UPDATE servers
      SET status = 'stopped', archived_at = NULL, archive_snapshot_id = NULL,
          archive_run_id = NULL, archive_trigger = NULL, archive_error = NULL,
          last_active_at = now(), updated_at = now()
      WHERE id = ${serverId}
    `;

    console.log(`[archive] ${serverId} restored from snapshot ${snapshotId}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[archive] unarchiving ${serverId} failed:`, error);

    // Back to `archived`, which is still the truth: the snapshot is untouched
    // and the files are in S3. `recreateServerContainer` may have written
    // `error` on its way out, so this is not conditioned on the current status.
    await sql`
      UPDATE servers
      SET status = 'archived',
          archive_error = ${`The restore from the archive did not finish: ${reason}`.slice(0, 2000)},
          updated_at = now()
      WHERE id = ${serverId} AND archived_at IS NOT NULL
    `;
  }
}

// --- Waiting on a run ------------------------------------------------------------------

/**
 * Block until a backup or restore run finishes, and return its snapshot id.
 *
 * Same shape as the migration's safety-backup wait, including the forced
 * reconcile: the backup scheduler's own timer is what advances a run, so driving
 * it here keeps the wait to the transfer's real duration rather than rounding
 * every phase up to the 30-second tick interval. Reconcile only, never a full
 * tick: a full tick evaluates both cron schedules and sweeps the fleet for idle
 * servers, none of which a waiter needs, several hundred times over the course of
 * one upload.
 *
 * A server that is deleted mid-transfer ends the wait rather than letting it run
 * out the clock, the same check `assertStillProvisioning` makes for a provision.
 */
async function waitForRun(
  serverId: string,
  runId: string,
  label: string,
): Promise<string> {
  const deadline = Date.now() + TRANSFER_WAIT_MS;

  for (;;) {
    await reconcileBackupRuns().catch(() => undefined);
    const run = await getServerBackup(serverId, runId);

    if (run.status === "succeeded") {
      if (!run.snapshotId) {
        throw new Error(
          `${label} reported success without naming a snapshot, so there is no ` +
            `record of where the files went.`,
        );
      }
      return run.snapshotId;
    }
    if (run.status === "failed") {
      throw new Error(`${label} failed: ${run.error ?? "no reason given"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label} did not finish within six hours, so it was abandoned. The ` +
          `server has not been changed.`,
      );
    }

    const rows = (await sql`
      SELECT status FROM servers WHERE id = ${serverId}
    `) as { status: string }[];
    if (!rows[0]) {
      throw new HttpError(409, "The server was deleted while it was being archived.");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// --- Recovery -------------------------------------------------------------------------

/**
 * Close out archives and unarchives the previous process abandoned.
 *
 * Runs at boot, next to `failInterruptedProvisions` and
 * `failInterruptedMigrations`, and for the same reason: these tasks live in this
 * process, and `archiving`/`restoring` are statuses nothing else is allowed to
 * correct, so a restart mid-transfer would otherwise leave that server
 * unreachable by every recovery path the panel has.
 *
 * Unlike those two, this one can often *finish the job* rather than only failing
 * it, which is the payoff of the commit point:
 *
 *   - `archiving` **with** a snapshot recorded: the files are in S3 and only the
 *     wipe is outstanding. Redo it and settle the row at `archived`.
 *   - `archiving` **without** one: nothing was removed. Back to `stopped`, with
 *     the reason on the row.
 *   - `restoring`: back to `archived`, which is still true, and retryable from
 *     the same button.
 */
export async function recoverInterruptedArchives(): Promise<void> {
  const interrupted = (await sql`
    SELECT id, archive_snapshot_id FROM servers WHERE status = 'archiving'
  `) as { id: string; archive_snapshot_id: string | null }[];

  for (const row of interrupted) {
    if (row.archive_snapshot_id) {
      try {
        await finishArchive(row.id);
        console.log(`[archive] finished an interrupted archive for ${row.id}`);
      } catch (error) {
        console.error(
          `[archive] could not finish the interrupted archive for ${row.id}:`,
          error,
        );
        await sql`
          UPDATE servers
          SET archive_error = ${
            "The panel restarted after this server's files were uploaded but " +
            "before they were removed from its node, and the retry failed: " +
            `${error instanceof Error ? error.message : String(error)}. The ` +
            "files are safely in S3; archiving again will finish the job."
          }, updated_at = now()
          WHERE id = ${row.id}
        `;
      }
      continue;
    }

    await sql`
      UPDATE servers
      SET status = 'stopped',
          archive_trigger = NULL,
          archive_error = 'The panel restarted while this server was being ' ||
                          'archived, so the transfer was abandoned before ' ||
                          'anything was removed from its node. Nothing was ' ||
                          'lost; archive it again to retry.',
          updated_at = now()
      WHERE id = ${row.id} AND status = 'archiving'
    `;
  }

  const restoring = (await sql`
    UPDATE servers
    SET status = 'archived',
        archive_error = 'The panel restarted while this server was being ' ||
                        'restored from its archive, so the restore was ' ||
                        'abandoned. Its files are still in S3; restore it again ' ||
                        'to retry.',
        updated_at = now()
    WHERE status = 'restoring' AND archived_at IS NOT NULL
    RETURNING id
  `) as { id: string }[];

  // A `restoring` row with no `archived_at` cannot happen through this module,
  // which clears that column only in the statement that settles the status. If
  // one exists it was hand-edited, and guessing at it would be worse than
  // leaving it for an operator to look at.
  if (interrupted.length > 0 || restoring.length > 0) {
    console.log(
      `[archive] recovered ${interrupted.length} interrupted archive(s) and ` +
        `${restoring.length} interrupted restore(s)`,
    );
  }
}

/**
 * When this server's idle clock last reset, so the UI can say how long is left
 * before the auto-archive policy takes it.
 *
 * Its own read rather than a field on `ServerSummary`: `last_active_at` is only
 * interesting on the one card that explains the policy, and adding it to the
 * summary would put it on every list page's payload to be used by nothing.
 */
export async function getServerIdleSince(serverId: string): Promise<Date | null> {
  const rows = (await sql`
    SELECT last_active_at, status FROM servers WHERE id = ${serverId}
  `) as { last_active_at: Date; status: string }[];
  const row = rows[0];
  // Only a stopped server has an idle period that means anything; for any other
  // status the column is just "when it last changed", which would read as a
  // countdown that is not running.
  if (!row || row.status !== "stopped") return null;
  return row.last_active_at;
}

// --- The idle sweep ----------------------------------------------------------------------

export interface IdleServer {
  id: string;
  name: string;
  nodeId: string;
  lastActiveAt: Date;
}

/**
 * Servers the auto-archive policy should take.
 *
 * The rule has one home here, the same reasoning as `listServersDueForBackup`.
 * Five conditions, each earning its place:
 *
 *   - **`status = 'stopped'`.** The only status that means "nobody is using
 *     this". Every other one is either in use, mid-transition, an administrative
 *     hold, or already archived. `error` is excluded too: a server that failed
 *     to start is a server somebody is probably trying to fix, and archiving it
 *     would take the evidence off the node.
 *   - **Stopped for the whole window.** `last_active_at` is the time of the last
 *     status change (migration 027), so for a stopped server it is the moment it
 *     went down, whether it was stopped on purpose or crashed and the sweeper
 *     noticed.
 *   - **It has a container.** A row that never finished its first install has
 *     nothing to archive.
 *   - **`backups_enabled`.** The only per-server opt-out that exists, and it
 *     reads exactly right here: an owner who has said "do not put my files in S3
 *     on a schedule" has said the thing that would otherwise happen. They can
 *     still archive by hand, and an operator who needs the disk back can still
 *     archive it for them.
 *   - **No backup or restore in flight.** Two restics on one repository contend
 *     on its lock.
 *
 * Oldest-idle first, so a fleet that drains over several ticks drains in the
 * order an operator would have picked.
 */
export async function listServersDueForAutoArchive(
  idleDays: number,
  limit: number,
): Promise<IdleServer[]> {
  const days = Math.max(1, Math.floor(idleDays));

  const rows = (await sql`
    SELECT s.id, s.name, s.node_id, s.last_active_at
    FROM servers s
    WHERE s.status = 'stopped'
      AND s.container_id IS NOT NULL
      AND s.archived_at IS NULL
      AND s.backups_enabled = TRUE
      AND s.last_active_at < now() - (${days} * INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM backup_runs b
        WHERE b.scope = 'server' AND b.server_id = s.id
          AND b.status IN ('pending', 'running')
      )
    ORDER BY s.last_active_at ASC
    LIMIT ${Math.max(1, Math.min(limit, 50))}
  `) as { id: string; name: string; node_id: string; last_active_at: Date }[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    nodeId: row.node_id,
    lastActiveAt: row.last_active_at,
  }));
}

/**
 * Archive everything the policy says is idle. One tick's worth.
 *
 * Called from the backup scheduler's timer rather than one of its own, because
 * an archive *is* a backup as far as a node is concerned: two timers could start
 * an archive and a scheduled backup against the same repository at the same
 * instant, and restic would have them contend on its lock. One timer, in
 * sequence, makes that impossible without a lock of our own.
 *
 * Failures are logged and skipped, never rethrown. A caller on a timer has
 * nobody to report to, and one server whose node is down must not stop the rest
 * of the sweep.
 */
export async function runIdleArchiveSweep(policy: {
  enabled: boolean;
  idleDays: number;
  concurrency: number;
}): Promise<number> {
  if (!policy.enabled) return 0;

  const due = await listServersDueForAutoArchive(
    policy.idleDays,
    Math.max(1, policy.concurrency),
  );

  let started = 0;
  for (const server of due) {
    if (started >= Math.max(1, policy.concurrency)) break;
    try {
      await archiveServer({ serverId: server.id, actorId: null, trigger: "idle" });
      started += 1;
      console.log(
        `[archive] auto-archiving "${server.name}" (${server.id}), idle since ` +
          `${server.lastActiveAt.toISOString()}`,
      );
    } catch (error) {
      // A server that changed state mid-sweep, a node that went down, a storage
      // quota that was reached between the query and the call. The next tick
      // re-evaluates from scratch.
      console.error(
        `[archive] could not auto-archive "${server.name}" (${server.id}):`,
        error,
      );
    }
  }
  return started;
}
