/**
 * Per-server task schedules: the store, the validator, and the runner.
 *
 * A schedule is a cron expression plus an ordered list of tasks, and a task is
 * one of the three privileged things the panel can already do to a server on
 * somebody's behalf: a power action, a file backup, a console command. See
 * `docs/scheduler.md` for the whole flow and `nodes/scheduleRunner.ts` for the
 * timer that fires it.
 *
 * The load-bearing decision in this file is that **a task executes through the
 * same service function the button does**: `power.restart` calls
 * `restartServer`, `backup` calls `startServerBackup`, `command` calls
 * `sendServerCommand`. Not a reimplementation, not a direct agent call. That is
 * what guarantees a schedule cannot skip a suspension check, a plugin
 * auto-update, a status transition or an audit row that the interactive path
 * performs, and it is why adding a task kind means finding the existing service
 * function rather than writing a new privileged path.
 */

import { sql } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/http";
import { isValidCron, parseCron } from "@/lib/cron";
import type { SubuserPermission } from "../auth/rbac";
import { recordAudit } from "./auditLog";
import {
  killServer,
  restartServer,
  startServer,
  stopServer,
  type ServerStatus,
} from "./serverManager";
import { startServerBackup } from "./serverBackups";
import { sendServerCommand } from "../nodes/nodeServerApi";

// --- Shape --------------------------------------------------------------------

/** Everything a task may be. Closed set, mirrored by the schema's CHECK. */
export const SCHEDULE_TASK_ACTIONS = [
  "power.start",
  "power.stop",
  "power.restart",
  "power.kill",
  "backup",
  "command",
] as const;

export type ScheduleTaskAction = (typeof SCHEDULE_TASK_ACTIONS)[number];

