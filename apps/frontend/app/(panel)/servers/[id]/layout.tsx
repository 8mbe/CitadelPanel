"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Lock, OctagonPause, Server } from "lucide-react";

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

  // A suspended server is locked down for its owner: they see *why* it was
  // suspended and cannot reach the console, files, ports, or any other section.
  // admin lifts the suspension. An admin bypasses the lock to inspect the
  // reason as a banner so the suspended state is unmistakable.
  if (server.status === "suspended" && !isAdmin) {
    return <SuspendedNotice server={server} />;
  }

  return (
    <ServerDataProvider initial={server}>
      <div className="flex flex-col gap-6">
        {server.status === "suspended" && <SuspendedBanner server={server} />}
        <ServerHeader server={server} />
        <ServerTabs serverId={server.id} />
        {children}
      </div>
    </ServerDataProvider>
  );
}
 * Full-page suspension notice. Replaces the entire server shell — no header,
  const when = server.suspendedAt ? formatRelative(server.suspendedAt) : null;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-16">
      <Alert>
        <OctagonPause />
        <AlertTitle>This server is suspended</AlertTitle>
        <AlertDescription>
            &ldquo;{server.name}&rdquo; has been suspended by an administrator and
            cannot be used until it is reinstated.
          </span>
        </AlertDescription>
      </Alert>

      {server.suspensionReason && (
        <div className="rounded-lg border bg-muted/40 p-4">
          <p className="text-xs font-medium text-muted-foreground">Reason</p>
          <p className="mt-1 whitespace-pre-line text-sm">
            {server.suspensionReason}
          </p>
        </div>
      )}

      {when && (
        <p className="text-xs text-muted-foreground">
          Suspended {when}. If you believe this is a mistake, contact your
          panel administrator.
        </p>
      )}

      <Button render={<Link href="/" />} nativeButton={false} className="w-fit">
        Back to dashboard
      </Button>
    </div>
  );
}

/**
 * Compact suspension banner shown to admins who bypass the owner lockout. It
 * surfaces the reason inline so the admin has context while inspecting a
 * suspended server, without blocking the shell.
 */
function SuspendedBanner({ server }: { server: ServerView }) {
  const when = server.suspendedAt ? formatRelative(server.suspendedAt) : null;
  return (
    <Alert>
      <OctagonPause />
      <AlertTitle>This server is suspended</AlertTitle>
      <AlertDescription>
          server until it is unsuspended.
        </span>
        {server.suspensionReason && (
            Reason: {server.suspensionReason}
            {when ? ` · Suspended ${when}` : ""}
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
