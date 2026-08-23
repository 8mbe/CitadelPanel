import { BackupsTab } from "@/components/server/backups-tab";

export const metadata = { title: "Backups" };

export default async function BackupsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BackupsTab serverId={id} />;
}
