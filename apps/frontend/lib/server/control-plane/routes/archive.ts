/**
 * Archive routes: move a server's files to S3 and bring them back.
 *
 * **Owner or admin only, never delegable.** Archiving is not gated on the
 * `backups` flag even though it takes a backup, and the reason is that the flag
 * means "may press the backup button", while this takes the server offline and
 * deletes its files from the node. That is the same class of action as delete
 * and reinstall, which is where the line already sits (`routes/servers.ts`).
 *
 * Reads gate with writes, per the project rule: the archive status view is
 * behind the same owner check, so a subuser with only `console` cannot
 * enumerate where a server's files went.
 *
 * See `docs/archive.md`.
 */

import { after } from "next/server";

import { requireServerOwner } from "../auth/middleware";
import { json, requireUuidParam } from "../lib/http";
import { listServerBackups } from "../services/serverBackups";
import {
  archiveServer,
  getServerIdleSince,
  unarchiveServer,
  waitForArchive,
} from "../services/serverArchive";
import { getServer } from "../services/serverManager";
import { getPublicBackupSettings } from "../services/settings";

/**
 * POST /api/servers/:id/archive.
 *
 * Answers **202** in spirit: the row is real and already says `archiving`, the
 * transfer is not done. The same contract as `POST /api/admin/servers`, and for
 * the same reason: uploading a world is minutes to hours, and no proxy, browser
 * or fetch timeout in the chain will hold a request open for it. The response
 * carries the server so the UI can flip to the archiving screen immediately
 * rather than waiting out a poll.
 */
export async function handleArchiveServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  const server = await archiveServer({
    serverId: id,
    actorId: user.id,
    trigger: "manual",
  });

  // The transfer outlives this response. `after()` stops the runtime treating
  // the request's work as finished when the response goes out, exactly as the
  // create and reinstall paths do.
  after(() => waitForArchive(id));

  return json({ server }, 202);
}

/**
 * POST /api/servers/:id/unarchive.
 *
 * Same shape, opposite direction. Comes back **stopped**, so the owner can look
 * at what was restored before players reconnect.
 */
export async function handleUnarchiveServer(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerOwner(request, id);

  const server = await unarchiveServer(id, user.id);
  after(() => waitForArchive(id));

  return json({ server }, 202);
}

/**
 * GET /api/servers/:id/archive.
 *
 * What the archive card needs in one round trip, because it cannot draw anything
 * useful without all of it: whether a destination is configured at all (otherwise
 * the card explains that instead of offering a button), what the auto-archive
 * policy will do to this server and when, and the run whose log is the archive's
 * progress.
 */
export async function handleGetServerArchive(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerOwner(request, id);

  const [server, settings, runs, idleSince] = await Promise.all([
    getServer(id),
    getPublicBackupSettings(),
    listServerBackups(id, 50),
    getServerIdleSince(id),
  ]);

  // The archive's own run, so the card can show its progress and log without the
  // caller having to find it among ordinary backups.
  const run =
    runs.find((entry) => entry.trigger === "archive" && entry.status !== "failed") ??
    runs.find((entry) => entry.trigger === "archive") ??
    null;

  return json({
    status: server.status,
    archive: server.archive,
    error: server.archiveError,
    run,
    policy: {
      /** Whether archiving is possible at all right now. */
      configured: settings.usable,
      autoEnabled: settings.usable && settings.archive.enabled,
      idleDays: settings.archive.idleDays,
      /**
       * When the idle clock started, or null when it is not running (the server
       * is not stopped). The UI turns this plus `idleDays` into a date rather
       * than being handed one, so it never shows a countdown for a server whose
       * clock is not ticking.
       */
      idleSince: idleSince?.toISOString() ?? null,
    },
  });
}
