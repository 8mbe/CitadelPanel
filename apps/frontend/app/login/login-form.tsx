"use client";

import * as React from "react";
import { Castle } from "lucide-react";

import { getSetupStatus } from "@/lib/api";
import {
  CaptchaWidget,
  usePublicCaptcha,
  type CaptchaWidgetHandle,
} from "@/components/captcha-widget";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";

// Credential requests stay on the Next.js origin and pass through its BFF.
const SIGN_IN_URL = "/api/auth/sign-in/email";
const SIGN_UP_URL = "/api/auth/sign-up/email";

// The captcha token travels in this header; the backend's before-hook verifies
// it before the credential handler runs (apps/backend/src/security/captcha.ts).
const CAPTCHA_HEADER = "x-captcha-response";

/**
 * The sign-in / sign-up surface.
 *
 * Reaching this component means the server already established that nobody is
 * signed in (see `page.tsx`), so it never has to reason about an existing
 * session — it only has to obtain one.
 *
 * `next` is the already-validated internal path the visitor was heading for
 * before being sent here; when absent, a successful credential exchange lands on
 * the panel root (or the wizard, when setup is unfinished).
 */
export default function LoginForm({ next }: { next?: string }) {
  const captcha = usePublicCaptcha();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Castle className="size-5" />
        </span>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          CitadelPanel
        </h1>
        <p className="text-sm text-muted-foreground">
          Self-hosted game server management.
        </p>
      </div>

      <Card className="w-full max-w-sm">
        <Tabs defaultValue="signin">
          <CardHeader>
            <CardTitle className="flex justify-center">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Create account</TabsTrigger>
              </TabsList>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TabsContent value="signin">
              <AuthForm mode="signin" captcha={captcha} next={next} />
            </TabsContent>
            <TabsContent value="signup">
              <AuthForm mode="signup" captcha={captcha} next={next} />
            </TabsContent>
          </CardContent>
        </Tabs>
      </Card>

      <p className="max-w-sm text-center text-xs text-muted-foreground">
        Accounts start without any servers — servers are provisioned by an
        administrator. Credentials are handled by Better Auth.
      </p>
    </div>
  );
}

function AuthForm({
  mode,
  captcha,
  next,
}: {
  mode: "signin" | "signup";
  captcha: ReturnType<typeof usePublicCaptcha>;
  next?: string;
}) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = React.useState<string | null>(null);
  const captchaRef = React.useRef<CaptchaWidgetHandle>(null);

  const captchaEnabled = Boolean(captcha?.enabled);
  // Block submit until a token is in hand, so the request is not spent on a
  // guaranteed server-side rejection.
  const captchaSatisfied = !captchaEnabled || captchaToken !== null;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);

    const data = new FormData(e.currentTarget);
    const body = JSON.stringify({
      name: data.get("name") ?? undefined,
      email: data.get("email"),
      password: data.get("password"),
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (captchaEnabled && captchaToken) headers[CAPTCHA_HEADER] = captchaToken;

    try {
      const res = await fetch(mode === "signin" ? SIGN_IN_URL : SIGN_UP_URL, {
        method: "POST",
        headers,
        body,
        credentials: "include",
      });

      if (!res.ok) {
        // Surface the backend's message (captcha failure, bad credentials)
        // rather than a generic string, so the operator can act on it.
        const detail = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        setError(
          detail?.message ??
            detail?.error ??
            (mode === "signin"
              ? "Sign-in failed. Check your credentials and try again."
              : "Sign-up failed. Please try again."),
        );
        // A captcha token is single-use; force a fresh solve before retrying.
        setCaptchaToken(null);
        captchaRef.current?.reset();
      } else {
        // A 200 with `twoFactorRedirect` means the credentials were correct but
        // the account has 2FA enabled — Better Auth has NOT issued a session
        // cookie yet. Send the user to the verification page; the next-URL is
        // forwarded so they land where they were heading after verifying.
        const body = (await res.json().catch(() => null)) as
          | { twoFactorRedirect?: boolean; twoFactorMethods?: string[] }
          | null;
        if (body?.twoFactorRedirect) {
          const params = new URLSearchParams();
          if (next) params.set("next", next);
          window.location.href = `/2fa${params.toString() ? `?${params}` : ""}`;
          return;
        }

        setNotice("Success! Redirecting…");
        if (next) {
          window.location.href = next;
          return;
        }
        const setup = await getSetupStatus().catch(() => null);
        window.location.href = setup?.needsSetup ? "/setup" : "/";
        return;
      }
    } catch {
      setError("The panel service is unavailable. Please try again shortly.");
      setCaptchaToken(null);
      captchaRef.current?.reset();
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <FieldGroup>
        {mode === "signup" && (
          <Field>
            <FieldLabel htmlFor={`${mode}-name`}>Name</FieldLabel>
            <Input id={`${mode}-name`} name="name" required placeholder="Ada Lovelace" />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor={`${mode}-email`}>Email</FieldLabel>
          <Input
            id={`${mode}-email`}
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            autoComplete="email"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${mode}-password`}>Password</FieldLabel>
          <Input
            id={`${mode}-password`}
            name="password"
            type="password"
            required
            minLength={8}
            placeholder="••••••••"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </Field>
      </FieldGroup>

      {captcha && captcha.enabled && (
        <CaptchaWidget
          ref={captchaRef}
          settings={captcha}
          onToken={setCaptchaToken}
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>
      )}

      <Button
        type="submit"
        disabled={loading || !captchaSatisfied}
        className="w-full"
      >
        {loading && <Spinner />}
        {mode === "signin" ? "Sign in" : "Create account"}
      </Button>
    </form>
  );
}
