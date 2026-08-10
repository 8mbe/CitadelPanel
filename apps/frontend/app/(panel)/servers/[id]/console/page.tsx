"use client";

import { ConsolePanel } from "@/components/server/console-panel";
import { ResourceStats } from "@/components/server/resource-stats";
import { useServerData } from "@/components/server/server-data-context";

/**
 * The console section: live resource stats (CPU, memory, disk, players) on
 * top, the interactive console below. Power actions live in the section
 * header above. Data comes from the shared server context the layout provides.
 */
export default function ConsolePage() {
  const { server } = useServerData();

  return (
    <div className="flex flex-col gap-4">
      <ResourceStats server={server} />
      <ConsolePanel serverId={server.id} status={server.status} />
    </div>
  );
}
