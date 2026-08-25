"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { adminDeleteUser, ApiError, type ApiUser } from "@/lib/api";

/**
 * Confirm deleting an account for good.
 *
 * The dialog does not re-implement the route's gates (banned, owns nothing,
 * not the last admin, no leftover server connections). It states what deletion
 * takes with it and renders whatever the route refuses with, so the reason the
 * admin sees is the reason the server actually applied rather than a second
 * copy of the rule that could drift from it.
 */
export function DeleteUserDialog({
  user,
  open,
  onOpenChange,
  onDeleted,
}: {
  user: ApiUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void | Promise<void>;
}) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await adminDeleteUser(user.id);
      onOpenChange(false);
      await onDeleted();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to delete the account.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-5 text-destructive" />
            Delete {user.name}
          </DialogTitle>
          <DialogDescription>
            Permanently deletes this account. It cannot be undone, and the
            person can register again only if registration is open.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 p-3 text-sm">
          <span className="font-medium">{user.name}</span>
          <span className="text-muted-foreground">{user.email}</span>
        </div>

        <p className="text-sm text-muted-foreground">
          Their sessions, sign-in credentials, API keys, SFTP credentials and
          access to other people&apos;s servers go with the account. What they
          did stays in the audit log, without their name on it.
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner />}
            Delete account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
