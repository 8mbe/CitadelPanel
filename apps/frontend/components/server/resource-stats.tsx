"use client";

import { Cpu, HardDrive, MemoryStick, Network, Users } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useServerStatus } from "@/components/server/server-data-context";
import { formatMb, formatNet, formatUptime } from "@/lib/format";
import type { ServerView } from "@/lib/types";

export function ResourceStats({ server }: { server: ServerView }) {
  const [status] = useServerStatus();
  const running = status === "running";
  const active = running || status === "starting";

  const memPct = server.memoryLimitMb
    ? Math.round((server.memoryUsedMb / server.memoryLimitMb) * 100)
    : 0;
  const diskPct = server.diskLimitMb
    ? Math.round((server.diskUsedMb / server.diskLimitMb) * 100)
    : 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card size="sm">
        <CardHeader>
          <CardDescription>CPU load</CardDescription>
          <CardTitle className="flex items-center gap-2 text-lg tabular-nums">
            <Cpu className="size-4 text-muted-foreground" />
            {active ? `${server.cpuPercent}%` : "0%"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            of allocated container vCPU
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Network className="size-3.5" />
            {running
              ? `↓${formatNet(server.networkRxBps)} ↑${formatNet(server.networkTxBps)}`
              : "no traffic"}
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Memory</CardDescription>
          <CardTitle className="flex items-center gap-2 text-lg tabular-nums">
            <MemoryStick className="size-4 text-muted-foreground" />
            {formatMb(server.memoryUsedMb)}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Limit</span>
            <span className="tabular-nums">{formatMb(server.memoryLimitMb)}</span>
          </div>
          <Progress value={memPct} className="w-full" />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Disk</CardDescription>
          <CardTitle className="flex items-center gap-2 text-lg tabular-nums">
            <HardDrive className="size-4 text-muted-foreground" />
            {formatMb(server.diskUsedMb)}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Quota</span>
            <span className="tabular-nums">{formatMb(server.diskLimitMb)}</span>
          </div>
          <Progress value={diskPct} className="w-full" />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Players</CardDescription>
          <CardTitle className="flex items-center gap-2 text-lg tabular-nums">
            <Users className="size-4 text-muted-foreground" />
            {running ? `${server.playerCount}/${server.playerMax}` : "—"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Uptime {formatUptime(server.uptimeSeconds)}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
