"use client";

import * as React from "react";
import {
  CalendarClock,
  Archive,
  Check,
  ChevronDown,
  CircleAlert,
  Play,
  Plus,
  Power,
  RefreshCw,
  Terminal,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useServerData } from "@/components/server/server-data-context";
import { viewerAllows } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
  ApiError,
  createServerSchedule,
  deleteServerSchedule,
  getScheduleRuns,
  getServerSchedules,
  previewSchedule,
  runServerSchedule,
  setScheduleEnabled,
  updateServerSchedule,
  type Schedule,
  type ScheduleListView,
  type ScheduleRun,
  type ScheduleTask,
  type ScheduleTaskAction,
  type ScheduleWrite,
} from "@/lib/api";
import type { ServerPermission } from "@/lib/types";

/** How long to wait after a keystroke before asking the server to parse a cron. */
const PREVIEW_DEBOUNCE_MS = 400;

/** Backend caps, mirrored so the form can refuse before a round trip. */
const MAX_TASKS = 10;
const MAX_DELAY_SECONDS = 900;

/**
 * How each task kind presents itself, and what it needs.
 *
 * `permission` is the flag the *backend* additionally requires to save a
 * schedule containing this task, over and above `schedules`. Mirrored here so
 * the form can grey out a task kind a subuser cannot use, rather than letting
 * them compose a schedule and then meet a 403 on save (`docs/scheduler.md`).
 */
const TASK_KINDS: readonly {
  action: ScheduleTaskAction;
  label: string;
  description: string;
  icon: LucideIcon;
  permission: ServerPermission;
}[] = [
  {
    action: "power.start",
    label: "Start",
    description: "Start the server if it is not already running.",
    icon: Power,
    permission: "start_stop",
  },
  {
    action: "power.stop",
    label: "Stop",
    description: "Stop the server gracefully, letting the game save.",
    icon: Power,
    permission: "start_stop",
  },
  {
    action: "power.restart",
    label: "Restart",
    description: "Stop and start the server.",
    icon: RefreshCw,
    permission: "start_stop",
  },
  {
    action: "power.kill",
    label: "Kill",
    description: "Force-stop with no grace period. The game does not get to save.",
    icon: Zap,
    permission: "start_stop",
  },
  {
    action: "backup",
    label: "Back up files",
    description: "Take a backup of the server's files, counting against its quota.",
    icon: Archive,
    permission: "backups",
  },
  {
    action: "command",
    label: "Console command",
    description: "Send a command to the server console, as if typed.",
    icon: Terminal,
    permission: "console",
  },
];

function kindOf(action: ScheduleTaskAction) {
  return TASK_KINDS.find((kind) => kind.action === action)!;
}

/** "in 4h 12m", or an absolute time once it is further out than a day. */
function relativeTime(iso: string): string {
  const target = new Date(iso).getTime();
  const deltaMinutes = Math.round((target - Date.now()) / 60_000);

  if (deltaMinutes < 1) return "any moment";
  if (deltaMinutes < 60) return `in ${deltaMinutes}m`;
  if (deltaMinutes < 1440) {
    const hours = Math.floor(deltaMinutes / 60);
    const minutes = deltaMinutes % 60;
    return minutes === 0 ? `in ${hours}h` : `in ${hours}h ${minutes}m`;
  }
  return new Date(iso).toLocaleString();
}

function delayLabel(seconds: number): string {
  if (seconds === 0) return "immediately";
  if (seconds % 60 === 0) return `after ${seconds / 60}m`;
  return `after ${seconds}s`;
}

// --- Task editor ----------------------------------------------------------------

/**
 * One row of the task list being edited.
 *
 * The delay is expressed per task and reads as "wait, then do this", which is
 * what makes the common staged schedule ("warn, wait a minute, restart") one
 * schedule rather than three that have to be timed against each other by hand.
 */
