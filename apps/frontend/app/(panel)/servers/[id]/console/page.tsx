"use client";

import { ConsolePanel } from "@/components/server/console-panel";
import { InstallLogPanel } from "@/components/server/install-log-panel";
import { ResourceStats } from "@/components/server/resource-stats";
import { useServerData } from "@/components/server/server-data-context";
import { isProvisioning } from "@/lib/server-status";

/**
 * The console section: live resource stats (CPU, memory, disk, players) on
 * top, the interactive console below. Power actions live in the section
 * header above. Data comes from the shared server context the layout provides.
 *
 * While a server is still being provisioned there is no container to attach to,
 * so the console is replaced by the install log, the output that actually
 * exists at that point. Only admins get here in that state (the shell locks the
 * section for everyone else), which matches the install-log endpoint's own gate.
 */
export default function ConsolePage() {
  const { server, status } = useServerData();

  return (
    <div className="flex flex-col gap-4">
      <ResourceStats server={server} />
      {isProvisioning(status) ? (
        <InstallLogPanel serverId={server.id} />
      ) : (
        <ConsolePanel serverId={server.id} status={server.status} />
      )}
    </div>
  );
}
