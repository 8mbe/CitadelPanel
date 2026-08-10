"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Server } from "lucide-react";

import { ServerHeader } from "@/components/server/server-header";
import { ServerDataProvider } from "@/components/server/server-data-context";
import { ServerTabs } from "@/components/server/server-tabs";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { getServer } from "@/lib/api";
import type { ServerView } from "@/lib/types";

/**
 * Server detail shell.
 *
 * Loads the one server this page is about and shares it with every section via
 * {@link ServerDataProvider}. A client component (not a server component) so the
 * fetch carries the session cookie and the live status/stats can update in
 * place. A missing or inaccessible server renders the not-found state rather
 * than throwing — the backend returns the same 404 for "does not exist" and "no
 * access", by design.
 */
export default function ServerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [server, setServer] = React.useState<ServerView | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "missing">(
    "loading",
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getServer(id);
        if (cancelled) return;
        if (!result) {
          setState("missing");
          return;
        }
        setServer(result);
        setState("ready");
      } catch {
        if (!cancelled) setState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state === "loading") {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-full max-w-lg" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state === "missing" || !server) {
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
      <div className="flex flex-col gap-6">
        <ServerHeader server={server} />
        <ServerTabs serverId={server.id} />
        {children}
      </div>
    </ServerDataProvider>
  );
}
