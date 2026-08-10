import { redirect } from "next/navigation";

/**
 * The console is the default section, so the server root forwards to it.
 * Both `/servers/[id]` and `/servers/[id]/console` reach the console.
 */
export default async function ServerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/servers/${id}/console`);
}
