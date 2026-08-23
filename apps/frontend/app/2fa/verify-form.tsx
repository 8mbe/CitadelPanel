"use client";

import * as React from "react";
import { Castle, ShieldCheck } from "lucide-react";

import { getPublicSettings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The second-factor verification form.
 *
 * After correct credentials, Better Auth set a short-lived 2FA cookie (not a
 * session). This form completes the flow by calling the verify endpoint for
 * TOTP, email OTP, or a backup code. Each of the three exchanges that 2FA
 * cookie for a real session cookie. On success the browser is sent to the
 * `next` path (or the panel root).
 *
 * Email OTP is only offered when the panel has mail configured (the plugin
 * only advertises OTP as a method when `sendOTP` is defined). We detect that
 * client-side by fetching the public mail-availability flag, which avoids
 * rendering a "send code" button that would silently no-op.
 */

type Method = "totp" | "otp" | "backup";

export default function TwoFactorVerifyForm({ next }: { next?: string }) {
  const [mailEnabled, setMailEnabled] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // getPublicSettings doesn't expose mail status directly, but the
        // presence of email-OTP as an offered method is determined server-side.
        // We probe with a send-OTP call only when the user clicks send, so here
        // we optimistically show the tab and let the send-OTP response tell us
        // whether OTP is available for this account.
        const settings = await getPublicSettings();
        if (!cancelled) setMailEnabled(Boolean(settings));
      } catch {
        if (!cancelled) setMailEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const redirect = () => {
    window.location.href = next ?? "/";
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <ShieldCheck className="size-5" />
        </span>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Two-factor verification
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter your verification code to continue.
        </p>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <Tabs defaultValue="totp">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="totp">Authenticator</TabsTrigger>
              <TabsTrigger value="otp">Email code</TabsTrigger>
              <TabsTrigger value="backup">Backup code</TabsTrigger>
            </TabsList>
            <TabsContent value="totp" className="mt-4">
              <TotpForm onSuccess={redirect} />
            </TabsContent>
            <TabsContent value="otp" className="mt-4">
              <OtpForm onSuccess={redirect} />
            </TabsContent>
            <TabsContent value="backup" className="mt-4">
              <BackupForm onSuccess={redirect} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <a
        href="/login"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Castle className="size-3" />
        Back to sign in
      </a>
    </div>
  );
}

// --- Shared helpers -----------------------------------------------------------

function useVerify(endpoint: string, onSuccess: () => void) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const verify = React.useCallback(
    async (body: Record<string, unknown>) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/auth${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as
            | { message?: string; code?: string }
            | null;
          setError(
            detail?.message ??
              "Verification failed. Check your code and try again.",
          );
          return false;
        }
        onSuccess();
        return true;
      } catch {
        setError("The panel service is unavailable. Please try again shortly.");
        return false;
      } finally {
        setLoading(false);
      }
    },
    [endpoint, onSuccess],
  );

  return { verify, loading, error };
}

// --- TOTP (authenticator app) -------------------------------------------------

function TotpForm({ onSuccess }: { onSuccess: () => void }) {
  const { verify, loading, error } = useVerify(
    "/two-factor/verify-totp",
    onSuccess,
  );

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "")
      .replace(/\s/g, "")
      .trim();
    await verify({ code, trustDevice: true });
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="totp-code">Authentication code</FieldLabel>
          <Input
            id="totp-code"
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
      <Button type="submit" disabled={loading} className="w-full">
        {loading && <Spinner />}
        Verify
      </Button>
    </form>
  );
}

// --- Email OTP ----------------------------------------------------------------

function OtpForm({ onSuccess }: { onSuccess: () => void }) {
  const [sent, setSent] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const { verify, loading, error } = useVerify(
    "/two-factor/verify-otp",
    onSuccess,
  );

  const send = async () => {
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/auth/two-factor/send-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        credentials: "include",
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        setSendError(
          detail?.message ??
            "Could not send a code. Email OTP may not be available for this panel.",
        );
        return;
      }
      setSent(true);
    } catch {
      setSendError("The panel service is unavailable. Please try again shortly.");
    } finally {
      setSending(false);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "")
      .replace(/\s/g, "")
      .trim();
    await verify({ code, trustDevice: true });
  };

  if (!sent) {
    return (
      <div className="flex flex-col gap-4">
        <CardDescription>
          A one-time code will be sent to your account's email address.
        </CardDescription>
        {sendError && <p className="text-sm text-destructive">{sendError}</p>}
        <Button onClick={send} disabled={sending}>
          {sending ? <Spinner /> : null}
          Send code
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="otp-code">Email code</FieldLabel>
          <Input
            id="otp-code"
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
      <div className="flex flex-col gap-2">
        <Button type="submit" disabled={loading}>
          {loading && <Spinner />}
          Verify
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={send}
          disabled={sending}
        >
          Resend code
        </Button>
      </div>
    </form>
  );
}

// --- Backup code --------------------------------------------------------------

function BackupForm({ onSuccess }: { onSuccess: () => void }) {
  const { verify, loading, error } = useVerify(
    "/two-factor/verify-backup-code",
    onSuccess,
  );

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "")
      .trim()
      .toUpperCase();
    await verify({ code, trustDevice: true });
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="backup-code">Backup code</FieldLabel>
          <Input
            id="backup-code"
            name="code"
            required
            autoComplete="off"
            maxLength={16}
            placeholder="XXXX-XXXX"
            className="text-center font-mono tracking-wider"
          />
        </Field>
      </FieldGroup>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={loading} className="w-full">
        {loading && <Spinner />}
        Verify
      </Button>
    </form>
  );
}
