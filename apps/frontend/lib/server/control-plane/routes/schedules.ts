/**
 * Schedule routes.
 *
 * Two gates, both required, and the second one is the interesting half:
 *
 *   1. `schedules` — reaching the tab and the CRUD at all. Reads gate with
 *      writes, per the project rule: a console-only subuser must not be able to
 *      enumerate what a server does unattended at 04:00.
 *
 *   2. **The permission each task would need by hand.** Writing a schedule that
 *      contains a console command additionally requires `console`; one that
 *      restarts requires `start_stop`; one that backs up requires `backups`.
 *      Without this, `schedules` alone would be a way to run arbitrary console
 *      commands on someone else's server, because "run this command every
 *      minute" is strictly more than "run this command". See `TASK_PERMISSIONS`
 *      in `services/serverSchedules.ts` and `docs/scheduler.md`.
 *
 * The second gate is enforced on create, update and "run now", but not on read
 * or delete. Reading is covered by gate 1, and *removing* a schedule can only
 * ever reduce what happens to the server, so requiring the tasks' own
 * permissions to delete one would mean a subuser could be unable to stop
 * something they can see.
 */

import { requireServerPermission } from "../auth/middleware";
import { accessAllows } from "../auth/rbac";
import {
  badRequest,
  forbidden,
  json,
  noContent,
  parseJsonBody,
  requireUuidParam,
} from "../lib/http";
import { getTimezone } from "../services/settings";
import {
  createServerSchedule,
  deleteServerSchedule,
  getServerSchedule,
  listScheduleRuns,
  listServerSchedules,
  parseScheduleInput,
  permissionsForTasks,
  runScheduleNow,
  setScheduleEnabled,
  updateServerSchedule,
  type ScheduleTask,
  type ScheduleView,
} from "../services/serverSchedules";
import {
  CRON_PRESETS,
  describeCron,
  isValidCron,
  nextCronRun,
  parseCron,
} from "@/lib/cron";
import type { ServerAccess } from "../auth/rbac";

/**
 * Refuse a schedule whose tasks the caller could not perform by hand.
 *
 * Owners and admins hold everything implicitly, so this only ever bites a
 * subuser. The message names the missing flag rather than saying "forbidden",
 * because the fix is for the *owner* to grant it and the subuser needs to be
 * able to ask for the right thing.
 */
function assertMayScheduleTasks(access: ServerAccess, tasks: ScheduleTask[]): void {
  for (const permission of permissionsForTasks(tasks)) {
    if (!accessAllows(access, permission)) {
      throw forbidden(
        `This schedule contains a task you cannot perform yourself. It needs the ` +
          `"${permission}" permission on this server in addition to "schedules".`,
      );
    }
  }
}

/**
 * Fill in each schedule's next run.
 *
 * Computed here rather than in the browser so it is in the panel's timezone,
 * which the browser has no reason to know, and by the same parser the runner
 * uses, so a schedule can never display one thing and do another. The timezone
 * is read once for the whole list, not per schedule.
 */
function withNextRuns(schedules: ScheduleView[], timezone: string): ScheduleView[] {
  const now = new Date();
  return schedules.map((schedule) => ({
    ...schedule,
    nextRun:
      schedule.enabled && isValidCron(schedule.cron)
        ? (nextCronRun(parseCron(schedule.cron), now, timezone)?.toISOString() ?? null)
        : null,
  }));
}

/**
 * GET /api/servers/:id/schedules
 *
 * Bundled with the timezone and the presets rather than split across endpoints,
 * because the tab cannot draw anything correct without them: a next-run time
 * means nothing without the zone it is in, and the preset list is what stops the
 * form demanding that an owner write cron.
 */
export async function handleListSchedules(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "schedules");

  const [schedules, timezone] = await Promise.all([
    listServerSchedules(id),
    getTimezone(),
  ]);

  return json({
    schedules: withNextRuns(schedules, timezone),
    timezone,
    presets: CRON_PRESETS,
  });
}

/** GET /api/servers/:id/schedules/:scheduleId */
export async function handleGetSchedule(
  request: Request,
  serverId: string,
  scheduleId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const sid = requireUuidParam(scheduleId, "scheduleId");
  await requireServerPermission(request, id, "schedules");

  const [schedule, timezone, runs] = await Promise.all([
    getServerSchedule(id, sid),
    getTimezone(),
    listScheduleRuns(sid),
  ]);

  return json({
    schedule: withNextRuns([schedule], timezone)[0],
    runs,
    timezone,
  });
}