export function isScheduleTaskAction(value: unknown): value is ScheduleTaskAction {
  return (
    typeof value === "string" &&
    (SCHEDULE_TASK_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * The subuser permission each task kind requires of whoever writes it.
 *
 * This map is the anti-escalation rule in one place. A subuser holding
 * `schedules` can manage schedules; it takes `console` on top of it to put a
 * console command in one, and `start_stop` to put a restart in one. Without
 * this, `schedules` would quietly be the most powerful flag in the set, because
 * "run this command every minute" is strictly more than "run this command".
 *
 * `backup` maps to `backups` and not to owner-only, matching the interactive
 * rule exactly: `backups` is enough to *take* a backup, and taking one is all a
 * schedule can do. There is no restore task, for the same reason restore is not
 * delegable at all (`docs/backups.md`).
 */
export const TASK_PERMISSIONS: Record<ScheduleTaskAction, SubuserPermission> = {
  "power.start": "start_stop",
  "power.stop": "start_stop",
  "power.restart": "start_stop",
  "power.kill": "start_stop",
  backup: "backups",
  command: "console",
};

/** Longest a single task may be made to wait before it runs. */
export const MAX_TASK_DELAY_SECONDS = 900;

/** Most tasks one schedule may hold. */
export const MAX_TASKS_PER_SCHEDULE = 10;

/** Most schedules one server may hold. */
export const MAX_SCHEDULES_PER_SERVER = 20;

/** A task as the API accepts and stores it. */
export interface ScheduleTask {
  action: ScheduleTaskAction;
  /** Only meaningful for `command`. */
  command: string | null;
  /** Seconds to wait *before* running this task. */
  delaySeconds: number;
  /** Whether a failure here lets the rest of the schedule proceed. */
  continueOnFailure: boolean;
}

export type ScheduleRunStatus = "running" | "succeeded" | "failed";
export type ScheduleTrigger = "manual" | "scheduled";

/** One task's outcome within a run, as stored in `server_schedule_runs.steps`. */
export interface ScheduleStep {
  position: number;
  action: ScheduleTaskAction;
  status: "succeeded" | "failed" | "skipped";
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface ScheduleRunView {
  id: string;
  scheduleId: string | null;
  trigger: ScheduleTrigger;
  status: ScheduleRunStatus;
  steps: ScheduleStep[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ScheduleView {
  id: string;
  serverId: string;
  name: string;
  cron: string;
  enabled: boolean;
  onlyWhenRunning: boolean;
  tasks: ScheduleTask[];
  /** Computed by the route, which knows the panel's timezone. */
  nextRun: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduleRunStatus | null;
  createdAt: string;
}

// --- Validation ---------------------------------------------------------------

/**
 * Turn an untrusted task array from a request into stored tasks.
 *
 * Pure, so it is unit-tested without a database (`serverSchedules.test.ts`).
 * Rejects rather than coerces wherever a coercion would silently change what the
 * author asked for: an unknown action, a command task with no command, a
 * negative delay. The one thing it does normalise is whitespace in a command,
 * because a trailing newline in a console command is invisible and harmless.
 *
 * A command is capped at the same 4096 bytes as the interactive console route,
 * so the two paths accept exactly the same commands.
 */
export function sanitizeScheduleTasks(input: unknown): ScheduleTask[] {
  if (!Array.isArray(input)) {
    throw badRequest('"tasks" must be an array.');
  }
  if (input.length === 0) {
    throw badRequest("A schedule needs at least one task.");
  }
  if (input.length > MAX_TASKS_PER_SCHEDULE) {
    throw badRequest(
      `A schedule may hold at most ${MAX_TASKS_PER_SCHEDULE} tasks; this one has ${input.length}.`,
    );
  }

  return input.map((raw, index) => {
    const position = index + 1;
    if (typeof raw !== "object" || raw === null) {
      throw badRequest(`Task ${position} is not an object.`);
    }
    const task = raw as Record<string, unknown>;

    if (!isScheduleTaskAction(task.action)) {
      throw badRequest(
        `Task ${position} has an unknown action. Use one of: ${SCHEDULE_TASK_ACTIONS.join(", ")}.`,
      );
    }
    const action = task.action;

    let command: string | null = null;
    if (action === "command") {
      if (typeof task.command !== "string" || task.command.trim().length === 0) {
        throw badRequest(`Task ${position} runs a console command, so it needs one.`);
      }
      command = task.command.trim();
      if (command.length > 4096) {
        throw badRequest(`Task ${position}'s command is longer than 4096 characters.`);
      }
    }

    const delayRaw = task.delaySeconds ?? 0;
    const delaySeconds = typeof delayRaw === "number" ? Math.trunc(delayRaw) : Number.NaN;
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0) {
      throw badRequest(`Task ${position}'s delay must be a whole number of seconds, or 0.`);
    }
    if (delaySeconds > MAX_TASK_DELAY_SECONDS) {
      throw badRequest(
        `Task ${position}'s delay is ${delaySeconds}s; the most one task may wait is ` +
          `${MAX_TASK_DELAY_SECONDS}s. Put the later half in its own schedule if you need ` +
          `a longer gap.`,
      );
    }

    return {
      action,
      command,
      delaySeconds,
      continueOnFailure: task.continueOnFailure === true,
    };
  });
}

/** The distinct permissions a set of tasks requires of its author. */
export function permissionsForTasks(tasks: ScheduleTask[]): SubuserPermission[] {
  return [...new Set(tasks.map((task) => TASK_PERMISSIONS[task.action]))];
}

/** Validate a cron expression, with the parser's own message as the 400 body. */
export function assertValidCron(cron: string): string {
  const trimmed = cron.trim();
  if (trimmed.length === 0) {
    throw badRequest("A schedule needs a cron expression.");
  }
  if (!isValidCron(trimmed)) {
    // parseCron's messages are written for the person who typed the expression.
    try {
      parseCron(trimmed);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Invalid schedule.");
    }
  }
  return trimmed;
}

function assertValidName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw badRequest("A schedule needs a name.");
  }
  const trimmed = name.trim();
  if (trimmed.length > 120) {
    throw badRequest("A schedule's name may be at most 120 characters.");
  }
  return trimmed;
}

/**
 * How long a run may take at the very most, from its own tasks.
 *
 * Every delay, plus a generous per-task allowance for the action itself. Used by
 * the runner's stale sweep to tell "still working through a 15-minute wait" from
 * "the process that owned this run is gone", which are otherwise the same row.
 */
export function runBudgetMs(tasks: Pick<ScheduleTask, "delaySeconds">[]): number {
  const delays = tasks.reduce((total, task) => total + task.delaySeconds, 0);
  return delays * 1000 + tasks.length * PER_TASK_BUDGET_MS;
}

/**
 * Per-task allowance on top of its delay.
 *
 * Five minutes, which is well past a graceful stop's timeout and past how long
 * an unreachable node takes to fail a request, so a task that has not finished
 * inside it is not slow but abandoned.
 */
const PER_TASK_BUDGET_MS = 5 * 60_000;

// --- Reads --------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  server_id: string;
  name: string;
  cron: string;
  enabled: boolean;
  only_when_running: boolean;
  last_run_at: Date | null;
  last_status: ScheduleRunStatus | null;
  created_at: Date;
}

interface TaskRow {
  schedule_id: string;
  position: number;
  action: ScheduleTaskAction;
  payload: { command?: string } | null;
  delay_seconds: number;
  continue_on_failure: boolean;
}

function toTask(row: TaskRow): ScheduleTask {
  return {
    action: row.action,
    command: row.payload?.command ?? null,
    delaySeconds: row.delay_seconds,
    continueOnFailure: row.continue_on_failure,
  };
}

function toView(row: ScheduleRow, tasks: ScheduleTask[]): ScheduleView {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    cron: row.cron,
    enabled: row.enabled,
    onlyWhenRunning: row.only_when_running,
    tasks,
    // The route fills this in: only it knows the panel's timezone, and computing
    // it here would mean a settings read per schedule.
    nextRun: null,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastStatus: row.last_status,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Every schedule on one server, with its tasks.
 *
 * Two queries rather than one per schedule, then grouped in memory: the tab
 * shows all of them expanded, so N+1 here would be N+1 round trips on every
 * page load (`docs/performance.md`).
 */
export async function listServerSchedules(serverId: string): Promise<ScheduleView[]> {
  const rows = (await sql`
    SELECT id, server_id, name, cron, enabled, only_when_running,
           last_run_at, last_status, created_at
    FROM server_schedules
    WHERE server_id = ${serverId}
    ORDER BY created_at ASC
  `) as ScheduleRow[];

  if (rows.length === 0) return [];

  const taskRows = (await sql`
    SELECT schedule_id, position, action, payload, delay_seconds, continue_on_failure
    FROM server_schedule_tasks
    WHERE schedule_id = ANY(${rows.map((row) => row.id)}::uuid[])
    ORDER BY schedule_id, position ASC
  `) as TaskRow[];

  const bySchedule = new Map<string, ScheduleTask[]>();
  for (const row of taskRows) {
    const list = bySchedule.get(row.schedule_id) ?? [];
    list.push(toTask(row));
    bySchedule.set(row.schedule_id, list);
  }

  return rows.map((row) => toView(row, bySchedule.get(row.id) ?? []));
}

/**
 * One schedule, scoped to its server.
 *
 * `serverId` is part of the lookup rather than checked afterwards, so a schedule
 * id from another server reads as "not found" instead of leaking that it exists.
 */
export async function getServerSchedule(
  serverId: string,
  scheduleId: string,
): Promise<ScheduleView> {
  const rows = (await sql`
    SELECT id, server_id, name, cron, enabled, only_when_running,
           last_run_at, last_status, created_at
    FROM server_schedules
    WHERE id = ${scheduleId} AND server_id = ${serverId}
  `) as ScheduleRow[];

  const row = rows[0];
  if (!row) throw notFound("Schedule not found");

  const taskRows = (await sql`
    SELECT schedule_id, position, action, payload, delay_seconds, continue_on_failure
    FROM server_schedule_tasks
    WHERE schedule_id = ${scheduleId}
    ORDER BY position ASC
  `) as TaskRow[];

  return toView(row, taskRows.map(toTask));
}

/** A schedule's recent runs, newest first. */
export async function listScheduleRuns(
  scheduleId: string,
  limit = 20,
): Promise<ScheduleRunView[]> {
  const rows = (await sql`
    SELECT id, schedule_id, trigger, status, steps, error, started_at, finished_at
    FROM server_schedule_runs
    WHERE schedule_id = ${scheduleId}
    ORDER BY started_at DESC
    LIMIT ${Math.min(Math.max(1, limit), 100)}
  `) as {
    id: string;
    schedule_id: string | null;
    trigger: ScheduleTrigger;
    status: ScheduleRunStatus;
    steps: ScheduleStep[];
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    scheduleId: row.schedule_id,
    trigger: row.trigger,
    status: row.status,
    steps: Array.isArray(row.steps) ? row.steps : [],
    error: row.error,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  }));
}

// --- Writes -------------------------------------------------------------------

export interface WriteScheduleInput {
  name: string;
  cron: string;
  enabled: boolean;
  onlyWhenRunning: boolean;
  tasks: ScheduleTask[];
}

/**
 * Parse an untrusted request body into a schedule, without touching the database.
 *
 * Separated from the write so a route can check the author's permissions against
 * {@link permissionsForTasks} *before* anything is inserted. Validating and
 * authorizing in one step would mean either authorizing against unvalidated
 * input or writing a row and then refusing it.
 */
export function parseScheduleInput(body: Record<string, unknown>): WriteScheduleInput {
  return {
    name: assertValidName(body.name),
    cron: assertValidCron(typeof body.cron === "string" ? body.cron : ""),
    // Absent means enabled: a schedule the author just wrote is one they want
    // running, and the form has no "and also switch it on" step.
    enabled: body.enabled === undefined ? true : body.enabled === true,
    onlyWhenRunning: body.onlyWhenRunning === true,
    tasks: sanitizeScheduleTasks(body.tasks),
  };
}

async function replaceTasks(scheduleId: string, tasks: ScheduleTask[]): Promise<void> {
  await sql`DELETE FROM server_schedule_tasks WHERE schedule_id = ${scheduleId}`;

  for (const [index, task] of tasks.entries()) {
    await sql`
      INSERT INTO server_schedule_tasks
        (schedule_id, position, action, payload, delay_seconds, continue_on_failure)
      VALUES (
        ${scheduleId},
        ${index + 1},
        ${task.action},
        ${sql.json((task.command === null ? {} : { command: task.command }) as never)},
        ${task.delaySeconds},
        ${task.continueOnFailure}
      )
    `;
  }
}

export async function createServerSchedule(
  serverId: string,
  input: WriteScheduleInput,
  actorId: string,
): Promise<ScheduleView> {
  const [{ count }] = (await sql`
    SELECT count(*)::int AS count FROM server_schedules WHERE server_id = ${serverId}
  `) as { count: number }[];

  if (count >= MAX_SCHEDULES_PER_SERVER) {
    throw conflict(
      `This server already has the maximum of ${MAX_SCHEDULES_PER_SERVER} schedules. ` +
        `Delete one before adding another.`,
    );
  }

  const [row] = (await sql`
    INSERT INTO server_schedules
      (server_id, name, cron, enabled, only_when_running, created_by)
    VALUES (
      ${serverId}, ${input.name}, ${input.cron},
      ${input.enabled}, ${input.onlyWhenRunning}, ${actorId}
    )
    RETURNING id
  `) as { id: string }[];

  await replaceTasks(row!.id, input.tasks);

  await recordAudit({
    userId: actorId,
    action: "server.schedule.create",
    targetType: "server",
    targetId: serverId,
    metadata: {
      scheduleId: row!.id,
      name: input.name,
      cron: input.cron,
      tasks: input.tasks.map((task) => task.action),
    },
  });

  return getServerSchedule(serverId, row!.id);
}

/**
 * Replace a schedule wholesale.
 *
 * A full replace rather than a field-by-field patch because the tasks are a list
 * whose order matters: a partial update of "task 2" is meaningless once task 1
 * has been removed, and every real edit from the form rewrites the list anyway.
 * The one exception is the enable switch, which has its own function below so
 * flipping it does not require sending the tasks back.
 */
export async function updateServerSchedule(
  serverId: string,
  scheduleId: string,
  input: WriteScheduleInput,
  actorId: string,
): Promise<ScheduleView> {
  // Existence is confirmed against this server, so a foreign id 404s.
  await getServerSchedule(serverId, scheduleId);

  await sql`
    UPDATE server_schedules
    SET name = ${input.name},
        cron = ${input.cron},
        enabled = ${input.enabled},
        only_when_running = ${input.onlyWhenRunning},
        updated_at = now()
    WHERE id = ${scheduleId}
  `;
  await replaceTasks(scheduleId, input.tasks);

  await recordAudit({
    userId: actorId,
    action: "server.schedule.update",
    targetType: "server",
    targetId: serverId,
    metadata: {
      scheduleId,
      name: input.name,
      cron: input.cron,
      enabled: input.enabled,
      tasks: input.tasks.map((task) => task.action),
    },
  });

  return getServerSchedule(serverId, scheduleId);
}

/** Switch a schedule on or off, leaving its tasks alone. */
export async function setScheduleEnabled(
  serverId: string,
  scheduleId: string,
  enabled: boolean,
  actorId: string,
): Promise<ScheduleView> {
  const existing = await getServerSchedule(serverId, scheduleId);

  await sql`
    UPDATE server_schedules
    SET enabled = ${enabled}, updated_at = now()
    WHERE id = ${scheduleId}
  `;

  await recordAudit({
    userId: actorId,
    action: "server.schedule.update",
    targetType: "server",
    targetId: serverId,
    metadata: { scheduleId, name: existing.name, enabled },
  });

  return { ...existing, enabled };
}

export async function deleteServerSchedule(
  serverId: string,
  scheduleId: string,
  actorId: string,
): Promise<void> {
  const existing = await getServerSchedule(serverId, scheduleId);

  // Tasks and run history cascade. The history goes deliberately: it is only ever
  // read through the schedule it belongs to, so keeping it would make it
  // unreachable rows nobody can explain.
  await sql`DELETE FROM server_schedules WHERE id = ${scheduleId}`;

  await recordAudit({
    userId: actorId,
    action: "server.schedule.delete",
    targetType: "server",
    targetId: serverId,
    metadata: { scheduleId, name: existing.name, cron: existing.cron },
  });
}

// --- Firing -------------------------------------------------------------------

/** A schedule the runner may consider, with everything a decision needs. */
export interface DueSchedule {
  id: string;
  serverId: string;
  serverName: string;
  nodeId: string;
  name: string;
  cron: string;
  onlyWhenRunning: boolean;
  serverStatus: ServerStatus;
  createdBy: string | null;
  tasks: ScheduleTask[];
}

/**
 * Every enabled schedule whose server is in a state worth acting on.
 *
 * The state filter lives here rather than in the runner so the "which servers?"
 * rule has one home, the same reasoning as `listServersDueForBackup`:
 *
 *   - `suspended`: the container is stopped pending review, and a schedule must
 *     not be a way to keep working on a server an administrator has frozen.
 *   - `creating` / `installing` / `deleting`: mid-transition, with nothing
 *     stable to act on.
 *
 * `error` is deliberately *not* excluded, unlike the backup sweep: a server that
 * failed a start is exactly the one whose nightly `power.start` schedule should
 * get another go.
 *
 * A schedule with an already-running run is excluded, which is the guard against
 * a long run (one with delays) being started a second time by a later tick.
 */
export async function listCandidateSchedules(): Promise<DueSchedule[]> {
  const rows = (await sql`
    SELECT sc.id, sc.server_id, sc.name, sc.cron, sc.only_when_running, sc.created_by,
           s.name AS server_name, s.node_id, s.status AS server_status
    FROM server_schedules sc
    JOIN servers s ON s.id = sc.server_id
    WHERE sc.enabled = TRUE
      AND s.status NOT IN ('suspended', 'creating', 'installing', 'deleting')
      AND NOT EXISTS (
        SELECT 1 FROM server_schedule_runs r
        WHERE r.schedule_id = sc.id AND r.status = 'running'
      )
    ORDER BY sc.created_at ASC
  `) as {
    id: string;
    server_id: string;
    name: string;
    cron: string;
    only_when_running: boolean;
    created_by: string | null;
    server_name: string;
    node_id: string;
    server_status: ServerStatus;
  }[];

  if (rows.length === 0) return [];

  const taskRows = (await sql`
    SELECT schedule_id, position, action, payload, delay_seconds, continue_on_failure
    FROM server_schedule_tasks
    WHERE schedule_id = ANY(${rows.map((row) => row.id)}::uuid[])
    ORDER BY schedule_id, position ASC
  `) as TaskRow[];

  const bySchedule = new Map<string, ScheduleTask[]>();
  for (const row of taskRows) {
    const list = bySchedule.get(row.schedule_id) ?? [];
    list.push(toTask(row));
    bySchedule.set(row.schedule_id, list);
  }

  return rows
    .map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      nodeId: row.node_id,
      name: row.name,
      cron: row.cron,
      onlyWhenRunning: row.only_when_running,
      serverStatus: row.server_status,
      createdBy: row.created_by,
      tasks: bySchedule.get(row.id) ?? [],
    }))
    // A schedule with no tasks cannot happen through the API (the validator
    // refuses an empty list) but would be a silent no-op run if it did.
    .filter((schedule) => schedule.tasks.length > 0);
}

