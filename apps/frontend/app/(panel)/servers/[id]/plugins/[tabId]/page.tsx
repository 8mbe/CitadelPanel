"use client";

import { useParams } from "next/navigation";
import { PluginsTab } from "@/components/server/plugins-tab";
import { useServerData } from "@/components/server/server-data-context";

export default function ContentTabPage() {
  const { tabId } = useParams<{ tabId: string }>();
  const { server } = useServerData();
  return <PluginsTab key={tabId} serverId={server.id} tabId={tabId} />;
}
