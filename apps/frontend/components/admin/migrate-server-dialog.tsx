"use client";

import * as React from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  TriangleAlert,
  Truck,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  adminCancelServerMigration,
  adminGetServerMigrationLogs,
  adminListNodes,
  adminListServerMigrations,
  adminPreflightServerMigration,
  adminStartServerMigration,
  ApiError,
  type MigratedPort,
  type MigrationLogLine,
  type MigrationPhase,
  type MigrationPreflight,
  type MigrationRollback,
  type MigrationStatus,
  type ServerMigration,
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How often the live migration is re-read while it runs. */
const POLL_MS = 2000;

const PHASE_LABELS: Record<MigrationPhase, string> = {
  queued: "Queued",
  preflight: "Checking both nodes",
  backup: "Taking a safety backup",
  stopping: "Stopping the server",
  transferring: "Copying files to the new node",
  allocating_ports: "Assigning ports on the new node",
  building: "Building the container",
  verifying: "Checking the new node",
  cutover: "Switching over",
  cleanup: "Removing the old copy",
  rollback: "Undoing the move",
  finished: "Finished",
};

/**
 * Move a server to another node, from the admin servers table.
 *
 * Two screens in one dialog, and the split is the point. The first is a
 * **verdict**: pick a destination and see every reason the move would be
 * refused, all of them at once, while the server is still running and nothing
 * has been touched. The second is a **live account** of the move itself, which
 * an admin will watch for a while and then walk away from.
 *
 * Neither is decoration. A migration stops somebody's game server for as long
 * as it takes to copy a world across a network, so "what is it doing right
 * now" and "did it work" are the two questions the whole feature has to answer
 * out loud. The panel's promise if it did not work — that the server is still
 * on the node it started on — is only worth anything if the dialog says so
 * plainly, which is what the failure state below does.
 *
 * Mounted only while a server is being migrated, so its state initialises fresh
 * per target server.
 */
