"use client";

import * as React from "react";
import { Archive, ArchiveRestore, Clock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { useServerData } from "@/components/server/server-data-context";
import {
  ApiError,
  archiveServer,
  getServerArchive,
  toServerView,
  unarchiveServer,
  type ServerArchiveState,
} from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { viewerIsOwner } from "@/lib/permissions";
import { isArchiveTransfer, isProvisioning } from "@/lib/server-status";

/**
 * What archiving moves, and what it leaves exactly where it is.
 *
 * Written as two lists for the same reason the reinstall card does it: the two
 * halves are the whole decision. The difference is that here the first list is
 * *reversible*, and the card has to make that unmistakable, because the word
 * "archive" sits close enough to "delete" that an owner will assume the worst
 * and never press it.
 */
const MOVED = [
  "Worlds and save data",
  "Configuration files, plugins and mods",
  "Everything uploaded over SFTP or the file manager",
];

const KEPT = [
  "The server's name, address and published ports",
  "Environment variables, subusers and SFTP credentials",
  "Provisioned databases and their contents, untouched on the node",
];

/**
 * Archive the server, or bring it back.
 *
 * Sits directly above the reinstall card at the bottom of Settings, which is
 * where an owner goes looking for "I am not using this right now". The pairing
 * is deliberate: the two destructive-looking actions on the page are next to
 * each other, and the one that keeps the files is first.
 *
 * Owner-or-admin only, matching the endpoint. A subuser with `settings` can
 * retune the game but cannot take it off its node.
 *
 * It polls only while a transfer is in flight. The archive's progress is the
 * backup run's, and the backups tab is where the log lives, so this card reports
 * the phase and sends the reader there rather than growing a second log viewer.
 */
export function ArchiveServerCard() {
  const { server, status, setStatus, refresh } = useServerData();
  const [state, setState] = React.useState<ServerArchiveState | null>(null);
  const [dialog, setDialog] = React.useState<"archive" | "restore" | null>(null);

  const transferring = isArchiveTransfer(status);
  // Read before the effect rather than after it: the endpoint is owner-only, so
  // a subuser's fetch would be a 403 on every mount of a card that renders
  // nothing for them. Hooks cannot be skipped, but the request can.
  const isOwner = viewerIsOwner(server.viewer);

  // One read on mount, then a poll for as long as a transfer is running. The
  // server record's own poll is what moves `status`; this only refreshes the
  // policy line and the run's phase.
  React.useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const next = await getServerArchive(server.id);
        if (!cancelled) setState(next);
      } catch {
        // A failed read leaves the previous state on screen. The card is
        // secondary to the status, which the shell already shows.
      }
    };

    if (isOwner) void read();
    if (!isOwner || !transferring) {
      return () => {
        cancelled = true;
      };
    }

    const timer = setInterval(read, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [server.id, transferring, status, isOwner]);

  if (!isOwner) return null;

  const archived = status === "archived";

  // Every reason the button cannot be offered, stated rather than hidden: a
  // missing button reads as a bug, a disabled one with a reason reads as an
  // answer. Same rule as the reinstall card.
  const blocked = archived
    ? null
    : status === "suspended"
      ? "This server is suspended. An administrator has to lift the suspension before it can be archived."
      : isProvisioning(status)
        ? "This server is still being built. It can be archived once that finishes."
        : status === "deleting"
          ? "This server is being deleted."
          : status === "migrating"
            ? "This server is being moved to another node."
            : state && !state.policy.configured
              ? "Archiving stores the server's files in S3, and no backup destination is configured. Ask an administrator to set one up under Admin → Backups."
              : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {archived ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
            {archived ? "Restore from archive" : "Archive server"}
          </CardTitle>
          <CardDescription>
            {archived
              ? "This server's files are stored in S3 and its node holds nothing. " +
                "Restoring copies them back and rebuilds the container, on the same " +
                "node and the same ports it had."
              : "Uploads every file on the server to S3, then frees its disk on the " +
                "node. The server keeps its address and everything the panel knows " +
                "about it, and you can bring it back whenever you want."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {archived ? (
            <ArchivedSummary state={state} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <FileList title="Moved to S3" items={MOVED} />
              <FileList title="Stays as it is" items={KEPT} />
            </div>
          )}

          {state?.error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="text-muted-foreground">{state.error}</span>
            </div>
          )}

          {!archived && state?.policy.autoEnabled && (
            <AutoArchiveNotice state={state} />
          )}

          {transferring ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              {status === "archiving"
                ? "Uploading this server's files to S3. Its container and files are " +
                  "removed from the node once the upload is complete."
                : "Copying this server's files back from S3. Its container is rebuilt " +
                  "once they land."}
              {state?.run?.phase ? ` (${state.run.phase.replace(/_/g, " ")})` : ""}
            </p>
          ) : blocked ? (
            <p className="text-sm text-muted-foreground">{blocked}</p>
          ) : (
            <div>
              <Button
                variant={archived ? "default" : "outline"}
                onClick={() => setDialog(archived ? "restore" : "archive")}
              >
                {archived ? "Restore from archive…" : "Archive server…"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Remounted per open so a cancelled confirmation leaves nothing behind. */}
      {dialog && (
        <ConfirmDialog
          mode={dialog}
          serverName={server.name}
          onClose={() => setDialog(null)}
          onDone={(nextStatus) => {
            setStatus(nextStatus);
            setDialog(null);
            void refresh().catch(() => undefined);
          }}
          serverId={server.id}
        />
      )}
    </>
  );
}

