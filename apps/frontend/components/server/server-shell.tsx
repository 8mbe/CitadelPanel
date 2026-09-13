"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, Loader2, Lock, OctagonPause, Truck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ArchiveServerCard } from "@/components/server/archive-server-card";
import { ServerHeader } from "@/components/server/server-header";
import { useServerData } from "@/components/server/server-data-context";
import {
  sectionFromPathname,
  ServerTabs,
} from "@/components/server/server-tabs";
import { formatRelative } from "@/lib/format";
import { sectionAllowed } from "@/lib/permissions";
import { isArchiveStatus, isProvisioning } from "@/lib/server-status";
import type { ServerView } from "@/lib/types";

/**
 * The server page's shell: header, tabs, section guard, and the full-page
 * lockouts (suspended, installing, migrating, archived).
 *
 * A client component because everything it gates on moves while the page is
 * open. The data provider's status poll is what notices a suspension lift or
 * an install finish. The section guard also needs the URL, which only the
 * client knows. The server record it reads arrived resolved during
 * rendering (see `resolveServerView`); nothing here fetches.
 */
export function ServerShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { server, status } = useServerData();
  const isAdmin = server.viewer?.kind === "admin";

  // Subusers see only the sections their grants cover. The tabs hide the rest,
  // but each section has its own URL, and this guard is what stops a subuser
  // from opening one directly. The backend rejects the section's API calls
  // anyway; the guard exists so the denial is explicit instead of a page of
  // 403s.
  const active = sectionFromPathname(pathname);
  const sectionGranted = sectionAllowed(active, server.viewer);

  // A suspended server is locked down for its owner: they see *why* it was
  // suspended and cannot reach the console, files, ports, or any other section.
  // The backend already blocks every mutating action, but hiding the interactive
  // UI entirely is the point. There is nothing the owner can do here until an
  // admin lifts the suspension. An admin bypasses the lock to inspect the
  // server (the backend grants admins access to any server); they still see the
  // reason as a banner so the suspended state is unmistakable.
  if (status === "suspended" && !isAdmin) {
    return <SuspendedNotice server={server} />;
  }

  // Same shape for a server that is still being built, and for the same reason:
  // there is no container yet, so every section is a page of errors waiting to
  // happen. The console has nothing to attach to, files has no game to write
  // for, ports and settings would be edited out from under the provision that
  // is still reading them. The owner gets one honest screen instead. Admins
  // keep the shell, because the install log is in the console and reading it is
  // the whole job when a provision goes wrong.
  if (isProvisioning(status) && !isAdmin) {
    return <InstallingNotice server={server} />;
  }

  // And again for a server being moved to another node. The same reasoning one
  // step further: not only is there nothing to operate, the sections would be
  // operating on the *wrong node*, since the record still names the source
  // until the cutover. Admins keep the shell because an admin is who started
  // the migration and who has to watch it.
  if (status === "migrating" && !isAdmin) {
    return <MigratingNotice server={server} />;
  }

  // And once more for a server whose files are in S3. This one is not a
  // lockout in the same sense as the others: the owner is not being kept out of
  // something, there is genuinely nothing there. No container, no data
  // directory, so the console has nothing to attach to, the file manager has no
  // files to list, and the database explorer would be the one tab that still
  // worked, which is the most confusing outcome of all.
  //
  // Unlike the other three this replaces the shell for admins as well. The
  // exemptions above exist because an admin has a job to do on the page (read
  // the install log, watch the migration); on an archived server there is
  // nothing on the node for anybody to inspect, and the one action that matters
  // is on this screen.
  if (isArchiveStatus(status)) {
    return <ArchivedNotice server={server} status={status} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {status === "suspended" && <SuspendedBanner server={server} />}
      {isProvisioning(status) && <InstallingBanner />}
      {status === "migrating" && <MigratingBanner />}
      <ServerHeader server={server} />
      <ServerTabs serverId={server.id} />
      {sectionGranted ? children : <SectionDenied />}
    </div>
  );
}

/**
 * Shown when the viewer navigates straight to a section URL their grants do
 * not cover. Mirrors the not-found state visually so denials read as a normal
 * outcome, not an error.
 */
function SectionDenied() {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <Empty className="max-w-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lock />
          </EmptyMedia>
          <EmptyTitle>No access to this section</EmptyTitle>
          <EmptyDescription>
            You don&apos;t have permission to use this part of the server. Ask
            the server&apos;s owner to grant it to you if you need it.
          </EmptyDescription>
        </EmptyHeader>
        <Button render={<Link href="/" />} nativeButton={false}>
          Back to dashboard
        </Button>
      </Empty>
    </div>
  );
}

/**
 * Full-page migrating notice, the owner's whole view while their server moves.
 *
 * Says the one thing the owner actually needs and the panel can actually
 * promise: the files are safe, because the original node keeps everything until
 * the move has been verified (see `docs/server-migration.md`). No progress bar,
 * for the same reason the installing notice has none — the panel cannot say how
 * long copying a world across a network will take, and an honest "this is
 * happening" beats a bar that stalls at 60%.
 */
function MigratingNotice({ server }: { server: ServerView }) {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Truck />
          </EmptyMedia>
          <EmptyTitle>Server is being moved…</EmptyTitle>
          <EmptyDescription>
            &ldquo;{server.name}&rdquo; is being migrated to another machine by
            an administrator. It is offline while its files are copied, and it
            will start again on the new machine when the move is done.
          </EmptyDescription>
        </EmptyHeader>
        <p className="text-muted-foreground max-w-sm text-center text-sm">
          Nothing is deleted from the original machine until the new one has
          been checked, so your world is safe either way. This page updates
          itself when the move finishes.
        </p>
      </Empty>
    </div>
  );
}

