"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
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

/**
 * Confirming the one irreversible action in the node-database feature: deleting
 * the data volume and starting a new database.
 *
 * It has to exist because MariaDB keeps its accounts *in the volume*. When a
 * database refuses the panel's credential, recreating the container changes
 * nothing (verified: `MARIADB_ROOT_PASSWORD` is only applied to an empty data
 * directory), so the only ways out are the credential that database already
 * knows, or this. That makes "delete the volume" a normal part of the recovery
 * path rather than an exotic admin operation, which is exactly why it needs a
 * gate rather than a button.
 *
 * Two steps, deliberately different in kind, matching the reinstall dialog: a
 * page of consequences to read, then a checkbox plus the name typed by hand. A
 * single "are you sure?" is a reflex; typing the name is a decision. The API
 * re-checks the typed value, so this is the real gate and not a decoration in
 * front of one.
 */
export function NodeDatabaseResetDialog({
  /** What the operator must type: the node's name, or the container's. */
  confirmPhrase,
  /** Databases that will be destroyed, when the panel knows the count. */
  databaseCount,
  /** One line naming what is being reset, e.g. the node or the machine. */
  subject,
  onConfirm,
  onClose,
}: {
  confirmPhrase: string;
  databaseCount: number | null;
  subject: string;
  onConfirm: (typed: string) => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = React.useState<"explain" | "confirm">("explain");
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSubmit = acknowledged && typed.trim() === confirmPhrase && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(typed.trim());
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The database could not be reset.",
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
              <DialogTitle>Delete this database and start over?</DialogTitle>
              <DialogDescription>{subject}</DialogDescription>
            </DialogHeader>

            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="text-muted-foreground">
                The container <em>and its data volume</em> are deleted.
                {databaseCount === null
                  ? " Every database inside it goes with it, whatever is in there."
                  : databaseCount === 0
                    ? " No server databases exist on it yet, so nothing is lost."
                    : ` ${databaseCount} server database${databaseCount === 1 ? "" : "s"} on this node ${databaseCount === 1 ? "is" : "are"} destroyed.`}{" "}
                The panel keeps no copy, and nothing here can bring it back. If
                you need any of it, close this and back it up first.
              </span>
            </div>

            <p className="text-sm text-muted-foreground">
              A new, empty database is created in its place, with a fresh account
              the panel generates and stores. Servers can then be given databases
              on it again, but they start empty.
            </p>

            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={() => setStep("confirm")}>
                I understand, continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Confirm the reset</DialogTitle>
              <DialogDescription>
                Two things to confirm, so this cannot happen by accident.
              </DialogDescription>
            </DialogHeader>

            <Field orientation="horizontal">
              <Checkbox
                id="node-db-reset-acknowledge"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <FieldLabel htmlFor="node-db-reset-acknowledge" className="font-normal">
                I understand the data volume and every database in it will be
                permanently deleted.
              </FieldLabel>
            </Field>

            <Field>
              <FieldLabel htmlFor="node-db-reset-phrase">
                Type{" "}
                <span className="font-mono font-medium text-foreground">
                  {confirmPhrase}
                </span>{" "}
                to confirm
              </FieldLabel>
              <Input
                id="node-db-reset-phrase"
                value={typed}
                autoComplete="off"
                placeholder={confirmPhrase}
                onChange={(e) => setTyped(e.target.value)}
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
              <Button variant="destructive" disabled={!canSubmit} onClick={submit}>
                {submitting && <Spinner />}
                Delete and create a new database
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