/** One half of the moved/kept comparison. */
function FileList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="text-sm text-muted-foreground">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** When and why this server was archived, for the restore side of the card. */
function ArchivedSummary({ state }: { state: ServerArchiveState | null }) {
  if (!state?.archive) return null;
  const when = formatRelative(state.archive.archivedAt);

  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
      <span className="text-sm font-medium">
        Archived {when}
        {state.archive.trigger === "idle" ? " automatically" : ""}
      </span>
      <span className="text-xs text-muted-foreground">
        {state.archive.trigger === "idle"
          ? `This server had been stopped for ${state.policy.idleDays} days, so the ` +
            `panel archived it to free space on its node. Nothing was lost.`
          : "Its files are stored in S3 and can be restored at any time."}
      </span>
    </div>
  );
}

/**
 * What the auto-archive policy will do to this server, and when.
 *
 * The date is computed here from `idleSince` + `idleDays` rather than being sent
 * ready-made, so the countdown is only ever shown when the clock is actually
 * running: `idleSince` is null unless the server is stopped.
 */
function AutoArchiveNotice({ state }: { state: ServerArchiveState }) {
  const { idleDays, idleSince } = state.policy;

  const dueIn = idleSince
    ? countdown(new Date(idleSince).getTime() + idleDays * 86_400_000)
    : null;

  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">
        {dueIn ? (
          <>
            This server is archived automatically once it has been stopped for{" "}
            {idleDays} days, which is {dueIn}. Start it to reset the countdown.
          </>
        ) : (
          <>
            Servers left stopped for {idleDays} days are archived automatically to
            free space on their node. Nothing is lost; they can be restored at any
            time.
          </>
        )}
      </span>
    </div>
  );
}

/**
 * "in 9 days" for a moment in the future.
 *
 * Its own helper rather than `formatRelative`, which only counts backwards: a
 * future timestamp there comes out as "just now", which is the single most
 * alarming thing this sentence could say. Rounded up, so a server with six hours
 * left reads as a day rather than as zero.
 */
function countdown(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return "at the next check";
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 1) return "within the hour";
  if (hours < 24) return `in ${hours} hours`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? "in a day" : `in ${days} days`;
}

/**
 * The confirmation.
 *
 * One step, not the reinstall's two, and no typed server name. The gate should
 * be proportionate to what is at risk, and nothing here is destroyed: an archive
 * that was a mistake is undone by pressing the other button. What the checkbox
 * confirms is therefore the thing that *is* irreversible in the short term, which
 * is the server going offline.
 */
function ConfirmDialog({
  mode,
  serverId,
  serverName,
  onClose,
  onDone,
}: {
  mode: "archive" | "restore";
  serverId: string;
  serverName: string;
  onClose: () => void;
  onDone: (status: ReturnType<typeof toServerView>["status"]) => void;
}) {
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const archiving = mode === "archive";
  const canSubmit = (acknowledged || !archiving) && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const summary = archiving
        ? await archiveServer(serverId)
        : await unarchiveServer(serverId);
      // Flip from the response rather than waiting for the next poll: the
      // shell's transfer screen is the confirmation that it started, so it
      // should be up the moment the dialog closes.
      onDone(toServerView(summary).status);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : archiving
            ? "Could not start the archive."
            : "Could not start the restore.",
      );
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {archiving
              ? `Archive “${serverName}”?`
              : `Restore “${serverName}” from its archive?`}
          </DialogTitle>
          <DialogDescription>
            {archiving
              ? "Its files are uploaded to S3 and then removed from its node."
              : "Its files are copied back onto its node and its container is rebuilt."}
          </DialogDescription>
        </DialogHeader>

        {archiving ? (
          <>
            <p className="text-sm text-muted-foreground">
              The server is stopped first, and stays offline until you restore it.
              Players cannot connect while it is archived. Nothing is deleted: it
              keeps its address, its ports, its settings and its databases, and
              restoring puts the files back exactly where they were.
            </p>
            <p className="text-sm text-muted-foreground">
              How long this takes depends on how much data the server has. You can
              leave the page; the archive carries on without you.
            </p>

            <Field orientation="horizontal">
              <Checkbox
                id="archive-acknowledge"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <FieldLabel htmlFor="archive-acknowledge" className="font-normal">
                I understand the server goes offline until I restore it.
              </FieldLabel>
            </Field>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            The server comes back stopped, so you can check it over before players
            reconnect. This takes as long as it takes to download the files.
          </p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button disabled={!canSubmit} onClick={submit}>
            {submitting && <Spinner />}
            {archiving ? "Archive server" : "Restore server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
