"use client";

import * as React from "react";
import { Check, Copy, Mail, MailX, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { adminCreateUser, type AdminInvitedUser, ApiError } from "@/lib/api";

/**
 * Create an account for someone else.
 *
 * The password field is optional on purpose: an admin inviting a customer
 * rarely has a secure way to invent one, so leaving it blank has the panel
 * generate a strong password and show it back exactly once. A supplied password
 * is never echoed (the admin typed it), so the confirmation panel only appears
 * with something to reveal when the panel generated it.
 *
 * The panel does not claim the person was told. Whether the invitation email
 * actually went out comes back from the request, and the confirmation says which
 * happened, because "mail is off, pass this on yourself" and "they have been
 * emailed" lead the admin to do different things next.
 */
export function AddUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<AdminInvitedUser | null>(null);
  const [copied, setCopied] = React.useState(false);

  const reset = () => {
    setName("");
    setEmail("");
    setPassword("");
    setError(null);
    setCreated(null);
    setCopied(false);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await adminCreateUser({
        name: name.trim(),
        email: email.trim(),
        password: password.trim(),
      });
      // Nothing to reveal (the admin chose the password) and the invite was
      // emailed: there is no second screen worth making them dismiss.
      if (result.password === null && result.emailSent) {
        close();
        return;
      }
      setCreated(result);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to create the account.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!created?.password) return;
    try {
      await navigator.clipboard.writeText(created.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the admin can still select the text manually.
    }
  };

  const canSubmit =
    name.trim().length > 0 &&
    email.trim().includes("@") &&
    // Blank is valid (generate one); anything typed has to clear the floor.
    (password.length === 0 || password.length >= 12);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-5" />
            {created ? `Account created for ${created.name}` : "Add a user"}
          </DialogTitle>
          <DialogDescription>
            {created
              ? "Pass the sign-in details on to them."
              : "Creates the account directly, even when registration is closed. Leave the password blank to have one generated."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="flex flex-col gap-3">
            {created.password && (
              <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="flex items-start gap-2 text-sm">
                  <UserPlus className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <span className="text-muted-foreground">
                    Copy this password now. It is stored hashed and cannot be
                    shown again. They can change it from their account settings.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                    {created.password}
                  </code>
                  <Button type="button" size="icon" variant="outline" onClick={copy}>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              {created.emailSent ? (
                <>
                  <Mail className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <span className="text-foreground">{created.email}</span> has
                    been emailed that an account was created for them. The email
                    does not contain the password.
                  </span>
                </>
              ) : (
                <>
                  <MailX className="mt-0.5 size-4 shrink-0" />
                  <span>
                    No invitation email was sent, because outbound email is not
                    configured (or the provider rejected it). Send{" "}
                    <span className="text-foreground">{created.email}</span>{" "}
                    their sign-in details yourself.
                  </span>
                </>
              )}
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="add-user-name">Name</FieldLabel>
                <Input
                  id="add-user-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={128}
                  placeholder="e.g. Ada Lovelace"
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="add-user-email">Email</FieldLabel>
                <Input
                  id="add-user-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={255}
                  placeholder="e.g. ada@example.com"
                  autoComplete="off"
                />
                <FieldDescription>
                  They sign in with this address. It counts as verified, since
                  you vouched for it by creating the account.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="add-user-password">
                  Password (optional)
                </FieldLabel>
                <Input
                  id="add-user-password"
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={512}
                  placeholder="Leave blank to generate one"
                  autoComplete="off"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit && !submitting) submit();
                  }}
                />
                <FieldDescription>
                  {password.length > 0 && password.length < 12
                    ? "At least 12 characters."
                    : "Minimum 12 characters. Blank generates a strong one and shows it once."}
                </FieldDescription>
              </Field>
            </FieldGroup>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={submitting || !canSubmit}>
                {submitting && <Spinner />}
                Create account
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
