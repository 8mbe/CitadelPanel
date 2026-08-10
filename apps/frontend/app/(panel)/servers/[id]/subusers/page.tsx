import { SubusersTab } from "@/components/server/subusers-tab";

export const metadata = { title: "Subusers" };

export default async function SubusersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SubusersTab serverId={id} />;
}
