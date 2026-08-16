"use client";

import * as React from "react";
import Link from "next/link";
import {
  Castle,
  Cpu,
  FolderOpen,
  HardDrive,
  MemoryStick,
  Play,
  Timer,
  TriangleAlert,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, getServerStats, listServers } from "@/lib/api";
import { formatMbPair, formatUptime } from "@/lib/format";
import type { ServerView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * One metered resource: label and value stacked above a usage bar.
 *
 * Label and value sit on separate lines on purpose. Side-by-side they collide
 * in a half-width card column as soon as the value is something like
 * "4.5/8 GB", which is what made the old tiles wrap and orphan the unit.
 */
function Meter({
  icon: Icon,
  label,
  value,
  percent,
  muted = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  percent: number;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {label}
      </span>
      <span
        className={cn(
          "text-sm leading-none font-medium tabular-nums",
          muted && "text-muted-foreground",
        )}
      >
        {value}
      </span>
      <Progress value={percent} className="mt-0.5 w-full" />
    </div>
  );
}

/**
 * One server tile on the selection screen. The server name is a stretched link
 * over the whole card; the footer holds quick-action links. Live stats (CPU,
 * memory, disk) come from the stats feed on the server page, so on this
 * summary they read zero until opened.
 */
function ServerTile({ server }: { server: ServerView }) {
  const running = server.status === "running";

  const pct = (used: number, limit: number) =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  const address =
    server.nodeHostname && server.primaryPort > 0
      ? `${server.nodeHostname}:${server.primaryPort}`
      : server.primaryPort > 0
        ? `port ${server.primaryPort}`
        : "—";

  return (
    <Card className="relative gap-3 transition-colors hover:ring-primary/40">
      <CardHeader>
        <CardTitle className="truncate">
          <Link
            href={`/servers/${server.id}`}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring after:absolute after:inset-0"
          >
            {server.name}
          </Link>
        </CardTitle>
        <CardDescription className="flex flex-col gap-0.5">
          <span className="truncate">{server.blueprintKey}</span>
          <span className="truncate font-mono text-xs">{address}</span>
        </CardDescription>
        <CardAction>
          <StatusBadge status={server.status} />
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-3 border-y py-2 text-xs">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground tabular-nums">
            <Timer className="size-3.5 shrink-0" />
            {running ? formatUptime(server.uptimeSeconds) : "Offline"}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {running ? "Online" : "—"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-x-4">
          <Meter
            icon={Cpu}
            label="CPU"
            value={running ? `${server.cpuPercent}%` : "—"}
            percent={running ? server.cpuPercent : 0}
            muted={!running}
          />
          <Meter
            icon={MemoryStick}
            label="Memory"
            value={formatMbPair(
              running ? server.memoryUsedMb : 0,
              server.memoryLimitMb,
            )}
            percent={running ? pct(server.memoryUsedMb, server.memoryLimitMb) : 0}
            muted={!running}
          />
          <Meter
            icon={HardDrive}
            label="Disk"
            value={formatMbPair(server.diskUsedMb, server.diskLimitMb)}
            percent={pct(server.diskUsedMb, server.diskLimitMb)}
          />
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Cpu className="size-3.5 shrink-0" />
          <span className="tabular-nums">
            {server.cpuLimit} vCPU{server.cpuLimit === 1 ? "" : "s"} allocated
          </span>
        </div>
      </CardContent>

      <CardFooter className="relative z-10 justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/servers/${server.id}/files`} />}
          nativeButton={false}
        >
          <FolderOpen data-icon="inline-start" />
          Files
        </Button>
        <Button
          size="sm"
          render={<Link href={`/servers/${server.id}/console`} />}
          nativeButton={false}
        >
          <Play data-icon="inline-start" />
          Manage
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Placeholder tile shown while the server list loads. */
function TileSkeleton() {
  return (
    <Card className="gap-3">
      <CardHeader>
        <Skeleton className="h-5 w-36" />
        <div className="flex flex-col gap-1">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-40" />
        </div>
        <CardAction>
          <Skeleton className="h-5 w-20" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="border-y py-2">
          <Skeleton className="h-4 w-full" />
        </div>
        <div className="grid grid-cols-3 gap-x-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-1 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-3.5 w-40" />
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
      </CardFooter>
    </Card>
  );
}

/**
 * The "Your servers" list. Loads the caller's visible servers from the backend.
 * Self-service creation does not exist: provisioning is an admin action, so the
 * empty state points the user at their administrator.
 */
export function YourServers() {
  const [servers, setServers] = React.useState<ServerView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const apiServers = await listServers();
        if (!cancelled) setServers(apiServers);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : "Could not load your servers.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll live resource samples for running servers so the tiles' CPU, memory,
  // and disk meters reflect current usage rather than the zeros the list
  // endpoint seeds. One request per running server every 5s — the stats
  // endpoint is per-server (no user-facing batch endpoint), and a typical user
  // has a handful of servers. Stops re-arming once no servers are running.
  //
  // The effect depends on a stable signature of WHICH servers are running, not
  // the live `servers` array — otherwise each poll's state update would
  // re-trigger it and re-arm a fresh interval every tick.
  const runningIds = servers
    .filter((s) => s.status === "running")
    .map((s) => s.id);
  const runningKey = runningIds.join(",");

  React.useEffect(() => {
    if (runningIds.length === 0) return;
    // Re-resolve from the current key so the closure captures stable ids.
    const ids = runningKey ? runningKey.split(",") : [];

    let cancelled = false;
    const tick = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await getServerStats(id)] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      );
      if (cancelled) return;

      const byId = new Map(
        results.filter(([, s]) => s !== null) as readonly (readonly [string, NonNullable<Awaited<ReturnType<typeof getServerStats>>>])[],
      );
      if (byId.size === 0) return;

      setServers((prev) =>
        prev.map((server) => {
          const stats = byId.get(server.id);
          if (!stats) return server;
          return {
            ...server,
            cpuPercent: Math.round(stats.cpuPercent),
            memoryUsedMb: Math.round(stats.memoryUsageMb),
            diskUsedMb: Math.round(stats.diskUsageMb),
          };
        }),
      );
    };

    void tick();
    const interval = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey]);

  const running = servers.filter((s) => s.status === "running").length;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Your servers
        </h1>
        <p className="text-sm text-muted-foreground">
          {loading
            ? "Loading your servers…"
            : servers.length === 0
              ? "Select a server to manage it."
              : `${running} of ${servers.length} running. Select a server to manage it.`}
        </p>
      </div>

      {error ? (
        <Empty className="min-h-[22rem]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlert />
            </EmptyMedia>
            <EmptyTitle>Couldn&apos;t load your servers</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <TileSkeleton key={i} />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <Empty className="min-h-[22rem]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Castle />
            </EmptyMedia>
            <EmptyTitle>No servers yet</EmptyTitle>
            <EmptyDescription>
              Servers are provisioned by an administrator. Your server will
              appear here as soon as one has been created for your account.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <p className="text-xs text-muted-foreground">
              Need a server? Contact the panel administrator with the game you
              want to run and the resources you expect to need.
            </p>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <ServerTile key={server.id} server={server} />
          ))}
        </div>
      )}
    </>
  );
}
