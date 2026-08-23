"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Database,
  Globe,
  HardDrive,
  Lock,
  LockOpen,
  MemoryStick,
  Cpu,
  Pencil,
  PlugZap,
  Plus,
  Power,
  PowerOff,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  adminAddNodePortPoolEntry,
  adminDeleteNode,
  adminDeleteNodePortPoolEntry,
  adminGetNode,
  adminTestNodeConnection,
  adminUpdateNode,
  adminUpdateNodeDetails,
  ApiError,
  type NodeHealthResult,
} from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCores,
  formatMb,
  formatRelative,
  nodeReachability,
  scoreTone,
} from "@/lib/format";
import { formatPortsCompact, parsePortSpec, PortSpecError } from "@/lib/portSpec";
import type {
  NodeDetail,
  NodePortAllocation,
  NodePortPoolEntry,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Node detail page.
 *
 * One aggregated fetch (`adminGetNode`) for the whole page, plus a parallel
 * `adminTestNodeConnection` on mount for live reachability, which also records
 * a heartbeat, so simply opening the node keeps its online status fresh. The
 * read endpoint works without the agent being reachable: capacity, servers and
 * ports still render; only the live usage sample and the reachability badge
 * reflect agent availability.
 */
export default function NodeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [detail, setDetail] = React.useState<NodeDetail | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "missing">(
    "loading",
  );

  // Live reachability from the on-mount probe. Distinct from the read data so a
  // slow/dead agent does not block the page body.
  const [health, setHealth] = React.useState<NodeHealthResult | null>(null);

  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await adminGetNode(id);
        if (cancelled) return;
        setDetail(result);
        setState("ready");
      } catch {
        // 404 (missing/inaccessible) and transport failures both render the
        // missing state rather than crashing, matching the server detail shell.
        if (cancelled) return;
        setState("missing");
      }
    })();

    // Probe in parallel: live reachability + an implicit heartbeat.
    (async () => {
      try {
        const result = await adminTestNodeConnection(id);
        if (cancelled) return;
        setHealth(result);
        // A reachable probe stamped a heartbeat; reload the read so the
        // header's "last seen" and the reachability badge stay accurate.
        if (result.reachable) setRefreshKey((k) => k + 1);
      } catch {
        // A transport failure here just leaves the badge at its read-derived
        // state; the read endpoint itself already succeeded.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Reload the read data when a probe or management action invalidates it.
  React.useEffect(() => {
    if (refreshKey === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await adminGetNode(id);
        if (cancelled) return;
        setDetail(result);
      } catch {
        // Best-effort refresh; the existing detail stays on screen.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, refreshKey]);

  if (state === "loading") {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state === "missing" || !detail) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Empty className="max-w-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HardDrive />
            </EmptyMedia>
            <EmptyTitle>Node not found</EmptyTitle>
            <EmptyDescription>
              The node you&apos;re looking for doesn&apos;t exist or was removed.
            </EmptyDescription>
          </EmptyHeader>
          <Button render={<Link href="/admin/nodes" />} nativeButton={false}>
            Back to nodes
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <NodeDetailBody
      detail={detail}
      health={health}
      onDelete={() => router.push("/admin/nodes")}
      onChanged={() => setRefreshKey((k) => k + 1)}
      onTested={(result) => {
        setHealth(result);
        if (result.reachable) setRefreshKey((k) => k + 1);
      }}
    />
  );
}

/** Reachability badge derived from a live probe, falling back to heartbeat age. */
function ReachabilityBadge({
  health,
  lastHeartbeatAt,
}: {
  health: NodeHealthResult | null;
  lastHeartbeatAt: string | null;
}) {
  // Prefer the live probe result when present; otherwise infer from heartbeat.
  const reachable = health?.reachable ?? null;
  const heartbeatTone = nodeReachability(lastHeartbeatAt);

  if (reachable === true) {
    return (
      <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        Online
      </Badge>
    );
  }
  if (reachable === false) {
    return (
      <Badge variant="destructive">
        {health?.unauthorized ? "Bad token" : "Offline"}
      </Badge>
    );
  }
  // No probe yet: fall back to heartbeat freshness.
  if (heartbeatTone === "online") {
    return (
      <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        Online
      </Badge>
    );
  }
  return (
    <Badge variant={heartbeatTone === "stale" ? "outline" : "outline"}>
      {heartbeatTone === "stale" ? "Stale" : "Never seen"}
    </Badge>
  );
}

function NodeDetailBody({
  detail,
  health,
  onDelete,
  onChanged,
  onTested,
}: {
  detail: NodeDetail;
  health: NodeHealthResult | null;
  onDelete: () => void;
  onChanged: () => void | Promise<void>;
  onTested: (result: NodeHealthResult) => void;
}) {
  const { servers, abuse } = detail;
  const hasHealth = health !== null;

  // Ports flattened across servers for the allocation view, sorted by port.
  const ports: NodePortAllocation[] = React.useMemo(
    () =>
      servers
        .flatMap((server) =>
          server.ports.map((port) => ({
            port: port.port,
            isPrimary: port.isPrimary,
            serverId: server.id,
            serverName: server.name,
          })),
        )
        .sort((a, b) => a.port - b.port),
    [servers],
  );

  return (
    <div className="flex flex-col gap-6">
      <NodeHeader
        detail={detail}
        health={health}
        onChanged={onChanged}
        onTested={onTested}
        onDelete={onDelete}
      />

      {/* Live probe status line, only meaningful once a probe has answered. */}
      {hasHealth && (
        <div className="text-xs text-muted-foreground">
          {health.reachable ? (
            <>
              Agent reachable
              {health.dockerVersion ? <> · Docker {health.dockerVersion}</> : null}
              {typeof health.containersRunning === "number" ? (
                <>
                  {" "}· {health.containersRunning} container
                  {health.containersRunning === 1 ? "" : "s"} running
                </>
              ) : null}
            </>
          ) : (
            <>Agent unreachable{health.error ? `: ${health.error}` : null}</>
          )}
        </div>
      )}

      {/* Same reasoning as the data-root callout below, one layer earlier: an
        agent that cannot open the Docker socket answers this page while every
        power action on the node fails. The agent's message names which of the
        two usual causes it is and the command that fixes it. */}
      {health?.reachable && health.dockerSocket && !health.dockerSocket.reachable && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <span className="font-medium text-destructive">
              This node&apos;s agent cannot reach Docker, so every container
              action will fail.
            </span>
            <span className="text-muted-foreground">
              {health.dockerSocket.error ??
                `Its agent cannot reach the Docker socket at ${health.dockerSocket.path}.`}
            </span>
          </div>
        </div>
      )}

      {/* A reachable agent that cannot write its data root will refuse every
        provision, so it gets its own callout rather than a footnote on the
        status line above. The message carries the command that fixes it. */}
      {health?.reachable && health.dataRoot && !health.dataRoot.writable && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <span className="font-medium text-destructive">
              This node cannot store server data, so provisioning will fail.
            </span>
            <span className="text-muted-foreground">
              {health.dataRoot.error ??
                `Its data root ${health.dataRoot.path} is not writable by the agent.`}
            </span>
          </div>
        </div>
      )}

      <CapacityCards detail={detail} />

      <PortPoolCard
        nodeId={detail.node.id}
        entries={detail.portPool}
        allocatedHostPorts={new Set(ports.map((p) => p.port))}
        onChanged={onChanged}
      />

      <AbuseCard abuse={abuse} />

      <ServersCard servers={servers} />

      <PortsCard ports={ports} />

      <Link
        href="/admin/nodes"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to nodes
      </Link>
    </div>
  );
}

function NodeHeader({
  detail,
  health,
  onChanged,
  onTested,
  onDelete,
}: {
  detail: NodeDetail;
  health: NodeHealthResult | null;
  onChanged: () => void | Promise<void>;
  onTested: (result: NodeHealthResult) => void;
  onDelete: () => void;
}) {
  const { node, servers } = detail;
  const [testing, setTesting] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Edit-details dialog. Fields pre-fill from the current node; the token is
  // never read back, so it starts blank and is only sent when the admin types a
  // new one (omitting it keeps the stored token).
  const [editOpen, setEditOpen] = React.useState(false);
  const [editName, setEditName] = React.useState(node.name);
  const [editHostname, setEditHostname] = React.useState(node.hostname);
  const [editApiUrl, setEditApiUrl] = React.useState(node.apiUrl);
  const [editToken, setEditToken] = React.useState("");
  const [editCpuReserve, setEditCpuReserve] = React.useState(String(node.cpuReservePct));
  const [editMemReserve, setEditMemReserve] = React.useState(String(node.memoryReservePct));
  const [editDiskReserve, setEditDiskReserve] = React.useState(String(node.diskReservePct));
  const [editOvercommit, setEditOvercommit] = React.useState(node.allowOvercommit);
  const [saving, setSaving] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);

  // Open the edit dialog, re-syncing the fields from the current node in case
  // it was refreshed (e.g. by a probe) since the last edit. Done in the click
  // handler rather than an effect so it does not trip the set-state-in-effect
  // rule.
  const openEdit = () => {
    setEditName(node.name);
    setEditHostname(node.hostname);
    setEditApiUrl(node.apiUrl);
    setEditToken("");
    setEditCpuReserve(String(node.cpuReservePct));
    setEditMemReserve(String(node.memoryReservePct));
    setEditDiskReserve(String(node.diskReservePct));
    setEditOvercommit(node.allowOvercommit);
    setEditError(null);
    setEditOpen(true);
  };

  const testConnection = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await adminTestNodeConnection(node.id);
      onTested(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to probe the node.");
    } finally {
      setTesting(false);
    }
  };

  const toggleActive = async () => {
    setToggling(true);
    setError(null);
    try {
      await adminUpdateNode(node.id, !node.isActive);
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update the node.");
    } finally {
      setToggling(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await adminDeleteNode(node.id);
      onDelete();
    } catch (err) {
      setDeleteError(
        err instanceof ApiError ? err.message : "Failed to delete the node.",
      );
    } finally {
      setDeleting(false);
    }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setEditError(null);
    try {
      await adminUpdateNodeDetails(node.id, {
        name: editName.trim(),
        hostname: editHostname.trim(),
        apiUrl: editApiUrl.trim(),
        ...(editToken.trim().length > 0 ? { apiToken: editToken.trim() } : {}),
        cpuReservePct: Number(editCpuReserve) || 0,
        memoryReservePct: Number(editMemReserve) || 0,
        diskReservePct: Number(editDiskReserve) || 0,
        allowOvercommit: editOvercommit,
      });
      setEditOpen(false);
      await onChanged?.();
    } catch (err) {
      setEditError(
        err instanceof ApiError ? err.message : "Failed to update the node.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            {node.name}
          </h1>
          <ReachabilityBadge health={health} lastHeartbeatAt={node.lastHeartbeatAt} />
          {!node.isActive && (
            <Badge variant="destructive" className="bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
              Drained
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Globe className="size-3.5" />
            {node.hostname}
          </span>
          <span className="inline-flex items-center gap-1">
            {node.apiUrl.startsWith("https://") ? (
              <Lock className="size-3" />
            ) : (
              <LockOpen className="size-3" />
            )}
            {node.apiUrl.startsWith("https://") ? "Encrypted" : "Plaintext"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Database className="size-3" />
            {node.hasDatabaseServer ? "Per-node DB" : "No DB"}
          </span>
          <span>
            {node.lastHeartbeatAt
              ? `Heartbeat ${formatRelative(node.lastHeartbeatAt)}`
              : "Never seen"}
          </span>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={openEdit}
        >
          <Pencil />
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={testConnection}
          disabled={testing}
        >
          {testing ? <Spinner /> : <PlugZap />}
          Test connection
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={toggleActive}
          disabled={toggling}
        >
          {toggling ? <Spinner /> : node.isActive ? <PowerOff /> : <Power />}
          {node.isActive ? "Drain" : "Activate"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 />
          Delete
        </Button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-destructive" />
              Delete node
            </DialogTitle>
            <DialogDescription>
              Remove <span className="text-foreground">{node.name}</span> from
              the panel. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          {/*
            Two gates must clear before the node can go, surfaced here so the
            admin sees exactly what to do instead of a 409 after the fact. The
            backend re-checks both (plus a race-condition FK backstop), so this
            is guidance, not enforcement.
          */}
          <ul className="flex flex-col gap-1.5 text-sm">
            <li className="flex items-center gap-2">
              {node.isActive ? (
                <X className="size-4 shrink-0 text-amber-500" />
              ) : (
                <Check className="size-4 shrink-0 text-emerald-500" />
              )}
              <span className="text-muted-foreground">
                {node.isActive ? (
                  <>
                    Drain the node first (use the{" "}
                    <span className="text-foreground">Drain</span> button above).
                  </>
                ) : (
                  "Node is drained."
                )}
              </span>
            </li>
            <li className="flex items-center gap-2">
              {servers.length > 0 ? (
                <X className="size-4 shrink-0 text-amber-500" />
              ) : (
                <Check className="size-4 shrink-0 text-emerald-500" />
              )}
              <span className="text-muted-foreground">
                {servers.length > 0 ? (
                  <>
                    Remove all {servers.length} server
                    {servers.length === 1 ? "" : "s"} hosted on this node first.
                  </>
                ) : (
                  "No servers hosted on this node."
                )}
              </span>
            </li>
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting || node.isActive || servers.length > 0}
            >
              {deleting && <Spinner />}
              Delete node
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={saveEdit}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Pencil className="size-5" />
                Edit node details
              </DialogTitle>
              <DialogDescription>
                Correct this node&rsquo;s connection details. The token is kept
                as-is unless you enter a new one.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="py-4">
              <Field>
                <FieldLabel htmlFor="node-edit-name">Name</FieldLabel>
                <Input
                  id="node-edit-name"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="node-edit-hostname">Hostname</FieldLabel>
                <Input
                  id="node-edit-hostname"
                  required
                  placeholder="aurora2.example.com"
                  value={editHostname}
                  onChange={(e) => setEditHostname(e.target.value)}
                />
                <FieldDescription>
                  The address players connect to, not the agent.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="node-edit-api-url">Agent URL</FieldLabel>
                <Input
                  id="node-edit-api-url"
                  required
                  placeholder="http://10.0.0.5:8081"
                  value={editApiUrl}
                  onChange={(e) => setEditApiUrl(e.target.value)}
                />
                <FieldDescription>
                  The agent&rsquo;s base URL, reachable from the panel.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="node-edit-token">Agent token</FieldLabel>
                <Input
                  id="node-edit-token"
                  type="password"
                  placeholder="Leave blank to keep the current token"
                  value={editToken}
                  onChange={(e) => setEditToken(e.target.value)}
                  autoComplete="off"
                />
                <FieldDescription>
                  Only enter a value to replace the stored token.
                </FieldDescription>
              </Field>

              <Separator />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">Resource reservation</span>
                <span className="text-xs text-muted-foreground">
                  Percentage of each resource the scheduler keeps free for the
                  node. 0% lets servers use the full total.
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="node-edit-cpu-reserve">CPU %</FieldLabel>
                  <Input
                    id="node-edit-cpu-reserve"
                    type="number"
                    min={0}
                    max={95}
                    value={editCpuReserve}
                    onChange={(e) => setEditCpuReserve(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="node-edit-mem-reserve">Memory %</FieldLabel>
                  <Input
                    id="node-edit-mem-reserve"
                    type="number"
                    min={0}
                    max={95}
                    value={editMemReserve}
                    onChange={(e) => setEditMemReserve(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="node-edit-disk-reserve">Disk %</FieldLabel>
                  <Input
                    id="node-edit-disk-reserve"
                    type="number"
                    min={0}
                    max={95}
                    value={editDiskReserve}
                    onChange={(e) => setEditDiskReserve(e.target.value)}
                  />
                </Field>
              </div>
              <Field orientation="horizontal">
                <Switch
                  id="node-edit-overcommit"
                  checked={editOvercommit}
                  onCheckedChange={setEditOvercommit}
                />
                <FieldLabel htmlFor="node-edit-overcommit" className="font-normal">
                  Allow overcommit
                </FieldLabel>
                <FieldDescription>
                  Ignore the reservation and allocate against the full total.
                  For nodes that intentionally oversubscribe.
                </FieldDescription>
              </Field>
            </FieldGroup>
            {editError && (
              <p className="pb-2 text-sm text-destructive">{editError}</p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Spinner />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A single capacity stat card.
 *
 * Shows the node's total for a resource, what is *allocated* (the sum of server
 * limits, committed by the scheduler), what is *live in use* right now (from
 * docker stats samples), and what is free. The bar fills to the allocated
 * fraction of the total; the live-used fraction is annotated beneath so an
 * admin can see overcommit (allocated can exceed live usage by design, since
 * limits are ceilings, not reservations).
 */
function CapacityCard({
  label,
  icon,
  unit,
  total,
  allocated,
  live,
  livePctOfTotal,
}: {
  label: string;
  icon: React.ReactNode;
  /** Suffix appended to bare numeric values, e.g. "cores" or "". */
  unit: string;
  total: number;
  allocated: number;
  /** Live-used amount, or null when no sample (node unreachable / nothing running). */
  live: number | null;
  /** Live-used as a fraction of total (0-100), for the live bar overlay. */
  livePctOfTotal: number | null;
}) {
  const allocatedPct =
    total > 0 ? Math.min(100, Math.round((allocated / total) * 100)) : 0;
  const free = Math.max(0, total - allocated);
  const livePct = livePctOfTotal ?? null;

  const fmt = (n: number) =>
    unit === "" ? formatMb(n) : unit === "cores" ? `${formatCores(n)} cores` : `${n} ${unit}`;

  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-lg tabular-nums">{fmt(total)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {/* Allocated: committed by the scheduler via server limits. */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Allocated</span>
          <span className="tabular-nums">
            {fmt(allocated)} · {allocatedPct}%
          </span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
          {/* Allicated fill. */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary/40"
            style={{ width: `${allocatedPct}%` }}
          />
          {/* Live-used fill overlaid on top, in the solid primary. */}
          {livePct !== null && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${Math.min(100, livePct)}%` }}
            />
          )}
        </div>
        {/* Live usage line, only when samples exist. */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">In use now</span>
          <span className="tabular-nums">
            {live === null ? (
              <span className="text-muted-foreground/70">no live data</span>
            ) : (
              fmt(live)
            )}
          </span>
        </div>
        {/* Free = total minus allocated (committed), the scheduling headroom. */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Free</span>
          <span className="tabular-nums">{fmt(free)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function CapacityCards({ detail }: { detail: NodeDetail }) {
  const { node, allocation, servers } = detail;

  // Live usage: sum sampled CPU (converted to cores), memory and disk across
  // servers. `cpuPercent` is "% of one core" (100 = 1 core), so divide by 100.
  // Disk is sampled by the agent by walking each server's data directory.
  const sampledServers = servers.filter((s) => s.cpuPercent !== null);
  const hasSamples = sampledServers.length > 0;
  const liveCpuCores = hasSamples
    ? sampledServers.reduce((sum, s) => sum + (s.cpuPercent ?? 0), 0) / 100
    : null;
  const liveMemMb = hasSamples
    ? sampledServers.reduce((sum, s) => sum + (s.memoryUsageMb ?? 0), 0)
    : null;
  const liveDiskMb = hasSamples
    ? sampledServers.reduce((sum, s) => sum + (s.diskUsageMb ?? 0), 0)
    : null;

  // Servers actually drawing resources right now: those with a live sample.
  const runningSampled = sampledServers.length;
  const totalServers = servers.length;

  const cpuAllocated = allocation?.cpuAllocated ?? 0;
  const memAllocated = allocation?.memoryAllocatedMb ?? 0;
  const diskAllocated = allocation?.diskAllocatedMb ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <CapacityCard
          label="CPU"
          icon={<Cpu className="size-3.5" />}
          unit="cores"
          total={node.cpuTotal}
          allocated={cpuAllocated}
          live={liveCpuCores}
          livePctOfTotal={
            liveCpuCores === null
              ? null
              : node.cpuTotal > 0
                ? (liveCpuCores / node.cpuTotal) * 100
                : 0
          }
        />
        <CapacityCard
          label="Memory"
          icon={<MemoryStick className="size-3.5" />}
          unit=""
          total={node.memoryTotalMb}
          allocated={memAllocated}
          live={liveMemMb}
          livePctOfTotal={
            liveMemMb === null
              ? null
              : node.memoryTotalMb > 0
                ? (liveMemMb / node.memoryTotalMb) * 100
                : 0
          }
        />
        <CapacityCard
          label="Disk"
          icon={<HardDrive className="size-3.5" />}
          unit=""
          total={node.diskTotalMb}
          allocated={diskAllocated}
          live={liveDiskMb}
          livePctOfTotal={
            liveDiskMb === null
              ? null
              : node.diskTotalMb > 0
                ? (liveDiskMb / node.diskTotalMb) * 100
                : 0
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {hasSamples ? (
          <>
            <span className="tabular-nums">{runningSampled}</span> of{" "}
            <span className="tabular-nums">{totalServers}</span> server
            {totalServers === 1 ? "" : "s"} running and sampled live. Allocated =
            committed limits; in use now = live docker stats.
          </>
        ) : (
          <>
            <span className="tabular-nums">{totalServers}</span> server
            {totalServers === 1 ? "" : "s"} on this node. No live usage samples.
            The node may be unreachable, or no servers are running.
          </>
        )}
      </p>
      {(node.allowOvercommit ||
        node.cpuReservePct > 0 ||
        node.memoryReservePct > 0 ||
        node.diskReservePct > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
          {node.allowOvercommit ? (
            <span>
              Overcommit is on. The scheduler allocates against the full totals
              and ignores the reservation below.
            </span>
          ) : (
            <span>
              Reservation (kept free for the node): CPU{" "}
              <span className="tabular-nums text-foreground">{node.cpuReservePct}%</span>
              {", "}
              memory{" "}
              <span className="tabular-nums text-foreground">{node.memoryReservePct}%</span>
              {", "}
              disk{" "}
              <span className="tabular-nums text-foreground">{node.diskReservePct}%</span>
              . New servers are placed only within the remaining share.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AbuseCard({
  abuse,
}: {
  abuse: NodeDetail["abuse"];
}) {
  const hasAny = abuse.openCount > 0 || abuse.reviewedCount > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-muted-foreground" />
          Abuse detection
        </CardTitle>
        <CardDescription>
          Heuristic flags from the abuse watcher for servers on this node.
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/admin/security" />}
            nativeButton={false}
          >
            Open queue
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-3 gap-3 text-center">
          <AbuseStat label="Open" value={abuse.openCount} tone="open" />
          <AbuseStat
            label="Reviewed"
            value={abuse.reviewedCount}
            tone="reviewed"
          />
          <AbuseStat label="Max score" value={abuse.maxScore} tone="score" />
        </div>

        {abuse.recent.length > 0 ? (
          <div className="grid gap-2">
            {abuse.recent.map((flag) => (
              <div
                key={flag.id}
                className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2.5"
              >
                <Badge variant={scoreTone(flag.score)} className="tabular-nums">
                  {flag.score}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{flag.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    {flag.serverName ?? flag.serverId.slice(0, 8)} ·{" "}
                    {formatRelative(flag.detectedAt)}
                  </p>
                </div>
                {flag.reviewed ? (
                  <Badge variant="outline">Reviewed</Badge>
                ) : (
                  <Badge variant="secondary">Open</Badge>
                )}
              </div>
            ))}
          </div>
        ) : (
          hasAny && (
            <p className="text-sm text-muted-foreground">
              No recent flags to show.
            </p>
          )
        )}
        {!hasAny && (
          <p className="text-sm text-muted-foreground">
            No abuse flags recorded for servers on this node.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AbuseStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "open" | "reviewed" | "score";
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3">
      <span
        className={cn(
          "text-2xl font-semibold tabular-nums",
          tone === "open" && value > 0 && "text-amber-600 dark:text-amber-400",
          tone === "score" &&
            value >= 100 &&
            "text-destructive",
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function ServersCard({
  servers,
}: {
  servers: NodeDetail["servers"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Servers{" "}
          <span className="text-muted-foreground">({servers.length})</span>
        </CardTitle>
        <CardDescription>
          Game servers hosted on this node, with a live usage sample.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Server</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Limits</TableHead>
              <TableHead className="text-right">CPU</TableHead>
              <TableHead className="text-right">Mem</TableHead>
              <TableHead className="text-right">Port</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {servers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  No servers on this node.
                </TableCell>
              </TableRow>
            ) : (
              servers.map((server) => {
                const primary =
                  server.ports.find((p) => p.isPrimary) ?? server.ports[0];
                return (
                  <TableRow key={server.id} className="group">
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{server.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {server.blueprintKey}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {server.ownerEmail}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={server.status} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums text-xs">
                      {formatMb(server.memoryLimitMb)}
                      <br />
                      {formatMb(server.diskLimitMb)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {server.cpuPercent !== null
                        ? `${Math.round(server.cpuPercent)}%`
                        : "Unknown"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {server.memoryUsageMb !== null
                        ? formatMb(server.memoryUsageMb)
                        : "Unknown"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {primary ? primary.port : "None"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        render={<Link href={`/servers/${server.id}`} />}
                        nativeButton={false}
                        aria-label={`Open ${server.name}`}
                      >
                        <ArrowUpRight />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Port pool management.
 *
 * The admin reserves host ports/ranges here; new servers draw from this set
 * (see the backend `allocateHostPort`). Distinct from {@link PortsCard}, which
 * shows ports already bound to servers. Adding an entry parses the spec
 * client-side for immediate feedback, then asks the backend to verify every
 * port is free on the host. A 409 surfaces the offending ports inline.
 */
function PortPoolCard({
  nodeId,
  entries,
  allocatedHostPorts,
  onChanged,
}: {
  nodeId: string;
  entries: NodePortPoolEntry[];
  /** Host ports currently bound to servers, for the "in use" delete warning. */
  allocatedHostPorts: Set<number>;
  onChanged: () => void | Promise<void>;
}) {
  const [spec, setSpec] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Delete-confirmation state. Holds the entry pending deletion so the dialog
  // can warn how many of its ports are currently allocated to servers.
  const [pendingDelete, setPendingDelete] = React.useState<NodePortPoolEntry | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  // Live validation hint, derived purely from `spec`, so no effect is needed
  // and it does not trip the set-state-in-effect rule. Recomputed each render.
  const hint = React.useMemo(() => {
    const trimmed = spec.trim();
    if (trimmed.length === 0) return null;
    try {
      const ports = parsePortSpec(trimmed);
      return `${ports.length} port${ports.length === 1 ? "" : "s"}: ${formatPortsCompact(ports)}`;
    } catch (err) {
      return err instanceof PortSpecError ? err.message : "Invalid spec.";
    }
  }, [spec]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = spec.trim();
    if (trimmed.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      await adminAddNodePortPoolEntry(nodeId, trimmed);
      // Clearing `spec` also clears the derived `hint`.
      setSpec("");
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add the port entry.");
    } finally {
      setAdding(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await adminDeleteNodePortPoolEntry(pendingDelete.id);
      setPendingDelete(null);
      await onChanged?.();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Failed to remove the entry.");
    } finally {
      setDeleting(false);
    }
  };

  const totalPorts = entries.reduce((sum, entry) => sum + entry.ports.length, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Port pool
          <span className="text-muted-foreground">
            ({entries.length} {entries.length === 1 ? "entry" : "entries"} · {totalPorts} ports)
          </span>
        </CardTitle>
        <CardDescription>
          Reserved host ports new servers draw from, at random. Each number is
          reserved on TCP and UDP together; the backend verifies both are free on
          the node before adding it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* Add form */}
        <form onSubmit={add} className="flex flex-col gap-3">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="port-spec">Ports or range</FieldLabel>
              <Input
                id="port-spec"
                placeholder="25565-25570 or 25565,25578"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                autoComplete="off"
              />
              {hint && (
                <FieldDescription
                  className={
                    hint.startsWith("Invalid") || hint.includes("out of range") || hint.includes("reversed") || hint.includes("more than once") || hint.includes("not a valid")
                      ? "text-destructive"
                      : undefined
                  }
                >
                  {hint}
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div>
            <Button type="submit" size="sm" disabled={adding || spec.trim().length === 0}>
              {adding ? <Spinner /> : <Plus />}
              Add to pool
            </Button>
          </div>
        </form>

        <Separator />

        {/* Entries */}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ports reserved. This node cannot host servers until at least one
            entry is added. There is no default range.
          </p>
        ) : (
          <div className="grid gap-2">
            {entries.map((entry) => {
              const inUse = entry.ports.filter((port) =>
                allocatedHostPorts.has(port),
              ).length;
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"
                >
                  <Badge variant="outline" className="font-mono text-xs uppercase">
                    tcp + udp
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm">{entry.spec}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.ports.length} port{entry.ports.length === 1 ? "" : "s"}
                      {inUse > 0 ? ` · ${inUse} currently allocated` : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove entry"
                    onClick={() => {
                      setDeleteError(null);
                      setPendingDelete(entry);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-destructive" />
              Remove port entry
            </DialogTitle>
            <DialogDescription>
              Remove <span className="font-mono text-foreground">{pendingDelete?.spec}</span>{" "}
              from the pool.
            </DialogDescription>
          </DialogHeader>
          {pendingDelete && pendingDelete.ports.some((p) => allocatedHostPorts.has(p)) ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {pendingDelete.ports.filter((p) => allocatedHostPorts.has(p)).length} of
              these ports are currently allocated to running servers. Those
              servers keep their bindings. Only future allocations are affected.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No servers are currently using ports from this entry.
            </p>
          )}
          {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Spinner />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PortsCard({ ports }: { ports: NodePortAllocation[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Port allocations{" "}
          <span className="text-muted-foreground">({ports.length})</span>
        </CardTitle>
        <CardDescription>
          Ports published on this node across all servers.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">Port</TableHead>
              <TableHead>Server</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ports.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  No ports allocated on this node.
                </TableCell>
              </TableRow>
            ) : (
              ports.map((port) => (
                <TableRow key={`${port.serverId}:${port.port}`} className="group">
                  <TableCell className="text-right tabular-nums font-mono">
                    {port.port}
                  </TableCell>
                  <TableCell className="flex items-center gap-2">
                    {port.serverName}
                    {port.isPrimary && (
                      <Badge variant="secondary" className="text-[10px]">
                        primary
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      render={<Link href={`/servers/${port.serverId}`} />}
                      nativeButton={false}
                      aria-label={`Open ${port.serverName}`}
                    >
                      <ArrowUpRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
