"use client";

import * as React from "react";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  Clock,
  Database,
  Play,
  RotateCcw,
  Trash2,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldDescription } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { formatBytes, formatRelative } from "@/lib/format";
import { viewerAllows } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useServerData } from "@/components/server/server-data-context";
import {
  ApiError,
  createServerBackup,
  deleteServerBackup,
  getServerBackupLogs,
  getServerBackups,
  restoreServerBackup,
  setServerBackupsEnabled,
  startServerAfterRestore,
  type ServerBackup,
  type ServerBackupLogLine,
  type ServerBackupsView,
} from "@/lib/api";

/** How often to poll while a run is in flight. */
const POLL_MS = 2000;

/** Human wording for each agent phase. */
const PHASE_LABELS: Record<string, string> = {
  starting: "Starting",
  dumping_databases: "Dumping databases",
  preparing_repository: "Preparing the S3 repository",
  uploading: "Uploading to S3",
  restoring_files: "Restoring files",
  importing_databases: "Restoring databases",
  applying_retention: "Applying retention",
  finished: "Finishing",
};

function phaseLabel(phase: string | null): string {
  if (!phase) return "Queued";
  return PHASE_LABELS[phase] ?? phase;
}

/** The run currently in flight, if any. Only one can be. */
function activeRun(backups: ServerBackup[]): ServerBackup | null {
  return (
    backups.find((backup) => backup.status === "pending" || backup.status === "running") ?? null
  );
}

/**
 * Live status for the in-flight run: phase, progress bar, and a log tail.
 *
 * Polling rather than streaming: the panel itself only learns about progress by
 * polling the node every tick, so an SSE feed here would add a second streaming
 * path without making the data any fresher than its slowest hop.
 *
 * The log is fetched with a cursor (`afterSeq`), so each poll transfers only new
 * lines rather than re-downloading a log that grows for the length of a backup.
 */
