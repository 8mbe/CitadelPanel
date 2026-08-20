"use client";

import { Cpu, HardDrive, MemoryStick } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  useLiveResourceStats,
  useServerStatus,
} from "@/components/server/server-data-context";
import { formatMb } from "@/lib/format";
import type { ServerView } from "@/lib/types";

export function ResourceStats({ server }: { server: ServerView }) {
  // These cards are the only thing on a server page that reads the live sample,
  // so the `/stats` poll runs while they are mounted and stops when they are not.
  useLiveResourceStats();
  const [status] = useServerStatus();
  const running = status === "running";
  const active = running || status === "starting";

  const memPct = server.memoryLimitMb
    ? Math.round((server.memoryUsedMb / server.memoryLimitMb) * 100)
    : 0;
  const diskPct = server.diskLimitMb
    ? Math.round((server.diskUsedMb / server.diskLimitMb) * 100)
    : 0;
  // `cpuPercent` is already a share of the allocated vCPUs (100 = one core
  // saturated), so it maps directly onto the bar without a used/limit divide.
  const cpuPct = active ? Math.min(100, Math.max(0, server.cpuPercent)) : 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <Card size="sm">
        <CardHeader>
          <CardDescription>CPU load</CardDescription>
          <CardTitle className="flex items-center gap-2 text-lg tabular-nums">
            <Cpu className="size-4 text-muted-foreground" />
            {active ? `${server.cpuPercent}%` : "0%"}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Allocated</span>
            <span className="tabular-nums">
              {server.cpuLimit} vCPU{server.cpuLimit === 1 ? "" : "s"}
            </span>
          </div>
          <Progress value={cpuPct} className="w-full" />
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
    </div>
  );
}
