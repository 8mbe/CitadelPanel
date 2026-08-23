"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";

import { AddNodeDialog, NodeCard } from "@/components/admin/node-cards";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { adminHeartbeatAllNodes, adminListNodes, ApiError } from "@/lib/api";
import { nodeReachability } from "@/lib/format";
import type { NodeAllocation, NodeView } from "@/lib/types";

interface NodeEntry {
  node: NodeView;
  allocation: NodeAllocation | null;
}

export default function AdminNodesPage() {
  const [nodes, setNodes] = React.useState<NodeEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped by the add-node dialog to trigger a reload without calling setState
  // synchronously from an effect.
  const [refreshKey, setRefreshKey] = React.useState(0);
  // True while the on-visit heartbeat sweep is in flight. Drives the subtle
  // "checking" indicator and is cleared when the sweep settles.
  const [sweeping, setSweeping] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await adminListNodes();
        if (cancelled) return;
        setNodes(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load nodes.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Auto-heartbeat: once the list is loaded, probe every active node and record
  // a heartbeat for each that answers, then reload so the reachability badges
  // reflect reality without a manual "Test connection" per card. Drained nodes
  // are not probed here (they are out of rotation). Open one to re-check it.
  React.useEffect(() => {
    if (loading || nodes.length === 0) return;
    let cancelled = false;
    (async () => {
      // setState inside the async callback, not the effect body, to avoid the
      // cascading-render the project's set-state-in-effect rule guards against.
      setSweeping(true);
      try {
        await adminHeartbeatAllNodes();
      } catch {
        // Best-effort: a failed sweep just leaves the existing badges in place.
      } finally {
        if (cancelled) return;
        setSweeping(false);
        // Reload so lastHeartbeatAt (and thus the badges) reflect the sweep.
        setRefreshKey((k) => k + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once per initial load of the node set, not on every refreshKey bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, nodes.length === 0]);

  const online = nodes.filter((n) => nodeReachability(n.node.lastHeartbeatAt) === "online").length;

  return (
    <>
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Nodes
          </h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading nodes…"
              : sweeping
                ? "Checking node health…"
                : `Docker hosts that run your game servers. ${online} of ${nodes.length} online.`}
          </p>
        </div>
        <AddNodeDialog onAdded={() => setRefreshKey((k) => k + 1)} />
      </div>

      {error ? (
        <Empty className="min-h-[16rem]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlert />
            </EmptyMedia>
            <EmptyTitle>Couldn&apos;t load nodes</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : nodes.length === 0 ? (
        <Empty className="min-h-[16rem]">
          <EmptyHeader>
            <EmptyTitle>No nodes yet</EmptyTitle>
            <EmptyDescription>
              Register a machine running the CitadelPanel agent to start hosting
              servers.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {nodes.map(({ node, allocation }) => (
            <NodeCard
              key={node.id}
              node={node}
              allocation={allocation}
              onTested={() => setRefreshKey((k) => k + 1)}
            />
          ))}
        </div>
      )}
    </>
  );
}
