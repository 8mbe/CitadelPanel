import Link from "next/link";
import { Server } from "lucide-react";

import { ServerDataProvider } from "@/components/server/server-data-context";
import { ServerShell } from "@/components/server/server-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { resolveServerView } from "@/lib/server/server-view";

/**
 * Server detail shell.
 *
 * A server component (like the panel layout above it) so the record this page
 * is about is resolved during rendering and handed to
 * {@link ServerDataProvider} before the first byte: every section route can
 * start fetching its own data on mount instead of waiting for a client-side
 * `GET /api/servers/:id` to come back first. That fetch used to gate the whole
 * page, roughly one round trip of avoidable serial wait on every load.
 *
 * The live parts stay client-side: {@link ServerShell} reads the provider's
 * status poll (suspension and installing lockouts move while the page is open)
 * and the URL (the section guard), both of which only the client knows. A
 * missing or inaccessible server renders the not-found state rather than
 * throwing. The backend returns the same answer for "does not exist" and "no
 * access", by design.
 */
export default async function ServerLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const server = await resolveServerView(id);

  if (!server) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Empty className="max-w-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Server />
            </EmptyMedia>
            <EmptyTitle>Server not found</EmptyTitle>
            <EmptyDescription>
              The server you&apos;re looking for doesn&apos;t exist, was deleted,
              or you don&apos;t have access to it.
            </EmptyDescription>
          </EmptyHeader>
          <Button render={<Link href="/" />} nativeButton={false}>
            Back to dashboard
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <ServerDataProvider initial={server}>
      <ServerShell>{children}</ServerShell>
    </ServerDataProvider>
  );
}