/** Compact migrating banner for admins, who keep the shell during a move. */
function MigratingBanner() {
  return (
    <Alert>
      <Loader2 className="animate-spin" />
      <AlertTitle>This server is being moved to another node</AlertTitle>
      <AlertDescription>
        Its owner sees a &ldquo;being moved&rdquo; notice until the migration
        finishes, and every action on the server is refused while it runs.
        Follow the migration from the admin servers list.
      </AlertDescription>
    </Alert>
  );
}

/**
 * Full-page installing notice, the owner's whole view of a server being built.
 *
 * Deliberately without a progress bar or a log: neither is honest. The panel
 * cannot say how long an image pull will take, and the install script's output
 * is operator detail (see the install-log route). What the owner needs is that
 * this is normal, that it is happening, and that they do not need to do
 * anything. The page moves on by itself when the server is ready.
 */
function InstallingNotice({ server }: { server: ServerView }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-16">
      <Alert>
        <Loader2 className="animate-spin" />
        <AlertTitle>Server is installing…</AlertTitle>
        <AlertDescription>
          <span className="block">
            &ldquo;{server.name}&rdquo; is being set up on its node. This can take
            a few minutes. The node downloads the game files before the server
            can start.
          </span>
        </AlertDescription>
      </Alert>

      <p className="text-xs text-muted-foreground">
        This page updates on its own when the server is ready. If it is still
        installing much later, contact your panel administrator.
      </p>

      <Button render={<Link href="/" />} nativeButton={false} className="w-fit">
        Back to dashboard
      </Button>
    </div>
  );
}

/**
 * Compact installing banner for admins, who keep the shell while a server is
 * being built. Says which parts of it are not real yet, so an admin reading the
 * install log in the console is not surprised by a files tab that has nothing
 * in it.
 */
function InstallingBanner() {
  return (
    <Alert>
      <Loader2 className="animate-spin" />
      <AlertTitle>This server is still installing</AlertTitle>
      <AlertDescription>
        <span className="block">
          You are viewing this as an administrator. The owner sees an
          &ldquo;installing&rdquo; notice until it finishes. Its container does
          not exist yet, so power actions and the live console are unavailable.
          The console shows the install log instead.
        </span>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Full-page suspension notice. Replaces the entire server shell, leaving no
 * header, tabs, or section content, so the owner cannot interact with the
 * server at all. Shows the reason an admin recorded and, when available, when
 * it happened, then offers a way back to the dashboard.
 */
function SuspendedNotice({ server }: { server: ServerView }) {
  const when = server.suspendedAt ? formatRelative(server.suspendedAt) : null;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-16">
      <Alert>
        <OctagonPause />
        <AlertTitle>This server is suspended</AlertTitle>
        <AlertDescription>
          <span className="block">
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
        <span className="block">
          You are viewing this as an administrator. The owner cannot use this
          server until it is unsuspended.
        </span>
        {server.suspensionReason && (
          <span className="mt-1 block whitespace-pre-line text-xs">
            Reason: {server.suspensionReason}
            {when ? ` · Suspended ${when}` : ""}
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Full-page notice for a server that is archived, or on its way to or from the
 * archive.
 *
 * It renders the archive card itself rather than linking to Settings, because
 * this screen *replaces* Settings along with every other section: a link to the
 * page the restore button lives on would be a link back to this one. So the card
 * is the action here, in its restore mode, and the alert above it is the
 * explanation. The same component owns both directions, which is what keeps the
 * two halves of the feature describing each other consistently, and it is why
 * this screen does not repeat what the card already says about when and why the
 * server was archived.
 */
function ArchivedNotice({
  server,
  status,
}: {
  server: ServerView;
  status: ServerView["status"];
}) {
  const transferring = status === "archiving" || status === "restoring";

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6 py-16">
      <Alert>
        {transferring ? <Loader2 className="animate-spin" /> : <Archive />}
        <AlertTitle>
          {status === "archiving"
            ? "This server is being archived"
            : status === "restoring"
              ? "This server is being restored"
              : "This server is archived"}
        </AlertTitle>
        <AlertDescription>
          <span className="block">
            {status === "archiving" ? (
              <>
                &ldquo;{server.name}&rdquo; is being uploaded to storage. Its
                files are removed from its node once the upload finishes. It
                keeps its address and everything the panel knows about it, and
                you can restore it whenever you want.
              </>
            ) : status === "restoring" ? (
              <>
                &ldquo;{server.name}&rdquo; is being copied back onto its node.
                It will come back stopped, so you can check it over before
                players reconnect.
              </>
            ) : (
              <>
                &ldquo;{server.name}&rdquo; has been archived. Its files are kept
                in storage rather than on its node, so nothing here is running.
                Restoring it puts everything back on the same node, on the same
                ports.
              </>
            )}
          </span>
        </AlertDescription>
      </Alert>

      {/* The restore button, and the progress line while a transfer runs. It
          renders nothing for a subuser, which is correct: archiving is owner or
          admin only, so they get the explanation and no controls. */}
      <ArchiveServerCard />

      <Button
        render={<Link href="/" />}
        nativeButton={false}
        variant="outline"
        className="w-fit"
      >
        Back to dashboard
      </Button>
    </div>
  );
}
