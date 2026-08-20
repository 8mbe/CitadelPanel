"use client";

import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Database,
  RotateCcw,
  Trash2,
} from "lucide-react";

import {
  ApiError,
  createNodeDatabaseBackup,
  deleteNodeDatabaseBackup,
  getDatabaseBackupNodes,
  getNodeDatabaseBackupLogs,
  getNodeDatabaseBackups,
  previewBackupSchedule,
  restoreNodeDatabaseBackup,
  setNodeDatabaseBackupsEnabled,
  type AdminSettings,
  type AdminSettingsUpdate,
  type DatabaseBackupNode,
  type DatabaseBackupsView,
  type ServerBackup,
  type ServerBackupLogLine,
} from "@/lib/api";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CRON_PRESETS } from "@/lib/cron";
import { formatBytes, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How often to poll while a run is in flight. */
const POLL_MS = 2000;

/** How long to wait after a keystroke before asking the server to parse a cron. */
const PREVIEW_DEBOUNCE_MS = 400;

const PHASE_LABELS: Record<string, string> = {
  starting: "Starting",
  preparing_repository: "Preparing the S3 repository",
  enforcing_limit: "Removing the oldest backup",
  dumping_databases: "Dumping databases",
  uploading: "Uploading to S3",
  restoring_files: "Fetching the snapshot",
  importing_databases: "Importing databases",
  measuring: "Measuring storage",
  finished: "Finishing",
};

function phaseLabel(phase: string | null): string {
  if (!phase) return "Queued";
  return PHASE_LABELS[phase] ?? phase;
}

function isActive(run: ServerBackup | null): boolean {
  return run !== null && (run.status === "pending" || run.status === "running");
}

/**
 * Database backups: the administrator-owned scope.
 *
 * Two cards, because they answer different questions. The schedule is
 * configuration — when should this happen, and how much history to keep. The
 * per-node list is operational — what is the state of each node right now, and let
 * me act on it.
 *
 * Deliberately separate from the server-backup schedule above it. Dumping every
 * database on a node uses that node's root-equivalent MariaDB credential, so it is
 * a more privileged operation on a different subject at a different cadence; an
 * operator who wants nightly file backups does not necessarily want the same
 * frequency of full database sweeps.
 */
export function DatabaseBackupsSection({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  return (
    <>
      <DatabaseScheduleCard settings={settings} patch={patch} />
      <NodeDatabaseBackupsCard configured={settings.backups.usable} />
    </>
  );
}

// --- Schedule --------------------------------------------------------------------

function DatabaseScheduleCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const s = settings.backups.databases;
  const [cron, setCron] = React.useState(s.schedule);
  const [maxPerNode, setMaxPerNode] = React.useState(String(s.maxPerNode));
  const [loading, setLoading] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{
    description: string;
    nextRuns: string[];
    timezone: string;
  } | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  // Computed server-side so it uses the panel's timezone and the same parser the
  // scheduler does — a schedule can never preview one thing and then do another.
  // Debounced so typing does not fire a request per keystroke, but not on first
  // render: the stored schedule needs no debouncing, and waiting for one left
  // the card blank for the delay every time the page opened.
  const previewedOnce = React.useRef(false);
  React.useEffect(() => {
    let cancelled = false;
    const delay = previewedOnce.current ? PREVIEW_DEBOUNCE_MS : 0;
    previewedOnce.current = true;
    const timer = setTimeout(async () => {
      try {
        const result = await previewBackupSchedule(cron);
        if (!cancelled) {
          setPreview(result);
          setPreviewError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(err instanceof ApiError ? err.message : "Invalid schedule.");
        }
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cron]);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        backups: {
          enabled: settings.backups.enabled,
          databases: {
            schedule: cron.trim(),
            maxPerNode: Math.max(0, Number(maxPerNode) || 0),
          },
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the schedule.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" />
          Database backups
        </CardTitle>
        <CardDescription>
          One snapshot per node, holding a SQL dump of every database provisioned on
          it. This is separate from server backups on purpose: reading every
          tenant&apos;s database at once needs the node&apos;s administrator
          credential, so it is not something a server owner can trigger.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="db-backups-cron">Cron expression</FieldLabel>
          <Input
            id="db-backups-cron"
            className="font-mono"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 3 * * *"
          />
          <FieldDescription>
            Leave empty to only back up databases when you press the button below.
            Consider a different hour from the server schedule — both read the same
            disks.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="db-backups-preset">Or pick a common schedule</FieldLabel>
          <Select value="" onValueChange={(value) => value && setCron(value)}>
            <SelectTrigger id="db-backups-preset">
              <SelectValue placeholder="Choose a preset…" />
            </SelectTrigger>
            <SelectContent>
              {CRON_PRESETS.map((preset) => (
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

        <Field>
          <FieldLabel htmlFor="db-backups-max">Backups kept per node</FieldLabel>
          <Input
            id="db-backups-max"
            type="number"
            min={0}
            max={1000}
            value={maxPerNode}
            onChange={(e) => setMaxPerNode(e.target.value)}
          />
          <FieldDescription>
            Once a node has this many, a new backup removes its oldest first — so the
            count never exceeds the limit. 0 means unlimited.
          </FieldDescription>
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}

        <div>
          <Button onClick={save} disabled={loading || previewError !== null}>
            {loading && <Spinner />}
            Save database schedule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Per-node operations ----------------------------------------------------------

/**
 * Live status for a node's in-flight run: phase, progress, and the log tail.
 *
 * Keyed on the run id by its caller, so a new run remounts it with fresh state
 * rather than needing the previous run's log cleared inside an effect.
 */
function ActiveRunPanel({
  nodeId,
  run,
  onFinished,
}: {
  nodeId: string;
  run: ServerBackup;
  onFinished: () => void;
}) {
  const [lines, setLines] = React.useState<ServerBackupLogLine[]>([]);
  const [phase, setPhase] = React.useState(run.phase);
  const [percent, setPercent] = React.useState(run.percent);
  const [error, setError] = React.useState<string | null>(run.error);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const cursor = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const data = await getNodeDatabaseBackupLogs(nodeId, run.id, cursor.current);
        if (cancelled) return;

        if (data.logs.length > 0) {
          cursor.current = data.logs[data.logs.length - 1]!.seq;
          setLines((previous) => [...previous, ...data.logs].slice(-400));
        }
        setPhase(data.phase);
        setPercent(data.percent);
        setError(data.error);

        if (data.status === "succeeded" || data.status === "failed") {
          onFinished();
          return;
        }
      } catch {
        // A dropped poll is not worth surfacing — the next one either succeeds or
        // the run resolves. The reconciler is the source of truth.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nodeId, run.id, onFinished]);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-sm">
        <Spinner className="size-3.5" />
        <span className="font-medium">
          {run.kind === "restore" ? "Restoring databases" : "Backing up databases"}
        </span>
        <span className="text-muted-foreground">· {phaseLabel(phase)}</span>
      </div>
      <Progress value={percent} />
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{percent}%</span>
        <span>started {formatRelative(run.createdAt)}</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <ScrollArea
        ref={scrollRef}
        className="h-40 rounded-md border bg-background p-2 font-mono text-xs"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground">Waiting for the node…</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {lines.map((line) => (
              <div
                key={line.seq}
                className={cn(
                  "break-words",
                  line.level === "error"
                    ? "text-destructive"
                    : line.level === "warn"
                      ? "text-amber-600 dark:text-amber-500"
                      : "text-foreground/80",
                )}
              >
                {line.message}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function RunStatusBadge({ run }: { run: ServerBackup }) {
  if (run.status === "succeeded") {
    return (
      <Badge variant="outline" className="gap-1">
        <CircleCheck className="size-3" />
        {run.kind === "restore" ? "Restored" : "Complete"}
      </Badge>
    );
  }
  if (run.status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleAlert className="size-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Spinner className="size-3" />
      Running
    </Badge>
  );
}

/** One history row for a node's database backup. */
function RunRow({
  run,
  busy,
  onRestore,
  onDelete,
}: {
  run: ServerBackup;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const restorable = run.kind === "backup" && run.status === "succeeded";

  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{new Date(run.createdAt).toLocaleString()}</span>
          <RunStatusBadge run={run} />
          {run.kind === "restore" && <Badge variant="secondary">Restore</Badge>}
          {run.trigger === "scheduled" && <Badge variant="outline">Scheduled</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {run.snapshotId && <span className="font-mono">{run.snapshotId.slice(0, 8)}</span>}
          {run.databases.length > 0 && (
            <span>
              {run.databases.length} database{run.databases.length === 1 ? "" : "s"}
            </span>
          )}
          {run.bytesAdded !== null && (
            <span className="tabular-nums">{formatBytes(run.bytesAdded)} uploaded</span>
          )}
        </div>
        {run.status === "failed" && run.error && (
          <p className="text-xs text-destructive">{run.error}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {restorable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onRestore}
          >
            <RotateCcw />
            Restore
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete backup"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/** One node's row, with an expandable history. */
function NodeRow({
  node,
  onChanged,
  onRestoreRequest,
  onDeleteRequest,
}: {
  node: DatabaseBackupNode;
  onChanged: () => void;
  onRestoreRequest: (node: DatabaseBackupNode, run: ServerBackup) => void;
  onDeleteRequest: (node: DatabaseBackupNode, run: ServerBackup) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [runs, setRuns] = React.useState<ServerBackup[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [historyKey, setHistoryKey] = React.useState(0);

  const active = isActive(node.lastRun) ? node.lastRun : null;

  React.useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getNodeDatabaseBackups(node.nodeId);
        if (!cancelled) setRuns(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load history.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, node.nodeId, historyKey]);

  const backUpNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await createNodeDatabaseBackup(node.nodeId);
      onChanged();
      setHistoryKey((key) => key + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the backup.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setNodeDatabaseBackupsEnabled(node.nodeId, enabled);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the node.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{node.nodeName}</span>
            {!node.hasDatabaseServer ? (
              <Badge variant="outline">No database server</Badge>
            ) : (
              <Badge variant="secondary">
                {node.databaseCount} database{node.databaseCount === 1 ? "" : "s"}
              </Badge>
            )}
            {node.backupCount > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {node.backupCount} kept
              </span>
            )}
          </div>

          {node.hasDatabaseServer ? (
            <span className="text-xs text-muted-foreground">
              {node.lastRun ? (
                <>
                  Last {node.lastRun.kind === "restore" ? "restore" : "backup"}{" "}
                  {formatRelative(node.lastRun.createdAt)}
                  {node.lastRun.status === "failed" && " — failed"}
                </>
              ) : (
                "Never backed up."
              )}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Run <span className="font-mono">bun run setup-db</span> on this node and
              set its database admin credentials to enable backups.
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch
            aria-label={`Include ${node.nodeName} in the database backup schedule`}
            checked={node.enabled}
            disabled={busy || !node.hasDatabaseServer}
            onCheckedChange={(checked) => void toggle(checked === true)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              busy ||
              !node.hasDatabaseServer ||
              node.databaseCount === 0 ||
              active !== null
            }
            onClick={backUpNow}
          >
            {busy ? <Spinner /> : <Database />}
            Back up now
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={expanded ? "Hide history" : "Show history"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {active && (
        <ActiveRunPanel
          key={active.id}
          nodeId={node.nodeId}
          run={active}
          onFinished={() => {
            onChanged();
            setHistoryKey((key) => key + 1);
          }}
        />
      )}

      {expanded && (
        <div className="flex flex-col gap-2">
          {runs === null ? (
            <Skeleton className="h-16 w-full" />
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No backups yet for this node.
            </p>
          ) : (
            runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                busy={busy || active !== null}
                onRestore={() => onRestoreRequest(node, run)}
                onDelete={() => onDeleteRequest(node, run)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The per-node operational list.
 *
 * Polls while any node has a run in flight, so a backup started here shows progress
 * without the operator refreshing. Idle otherwise — there is nothing to watch.
 */
function NodeDatabaseBackupsCard({ configured }: { configured: boolean }) {
  const [data, setData] = React.useState<DatabaseBackupsView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [restoreTarget, setRestoreTarget] = React.useState<{
    node: DatabaseBackupNode;
    run: ServerBackup;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{
    node: DatabaseBackupNode;
    run: ServerBackup;
  } | null>(null);
  const [acting, setActing] = React.useState(false);

  const reload = React.useCallback(() => setRefreshKey((key) => key + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const view = await getDatabaseBackupNodes();
        if (!cancelled) setData(view);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load nodes.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Keep the list fresh while something is running, so the badges and counts move
  // in step with the log panel above them.
  const anyActive = data?.nodes.some((node) => isActive(node.lastRun)) ?? false;
  React.useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
  }, [anyActive, reload]);

  const confirmRestore = async () => {
    if (!restoreTarget) return;
    setActing(true);
    try {
      await restoreNodeDatabaseBackup(restoreTarget.node.nodeId, restoreTarget.run.id);
      setRestoreTarget(null);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the restore.");
    } finally {
      setActing(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setActing(true);
    try {
      await deleteNodeDatabaseBackup(deleteTarget.node.nodeId, deleteTarget.run.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the backup.");
    } finally {
      setActing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nodes</CardTitle>
        <CardDescription>
          Every node with a database server, and the state of its database backups.
          The switch controls whether the schedule includes it; the button runs one
          now.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!configured && (
          <p className="text-sm text-muted-foreground">
            Set an S3 destination above before backing anything up.
          </p>
        )}

        {data?.schedule.cron && (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="size-4" />
            Scheduled <span className="font-mono text-foreground">{data.schedule.cron}</span>
            {data.schedule.nextRun && (
              <>
                {" "}
                · next{" "}
                <span className="text-foreground">
                  {new Date(data.schedule.nextRun).toLocaleString()}
                </span>
              </>
            )}
          </p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {data === null ? (
          <Skeleton className="h-24 w-full" />
        ) : data.nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No nodes registered yet.
          </p>
        ) : (
          data.nodes.map((node) => (
            <NodeRow
              key={node.nodeId}
              node={node}
              onChanged={reload}
              onRestoreRequest={(n, run) => setRestoreTarget({ node: n, run })}
              onDeleteRequest={(n, run) => setDeleteTarget({ node: n, run })}
            />
          ))
        )}
      </CardContent>

      <Dialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore every database on this node?</DialogTitle>
            <DialogDescription>
              This overwrites the live contents of{" "}
              {restoreTarget?.run.databases.length ?? 0} database
              {(restoreTarget?.run.databases.length ?? 0) === 1 ? "" : "s"} on{" "}
              <span className="font-medium">{restoreTarget?.node.nodeName}</span> with
              the dump taken{" "}
              {restoreTarget && new Date(restoreTarget.run.createdAt).toLocaleString()}.
              That affects every tenant with a database on this node, and anything
              written since then is lost. Servers are not stopped — restart the
              affected ones afterwards so they stop serving stale rows.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRestoreTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={acting}
              onClick={confirmRestore}
            >
              {acting && <Spinner />}
              Restore databases
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this database backup?</DialogTitle>
            <DialogDescription>
              The snapshot is removed from S3 and its space reclaimed. This is the only
              copy of that point in time for{" "}
              <span className="font-medium">{deleteTarget?.node.nodeName}</span> — it
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={acting}
              onClick={confirmDelete}
            >
              {acting && <Spinner />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
