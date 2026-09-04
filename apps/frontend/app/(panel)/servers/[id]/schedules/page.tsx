import { SchedulesTab } from "@/components/server/schedules-tab";

export const metadata = { title: "Schedules" };

export default async function SchedulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SchedulesTab serverId={id} />;
}
