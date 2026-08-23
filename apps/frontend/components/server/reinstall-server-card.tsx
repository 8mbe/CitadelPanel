"use client";

import * as React from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useServerData } from "@/components/server/server-data-context";
import { ApiError, reinstallServer, toServerView } from "@/lib/api";
import { viewerIsOwner } from "@/lib/permissions";
import { isProvisioning } from "@/lib/server-status";

/**
 * What a reinstall destroys and what it keeps, in the owner's terms.
 *
 * Written out rather than summarised as "resets the server" because the two
 * halves are the whole decision: everything the owner *made* is in the first
 * list, and the second holds everything that would make them hesitate for the
 * wrong reason, such as losing their address, their database, or the people
 * they share the server with. Both lists are shown before the confirmation,
 * not after it.
 */
const DELETED = [
  "Worlds and save data",
  "Configuration files, including anything edited in the file manager",
  "Installed plugins and mods, and their config folders",
  "Server logs and console history",
  "Every other file uploaded over SFTP or the file manager",
];

const KEPT = [
  "The server's name, address and published ports",
  "Environment variables set in the Environment tab",
  "Provisioned databases and their contents",
  "Subusers, SFTP credentials, and connected servers",
];

/**
 * Reinstall the server from its blueprint: the destructive action on the
 * settings page.
 *
 * Owner-or-admin only, matching the endpoint. A subuser with `settings` can
 * change env vars but cannot erase the server. Two confirmations stand between
 * the button and the request, and they are deliberately different in kind: the
 * first is a page of consequences to read, the second asks for the server's name
 * typed by hand. A single "are you sure?" is a reflex; naming the server is not
 * something a mis-click reaches, and it is also what the API requires, so the
 * confirmation is the real gate rather than a decoration in front of one.
 */
export function ReinstallServerCard() {
  const { server, status } = useServerData();
  const [open, setOpen] = React.useState(false);

  if (!viewerIsOwner(server.viewer)) return null;

  // A suspended server must stay untouched, and one that is already being built
  // has nothing to reinstall yet. Both are stated rather than hidden: a missing
  // button reads as a bug, a disabled one with a reason reads as an answer.
  const blocked =
    status === "suspended"
      ? "This server is suspended. An administrator has to lift the suspension before it can be reinstalled."
      : isProvisioning(status)
        ? "This server is still being built. It can be reinstalled once that finishes."
        : status === "deleting"
          ? "This server is being deleted."
          : null;

  return (
    <>
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <RotateCcw className="size-4" />
            Reinstall server
          </CardTitle>
          <CardDescription>
            Deletes every file on the server and installs it again from scratch,
            exactly as it was first created. There is no backup and no undo.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FileList
              title="Deleted permanently"
              items={DELETED}
              tone="destructive"
            />
            <FileList title="Kept" items={KEPT} tone="muted" />
          </div>

          {blocked ? (
            <p className="text-sm text-muted-foreground">{blocked}</p>
          ) : (
            <div>
              <Button variant="destructive" onClick={() => setOpen(true)}>
                Reinstall server…
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Remounted on each open so a cancelled confirmation never leaves a
          ticked checkbox or a typed name behind for the next attempt. */}
      {open && <ReinstallDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** One half of the deleted/kept comparison. */
function FileList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "destructive" | "muted";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={
          tone === "destructive"
            ? "text-xs font-medium text-destructive"
            : "text-xs font-medium text-muted-foreground"
        }
      >
        {title}
      </p>
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

/**
 * The two-step confirmation.
 *
 * Step one restates the consequence in one sentence and offers a way out; step
 * two asks for the checkbox *and* the server's name. Nothing is sent until both
 * are satisfied, and the backend refuses the request on its own if the name is
 * wrong, so a client that skipped this dialog gains nothing.
 */
function ReinstallDialog({ onClose }: { onClose: () => void }) {
  const { server, setStatus, refresh } = useServerData();
  const [step, setStep] = React.useState<"explain" | "confirm">("explain");
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [typedName, setTypedName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const nameMatches = typedName.trim() === server.name;
  const canSubmit = acknowledged && nameMatches && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const summary = await reinstallServer(server.id, typedName.trim());
      // Flip to `installing` from the response rather than waiting for the next
      // poll: the shell's installing gate is the confirmation that the reinstall
      // started, so it should be on screen the moment the dialog closes.
      setStatus(toServerView(summary).status);
      onClose();
      // The record itself changed too (its container is gone); the shell's
      // provisioning poll takes over from here.
      void refresh().catch(() => undefined);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not start the reinstall.",
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
        {step === "explain" ? (
          <>
            <DialogHeader>
              <DialogTitle>Reinstall &ldquo;{server.name}&rdquo;?</DialogTitle>
              <DialogDescription>
                This deletes every file on the server and installs it again from
                its blueprint.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <span className="text-muted-foreground">
                Your worlds, configuration, plugins and uploads are deleted from
                the node. The panel keeps no copy of them, and nothing here can
                bring them back. If you want any of it, close this and download
                it from the file manager first.
              </span>
            </div>

            <p className="text-sm text-muted-foreground">
              The server will be stopped, wiped, and rebuilt. That takes a few
              minutes, and it comes back stopped. You start it when you are
              ready for players on it.
            </p>

            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button variant="destructive" onClick={() => setStep("confirm")}>
                I understand, continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Confirm the reinstall</DialogTitle>
              <DialogDescription>
                Two things to confirm, so this cannot happen by accident.
              </DialogDescription>
            </DialogHeader>

            <Field orientation="horizontal">
              <Checkbox
                id="reinstall-acknowledge"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <FieldLabel
                htmlFor="reinstall-acknowledge"
                className="font-normal"
              >
                I understand every file on this server will be permanently
                deleted.
              </FieldLabel>
            </Field>

            <Field>
              <FieldLabel htmlFor="reinstall-name">
                Type{" "}
                <span className="font-mono font-medium text-foreground">
                  {server.name}
                </span>{" "}
                to confirm
              </FieldLabel>
              <Input
                id="reinstall-name"
                value={typedName}
                autoComplete="off"
                placeholder={server.name}
                onChange={(e) => setTypedName(e.target.value)}
              />
            </Field>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => setStep("explain")}
              >
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={!canSubmit}
                onClick={submit}
              >
                {submitting && <Spinner />}
                Delete all files and reinstall
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
