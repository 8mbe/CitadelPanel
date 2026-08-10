"use client";

import { Users } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useServerStatus } from "@/components/server/server-data-context";

/**
 * Connected players.
 *
 * A live player roster needs a per-game query protocol the node agent does not
 * expose yet, so this shows the running/offline state honestly rather than
 * inventing a list. Once the agent surfaces player queries, this becomes a real
 * table fed from that endpoint.
 */
export function PlayersTab() {
  const [status] = useServerStatus();
  const running = status === "running";

  return (
    <Empty className="min-h-[18rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Users />
        </EmptyMedia>
        <EmptyTitle>
          {running ? "Player list coming soon" : "Server is offline"}
        </EmptyTitle>
        <EmptyDescription>
          {running
            ? "This server is running. Live player rosters are not available yet — they arrive once the node agent supports in-game queries."
            : "Start the server to see who connects. Live player rosters are not available yet."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
