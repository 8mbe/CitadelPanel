import { DatabaseTab } from "@/components/server/database-tab";

export const metadata = { title: "Database" };

export default async function DatabasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DatabaseTab serverId={id} />;
}