function ActiveRunCard({
  serverId,
  run,
  onFinished,
}: {
  serverId: string;
  run: ServerBackup;
  onFinished: () => void;
}) {
  // Seeded from the run the parent handed us and then owned locally, because this
  // component polls for its own updates. The caller keys this component on the
  // run id, so a new run remounts it with fresh state rather than needing the
  // previous run's log cleared out inside an effect.
  const [lines, setLines] = React.useState<ServerBackupLogLine[]>([]);
  const [status, setStatus] = React.useState(run.status);
  const [phase, setPhase] = React.useState(run.phase);
  const [percent, setPercent] = React.useState(run.percent);
  const [error, setError] = React.useState<string | null>(run.error);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // A ref, not state: the poll loop reads the cursor on every tick and must not
  // re-subscribe (or drop lines) each time it advances.
  const cursor = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const data = await getServerBackupLogs(serverId, run.id, cursor.current);
        if (cancelled) return;

        if (data.logs.length > 0) {
          cursor.current = data.logs[data.logs.length - 1]!.seq;
          // Capped so a very long backup cannot grow the DOM without bound; the
          // full log stays in the database.
          setLines((previous) => [...previous, ...data.logs].slice(-400));
        }
        setStatus(data.status);
        setPhase(data.phase);
        setPercent(data.percent);
        setError(data.error);

        if (data.status === "succeeded" || data.status === "failed") {
          onFinished();
          return;
        }
      } catch {
        // A dropped poll is not worth surfacing. The next one will either
        // succeed or the run will resolve. The reconciler is the source of truth.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, run.id, onFinished]);

  // Keep the newest line in view, the way a console does.
  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const isRestore = run.kind === "restore";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Spinner />
          {isRestore ? "Restore in progress" : "Backup in progress"}
        </CardTitle>
        <CardDescription>
          {phaseLabel(phase)}
          {run.trigger === "scheduled" && " · started by the schedule"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Progress value={percent} />
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>{percent}%</span>
            <span>started {formatRelative(run.createdAt)}</span>
          </div>
        </div>

        {status === "failed" && error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <div className="flex flex-col gap-1.5">
          <FieldDescription>
            Log from the node. Kept with this backup, so it is still here after the
            run finishes.
          </FieldDescription>
          <ScrollArea
            ref={scrollRef}
            className="h-56 rounded-lg border bg-muted/30 p-3 font-mono text-xs"
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
      </CardContent>
    </Card>
  );
}

/** Status pill for a finished run. */
function StatusBadge({ backup }: { backup: ServerBackup }) {
  if (backup.status === "succeeded") {
    return (
      <Badge variant="outline" className="gap-1">
        <CircleCheck className="size-3" />
        {backup.kind === "restore" ? "Restored" : "Complete"}
      </Badge>
    );
  }
  if (backup.status === "failed") {
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

/**
 * One row in the history.
 *
 * Both byte counts are shown when available. The second ("N uploaded") is the one
 * that matters for cost: restic deduplicates and compresses, so a nightly backup
 * of a 30 GB world routinely uploads a few hundred megabytes.
 */
function BackupRow({
  backup,
  canManage,
  busy,
  onRestore,
  onDelete,
}: {
  backup: ServerBackup;
  canManage: boolean;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const restorable = backup.kind === "backup" && backup.status === "succeeded";

  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {new Date(backup.createdAt).toLocaleString()}
          </span>
          <StatusBadge backup={backup} />
          {backup.kind === "restore" && <Badge variant="secondary">Restore</Badge>}
          {backup.trigger === "scheduled" && <Badge variant="outline">Scheduled</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {backup.snapshotId && (
            <span className="font-mono">{backup.snapshotId.slice(0, 8)}</span>
          )}
          {backup.bytesProcessed !== null && (
            <span className="tabular-nums">{formatBytes(backup.bytesProcessed)} read</span>
          )}
          {backup.bytesAdded !== null && (
            <span className="tabular-nums">{formatBytes(backup.bytesAdded)} uploaded</span>
          )}
          {backup.databases.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Database className="size-3" />
              {backup.databases.length} database
              {backup.databases.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {backup.status === "failed" && backup.error && (
          <p className="text-xs text-destructive">{backup.error}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {restorable && canManage && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRestore}>
            <RotateCcw />
            Restore
          </Button>
        )}
        {canManage && (
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
        )}
      </div>
    </div>
  );
}

/**
 * The Backups tab.
 *
 * A backup is a restic snapshot in the operator's S3 bucket holding the server's
 * data directory *and* a SQL dump of every database it has provisioned, taken as
 * one unit, so a restore never puts a world back next to a database from a
 * different moment.
 *
 * Runs are asynchronous: the button returns immediately and the node does the
 * work, so this polls for progress and tails the log. Restore and delete are
 * owner-only (the API enforces it); a subuser with the `backups` flag sees the
 * history and can take a backup, but not overwrite a world or destroy a snapshot.
 */
export function BackupsTab({ serverId }: { serverId: string }) {
  const { server, refresh } = useServerData();
  const [data, setData] = React.useState<ServerBackupsView | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const [creating, setCreating] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = React.useState<ServerBackup | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<ServerBackup | null>(null);
  const [togglingSchedule, setTogglingSchedule] = React.useState(false);
  const [startingServer, setStartingServer] = React.useState(false);

  // Restore and delete destroy data, so they stay with the owner even though the
  // `backups` flag is enough to reach this tab. The API is the enforcement point.
  const isOwner = server.viewer?.kind === "owner" || server.viewer?.kind === "admin";
  const canBackup = viewerAllows(server.viewer, "backups");
  const canManageSchedule = viewerAllows(server.viewer, "settings");

  const reload = React.useCallback(() => setRefreshKey((key) => key + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const view = await getServerBackups(serverId);
        if (!cancelled) setData(view);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          if (!cancelled) setDenied(true);
        } else if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load backups.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, refreshKey]);

  const running = data ? activeRun(data.backups) : null;

  const takeBackup = async () => {
    setCreating(true);
    setError(null);
    setNote(null);
    try {
      await createServerBackup(serverId);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to start the backup.");
    } finally {
      setCreating(false);
    }
  };

  const confirmRestore = async () => {
    if (!restoreTarget) return;
    setBusyId(restoreTarget.id);
    setError(null);
    setNote(null);
    try {
      await restoreServerBackup(serverId, restoreTarget.id);
      setRestoreTarget(null);
      reload();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to start the restore.");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    setError(null);
    setNote(null);
    try {
      await deleteServerBackup(serverId, deleteTarget.id);
      setDeleteTarget(null);
      reload();
      setNote("Backup deleted and its data reclaimed from S3.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete the backup.");
    } finally {
      setBusyId(null);
    }
  };

  const toggleSchedule = async (enabled: boolean) => {
    setTogglingSchedule(true);
    setError(null);
    try {
      await setServerBackupsEnabled(serverId, enabled);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update the schedule.");
    } finally {
      setTogglingSchedule(false);
    }
  };

  const bringServerUp = async () => {
    setStartingServer(true);
    setError(null);
    try {
      await startServerAfterRestore(serverId);
      setNote("Server starting.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to start the server.");
    } finally {
      setStartingServer(false);
    }
  };

  if (denied) {
    return (
      <Empty className="min-h-[12rem]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Archive />
          </EmptyMedia>
          <EmptyTitle>No access</EmptyTitle>
          <EmptyDescription>
            You need the backups permission on this server to view its backups.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Spinner />
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  // Nothing works without a destination, and that is an admin's job, so say so
  // rather than showing a button that would only ever return an error.
  if (!data.schedule.configured) {
    return (
      <Empty className="min-h-[14rem]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Archive />
          </EmptyMedia>
          <EmptyTitle>Backups are not configured</EmptyTitle>
          <EmptyDescription>
            An administrator needs to set an S3 destination for this panel before
            servers can be backed up. Once they have, this tab will back up this
            server&apos;s files and its databases together.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const lastRestore = data.backups.find((backup) => backup.kind === "restore");
  const showStartPrompt =
    lastRestore?.status === "succeeded" && server.status !== "running" && isOwner;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Backups</CardTitle>
          <CardDescription>
            Each backup is an encrypted, deduplicated snapshot in the panel&apos;s S3
            bucket. It holds this server&apos;s files and a dump of every database it
            owns, taken together, so restoring never leaves a world next to a
            database from a different moment.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              {data.schedule.cron ? (
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-4" />
                  Automatic backups run on{" "}
                  <span className="font-mono text-foreground">{data.schedule.cron}</span>
                  {data.schedule.nextRun && (
                    <>
                      {" "}
                      · next{" "}
                      <span className="text-foreground">
                        {new Date(data.schedule.nextRun).toLocaleString()}
                      </span>
                    </>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-4" />
                  No automatic schedule. Backups run when you take them.
                </span>
              )}
              <span className="text-xs">
                {data.quota.max > 0
                  ? `Keeping ${data.quota.used} of ${data.quota.max}. A new backup replaces the oldest.`
                  : `${data.quota.used} kept, no limit set.`}{" "}
                Times shown in {data.schedule.timezone}.
              </span>
            </div>

            <Button
              type="button"
              disabled={!canBackup || creating || running !== null}
              onClick={takeBackup}
            >
              {creating && <Spinner />}
              <Archive />
              Back up now
            </Button>
          </div>

          {data.schedule.cron && canManageSchedule && (
            <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Include in the schedule</span>
                <span className="text-xs text-muted-foreground">
                  When off, this server is skipped by automatic backups. You can
                  still back it up by hand.
                </span>
              </div>
              <Switch
                checked={data.schedule.enabledForServer}
                disabled={togglingSchedule}
                onCheckedChange={(checked) => void toggleSchedule(checked === true)}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </CardContent>
      </Card>

      {running && (
        // Keyed on the run id so a new run gets a fresh component (and a fresh
        // log) rather than inheriting the previous one's state.
        <ActiveRunCard
          key={running.id}
          serverId={serverId}
          run={running}
          onFinished={reload}
        />
      )}

      {showStartPrompt && (
        <Card>
          <CardHeader>
            <CardTitle>Restore finished</CardTitle>
            <CardDescription>
              The server was stopped for the restore and left stopped on purpose,
              so you can look it over before players reconnect.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" disabled={startingServer} onClick={bringServerUp}>
              {startingServer ? <Spinner /> : <Play />}
              Start the server
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Failed runs are kept alongside successful ones. A backup that did not
            happen is the thing most worth knowing about.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No backups yet. The first one uploads everything; later ones only
              upload what changed.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {data.backups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  canManage={isOwner}
                  busy={busyId === backup.id || running !== null}
                  onRestore={() => setRestoreTarget(backup)}
                  onDelete={() => setDeleteTarget(backup)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={restoreTarget !== null} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              This stops the server and overwrites its files with the snapshot from{" "}
              {restoreTarget && new Date(restoreTarget.createdAt).toLocaleString()}.
              {restoreTarget && restoreTarget.databases.length > 0 && (
                <>
                  {" "}
                  It also replaces the contents of{" "}
                  <span className="font-mono">{restoreTarget.databases.join(", ")}</span>{" "}
                  with the dump inside the snapshot.
                </>
              )}{" "}
              Anything written since then is lost. The server is left stopped so you
              can check it before starting it again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRestoreTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busyId !== null}
              onClick={confirmRestore}
            >
              {busyId !== null && <Spinner />}
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this backup?</DialogTitle>
            <DialogDescription>
              The snapshot is removed from S3 and its data reclaimed. This is the
              only copy of that point in time, and it cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busyId !== null}
              onClick={confirmDelete}
            >
              {busyId !== null && <Spinner />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
