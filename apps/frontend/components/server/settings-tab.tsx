"use client";

import { Lock } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConnectedServersCard } from "@/components/server/connected-servers-card";
import { useServerData } from "@/components/server/server-data-context";
import {
  ApiError,

/** One read-only allocation row. */
function Allocation({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Per-server settings.
 *
 * The permission model (plan.md section 5) is what shapes this page: a user
 * manages their server but never sizes it. Resource limits are set by an admin
 * at provisioning time and changed only from the admin area, so they render
 * read-only here — there is no owner-facing API to change them, and showing
 * inputs would promise something the backend would refuse.
 */
export function SettingsTab() {
  const { server } = useServerData();
  const { user } = useSession();

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Server identity.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Allocation label="Name" value={server.name} />
          <Allocation label="Game" value={server.blueprintKey} />
          <Allocation
            label="Primary port"
            value={server.primaryPort > 0 ? String(server.primaryPort) : "—"}
        <ConnectedServersCard />
      </TabsContent>
    </Tabs>
  );
}

          />
          <p className="border-t pt-3 text-xs text-muted-foreground">
            Game-specific settings (difficulty, MOTD, and so on) are edited
            through the server&apos;s own config files in the Files section.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Resources
            <Lock className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </CardTitle>
          <CardDescription>
            Allocated by an administrator and enforced by Docker.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Allocation label="CPU" value={`${server.cpuLimit} vCPU`} />
          <Allocation label="Memory" value={formatMb(server.memoryLimitMb)} />
          <Allocation label="Disk" value={formatMb(server.diskLimitMb)} />
          <p className="border-t pt-3 text-xs text-muted-foreground">
            {user.role === "admin"
              ? "Change these from Admin → Servers. The server must be stopped first."
              : "Need more? Contact the panel administrator."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
