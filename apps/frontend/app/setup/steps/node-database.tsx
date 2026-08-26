"use client";

import * as React from "react";
import { Check, Database } from "lucide-react";

import {
  ApiError,
  adminGetNodeDatabase,
  adminSetUpNodeDatabase,
} from "@/lib/api";
import type { NodeDatabaseView } from "@/lib/types";
import {
  nodeDatabasePhaseLabel,
  useNodeDatabaseProgress,
} from "@/lib/node-database-progress";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import { ErrorNote, SuccessNote, WarningNote } from "./wizard-ui";

/**
 * Giving the first node a database, immediately after it is registered.
 *
 * Unlike the port pool next to it, this is genuinely optional: a node without a
 * database hosts servers fine, it just cannot hand them a MySQL database. So it
 * is offered rather than pressed, and nothing here blocks the wizard.
 *
 * It belongs in the wizard anyway, because this is the moment the operator is
 * thinking about what the node can do. Finding out months later that the feature
 * existed, from a plugin that needs MySQL and a server that cannot have one, is
 * the outcome worth avoiding. One button beats a footnote pointing at the admin
 * area.
 *
 * The panel creates the container through the node's agent and keeps the
 * generated credential encrypted, so there is nothing for the operator to copy.
 * See `docs/node-database.md`.
 */
export function NodeDatabaseSetup({
  nodeId,
  agentReachable,
}: {
  nodeId: string;
  agentReachable: boolean;
}) {
  const [view, setView] = React.useState<NodeDatabaseView | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);

  // Same slow call as everywhere else, same progress treatment: the phase is
  // polled off the node, the seconds prove the page is alive.
  const {
    running: creating,
    phase,
    elapsed,
    run: withProgress,
  } = useNodeDatabaseProgress(async () => (await adminGetNodeDatabase(nodeId)).status);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      setView(await adminGetNodeDatabase(nodeId));
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? err.message
          : "The node's database state could not be read.",
      );
    }
  }, [nodeId]);

  React.useEffect(() => {
    if (!agentReachable) return;
    // Wrapped rather than called bare, matching `node-ports.tsx`: the read is an
    // external fetch, so its state updates belong after the await, not in the
    // effect body.
    (async () => {
      await load();
    })();
  }, [agentReachable, load]);

  const create = async () => {
    setCreateError(null);
    try {
      setView(await withProgress(() => adminSetUpNodeDatabase(nodeId)));
    } catch (err) {
      setCreateError(
        err instanceof ApiError
          ? err.message
          : "The database could not be created on the node.",
      );
    }
  };

  if (!agentReachable) {
    return (
      <WarningNote>
        A database is created by asking the agent to run a container, so this has
        to wait until it responds. It can be set up later from{" "}
        <strong>Admin &rarr; Nodes</strong> with one button; nothing else depends
        on it.
      </WarningNote>
    );
  }

  if (!view && !loadError) return <Skeleton className="h-20 w-full" />;

  // Already there: either this button made it, or the register form was given an
  // existing database's credentials a moment ago.
  if (view?.status?.exists) {
    return (
      <SuccessNote>
        <span className="flex items-center gap-1.5">
          <Check className="size-3.5 shrink-0" />
          Ready. Servers on this node can each be given their own database.
        </span>
      </SuccessNote>
    );
  }

  // Credentials for a database this agent does not run were entered on the form
  // a moment ago. Creating one here would repoint the node at a new empty
  // database, so the wizard says so and offers nothing; the admin page has the
  // confirmation flow for the rarer "that database is gone" case.
  if (view?.configured) {
    return (
      <SuccessNote>
        Using the database at {view.configured.host}:{view.configured.port}, from
        the credentials you entered. Servers on this node can each be given their
        own database inside it.
      </SuccessNote>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Optional. Some plugins and mods need a MySQL database. Setting one up
        runs a MariaDB container on the node, reachable only by servers on it,
        never from the internet. Each server then gets its own database and user
        inside it, on request.
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={create}
          disabled={creating}
        >
          {creating ? <Spinner /> : <Database />}
          {creating ? "Setting up…" : "Set up a database"}
        </Button>
      </div>
      {/* Said before the click, and kept live during it: a minute of no visible
        progress is how operators conclude a button is broken and reload. */}
      {creating ? (
        <div className="flex flex-col gap-1" role="status" aria-live="polite">
          <span className="text-xs text-foreground">
            {nodeDatabasePhaseLabel(phase)}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {elapsed}s elapsed. Leave this page open.
          </span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Takes about a minute the first time, while the node downloads MariaDB.
          You can also do this later from Admin → Nodes.
        </p>
      )}

      {loadError && (
        <ErrorNote title="Could not read the database state" onRetry={load}>
          {loadError}
        </ErrorNote>
      )}
      {createError && (
        <ErrorNote
          title="Could not set up the database"
          onRetry={create}
          retrying={creating}
        >
          {createError}
        </ErrorNote>
      )}
    </div>
  );
}
