"use client";

import * as React from "react";
import { Check, Database, Play, Square, TriangleAlert } from "lucide-react";

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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  adminGetNodeDatabase,
  adminSetUpNodeDatabase,
  adminStartNodeDatabase,
  adminStopNodeDatabase,
  ApiError,
} from "@/lib/api";
import type { NodeDatabaseView } from "@/lib/types";

/**
 * The node's shared database, on the node's admin page.
 *
 * The node agent owns the Docker socket, so creating the MariaDB container is
 * one API call. This card is that call, plus start and stop. Before it, the only
 * way to give a node a database was to SSH in, run `bun run setup-db`, and paste
 * the password it printed into the register-node form; the credentials now never
 * leave the panel.
 *
 * Loads itself rather than arriving with the page: the status is an agent round
 * trip (plus a ping inside the container), which the rest of the node page
 * should not wait on. See `routes/nodeDatabase.ts`.
 *
 * `onChanged` refreshes the page around it, because setting up a database flips
 * the node's "Per-node DB" flag in the header.
 */
export function NodeDatabaseCard({
  nodeId,
  onChanged,
}: {
  nodeId: string;
  onChanged?: () => void | Promise<void>;
}) {
  const [view, setView] = React.useState<NodeDatabaseView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [action, setAction] = React.useState<"setup" | "start" | "stop" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stopOpen, setStopOpen] = React.useState(false);
  const [replaceOpen, setReplaceOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await adminGetNodeDatabase(nodeId));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to read the database status.",
      );
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  React.useEffect(() => {
    // Wrapped rather than called bare, matching the setup wizard's blocks: the
    // read is an external fetch, so its state updates belong after the await.
    (async () => {
      await load();
    })();
  }, [load]);

  /**
   * Run one lifecycle action. Every route answers with the same view shape, so
   * the card replaces its state from the response instead of re-fetching, which
   * keeps the status honest even when the action itself took two minutes.
   */
  const run = async (
    kind: "setup" | "start" | "stop",
    call: () => Promise<NodeDatabaseView>,
  ) => {
    setAction(kind);
    setError(null);
    try {
      setView(await call());
      await onChanged?.();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to ${kind === "setup" ? "set up" : kind} the database.`,
      );
    } finally {
      setAction(null);
    }
  };

  const status = view?.status ?? null;
  const running = status?.state === "running";
  const busy = action !== null;

  // The node points at a database this agent does not run: the register-node
  // form was given an existing MariaDB's credentials (or our container was
  // removed). Creating one here would silently repoint the node at a new empty
  // database, so it takes a confirmation that names the address being replaced.
  const configuredElsewhere = Boolean(view?.configured && !status?.exists);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" />
          Shared database
          <StatusBadge view={view} loading={loading} />
        </CardTitle>
        <CardDescription>
          One MariaDB container per node, on an internal Docker network with no
          published host ports. Servers on this node can each provision their own
          database and user inside it. The panel sets it up through the node&apos;s
          agent, so there is nothing to run over SSH.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {loading && !view ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : view && !view.reachable ? (
          <p className="text-sm text-muted-foreground">
            This node&apos;s agent did not answer, so its database state is
            unknown. {view.error}
          </p>
        ) : status ? (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
              <Detail label="Container" value={status.containerName} mono />
              <Detail label="Image" value={status.image} mono />
              {/* Docker assigns the container's IP at start, so a stopped
                database has no address rather than a stale one. */}
              <Detail
                label="Address"
                value={
                  status.host
                    ? `${status.host}:${status.port}`
                    : running
                      ? "not on the network"
                      : "assigned at start"
                }
                mono
              />
              <Detail
                label="Server databases"
                value={String(view?.databaseCount ?? 0)}
              />
            </dl>

            {/* The credential is the reason a container can exist and still be
              useless to the panel: without it, no database can be provisioned
              inside it. Worth saying out loud rather than leaving the admin to
              infer it from a failed provision later. */}
            {status.exists && !view?.hasCredentials && (
              <Callout tone="warning">
                The panel has no admin credential for this database, so servers
                here cannot provision one. It was created outside this panel.
                Either register the node with its credentials, or remove the
                container (<Code>docker rm -f {status.containerName}</Code>) and set
                it up again. The data volume <Code>{status.volumeName}</Code> is
                kept either way.
              </Callout>
            )}

            {running && !status.ready && (
              <Callout tone="warning">
                The container is running but is not accepting connections yet.
                MariaDB&apos;s first boot initialises its system tables, which
                takes about 20 seconds.
              </Callout>
            )}
          </>
        ) : configuredElsewhere ? (
          <Callout tone="warning">
            This node is configured to use a database at{" "}
            <Code>
              {view?.configured?.host}:{view?.configured?.port}
            </Code>
            , which this agent does not run. That is expected if it was entered
            when the node was registered. Creating one here would point the node
            at a new, empty database instead.
          </Callout>
        ) : (
          <p className="text-sm text-muted-foreground">
            No database on this node yet. Setting one up pulls MariaDB, creates
            the internal network and a data volume, and starts the container.
            Takes about a minute on a cold node.
          </p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          {!status?.exists ? (
            <Button
              type="button"
              size="sm"
              variant={configuredElsewhere ? "outline" : "default"}
              disabled={busy || loading || view?.reachable === false}
              onClick={() =>
                configuredElsewhere
                  ? setReplaceOpen(true)
                  : run("setup", () => adminSetUpNodeDatabase(nodeId))
              }
            >
              {action === "setup" ? <Spinner /> : <Database />}
              {action === "setup"
                ? "Setting up…"
                : configuredElsewhere
                  ? "Create one here instead"
                  : "Set up database"}
            </Button>
          ) : running ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setStopOpen(true)}
            >
              {action === "stop" ? <Spinner /> : <Square />}
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => run("start", () => adminStartNodeDatabase(nodeId))}
            >
              {action === "start" ? <Spinner /> : <Play />}
              {action === "start" ? "Starting…" : "Start"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </div>
      </CardContent>

      {/* Replacing a configured address is destructive in a way that is easy to
        miss, so the dialog states what stops working rather than just asking. */}
      <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Point this node at a new database?</DialogTitle>
            <DialogDescription>
              The node currently uses {view?.configured?.host}:
              {view?.configured?.port}. Creating a database here replaces that
              address, so any server still using the old one loses access to its
              data. Do this only if that database is gone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReplaceOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={action === "setup"}
              onClick={async () => {
                await run("setup", () =>
                  adminSetUpNodeDatabase(nodeId, { replaceEndpoint: true }),
                );
                setReplaceOpen(false);
              }}
            >
              {action === "setup" && <Spinner />}
              Create and replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stop confirms, start does not: stopping breaks every live game server
        that is talking to this database, and the count is the thing worth
        seeing before the click. */}
      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop this node&apos;s database?</DialogTitle>
            <DialogDescription>
              {view?.databaseCount
                ? `${view.databaseCount} server database${view.databaseCount === 1 ? "" : "s"} on this node will be unreachable until it is started again. Servers already running will keep running, but their database queries will fail.`
                : "No server databases exist here yet, so nothing is using it. It can be started again at any time."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setStopOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={action === "stop"}
              onClick={async () => {
                await run("stop", () => adminStopNodeDatabase(nodeId));
                setStopOpen(false);
              }}
            >
              {action === "stop" && <Spinner />}
              Stop database
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * The one-word answer to "is this node's database working".
 *
 * "Starting" exists because Docker calls the container running well before
 * MariaDB accepts connections, and an admin who sees a green badge then watches
 * a provision fail learns to distrust the badge.
 */
function StatusBadge({
  view,
  loading,
}: {
  view: NodeDatabaseView | null;
  loading: boolean;
}) {
  if (loading && !view) return <Skeleton className="h-5 w-20" />;
  if (!view) return null;

  if (!view.reachable) {
    return (
      <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
        Unknown
      </Badge>
    );
  }
  if (!view.status?.exists) return <Badge variant="outline">Not set up</Badge>;
  if (view.status.state !== "running") {
    return (
      <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
        Stopped
      </Badge>
    );
  }
  if (!view.status.ready) {
    return (
      <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
        Starting
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    >
      Running
    </Badge>
  );
}

/** One label/value pair in the card's detail grid. */
function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate font-mono" : "tabular-nums"}>{value}</dd>
    </div>
  );
}

/** An inline note, in the same two tones the node page's callouts use. */
function Callout({
  tone,
  children,
}: {
  tone: "warning" | "ok";
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={
        tone === "ok"
          ? "flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs"
          : "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
      }
    >
      {tone === "ok" ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
      ) : (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      )}
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}

/** Inline command/identifier, matching the register dialog's code style. */
function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-foreground">{children}</code>;
}
