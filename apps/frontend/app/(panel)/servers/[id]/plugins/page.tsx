"use client";

import { PluginsTab } from "@/components/server/plugins-tab";
import { useServerData } from "@/components/server/server-data-context";

/**
 * The plugins/mods section: catalog search, installs, enable/disable and the
 * pre-start auto-update setting, shown only when the server's blueprint
 * declares plugin support (the tab list and the layout guard enforce that).
 * Data comes from the shared server context the layout provides.
 */
export default function PluginsPage() {
  const { server } = useServerData();

  return <PluginsTab serverId={server.id} />;
}
