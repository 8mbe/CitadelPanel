"use client";

import * as React from "react";
import { ArrowRight, Check, X } from "lucide-react";

import { ApiError, setupCreateAdmin } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { ErrorNote } from "./wizard-ui";

/**
 * Step 1: claim the first admin account.
 *
 * The one unauthenticated step, and the only mandatory one: the endpoint
 * refuses the moment any admin exists, so there is nothing to skip to. Creating
 * the account signs the browser in, which is what lets every later step
 * authenticate normally.
 *
 * Validation is live rather than on submit. This is the first password the
 * operator will ever type into the panel and the only credential that exists;
 * telling them after the fact that it was too short, when the confirm field has
 * already been filled in, is the worst moment to find out.
 */

interface Rule {
  label: string;
  test: (password: string) => boolean;
}

const RULES: Rule[] = [
  { label: "At least 12 characters", test: (p) => p.length >= 12 },
  { label: "A lower-case and an upper-case letter", test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { label: "A number or a symbol", test: (p) => /[^A-Za-z]/.test(p) },
];

export function AdminStep({
  onDone,
}: {
  /** Hands the freshly-created account up: the wizard has no session context. */
  onDone: (admin: { id: string; email: string }) => void;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [touchedConfirm, setTouchedConfirm] = React.useState(false);
  const [touchedEmail, setTouchedEmail] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const rules = RULES.map((rule) => ({ ...rule, ok: rule.test(password) }));
  const passwordValid = rules.every((r) => r.ok);
  const confirmMismatch = touchedConfirm && confirm !== "" && confirm !== password;

  const issues: string[] = [];
  if (name.trim() === "") issues.push("Enter a name.");
  if (!emailValid) issues.push("Enter a valid email address.");
  if (!passwordValid) issues.push("Meet every password requirement.");
  if (confirm !== password || confirm === "") issues.push("Repeat the password.");

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (issues.length > 0) return;
    setLoading(true);
    setError(null);
    try {
      const { user } = await setupCreateAdmin({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      onDone({ id: user.id, email: user.email });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "The account could not be created. Check that the panel can reach its database, then try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <CardHeader>
        <CardTitle>Create the admin account</CardTitle>
        <CardDescription>
          The first account owns the panel: it manages nodes, provisions servers
          and reviews security flags. There is no default password. You set the
          only credential now.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="admin-name">Name</FieldLabel>
              <Input
                id="admin-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                autoComplete="name"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="admin-email">Email</FieldLabel>
              <Input
                id="admin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setTouchedEmail(true)}
                placeholder="you@example.com"
                autoComplete="email"
                aria-invalid={touchedEmail && email !== "" && !emailValid}
                className={cn(
                  touchedEmail &&
                    email !== "" &&
                    !emailValid &&
                    "border-destructive focus-visible:ring-destructive/30",
                )}
              />
              {touchedEmail && email !== "" && !emailValid && (
                <FieldDescription className="text-destructive">
                  That does not look like an email address. You sign in with it,
                  so it has to be one you can read.
                </FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="admin-password">Password</FieldLabel>
              <Input
                id="admin-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 12 characters"
                autoComplete="new-password"
              />
              <ul className="flex flex-col gap-1 pt-1">
                {rules.map((rule) => (
                  <li
                    key={rule.label}
                    className={cn(
                      "flex items-center gap-1.5 text-xs transition-colors",
                      rule.ok
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {rule.ok ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : (
                      <X className="size-3.5 shrink-0" />
                    )}
                    {rule.label}
                  </li>
                ))}
              </ul>
            </Field>
            <Field>
              <FieldLabel htmlFor="admin-confirm">Confirm password</FieldLabel>
              <Input
                id="admin-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onBlur={() => setTouchedConfirm(true)}
                placeholder="Repeat the password"
                autoComplete="new-password"
                aria-invalid={confirmMismatch}
                className={cn(
                  confirmMismatch &&
                    "border-destructive focus-visible:ring-destructive/30",
                )}
              />
              {confirmMismatch && (
                <FieldDescription className="text-destructive">
                  The two passwords do not match.
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>

          {error && (
            <ErrorNote title="Could not create the account">{error}</ErrorNote>
          )}

          <Button
            type="submit"
            disabled={loading || issues.length > 0}
            className="w-full"
          >
            {loading && <Spinner />}
            Create account and continue
            {!loading && <ArrowRight />}
          </Button>
          {issues.length > 0 && (
            <p className="text-center text-xs text-muted-foreground">
              {issues[0]}
            </p>
          )}
        </form>
      </CardContent>
    </>
  );
}