function TaskEditorRow({
  task,
  index,
  total,
  allowed,
  onChange,
  onRemove,
}: {
  task: ScheduleTask;
  index: number;
  total: number;
  allowed: (permission: ServerPermission) => boolean;
  onChange: (task: ScheduleTask) => void;
  onRemove: () => void;
}) {
  const kind = kindOf(task.action);

  return (
    <div
      data-slot="schedule-task-editor"
      className="flex flex-col gap-3 rounded-lg border bg-muted/20 px-3 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground">
          {index + 1}
        </span>
        <Select
          value={task.action}
          onValueChange={(value) => {
            if (!value) return;
            const action = value as ScheduleTaskAction;
            // Dropping the command when the action changes away from `command`
            // keeps the payload honest: a stored command on a restart task would
            // be invisible state the author cannot see or edit.
            onChange({ ...task, action, command: action === "command" ? task.command : null });
          }}
        >
          <SelectTrigger aria-label={`Task ${index + 1} action`} className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TASK_KINDS.map((option) => (
              <SelectItem
                key={option.action}
                value={option.action}
                disabled={!allowed(option.permission)}
              >
                {option.label}
                {!allowed(option.permission) && " (no permission)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove task ${index + 1}`}
          disabled={total <= 1}
          onClick={onRemove}
          className="shrink-0"
        >
          <Trash2 />
        </Button>
      </div>

      <p className="pl-8 text-xs text-muted-foreground">{kind.description}</p>

      {task.action === "command" && (
        <Field className="pl-8">
          <FieldLabel htmlFor={`task-${index}-command`}>Command</FieldLabel>
          <Input
            id={`task-${index}-command`}
            className="font-mono"
            value={task.command ?? ""}
            onChange={(event) => onChange({ ...task, command: event.target.value })}
            placeholder="say Restarting in 60 seconds"
          />
          <FieldDescription>
            Sent to the console exactly as written, with no leading slash unless the
            game wants one.
          </FieldDescription>
        </Field>
      )}

      <div className="flex flex-col gap-3 pl-8 sm:flex-row sm:items-end sm:gap-4">
        <Field className="sm:max-w-40">
          <FieldLabel htmlFor={`task-${index}-delay`}>Wait first (seconds)</FieldLabel>
          <Input
            id={`task-${index}-delay`}
            type="number"
            min={0}
            max={MAX_DELAY_SECONDS}
            value={String(task.delaySeconds)}
            onChange={(event) =>
              onChange({ ...task, delaySeconds: Math.max(0, Number(event.target.value) || 0) })
            }
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={task.continueOnFailure}
            onCheckedChange={(checked) =>
              onChange({ ...task, continueOnFailure: checked === true })
            }
          />
          <span className="text-muted-foreground">
            Carry on if this task fails
          </span>
        </label>
      </div>
    </div>
  );
}

const BLANK_TASK: ScheduleTask = {
  action: "power.restart",
  command: null,
  delaySeconds: 0,
  continueOnFailure: false,
};

/**
 * The create/edit form.
 *
 * One form for both, because the edit is a whole replace: the tasks are an
 * ordered list, so there is no partial edit of one that means anything once
 * another has moved. The cron preview comes from the server for the reason
 * stated in `previewSchedule` — the browser must not be the thing that decides
 * what an expression means.
 */
function ScheduleForm({
  serverId,
  existing,
  presets,
  allowed,
  onSaved,
  onCancel,
}: {
  serverId: string;
  existing: Schedule | null;
  presets: ScheduleListView["presets"];
  allowed: (permission: ServerPermission) => boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = React.useState(existing?.name ?? "");
  const [cron, setCron] = React.useState(existing?.cron ?? "0 4 * * *");
  const [onlyWhenRunning, setOnlyWhenRunning] = React.useState(
    existing?.onlyWhenRunning ?? false,
  );
  const [tasks, setTasks] = React.useState<ScheduleTask[]>(
    existing?.tasks.length ? existing.tasks : [BLANK_TASK],
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{
    description: string;
    nextRuns: string[];
    timezone: string;
  } | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  // Debounced after the first pass, not on the way in: there is nothing to
  // debounce when the value is the stored expression, and waiting left the card
  // empty for the delay on every open.
  const previewedOnce = React.useRef(false);
  React.useEffect(() => {
    let cancelled = false;
    const delay = previewedOnce.current ? PREVIEW_DEBOUNCE_MS : 0;
    previewedOnce.current = true;

    const timer = setTimeout(async () => {
      try {
        const result = await previewSchedule(serverId, cron);
        if (!cancelled) {
          setPreview(result);
          setPreviewError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(
            err instanceof ApiError ? err.message : "That is not a valid schedule.",
          );
        }
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serverId, cron]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: ScheduleWrite = {
        name: name.trim(),
        cron: cron.trim(),
        enabled: existing?.enabled ?? true,
        onlyWhenRunning,
        tasks,
      };
      if (existing) {
        await updateServerSchedule(serverId, existing.id, payload);
      } else {
        await createServerSchedule(serverId, payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the schedule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-slot="schedule-form">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4" />
          {existing ? "Edit schedule" : "New schedule"}
        </CardTitle>
        <CardDescription>
          A schedule runs its tasks in order, on a five-field cron expression
          evaluated in the panel&apos;s timezone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor="schedule-name">Name</FieldLabel>
          <Input
            id="schedule-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nightly restart"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="schedule-cron">Cron expression</FieldLabel>
          <Input
            id="schedule-cron"
            className="font-mono"
            value={cron}
            onChange={(event) => setCron(event.target.value)}
            placeholder="0 4 * * *"
          />
          <FieldDescription>
            <span className="font-mono">minute hour day-of-month month day-of-week</span>
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="schedule-preset">Or pick a common schedule</FieldLabel>
          <Select value="" onValueChange={(value) => value && setCron(value)}>
            <SelectTrigger id="schedule-preset">
              <SelectValue placeholder="Choose a preset…" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {previewError ? (
          <p className="text-sm text-destructive">{previewError}</p>
        ) : (
          preview && (
            <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
              <span className="text-sm font-medium">{preview.description}</span>
              {preview.nextRuns.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  Next runs ({preview.timezone}):{" "}
                  {preview.nextRuns
                    .slice(0, 3)
                    .map((iso) => new Date(iso).toLocaleString())
                    .join(" · ")}
                </span>
              )}
            </div>
          )
        )}

        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={onlyWhenRunning}
            onCheckedChange={(checked) => setOnlyWhenRunning(checked === true)}
          />
          <span className="text-muted-foreground">
            Only run when the server is running
          </span>
        </label>

        <Separator />

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Tasks</span>
              <span className="text-xs text-muted-foreground">
                Run in order. A failed task stops the ones after it unless you say
                otherwise.
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={tasks.length >= MAX_TASKS}
              onClick={() => setTasks([...tasks, BLANK_TASK])}
            >
              <Plus />
              Add task
            </Button>
          </div>

          {tasks.map((task, index) => (
            <TaskEditorRow
              key={index}
              task={task}
              index={index}
              total={tasks.length}
              allowed={allowed}
              onChange={(next) =>
                setTasks(tasks.map((entry, i) => (i === index ? next : entry)))
              }
              onRemove={() => setTasks(tasks.filter((_, i) => i !== index))}
            />
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-2">
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? <Spinner /> : <Check />}
            {existing ? "Save changes" : "Create schedule"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Run history ----------------------------------------------------------------

function StepRow({ step }: { step: ScheduleRun["steps"][number] }) {
  const kind = kindOf(step.action);

  return (
    <div className="flex items-start gap-2 py-1 text-xs">
      <span
        className={cn(
          "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full",
          step.status === "succeeded" && "bg-primary/15 text-primary",
          step.status === "failed" && "bg-destructive/15 text-destructive",
          step.status === "skipped" && "bg-muted text-muted-foreground",
        )}
      >
        {step.status === "succeeded" ? (
          <Check className="size-3" />
        ) : step.status === "failed" ? (
          <X className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">
          {step.position}. {kind.label}
        </span>
        {step.error && <span className="text-muted-foreground">{step.error}</span>}
      </div>
    </div>
  );
}

/**
 * A schedule's recent runs.
 *
 * Loaded on demand rather than with the list: the history is only interesting
 * for the schedule somebody is looking into, and fetching it for every schedule
 * on every page load would be one query per schedule for data nobody read.
 */
function RunHistory({ serverId, scheduleId }: { serverId: string; scheduleId: string }) {
  const [runs, setRuns] = React.useState<ScheduleRun[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getScheduleRuns(serverId, scheduleId);
        if (!cancelled) setRuns(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load run history.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, scheduleId]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!runs) return <Skeleton className="h-16 w-full" />;
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This schedule has not run yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {runs.map((run) => (
        <div key={run.id} className="rounded-lg border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                run.status === "succeeded"
                  ? "default"
                  : run.status === "failed"
                    ? "destructive"
                    : "secondary"
              }
            >
              {run.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {new Date(run.startedAt).toLocaleString()}
              {run.trigger === "manual" && " · run by hand"}
            </span>
          </div>
          {run.steps.length > 0 && (
            <div className="mt-1.5 flex flex-col">
              {run.steps.map((step) => (
                <StepRow key={step.position} step={step} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- Schedule card --------------------------------------------------------------

function ScheduleCard({
  serverId,
  schedule,
  timezone,
  canRun,
  onEdit,
  onChanged,
}: {
  serverId: string;
  schedule: Schedule;
  timezone: string;
  canRun: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState<"toggle" | "run" | "delete" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const act = async (
    kind: "toggle" | "run" | "delete",
    work: () => Promise<string | null>,
  ) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      setNote(await work());
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-slot="schedule-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              {schedule.name}
              {!schedule.enabled && <Badge variant="outline">Off</Badge>}
              {schedule.lastStatus === "failed" && (
                <Badge variant="destructive">Last run failed</Badge>
              )}
              {schedule.lastStatus === "running" && <Badge variant="secondary">Running</Badge>}
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-foreground">{schedule.cron}</span>
              <span>·</span>
              {schedule.enabled && schedule.nextRun ? (
                <span>
                  next {relativeTime(schedule.nextRun)} ({timezone})
                </span>
              ) : (
                <span>not scheduled</span>
              )}
              {schedule.onlyWhenRunning && (
                <>
                  <span>·</span>
                  <span>only while running</span>
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Switch
              aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`}
              checked={schedule.enabled}
              disabled={busy !== null}
              onCheckedChange={(checked) =>
                act("toggle", async () => {
                  await setScheduleEnabled(serverId, schedule.id, checked === true);
                  return null;
                })
              }
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/*
          The task list is the schedule. Shown expanded rather than behind a
          disclosure, because "what does this actually do at 04:00?" is the only
          question a reader has, and a collapsed card answers none of it.
        */}
        <ol className="flex flex-col gap-1.5">
          {schedule.tasks.map((task, index) => {
            const kind = kindOf(task.action);
            return (
              <li
                key={index}
                className="flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm"
              >
                <kind.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span>
                    {kind.label}
                    {task.action === "command" && task.command && (
                      <span className="font-mono text-muted-foreground"> {task.command}</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {delayLabel(task.delaySeconds)}
                    {task.continueOnFailure && " · carries on if it fails"}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>

        {error && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
        {note && <p className="text-sm text-muted-foreground">{note}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {canRun && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act("run", async () => {
                  const { status } = await runServerSchedule(serverId, schedule.id);
                  return status === "succeeded"
                    ? "Every task in this schedule ran."
                    : "The run finished with a failure. Open its history for which task.";
                })
              }
            >
              {busy === "run" ? <Spinner /> : <Play />}
              Run now
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowHistory(!showHistory)}
          >
            {showHistory ? "Hide history" : "History"}
          </Button>
          <div className="grow" />
          {confirmDelete ? (
            <>
              <span className="text-sm text-muted-foreground">Delete this schedule?</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  act("delete", async () => {
                    await deleteServerSchedule(serverId, schedule.id);
                    return null;
                  })
                }
              >
                {busy === "delete" ? <Spinner /> : <Trash2 />}
                Delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${schedule.name}`}
              disabled={busy !== null}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
            </Button>
          )}
        </div>

        {showHistory && (
          <>
            <Separator />
            <RunHistory serverId={serverId} scheduleId={schedule.id} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// --- Tab ------------------------------------------------------------------------

/**
 * The Schedules tab.
 *
 * A schedule is a cron expression plus an ordered list of tasks: power actions,
 * a file backup, or a console command. Every task runs through the same panel
 * path the equivalent button does, so a schedule can do nothing its author could
 * not do by hand — which is also why the form disables the task kinds the
 * viewer's own permissions would not allow (`docs/scheduler.md`).
 */
export function SchedulesTab({ serverId }: { serverId: string }) {
  const { server } = useServerData();
  const [data, setData] = React.useState<ScheduleListView | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  /** null = closed, "new" = create, otherwise the id being edited. */
  const [editing, setEditing] = React.useState<string | "new" | null>(null);

  const allowed = React.useCallback(
    (permission: ServerPermission) => viewerAllows(server.viewer, permission),
    [server.viewer],
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const view = await getServerSchedules(serverId);
        if (!cancelled) setData(view);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          if (!cancelled) setDenied(true);
        } else if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load schedules.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, refreshKey]);

  const reload = () => setRefreshKey((key) => key + 1);

  if (denied) {
    return (
      <Empty className="max-w-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarClock />
          </EmptyMedia>
          <EmptyTitle>No access to schedules</EmptyTitle>
          <EmptyDescription>
            You don&apos;t have the &quot;schedules&quot; permission on this server.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <Skeleton className="h-64 w-full" />;

  const editingSchedule =
    editing && editing !== "new"
      ? (data.schedules.find((schedule) => schedule.id === editing) ?? null)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-lg font-semibold tracking-tight">Schedules</h2>
          <p className="text-sm text-muted-foreground">
            Unattended tasks on a cron expression, evaluated in{" "}
            <span className="font-medium text-foreground">{data.timezone}</span>. Each
            schedule runs its tasks in order.
          </p>
        </div>
        {editing === null && (
          <Button type="button" onClick={() => setEditing("new")}>
            <Plus />
            New schedule
          </Button>
        )}
      </div>

      {editing !== null && (
        <ScheduleForm
          serverId={serverId}
          existing={editingSchedule}
          presets={data.presets}
          allowed={allowed}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {data.schedules.length === 0 && editing === null ? (
        <Empty className="max-w-md">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClock />
            </EmptyMedia>
            <EmptyTitle>No schedules yet</EmptyTitle>
            <EmptyDescription>
              Schedules run without anyone watching: restart the server nightly, warn
              players before it happens, or take a backup every morning.
            </EmptyDescription>
          </EmptyHeader>
          <Button type="button" onClick={() => setEditing("new")}>
            <Plus />
            New schedule
          </Button>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {data.schedules
            // The one being edited is already shown, in the form above.
            .filter((schedule) => schedule.id !== editing)
            .map((schedule) => (
              <ScheduleCard
                key={schedule.id}
                serverId={serverId}
                schedule={schedule}
                timezone={data.timezone}
                canRun={schedule.tasks.every((task) =>
                  allowed(kindOf(task.action).permission),
                )}
                onEdit={() => setEditing(schedule.id)}
                onChanged={reload}
              />
            ))}
        </div>
      )}
    </div>
  );
}
