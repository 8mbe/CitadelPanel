"use client";

import { ConsolePanel } from "@/components/server/console-panel";
import { InstallLogPanel } from "@/components/server/install-log-panel";
import { ResourceStats } from "@/components/server/resource-stats";
import { StartFailureAlert } from "@/components/server/start-failure-alert";
import { useServerData } from "@/components/server/server-data-context";
import { isProvisioning } from "@/lib/server-status";

/**
 * The console section: live resource stats (CPU, memory, disk, players) on
 * top, the interactive console below. Power actions live in the section
 * header above. Data comes from the shared server context the layout provides.
 *
 * A start that did not hold puts an explanation above all of it: the reason the
 * last start failed, and the container output captured at the time. It sits
 * here because this is where someone goes when a server "won't start", and the
 * console below it can only show what the *current* container is saying.
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
      {server.startFailure && !isProvisioning(status) && (
        <StartFailureAlert serverId={server.id} failure={server.startFailure} />
      )}
      {isProvisioning(status) ? (
        <InstallLogPanel serverId={server.id} />
      ) : (
        <ConsolePanel serverId={server.id} status={server.status} />
      )}
    </div>
  );
}
