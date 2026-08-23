"use client";

import * as React from "react";
import QRCode from "react-qr-code";
import { Check, Copy, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";

import { ApiError, authRequest } from "@/lib/api";
import { useSession } from "@/components/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Two-factor authentication management.
 *
 * Backed by Better Auth's twoFactor plugin endpoints, all reached via
 * `authRequest` (same-origin, credentialed). The flow:
 *
 *  - Enable: POST /two-factor/enable (password) → { totpURI, backupCodes }
 *    → user scans QR, enters a TOTP to confirm → POST /two-factor/verify-totp.
 *    `twoFactorEnabled` is only set to true after that first verification.
 *  - Disable: POST /two-factor/disable (password).
 *  - Regenerate backup codes: POST /two-factor/generate-backup-codes (password).
 *
 * Backup codes are shown once (at enable and at regenerate) and cannot be
 * recovereded. The section reads the live `twoFactorEnabled` flag from the
 * session provider so it stays in sync after enable/disable.
 */
export function TwoFactorSection() {
  const { user, refresh } = useSession();
  const [showDisable, setShowDisable] = React.useState(false);
  const [showRegenerate, setShowRegenerate] = React.useState(false);

  if (user.twoFactorEnabled) {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4" />
              Two-factor authentication
              <Badge variant="secondary" className="ml-1">
                Active
              </Badge>
            </CardTitle>
            <CardDescription>
              Your account requires a verification code from your authenticator
              app at sign-in. You can also use an email code or a backup code.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRegenerate(true)}
              >
                <KeyRound className="size-4" />
                Regenerate backup codes
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => setShowDisable(true)}
              >
                <ShieldOff className="size-4" />
                Disable
              </Button>
            </div>
          </CardContent>
        </Card>

        <DisableDialog
          open={showDisable}
          onOpenChange={setShowDisable}
          onDone={refresh}
        />
        <RegenerateDialog
          open={showRegenerate}
          onOpenChange={setShowRegenerate}
        />
      </>
    );
  }

  return <EnableSection onEnabled={refresh} />;
}

// --- Enable flow ---------------------------------------------------------------

function EnableSection({ onEnabled }: { onEnabled: () => Promise<unknown> }) {
  const [step, setStep] = React.useState<"password" | "setup" | "verify">(
    "password",
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [totpUri, setTotpUri] = React.useState<string | null>(null);
  const [backupCodes, setBackupCodes] = React.useState<string[] | null>(null);

  const enable = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(
      new FormData(e.currentTarget).get("password") ?? "",
    );
    setLoading(true);
    setError(null);
    try {
      const data = await authRequest<{ totpURI: string; backupCodes: string[] }>(
        "/api/auth/two-factor/enable",
        { method: "POST", body: JSON.stringify({ password }) },
      );
      setTotpUri(data.totpURI);
      setBackupCodes(data.backupCodes);
      setStep("setup");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not enable 2FA.",
      );
    } finally {
      setLoading(false);
    }
  };

  const verify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "")
      .replace(/\s/g, "")
      .trim();
    setLoading(true);
    setError(null);
    try {
      await authRequest("/api/auth/two-factor/verify-totp", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      await onEnabled();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Invalid code. Try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          Two-factor authentication
        </CardTitle>
        <CardDescription>
          Add a second step to sign-in using an authenticator app (Google
          Authenticator, Authy, 1Password, etc.). You'll also receive backup
          codes for when you don't have your device.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {step === "password" && (
          <form onSubmit={enable} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="enable-password">
                  Confirm your password
                </FieldLabel>
                <Input
                  id="enable-password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </Field>
            </FieldGroup>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div>
              <Button type="submit" disabled={loading}>
                {loading && <Spinner />}
                Begin setup
              </Button>
            </div>
          </form>
        )}

        {step === "setup" && totpUri && backupCodes && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg bg-white p-3">
                <QRCode value={totpUri} size={160} />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Scan this QR code with your authenticator app, then enter the
                6-digit code it shows.
              </p>
            </div>

            <BackupCodesDisplay codes={backupCodes} />

            <form onSubmit={verify} className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="enable-code">
                    Verification code
                  </FieldLabel>
                  <Input
                    id="enable-code"
                    name="code"
                    required
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    placeholder="123456"
                    className="text-center font-mono text-lg tracking-widest"
                  />
                </Field>
              </FieldGroup>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div>
                <Button type="submit" disabled={loading}>
                  {loading && <Spinner />}
                  Verify and enable
                </Button>
              </div>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Backup codes display -----------------------------------------------------

function BackupCodesDisplay({ codes }: { codes: string[] }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the user can still select the text manually.
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2 text-sm">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span className="text-muted-foreground">
          Save these backup codes in a secure location. Each can be used once if
          you lose access to your authenticator. They cannot be shown again.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-2 font-mono text-xs">
        {codes.map((code, i) => (
          <span key={i} className="px-1 py-0.5">
            {code}
          </span>
        ))}
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copy}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy all"}
        </Button>
      </div>
    </div>
  );
}

// --- Disable dialog -----------------------------------------------------------

function DisableDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<unknown>;
}) {
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await authRequest("/api/auth/two-factor/disable", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await onDone();
      onOpenChange(false);
      setPassword("");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not disable 2FA.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) {
          setPassword("");
          setError(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable two-factor authentication?</DialogTitle>
          <DialogDescription>
            Your account will no longer require a verification code at sign-in.
            Enter your password to confirm.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="disable-password">Password</FieldLabel>
            <Input
              id="disable-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={loading}>
              {loading ? <Spinner /> : null}
              Disable
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Regenerate backup codes dialog -------------------------------------------

function RegenerateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = React.useState<"password" | "codes">("password");
  const [password, setPassword] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const generate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await authRequest<{ backupCodes: string[] }>(
        "/api/auth/two-factor/generate-backup-codes",
        { method: "POST", body: JSON.stringify({ password }) },
      );
      setCodes(data.backupCodes);
      setStep("codes");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not generate codes.",
      );
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    // Reset after the dialog animates out.
    setTimeout(() => {
      setStep("password");
      setPassword("");
      setCodes(null);
      setError(null);
    }, 150);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : close())}>
      <DialogContent>
        {step === "password" && (
          <>
            <DialogHeader>
              <DialogTitle>Regenerate backup codes</DialogTitle>
              <DialogDescription>
                This invalidates all previous backup codes and generates a new
                set. Enter your password to confirm.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={generate} className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="regen-password">Password</FieldLabel>
                <Input
                  id="regen-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </Field>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? <Spinner /> : null}
                  Generate
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
        {step === "codes" && codes && (
          <>
            <DialogHeader>
              <DialogTitle>New backup codes</DialogTitle>
              <DialogDescription>
                Save these now. They cannot be shown again.
              </DialogDescription>
            </DialogHeader>
            <BackupCodesDisplay codes={codes} />
            <DialogFooter>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