/** GET /api/servers/:id/schedules/:scheduleId/runs */
export async function handleListScheduleRuns(
  request: Request,
  serverId: string,
  scheduleId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const sid = requireUuidParam(scheduleId, "scheduleId");
  await requireServerPermission(request, id, "schedules");

  // Scopes the schedule to this server before its history is readable.
  await getServerSchedule(id, sid);

  return json({ runs: await listScheduleRuns(sid) });
}

/** POST /api/servers/:id/schedules */
export async function handleCreateSchedule(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user, access } = await requireServerPermission(request, id, "schedules");

  const input = parseScheduleInput(await parseJsonBody(request));
  assertMayScheduleTasks(access, input.tasks);

  const schedule = await createServerSchedule(id, input, user.id);
  const timezone = await getTimezone();

  return json({ schedule: withNextRuns([schedule], timezone)[0] }, 201);
}

/**
 * PATCH /api/servers/:id/schedules/:scheduleId
 *
 * Two shapes, because the tab has two very different edits. A body carrying only
 * `enabled` flips the switch; anything else is a full replace of the schedule.
 * The switch is special-cased rather than folded into the replace so the list
 * view's toggle does not have to send the whole task array back, which it would
 * otherwise have to keep in sync just to turn a schedule off.
 */
export async function handleUpdateSchedule(
  request: Request,
  serverId: string,
  scheduleId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const sid = requireUuidParam(scheduleId, "scheduleId");
  const { user, access } = await requireServerPermission(request, id, "schedules");

  const body = await parseJsonBody(request);
  const timezone = await getTimezone();

  if (body.tasks === undefined && typeof body.enabled === "boolean") {
    const schedule = await setScheduleEnabled(id, sid, body.enabled, user.id);
    return json({ schedule: withNextRuns([schedule], timezone)[0] });
  }

  const input = parseScheduleInput(body);
  assertMayScheduleTasks(access, input.tasks);

  const schedule = await updateServerSchedule(id, sid, input, user.id);
  return json({ schedule: withNextRuns([schedule], timezone)[0] });
}

/** DELETE /api/servers/:id/schedules/:scheduleId */
export async function handleDeleteSchedule(
  request: Request,
  serverId: string,
  scheduleId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const sid = requireUuidParam(scheduleId, "scheduleId");
  const { user } = await requireServerPermission(request, id, "schedules");

  await deleteServerSchedule(id, sid, user.id);
  return noContent();
}

/**
 * POST /api/servers/:id/schedules/:scheduleId/run
 *
 * Runs the schedule now. Unlike a scheduled fire this *is* awaited, so the
 * response carries the outcome and the person who pressed the button learns
 * whether it worked without polling. A schedule holding long delays therefore
 * holds this request open for them; that is the honest behaviour for a button
 * labelled "Run now", and the run row is there either way if the request is
 * abandoned.
 */
export async function handleRunSchedule(
  request: Request,
  serverId: string,
  scheduleId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const sid = requireUuidParam(scheduleId, "scheduleId");
  const { user, access } = await requireServerPermission(request, id, "schedules");

  const schedule = await getServerSchedule(id, sid);
  assertMayScheduleTasks(access, schedule.tasks);

  const status = await runScheduleNow(id, sid, user.id);
  const runs = await listScheduleRuns(sid, 1);

  return json({ status, run: runs[0] ?? null });
}

/**
 * POST /api/servers/:id/schedules/preview
 *
 * Validates an expression and says what it means, in the panel's timezone. The
 * server-side twin of the admin backup form's preview, and for the same reason:
 * the browser must not be the thing that decides what a schedule means, or a
 * schedule could preview one thing and then do another.
 *
 * Gated on `schedules` rather than left open, because it is reached from the
 * schedules form and an ungated cron parser is an ungated endpoint.
 */
export async function handlePreviewSchedule(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "schedules");

  const body = await parseJsonBody(request);
  const timezone = await getTimezone();

  let expression;
  try {
    expression = parseCron(typeof body.cron === "string" ? body.cron : "");
  } catch (error) {
    // The parser's messages are written for the operator who typed the
    // expression, so they pass straight through as the 400 body. Rethrowing the
    // CronParseError instead would surface as a 500.
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
