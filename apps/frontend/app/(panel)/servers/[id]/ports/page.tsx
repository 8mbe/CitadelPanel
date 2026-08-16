import { PortsTab } from "@/components/server/ports-tab";

export const metadata = { title: "Ports" };

export default async function PortsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PortsTab serverId={id} />;
}