export function MigrateServerDialog({
  serverId,
  serverName,
  currentNodeId,
  currentNodeName,
  open,
  onOpenChange,
  onChanged,
}: {
  serverId: string;
  serverName: string;
  currentNodeId: string;
  currentNodeName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the migration finishes, so the parent list can re-read. */
  onChanged: () => void;
}) {
  const [nodes, setNodes] = React.useState<{ id: string; name: string }[]>([]);
  const [destinationId, setDestinationId] = React.useState<string>("");
  const [preflight, setPreflight] = React.useState<MigrationPreflight | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [migration, setMigration] = React.useState<ServerMigration | null>(null);

  // A migration started in another tab, or before this dialog was opened, is
  // picked up rather than ignored: the row is the durable record, so opening
  // the dialog on a server that is already moving should show that move.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void (async () => {
      try {
        const [nodeList, existing] = await Promise.all([
          adminListNodes(),
          adminListServerMigrations(serverId),
        ]);
        if (cancelled) return;
        setNodes(
          nodeList
            .map(({ node }) => ({ id: node.id, name: node.name }))
            .filter((node) => node.id !== currentNodeId),
        );
        if (existing.active) setMigration(existing.active);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load nodes.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, serverId, currentNodeId]);

  // The preflight talks to two agents, measures a directory and probes ports,
  // so it runs when a destination is chosen rather than on every render.
  React.useEffect(() => {
    if (!destinationId || migration) return;
    let cancelled = false;

    void (async () => {
      try {
        const result = await adminPreflightServerMigration(serverId, destinationId);
        if (!cancelled) setPreflight(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "The checks could not be run.");
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serverId, destinationId, migration]);

  const start = async () => {
    if (!preflight) return;
    setStarting(true);
    setError(null);
    try {
      setMigration(
        await adminStartServerMigration(serverId, {
          destinationNodeId: preflight.destinationNodeId,
          acknowledgeNoBackup: acknowledged,
        }),
      );
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The migration could not be started.");
    } finally {
      setStarting(false);
    }
  };

  const blockedOnBackup =
    preflight?.requiresNoBackupAcknowledgement === true && !acknowledged;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="size-4" />
            Move &ldquo;{serverName}&rdquo; to another node
          </DialogTitle>
          <DialogDescription>
            {migration
              ? "The server stays on its original node until the move has been " +
                "checked, so a failure here is not an outage."
              : `Currently on ${currentNodeName ?? "an unknown node"}. The server ` +
                "will be stopped for the move and started again afterwards."}
          </DialogDescription>
        </DialogHeader>

        {migration ? (
          <MigrationProgress
            serverId={serverId}
            migration={migration}
            onFinished={onChanged}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Destination node</FieldLabel>
              <Select
                value={destinationId}
                onValueChange={(value) => {
                  if (!value) return;
                  // Cleared here rather than in the effect that fetches: a
                  // synchronous setState in an effect body is a cascading
                  // render, and choosing a destination is the actual event that
                  // invalidates the previous verdict.
                  setDestinationId(String(value));
                  setPreflight(null);
                  setError(null);
                  setAcknowledged(false);
                  setChecking(true);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a node" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Only nodes other than the one this server is on. Every check
                below runs against the node you pick.
              </FieldDescription>
            </Field>

            {checking && (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner />
                Checking capacity, disk, ports and reachability…
              </div>
            )}

            {preflight && <PreflightReport preflight={preflight} />}

            {preflight?.requiresNoBackupAcknowledgement && preflight.canMigrate && (
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(value) => setAcknowledged(value === true)}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">
                  Move it anyway, with no backup taken first. The original
                  node&rsquo;s copy is still kept until the move is verified.
                </span>
              </label>
            )}

            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {migration ? (
            <MigrationFooter
              serverId={serverId}
              migration={migration}
              onClose={() => onOpenChange(false)}
            />
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={start}
                disabled={
                  starting || checking || !preflight?.canMigrate || blockedOnBackup
                }
              >
                {starting && <Spinner />}
                Move server
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The verdict: every check, with the failures readable rather than counted.
 *
 * All of them are shown, not just the failures, because an admin about to stop
 * somebody's server wants to see that the destination really was checked for
 * disk and capacity, not only that nothing objected.
 */
function PreflightReport({ preflight }: { preflight: MigrationPreflight }) {
  const failures = preflight.checks.filter((check) => check.status === "fail");
  const remapped = preflight.plannedPorts.filter((entry) => entry.to === 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        {preflight.checks.map((check) => (
          <div key={check.id} className="flex items-start gap-2.5 text-sm">
            {check.status === "ok" ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : check.status === "warn" ? (
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
            ) : (
              <CircleX className="text-destructive mt-0.5 size-4 shrink-0" />
            )}
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{check.label}</span>
              <span className="text-muted-foreground">{check.detail}</span>
            </div>
          </div>
        ))}
      </div>

      {failures.length > 0 ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>This server cannot be moved to that node yet</AlertTitle>
          <AlertDescription>
            Fix the {failures.length === 1 ? "problem" : `${failures.length} problems`}{" "}
            above, or choose a different destination. Nothing has been changed.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <CircleCheck />
          <AlertTitle>Ready to move</AlertTitle>
          <AlertDescription>
            {preflight.dataSizeBytes !== null
              ? `${formatBytes(preflight.dataSizeBytes)} will be copied to ` +
                `${preflight.destinationNodeName}. `
              : ""}
            {remapped.length > 0
              ? `${remapped.length} port(s) are already taken there and will be ` +
                "reassigned, so this server's address will change."
              : "The server keeps its port numbers, so its address does not change."}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/**
 * The live account of a move in progress, and of how it ended.
 *
 * Polled rather than streamed, for the same reason the backup log is: the panel
 * itself learns about a phase by finishing it, so a push channel would add a
 * second streaming path without making anything fresher.
 *
 * The finished states are the part worth reading carefully. A failure says
 * three things in order — that it failed, where, and *that the server is still
 * on its original node* — because the third is the one an operator needs at
 * 2am and the one a generic "migration failed" toast never gives them.
 */
function MigrationProgress({
  serverId,
  migration,
  onFinished,
}: {
  serverId: string;
  migration: ServerMigration;
  onFinished: () => void;
}) {
  const [lines, setLines] = React.useState<MigrationLogLine[]>([]);
  const [status, setStatus] = React.useState<MigrationStatus>(migration.status);
  const [phase, setPhase] = React.useState<MigrationPhase>(migration.phase);
  const [percent, setPercent] = React.useState(migration.percent);
  const [bytesTotal, setBytesTotal] = React.useState(migration.bytesTotal);
  const [bytesDone, setBytesDone] = React.useState(migration.bytesTransferred);
  const [error, setError] = React.useState(migration.error);
  const [failedPhase, setFailedPhase] = React.useState(migration.failedPhase);
  const [rollback, setRollback] = React.useState<MigrationRollback | null>(
    migration.rollback,
  );
  const [ports, setPorts] = React.useState<MigratedPort[]>(migration.destinationPorts);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // A ref, not state: the poll reads it every tick and must not re-subscribe
  // (or drop lines) each time it advances.
  const cursor = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const data = await adminGetServerMigrationLogs(
          serverId,
          migration.id,
          cursor.current,
        );
        if (cancelled) return;

        if (data.logs.length > 0) {
          cursor.current = data.logs[data.logs.length - 1]!.seq;
          // Capped so a long move cannot grow the DOM without bound; the full
          // log stays in the database.
          setLines((previous) => [...previous, ...data.logs].slice(-400));
        }
        setStatus(data.status);
        setPhase(data.phase);
        setPercent(data.percent);
        setBytesTotal(data.bytesTotal);
        setBytesDone(data.bytesTransferred);
        setError(data.error);
        setFailedPhase(data.failedPhase);
        setRollback(data.rollback);
        setPorts(data.destinationPorts);

        if (
          data.status === "succeeded" ||
          data.status === "failed" ||
          data.status === "cancelled"
        ) {
          onFinished();
          return;
        }
      } catch {
        // A dropped poll is not worth surfacing: the row is the truth and the
        // next tick either reads it or the move resolves.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, migration.id, onFinished]);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const running = status === "pending" || status === "running" || status === "cancelling";
  const changedPorts = ports.filter(
    (entry, index) => entry.port !== migration.sourcePorts[index]?.port,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          {running && <Spinner />}
          {status === "cancelling" ? "Cancelling…" : PHASE_LABELS[phase]}
        </div>
        <Progress value={percent} />
        <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
          <span>{percent}%</span>
          {phase === "transferring" && bytesTotal !== null && (
            <span>
              {formatBytes(bytesDone)} of {formatBytes(bytesTotal)}
            </span>
          )}
        </div>
      </div>

      {status === "succeeded" && (
        <Alert>
          <CircleCheck />
          <AlertTitle>
            Moved to {migration.destinationNodeName ?? "the destination node"}
          </AlertTitle>
          <AlertDescription>
            {changedPorts.length === 0
              ? "The server keeps the same address."
              : `Port(s) changed: ${changedPorts
                  .map(
                    (entry, index) =>
                      `${migration.sourcePorts[index]?.port} → ${entry.port}`,
                  )
                  .join(", ")}. Tell the owner their address has changed.`}
            {error && ` ${error}`}
          </AlertDescription>
        </Alert>
      )}

      {(status === "failed" || status === "cancelled") && (
        <Alert variant={status === "failed" ? "destructive" : undefined}>
          <CircleAlert />
          <AlertTitle>
            {status === "failed"
              ? `Migration failed${failedPhase ? ` during ${PHASE_LABELS[failedPhase].toLowerCase()}` : ""}`
              : "Migration cancelled"}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-1.5">
            {error && <span>{error}</span>}
            <span>
              {rollback === "partial"
                ? `The server was NOT moved, but putting things back did not fully ` +
                  `succeed. Check ${migration.sourceNodeName ?? "the original node"} ` +
                  `and ${migration.destinationNodeName ?? "the destination"} before ` +
                  `retrying — the log below says what could not be undone.`
                : `The server was not moved. It is still on ` +
                  `${migration.sourceNodeName ?? "its original node"} with its files ` +
                  `intact, and has been put back the way it was.`}
            </span>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <FieldDescription>
          Kept with this migration, so it is still here after the move finishes.
        </FieldDescription>
        <ScrollArea
          ref={scrollRef}
          className="bg-muted/30 h-56 rounded-lg border p-3 font-mono text-xs"
        >
          {lines.length === 0 ? (
            <p className="text-muted-foreground">Starting…</p>
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
    </div>
  );
}

/**
 * Close, plus Cancel while cancelling is still an option.
 *
 * Closing the dialog does not stop anything: the migration runs on the server
 * and reports to its row, which is exactly what an admin who started an
 * hour-long move needs. The button says "Close", never "Cancel", so the two
 * cannot be confused at the moment it matters.
 */
function MigrationFooter({
  serverId,
  migration,
  onClose,
}: {
  serverId: string;
  migration: ServerMigration;
  onClose: () => void;
}) {
  const [cancelling, setCancelling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const cancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await adminCancelServerMigration(serverId, migration.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel.");
    } finally {
      setCancelling(false);
    }
  };

  // Past the cutover there is nothing to cancel *to*: the server is on the
  // destination, and the honest option is to migrate it back afterwards.
  const cancellable =
    (migration.status === "pending" || migration.status === "running") &&
    migration.phase !== "cutover" &&
    migration.phase !== "cleanup";

  return (
    <>
      {error && <p className="text-destructive mr-auto text-sm">{error}</p>}
      {cancellable && (
        <Button variant="outline" onClick={cancel} disabled={cancelling}>
          {cancelling && <Spinner />}
          Stop and put it back
        </Button>
      )}
      <Button onClick={onClose}>Close</Button>
    </>
  );
}
