"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  Copy,
  Cpu,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  Lock,
  LockOpen,
  MemoryStick,
  PlugZap,
  Plus,
  Server,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  adminCreateNode,
  adminProbeNodeConnection,
  adminTestNodeConnection,
  ApiError,
} from "@/lib/api";
import { formatMb, formatRelative, nodeReachability } from "@/lib/format";
import type { NodeAllocation, NodeView } from "@/lib/types";

/**
 * Register-a-node dialog.
 *
 * Calls POST /api/admin/nodes for real. When the operator leaves the token
 * blank the backend generates one and returns it **once** — the dialog then
 * shows that token with a copy button and does not let it be dismissed by
 * accident, because it can never be retrieved again.
 */
export function AddNodeDialog({ onAdded }: { onAdded?: () => void | Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [hostname, setHostname] = React.useState("");
  const [apiUrl, setApiUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const [diskGb, setDiskGb] = React.useState("100");
  const [cpuReserve, setCpuReserve] = React.useState("0");
  const [memReserve, setMemReserve] = React.useState("0");
  const [diskReserve, setDiskReserve] = React.useState("0");
  const [overcommit, setOvercommit] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    token?: string;
    warning?: string;
    reachable: boolean;
  } | null>(null);
  // Pre-registration probe. Distinct from `result`, which holds the *register*
  // outcome. Kept as a 3-state union so a wrong token reads differently from a
  // dead host: amber (fix the token) vs red (fix the network/URL).
  const [probing, setProbing] = React.useState(false);
  const [probe, setProbe] = React.useState<
    | {
        state: "ok";
        dockerVersion?: string;
        containersRunning?: number;
        /** Set when the agent answered but cannot write its data root. */
        dataRootError?: string;
      }
    | { state: "unauthorized" }
    | { state: "error"; message: string }
    | null
  >(null);

  const reset = () => {
    setName("");
    setHostname("");
    setApiUrl("");
    setToken("");
    setDiskGb("100");
    setCpuReserve("0");
    setMemReserve("0");
    setDiskReserve("0");
    setOvercommit(false);
    setError(null);
    setResult(null);
    setProbe(null);
  };

  const testConnection = async () => {
    const trimmedToken = token.trim();
    if (!apiUrl.trim() || !trimmedToken) return;
    setProbing(true);
    setProbe(null);
    try {
      const health = await adminProbeNodeConnection({
        apiUrl: apiUrl.trim(),
        token: trimmedToken,
      });
      setProbe(
        health.reachable
          ? {
              state: "ok",
              dockerVersion: health.dockerVersion,
              containersRunning: health.containersRunning,
              // Caught here rather than at the first provision: a node whose
              // data root the agent cannot write to answers health checks
              // perfectly and then fails every server creation.
              dataRootError:
                health.dataRoot && !health.dataRoot.writable
                  ? (health.dataRoot.error ??
                    `Its data root ${health.dataRoot.path} is not writable by the agent.`)
                  : undefined,
            }
          : health.unauthorized
            ? { state: "unauthorized" }
            : { state: "error", message: health.error ?? "No response from agent." },
      );
    } catch (err) {
      setProbe({
        state: "error",
        message: err instanceof ApiError ? err.message : "Failed to probe the node.",
      });
    } finally {
      setProbing(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await adminCreateNode({
        name,
        hostname,
        apiUrl,
        token: token.trim() || undefined,
        diskTotalMb: Math.round(Number(diskGb) * 1024),
        cpuReservePct: Number(cpuReserve) || 0,
        memoryReservePct: Number(memReserve) || 0,
        diskReservePct: Number(diskReserve) || 0,
        allowOvercommit: overcommit,
      });
      setResult({
        token: response.token,
        warning: response.warning,
        reachable: response.health.reachable,
      });
      await onAdded?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to register the node.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <Plus />
        Add node
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Check className="size-5 text-primary" />
                Node registered
              </DialogTitle>
              <DialogDescription>
                {result.reachable
                  ? "The agent responded and its capacity was recorded."
                  : "The node was saved, but its agent did not respond yet."}
              </DialogDescription>
            </DialogHeader>
            {result.token && <GeneratedToken token={result.token} />}
            {result.warning && !result.token && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <span className="text-muted-foreground">{result.warning}</span>
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Register a node</DialogTitle>
              <DialogDescription>
                Point CitadelPanel at a machine running the node agent. The panel
                probes it and records its capacity.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="node-name">Display name</FieldLabel>
                  <Input
                    id="node-name"
                    required
                    placeholder="Aurora 2"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="node-hostname">Hostname</FieldLabel>
                  <Input
                    id="node-hostname"
                    required
                    placeholder="aurora2.example.com"
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value)}
                  />
                  <FieldDescription>
                    The address players connect to, not the agent.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="node-api-url">Agent URL</FieldLabel>
                  <Input
                    id="node-api-url"
                    required
                    placeholder="https://10.0.1.20:8081"
                    value={apiUrl}
                    onChange={(e) => {
                      setApiUrl(e.target.value);
                      setProbe(null);
                    }}
                  />
                  <FieldDescription>
                    Where the node agent is listening. Use https:// or keep it on
                    a private network — the token below grants full control of
                    that machine.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="node-token">Agent token</FieldLabel>
                  <Input
                    id="node-token"
                    type="password"
                    placeholder="Leave blank to generate one"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      // Editing the credential invalidates any prior probe result.
                      setProbe(null);
                    }}
                    autoComplete="off"
                  />
                  <FieldDescription>
                    The agent&apos;s AGENT_TOKEN. If left blank, one is generated
                    and shown once — you then set it on the agent and restart it.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="node-disk">Disk capacity (GB)</FieldLabel>
                  <Input
                    id="node-disk"
                    type="number"
                    min={1}
                    required
                    value={diskGb}
                    onChange={(e) => setDiskGb(e.target.value)}
                  />
                  <FieldDescription>
                    CPU and memory are read from the agent automatically when it
                    is reachable.
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
                <div className="grid grid-cols-3 gap-3">
                  <Field>
                    <FieldLabel htmlFor="node-cpu-reserve">CPU %</FieldLabel>
                    <Input
                      id="node-cpu-reserve"
                      type="number"
                      min={0}
                      max={95}
                      value={cpuReserve}
                      onChange={(e) => setCpuReserve(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="node-mem-reserve">Memory %</FieldLabel>
                    <Input
                      id="node-mem-reserve"
                      type="number"
                      min={0}
                      max={95}
                      value={memReserve}
                      onChange={(e) => setMemReserve(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="node-disk-reserve">Disk %</FieldLabel>
                    <Input
                      id="node-disk-reserve"
                      type="number"
                      min={0}
                      max={95}
                      value={diskReserve}
                      onChange={(e) => setDiskReserve(e.target.value)}
                    />
                  </Field>
                </div>
                <Field orientation="horizontal">
                  <Switch
                    id="node-overcommit"
                    checked={overcommit}
                    onCheckedChange={setOvercommit}
                  />
                  <FieldLabel htmlFor="node-overcommit" className="font-normal">
                    Allow overcommit
                  </FieldLabel>
                  <FieldDescription>
                    Ignore the reservation and allocate against the full total —
                    for nodes that intentionally oversubscribe.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              {probe && (
                <div
                  role="status"
                  className={
                    probe.state === "ok" && !probe.dataRootError
                      ? "flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm"
                      : probe.state === "unauthorized" ||
                          (probe.state === "ok" && probe.dataRootError)
                        ? "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
                        : "flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                  }
                >
                  {probe.state === "ok" && !probe.dataRootError ? (
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  ) : probe.state === "unauthorized" ||
                    (probe.state === "ok" && probe.dataRootError) ? (
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  ) : (
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  )}
                  <span
                    className={
                      probe.state === "error" ? undefined : "text-muted-foreground"
                    }
                  >
                    {probe.state === "ok" ? (
                      <>
                        Connected
                        {probe.dockerVersion ? <> · Docker {probe.dockerVersion}</> : null}
                        {typeof probe.containersRunning === "number" ? (
                          <>
                            {" "}
                            · {probe.containersRunning} container
                            {probe.containersRunning === 1 ? "" : "s"} running
                          </>
                        ) : null}
                        {/* Amber, not red: the connection details are correct
                          and worth saving — it is the node that needs fixing
                          before it can host a server. */}
                        {probe.dataRootError ? (
                          <>
                            <br />
                            This node cannot store server data yet, so
                            provisioning will fail. {probe.dataRootError}
                          </>
                        ) : null}
                      </>
                    ) : probe.state === "unauthorized" ? (
                      <>
                        The agent rejected this token. The URL is reachable, but
                        the token does not match the agent&apos;s AGENT_TOKEN.
                      </>
                    ) : (
                      probe.message
                    )}
                  </span>
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={testConnection}
                  // The probe needs both a URL and a token. With no token, the
                  // operator intends to generate one — which cannot be tested
                  // until it is set on the agent, so disable rather than 401.
                  disabled={
                    probing || submitting || !apiUrl.trim() || !token.trim()
                  }
                >
                  {probing ? <Spinner /> : <PlugZap />}
                  Test connection
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting && <Spinner />}
                  Register node
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The one-time generated agent token, with copy-to-clipboard. */
function GeneratedToken({ token }: { token: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the operator can still select the text manually.
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2 text-sm">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span className="text-muted-foreground">
          Copy this token now — it is stored encrypted and cannot be shown again.
          Set it as <code className="text-foreground">AGENT_TOKEN</code> on the
          node and restart its agent.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {token}
        </code>
        <Button type="button" size="icon" variant="outline" onClick={copy}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

export function NodeCard({
  node,
  allocation,
  onTested,
}: {
  node: NodeView;
  allocation: NodeAllocation | null;
  /**
   * Called after a probe answers, regardless of reachability. A successful
   * probe records a heartbeat server-side, so the parent reloads to refresh the
   * "online" badge and heartbeat timestamp.
   */
  onTested?: () => void | Promise<void>;
}) {
  const memPct = allocation
    ? Math.round((allocation.memoryAllocatedMb / node.memoryTotalMb) * 100)
    : 0;
  const diskPct = allocation
    ? Math.round((allocation.diskAllocatedMb / node.diskTotalMb) * 100)
    : 0;

  // Test-connection state. No toast library is wired up, so feedback is shown
  // inline beneath the button — the same pattern the mail test button uses.
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<
    | {
        reachable: true;
        dockerVersion?: string;
        containersRunning?: number;
        /** Set only when the agent reports a data root it cannot write to. */
        dataRootError?: string;
      }
    | { reachable: false; error: string }
    | null
  >(null);

  const testConnection = async () => {
    setTesting(true);
    setResult(null);
    try {
      const health = await adminTestNodeConnection(node.id);
      setResult(
        health.reachable
          ? {
              reachable: true,
              dockerVersion: health.dockerVersion,
              containersRunning: health.containersRunning,
              // A writable data root is the difference between "connected" and
              // "connected but every provision will fail".
              dataRootError:
                health.dataRoot && !health.dataRoot.writable
                  ? (health.dataRoot.error ??
                    `Its data root ${health.dataRoot.path} is not writable by the agent.`)
                  : undefined,
            }
          : { reachable: false, error: health.error ?? "No response from agent." },
      );
      // A reachable probe also stamped a heartbeat, so let the page refresh.
      if (health.reachable) await onTested?.();
    } catch (err) {
      setResult({
        reachable: false,
        error:
          err instanceof ApiError ? err.message : "Failed to reach the panel.",
      });
    } finally {
      setTesting(false);
    }
  };

  const reachability = nodeReachability(node.lastHeartbeatAt);

  return (
    <Card className="group/card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>
            <Link
              href={`/admin/nodes/${node.id}`}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring hover:underline"
            >
              {node.name}
            </Link>
          </CardTitle>
          {/* Reachability is inferred from heartbeat freshness, not the drain
            toggle — a drained node can still be reachable, and a reachable
            node can be out of rotation. */}
          <Badge
            variant="outline"
            className={
              reachability === "online"
                ? "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : reachability === "stale"
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : ""
            }
          >
            {reachability === "online"
              ? "Online"
              : reachability === "stale"
                ? "Stale"
                : "Never seen"}
          </Badge>
          {!node.isActive && (
            <Badge
              variant="outline"
              className="bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
            >
              Drained
            </Badge>
          )}
        </div>
        <CardDescription className="flex items-center gap-1.5">
          <Globe className="size-3.5" />
          {node.hostname}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Cpu className="size-3.5" />
            {node.cpuTotal} vCPU
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <MemoryStick className="size-3.5" />
            {formatMb(node.memoryTotalMb)}
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <HardDrive className="size-3.5" />
            {formatMb(node.diskTotalMb)}
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Server className="size-3.5" />
            {node.apiUrl.replace(/^https?:\/\//, "")}
          </div>
        </div>

        <Separator />

        <div className="grid gap-2 text-xs">
          <div className="flex justify-between text-muted-foreground">
            <span>Memory allocated</span>
            <span className="tabular-nums">
              {formatMb(allocation?.memoryAllocatedMb ?? 0)} · {memPct}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${memPct}%` }}
            />
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Disk allocated</span>
            <span className="tabular-nums">
              {formatMb(allocation?.diskAllocatedMb ?? 0)} · {diskPct}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${diskPct}%` }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {/*
            The agent token is root-equivalent for the node, so whether it
            crosses the network in the clear is worth surfacing on the card.
          */}
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
          <span className="ml-auto">
            {node.lastHeartbeatAt
              ? `Heartbeat ${formatRelative(node.lastHeartbeatAt)}`
              : "Never seen"}
          </span>
        </div>

        {result && (
          <div
            role="status"
            className={
              result.reachable && !result.dataRootError
                ? "flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-2.5 text-xs"
                : "flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
            }
          >
            {result.reachable && !result.dataRootError ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
            ) : (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span className="text-muted-foreground">
              {result.reachable ? (
                <>
                  Connected
                  {result.dockerVersion ? (
                    <> · Docker {result.dockerVersion}</>
                  ) : null}
                  {typeof result.containersRunning === "number" ? (
                    <>
                      {" "}
                      · {result.containersRunning} container
                      {result.containersRunning === 1 ? "" : "s"} running
                    </>
                  ) : null}
                  {/* Reachable but unable to store data: say so here, because
                    the next thing this admin does is provision a server. */}
                  {result.dataRootError ? (
                    <>
                      <br />
                      <span className="text-destructive">
                        Cannot store server data — provisioning will fail.
                      </span>{" "}
                      {result.dataRootError}
                    </>
                  ) : null}
                </>
              ) : (
                result.error
              )}
            </span>
          </div>
        )}
      </CardContent>
      {/* Card footer is where card-level actions belong, per the card layout. */}
      <CardFooter>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={testConnection}
          disabled={testing}
        >
          {testing ? <Spinner /> : <PlugZap />}
          Test connection
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          render={<Link href={`/admin/nodes/${node.id}`} />}
          nativeButton={false}
        >
          Open
          <ArrowUpRight />
        </Button>
      </CardFooter>
    </Card>
  );
}
