"use client";

import { Globe } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { PowerControls } from "@/components/server/power-controls";
import { useServerData } from "@/components/server/server-data-context";
import type { ServerView } from "@/lib/types";

/**
 * The server identity row: name + live status on the left, power actions on
 * the right. Stacks vertically on small screens.
 *
 * Reads the live record from context so status and the primary address stay
 * current; the `server` prop is only the initial value the layout loaded with.
 */
export function ServerHeader({ server: initial }: { server: ServerView }) {
  const { server, status } = useServerData();
  const primaryPort = server.primaryPort || initial.primaryPort;
  // The connect address is the node's hostname (player-facing, not the agent
  // URL) plus the primary host port. Hide it until both are known.
  const address =
    server.nodeHostname && primaryPort > 0
      ? `${server.nodeHostname}:${primaryPort}`
      : primaryPort > 0
        ? `port ${primaryPort}`
        : null;

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            {server.name}
          </h1>
          <StatusBadge status={status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <Badge variant="outline" className="font-mono text-[10px]">
            {server.blueprintKey}
          </Badge>
          {address && (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs">
              <Globe className="size-3.5" />
              {address}
            </span>
          )}
        </div>
      </div>
      <PowerControls />
    </div>
  );
}