/**
 * Whether a scheduled run has already been started for this schedule since
 * `since`.
 *
 * The double-fire guard is a time window rather than a stored "last fired at"
 * marker, for the same reason the backup scheduler's is: the tick is shorter
 * than a minute, so the same due minute is evaluated more than once, and a
 * marker would have to be written transactionally with the run to be
 * trustworthy. Asking "did a scheduled run start since the top of this minute?"
 * needs no extra state and survives a panel restart mid-minute.
 *
 * Manual runs are excluded from the question: pressing "Run now" at 03:59:58
 * must not cancel the 04:00 fire.
 */
export async function hasScheduledRunSince(
  scheduleId: string,
  since: Date,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM server_schedule_runs
    WHERE schedule_id = ${scheduleId}
      AND trigger = 'scheduled'
      AND started_at >= ${since}
    LIMIT 1
  `) as { 1: number }[];

  return rows.length > 0;
}

// --- Running ------------------------------------------------------------------

async function openRun(
  schedule: { id: string; serverId: string },
  trigger: ScheduleTrigger,
  actorId: string | null,
): Promise<string> {
  const [row] = (await sql`
    INSERT INTO server_schedule_runs (schedule_id, server_id, trigger, status, actor_id)
    VALUES (${schedule.id}, ${schedule.serverId}, ${trigger}, 'running', ${actorId})
    RETURNING id
  `) as { id: string }[];

  await sql`
    UPDATE server_schedules
    SET last_run_at = now(), last_status = 'running'
    WHERE id = ${schedule.id}
  `;

  return row!.id;
}

async function closeRun(
  runId: string,
  scheduleId: string,
  status: Exclude<ScheduleRunStatus, "running">,
  steps: ScheduleStep[],
  error: string | null,
): Promise<void> {
  await sql`
    UPDATE server_schedule_runs
    SET status = ${status},
        steps = ${sql.json(steps as never)},
        error = ${error},
        finished_at = now()
    WHERE id = ${runId}
  `;
  await sql`
    UPDATE server_schedules SET last_status = ${status} WHERE id = ${scheduleId}
  `;
}

/** Sleep, for a task's `delaySeconds`. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform one task.
 *
 * Every branch delegates to the service function the interactive path uses, so a
 * scheduled action is indistinguishable from a clicked one: the same suspension
 * checks, the same status transitions, the same plugin auto-update before a
 * start, and the same audit row. `actorId` is the schedule's author, which is
 * what makes those audit rows attributable to a person rather than to "the
 * system"; it is null only when that account has since been deleted.
 */
async function runTask(
  schedule: DueSchedule,
  task: ScheduleTask,
  actorId: string | null,
): Promise<void> {
  switch (task.action) {
    case "power.start":
      await startServer(schedule.serverId, actorId);
      return;
    case "power.stop":
      await stopServer(schedule.serverId, actorId);
      return;
    case "power.restart":
      await restartServer(schedule.serverId, actorId);
      return;
    case "power.kill":
      await killServer(schedule.serverId, actorId);
      return;
    case "backup":
      // Fire-and-track: `startServerBackup` hands the job to the node and
      // returns. Waiting for the snapshot would hold the run open for however
      // long a world takes to upload, and the backup already has its own
      // durable row, its own log and its own reconciler. What this task owns is
      // "was the backup accepted", which is exactly what a throw here means.
      await startServerBackup({
        serverId: schedule.serverId,
        actorId,
        trigger: "scheduled",
      });
      return;
    case "command": {
      if (!task.command) {
        // Unreachable through the API; a hand-edited row would land here.
        throw new Error("This task is a console command but carries no command.");
      }
      await sendServerCommand(schedule.nodeId, schedule.serverId, task.command);
      await recordAudit({
        userId: actorId,
        action: "server.console.command",
        targetType: "server",
        targetId: schedule.serverId,
        metadata: {
          command: task.command.slice(0, 500),
          via: "schedule",
          scheduleId: schedule.id,
        },
      });
      return;
    }
  }
}

/**
 * Execute a schedule's tasks in order and record the outcome.
 *
 * Never throws. The caller is either a timer with nobody to report to or a route
 * that has already answered, so every failure has to become a *recorded*
 * outcome. The run row is the report.
 *
 * A failing task stops the rest unless it is marked `continue_on_failure`; the
 * tasks that did not run are recorded as `skipped` rather than omitted, so the
 * run explains itself without the reader having to compare it against the
 * schedule.
 */
export async function executeSchedule(
  schedule: DueSchedule,
  trigger: ScheduleTrigger,
  actorId: string | null,
): Promise<ScheduleRunStatus> {
  const runId = await openRun(schedule, trigger, actorId);
  const steps: ScheduleStep[] = [];
  let failed = false;
  let stoppedAt: number | null = null;

  for (const [index, task] of schedule.tasks.entries()) {
    if (stoppedAt !== null) {
      const now = new Date().toISOString();
      steps.push({
        position: index + 1,
        action: task.action,
        status: "skipped",
        error: `Skipped: task ${stoppedAt} failed and does not allow the schedule to continue.`,
        startedAt: now,
        finishedAt: now,
      });
      continue;
    }

    if (task.delaySeconds > 0) {
      await wait(task.delaySeconds * 1000);
    }

    const startedAt = new Date().toISOString();
    try {
      await runTask(schedule, task, actorId);
      steps.push({
        position: index + 1,
        action: task.action,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      failed = true;
      steps.push({
        position: index + 1,
        action: task.action,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      if (!task.continueOnFailure) stoppedAt = index + 1;
    }
  }

  const status: Exclude<ScheduleRunStatus, "running"> = failed ? "failed" : "succeeded";
  const firstFailure = steps.find((step) => step.status === "failed");

  try {
    await closeRun(
      runId,
      schedule.id,
      status,
      steps,
      failed ? (firstFailure?.error ?? "A task failed.") : null,
    );
  } catch (error) {
    // The tasks already ran; losing the report is bad but not worth throwing
    // into a timer over. The boot sweep will close the row out.
    console.error(`[schedules] could not record run ${runId}:`, error);
  }

  return status;
}

/**
 * Run a schedule now, on a person's request.
 *
 * Deliberately reuses the whole scheduled path, including
 * {@link listCandidateSchedules}' state filter, so "Run now" cannot do something
 * the schedule itself would have refused: a suspended server is not startable by
 * hand through this button either.
 *
 * `onlyWhenRunning` is the one rule a manual run ignores. It exists to stop an
 * unattended schedule acting on a stopped server; somebody pressing the button
 * is not unattended, and refusing them would be a puzzle rather than a
 * safeguard.
 */
export async function runScheduleNow(
  serverId: string,
  scheduleId: string,
  actorId: string,
): Promise<ScheduleRunStatus> {
  // Confirms the schedule belongs to this server before anything else.
  await getServerSchedule(serverId, scheduleId);

  const candidates = await listCandidateSchedules();
  const schedule = candidates.find((entry) => entry.id === scheduleId);

  if (!schedule) {
    // Either the server is in a state the runner will not act on, or a run is
    // already in flight. Both are worth saying apart, since only one is temporary
    // in a way the operator controls.
    const running = await sql`
      SELECT 1 FROM server_schedule_runs
      WHERE schedule_id = ${scheduleId} AND status = 'running' LIMIT 1
    `;
    if ((running as unknown[]).length > 0) {
      throw conflict("This schedule is already running.");
    }
    throw conflict(
      "This schedule cannot run right now: the server is suspended, being created, " +
        "installing, or being deleted.",
    );
  }

  return executeSchedule(schedule, "manual", actorId);
}

// --- Recovery -----------------------------------------------------------------

/**
 * Fail runs that nobody is working on any more.
 *
 * Called at boot (like `failInterruptedProvisions`) and on every tick. Runs
 * execute in this process, so a `running` row from a previous process has no
 * owner; and a row whose own budget has expired has an owner that is not coming
 * back. Both must be closed, because a stuck `running` row blocks the schedule's
 * next fire through {@link listCandidateSchedules}' already-running check.
 *
 * `bootedAt` separates the two cases: rows started before this process existed
 * are failed immediately, while rows this process started are given their own
 * budget first. Without that split, a boot sweep would kill a legitimate
 * in-flight run every tick.
 */
export async function failInterruptedScheduleRuns(bootedAt: number): Promise<number> {
  const rows = (await sql`
    SELECT r.id, r.schedule_id, r.started_at,
           COALESCE(sum(t.delay_seconds), 0)::int AS delay_total,
           count(t.id)::int AS task_count
    FROM server_schedule_runs r
    LEFT JOIN server_schedule_tasks t ON t.schedule_id = r.schedule_id
    WHERE r.status = 'running'
    GROUP BY r.id, r.schedule_id, r.started_at
  `) as {
    id: string;
    schedule_id: string | null;
    started_at: Date;
    delay_total: number;
    task_count: number;
  }[];

  let closed = 0;
  for (const row of rows) {
    const started = row.started_at.getTime();
    const budget = row.delay_total * 1000 + Math.max(1, row.task_count) * PER_TASK_BUDGET_MS;
    const abandoned = started < bootedAt;
    const expired = Date.now() - started > budget;

    if (!abandoned && !expired) continue;

    await sql`
      UPDATE server_schedule_runs
      SET status = 'failed',
          error = ${
            abandoned
              ? "The panel restarted while this run was in progress, so it was " +
                "abandoned part-way. Any task that had already started on a node " +
                "completed there. The next scheduled run is unaffected."
              : "This run did not finish within the time its own tasks allow for, so " +
                "it was closed out. Check the server's activity feed for which of " +
                "its actions took effect."
          },
          finished_at = now()
      WHERE id = ${row.id}
    `;
    if (row.schedule_id) {
      await sql`
        UPDATE server_schedules SET last_status = 'failed' WHERE id = ${row.schedule_id}
      `;
    }
    closed += 1;
  }

  return closed;
}
