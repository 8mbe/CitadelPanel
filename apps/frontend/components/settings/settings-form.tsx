"use client";

import * as React from "react";
import { KeyRound, Trash2, TriangleAlert } from "lucide-react";

import { ApiError, authRequest } from "@/lib/api";
import { useSession } from "@/components/session-provider";
import { ApiKeysSection } from "@/components/settings/api-keys-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * The account settings surface. One stacked Card per concern so a save in one
 * section cannot leak into another. Username/email/password go straight to
 * Better Auth's own `/api/auth/*` endpoints via `authRequest`; the session is
 * refreshed afterwards so the shell reflects name/email changes immediately.
 */
export function SettingsForm() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage your account credentials, API keys, and access.
        </p>
      </div>

      <UsernameSection />
      <EmailSection />
      <PasswordSection />
      <TwoFactorSection />
      <ApiKeysSection />
      <DangerZoneSection />
    </div>
  );
}

// --- Username -----------------------------------------------------------------

function UsernameSection() {
  const { user, refresh } = useSession();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await authRequest("/api/auth/update-user", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your name.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Display name</CardTitle>
        <CardDescription>
          Shown in the header and on your server activity. Does not change your
          sign-in email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                name="name"
                key={user.name}
                defaultValue={user.name}
                required
                maxLength={128}
                placeholder="Your name"
              />
            </Field>
          </FieldGroup>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && !error && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
          )}
          <div>
            <Button type="submit" disabled={loading}>
              {loading && <Spinner />}
              Save name
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- Email --------------------------------------------------------------------

function EmailSection() {
  const { user, refresh } = useSession();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const newEmail = String(new FormData(e.currentTarget).get("email") ?? "")
      .trim()
      .toLowerCase();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await authRequest("/api/auth/change-email", {
        method: "POST",
        body: JSON.stringify({ newEmail }),
      });
      const refreshed = await refresh();
      // Better Auth returns success even for an already-taken address (to avoid
      // leaking which emails exist). If the email did not actually change, that
      // is the cause — surface it rather than claiming success.
      if (refreshed && refreshed.email !== newEmail) {
        setError("That email is already in use.");
      } else {
        setNotice("Email updated.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change your email.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email address</CardTitle>
        <CardDescription>
          The address you sign in with. If email verification is configured, a
          confirmation link is sent to your current address before the change
          takes effect.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                key={user.email}
                defaultValue={user.email}
                required
                maxLength={255}
                autoComplete="email"
              />
            </Field>
          </FieldGroup>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              {notice}
            </p>
          )}
          <div>
            <Button type="submit" disabled={loading}>
              {loading && <Spinner />}
              Save email
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- Password -----------------------------------------------------------------

function PasswordSection() {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // React 19 nulls `event.currentTarget` once the synchronous portion of the
    // handler returns (at the first `await`). Capture the form now so the
    // post-`await` `reset()` still has a live reference — otherwise it throws a
    // null TypeError that the catch turns into a misleading "Could not change
    // your password." even though the 200 response means it *was* changed.
    const form = e.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirm = String(data.get("confirm") ?? "");

    setError(null);
    setSaved(false);

    if (newPassword !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    if (newPassword.length < 12) {
      setError("The new password must be at least 12 characters.");
      return;
    }

    setLoading(true);
    try {
      await authRequest("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      form.reset();
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not change your password.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Choose a password you do not use elsewhere. Minimum 12 characters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="currentPassword">Current password</FieldLabel>
              <Input
                id="currentPassword"
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="newPassword">New password</FieldLabel>
              <Input
                id="newPassword"
                name="newPassword"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
              />
            </Field>
          </FieldGroup>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              Password changed.
            </p>
          )}
          <div>
            <Button type="submit" disabled={loading}>
              {loading && <Spinner />}
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- Danger zone --------------------------------------------------------------

function DangerZoneSection() {
  const { user } = useSession();
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canDelete = user.ownedServers === 0;

  const del = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      !window.confirm(
        "This permanently deletes your account and cannot be undone. Continue?",
      )
    ) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await authRequest("/api/account/delete", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      // The response clears the session cookie; send the browser to sign in.
      window.location.href = "/login";
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not delete the account.",
      );
      setLoading(false);
    }
  };

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <Trash2 className="size-4" />
          Delete account
        </CardTitle>
        <CardDescription>
          Permanently removes your account, sessions, and subuser access. This
          cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {canDelete ? (
          <form onSubmit={del} className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <span className="text-muted-foreground">
                Enter your password to confirm. Your account will be deleted
                immediately and you will be signed out.
              </span>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="deletePassword">Password</FieldLabel>
                <Input
                  id="deletePassword"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            </FieldGroup>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div>
              <Button type="submit" variant="destructive" disabled={loading}>
                {loading && <Spinner />}
                Delete my account
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <span className="text-muted-foreground">
              You own {user.ownedServers} server
              {user.ownedServers === 1 ? "" : "s"}. Delete or transfer them
              before you can delete your account — an account that owns servers
              cannot be removed.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
