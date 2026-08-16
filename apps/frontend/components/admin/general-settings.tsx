"use client";

import * as React from "react";
import { Info, Mail, Send } from "lucide-react";

import {
  ApiError,
  getAdminSettings,
  sendTestEmail,
  updateAdminSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
  type MailProvider,
} from "@/lib/api";
import {
  CaptchaSettingsForm,
  toCaptchaPayload,
  type CaptchaFormValue,
} from "@/components/captcha-settings-form";
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { guessTimezone, listTimezones } from "@/lib/timezones";

/**
 * Admin general settings. Three independent cards, each saving on its own so a
 * captcha change never implies a mail change. Loaded once from
 * `GET /api/admin/settings`; updates go to `PATCH /api/admin/settings`.
 */
export function AdminGeneralSettings() {
  const [settings, setSettings] = React.useState<AdminSettings | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getAdminSettings();
        if (!cancelled) setSettings(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Could not load settings.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!settings) {
    return <Skeleton className="h-96 w-full" />;
  }

  // Apply a patch and keep the local view in sync with the returned state.
  const patch = async (update: AdminSettingsUpdate): Promise<AdminSettings> => {
    const next = await updateAdminSettings(update);
    setSettings(next);
    return next;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          General settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Panel-wide configuration. Changes take effect immediately.
        </p>
      </div>

      <GeneralCard settings={settings} patch={patch} />
      <CaptchaCard settings={settings} patch={patch} />
      <MailCard settings={settings} patch={patch} />
      <VerificationCard settings={settings} patch={patch} />
      <ServerLimitsCard settings={settings} patch={patch} />
    </div>
  );
}

// --- Timezone -----------------------------------------------------------------

function GeneralCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const [timezone, setTimezone] = React.useState(
    settings.timezone && settings.timezone !== "UTC"
      ? settings.timezone
      : guessTimezone(),
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const zones = React.useMemo(() => listTimezones(), []);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({ timezone });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the timezone.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timezone</CardTitle>
        <CardDescription>
          How timestamps are displayed across the panel. Stored data stays in
          UTC; this only affects display.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
          <Select value={timezone} onValueChange={(v) => setTimezone(v ?? "UTC")}>
            <SelectTrigger id="timezone" className="w-full">
              <SelectValue placeholder="Select a timezone" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {zones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        <div>
          <Button onClick={save} disabled={loading || timezone === settings.timezone}>
            {loading && <Spinner />}
            Save timezone
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Captcha ------------------------------------------------------------------

function CaptchaCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const [value, setValue] = React.useState<CaptchaFormValue>(() => ({
    enabled: settings.captcha.enabled,
    provider: settings.captcha.provider,
    siteKey: settings.captcha.siteKey ?? "",
    secretKey: "",
    apiEndpoint: settings.captcha.apiEndpoint ?? "",
    minScore: settings.captcha.minScore,
  }));
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        captcha: toCaptchaPayload(value, settings.captcha.hasSecretKey),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save captcha settings.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bot protection</CardTitle>
        <CardDescription>
          A captcha on sign-in, sign-up and password reset. Disabling keeps the
          stored keys so toggling back on needs no re-entry.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CaptchaSettingsForm
          value={value}
          onChange={setValue}
          hasStoredSecret={settings.captcha.hasSecretKey}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        <div>
          <Button onClick={save} disabled={loading}>
            {loading && <Spinner />}
            {value.enabled ? "Save captcha" : "Save (captcha off)"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Mail ---------------------------------------------------------------------

interface MailFormValue {
  enabled: boolean;
  provider: MailProvider | null;
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  smtpSecure: boolean;
  resendApiKey: string;
}

function MailCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const m = settings.mail;
  const [value, setValue] = React.useState<MailFormValue>({
    enabled: m.enabled,
    provider: m.provider,
    fromName: m.fromName ?? "",
    fromEmail: m.fromEmail ?? "",
    smtpHost: m.smtpHost ?? "",
    smtpPort: m.smtpPort?.toString() ?? "",
    smtpUser: m.smtpUser ?? "",
    smtpPassword: "",
    smtpSecure: m.smtpSecure,
    resendApiKey: "",
  });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Test email state.
  const [testTo, setTestTo] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<string | null>(null);

  const set = <K extends keyof MailFormValue>(key: K, v: MailFormValue[K]) =>
    setValue((prev) => ({ ...prev, [key]: v }));

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        mail: {
          enabled: value.enabled,
          provider: value.provider,
          fromName: value.fromName.trim() || null,
          fromEmail: value.fromEmail.trim() || null,
          smtpHost: value.smtpHost.trim() || null,
          smtpPort: value.smtpPort === "" ? null : Number(value.smtpPort),
          smtpUser: value.smtpUser.trim() || null,
          // Empty field ⇒ keep stored (omit) when one exists, else clear.
          smtpPassword: value.smtpPassword === "" ? undefined : value.smtpPassword,
          smtpSecure: value.smtpSecure,
          resendApiKey: value.resendApiKey === "" ? undefined : value.resendApiKey,
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save mail settings.");
    } finally {
      setLoading(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await sendTestEmail(testTo.trim());
      setTestResult(
        res.ok
          ? "Test email sent. Check the inbox (and spam folder)."
          : "The email could not be sent. Check the mail configuration and server logs.",
      );
    } catch (err) {
      setTestResult(
        err instanceof ApiError ? err.message : "Could not send the test email.",
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" />
          Email
        </CardTitle>
        <CardDescription>
          Outbound email for verification and password-reset messages. Choose a
          provider; secrets are stored encrypted and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="mail-enabled">Enable email</FieldLabel>
              <FieldDescription>
                When off, the panel runs without email: signup works, password
                reset is unavailable, and email changes apply immediately.
              </FieldDescription>
            </div>
            <Switch
              id="mail-enabled"
              checked={value.enabled}
              onCheckedChange={(c) => set("enabled", c)}
            />
          </Field>

          {value.enabled && (
            <>
              <Field>
                <FieldLabel htmlFor="mail-provider">Provider</FieldLabel>
                <Select
                  value={value.provider ?? ""}
                  onValueChange={(v) => set("provider", v as MailProvider)}
                >
                  <SelectTrigger id="mail-provider" className="w-full">
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="smtp">SMTP</SelectItem>
                    <SelectItem value="resend">Resend (HTTP API)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="mail-from-name">From name</FieldLabel>
                <Input
                  id="mail-from-name"
                  value={value.fromName}
                  onChange={(e) => set("fromName", e.target.value)}
                  placeholder="CitadelPanel"
                  maxLength={128}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="mail-from-email">From email</FieldLabel>
                <Input
                  id="mail-from-email"
                  type="email"
                  value={value.fromEmail}
                  onChange={(e) => set("fromEmail", e.target.value)}
                  placeholder="panel@example.com"
                  maxLength={255}
                />
              </Field>

              {value.provider === "smtp" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="mail-smtp-host">SMTP host</FieldLabel>
                    <Input
                      id="mail-smtp-host"
                      value={value.smtpHost}
                      onChange={(e) => set("smtpHost", e.target.value)}
                      placeholder="smtp.example.com"
                      maxLength={255}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mail-smtp-port">SMTP port</FieldLabel>
                    <Input
                      id="mail-smtp-port"
                      type="number"
                      value={value.smtpPort}
                      onChange={(e) => set("smtpPort", e.target.value)}
                      placeholder="587"
                    />
                    <FieldDescription>
                      465 with TLS below; 587/25 uses STARTTLS.
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mail-smtp-user">SMTP username</FieldLabel>
                    <Input
                      id="mail-smtp-user"
                      value={value.smtpUser}
                      onChange={(e) => set("smtpUser", e.target.value)}
                      placeholder="Leave blank if your server needs no auth"
                      autoComplete="off"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mail-smtp-password">SMTP password</FieldLabel>
                    <Input
                      id="mail-smtp-password"
                      type="password"
                      value={value.smtpPassword}
                      onChange={(e) => set("smtpPassword", e.target.value)}
                      placeholder={
                        m.hasSmtpPassword
                          ? "Stored — leave blank to keep unchanged"
                          : "Server password"
                      }
                      autoComplete="off"
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <div className="flex flex-1 flex-col gap-0.5">
                      <FieldLabel htmlFor="mail-smtp-secure">Use TLS</FieldLabel>
                      <FieldDescription>
                        Implicit TLS on port 465; off for STARTTLS on 587/25.
                      </FieldDescription>
                    </div>
                    <Switch
                      id="mail-smtp-secure"
                      checked={value.smtpSecure}
                      onCheckedChange={(c) => set("smtpSecure", c)}
                    />
                  </Field>
                </>
              )}

              {value.provider === "resend" && (
                <Field>
                  <FieldLabel htmlFor="mail-resend-key">Resend API key</FieldLabel>
                  <Input
                    id="mail-resend-key"
                    type="password"
                    value={value.resendApiKey}
                    onChange={(e) => set("resendApiKey", e.target.value)}
                    placeholder={
                      m.hasResendApiKey
                        ? "Stored — leave blank to keep unchanged"
                        : "re_xxxxxxxxxxxx"
                    }
                    autoComplete="off"
                  />
                </Field>
              )}
            </>
          )}
        </FieldGroup>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        <div>
          <Button onClick={save} disabled={loading}>
            {loading && <Spinner />}
            Save email
          </Button>
        </div>

        {settings.mail.enabled && (
          <div className="flex flex-col gap-2 border-t pt-4">
            <FieldLabel htmlFor="mail-test-to">Send a test email</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="mail-test-to"
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@example.com"
              />
              <Button
                type="button"
                variant="outline"
                onClick={sendTest}
                disabled={testing || testTo.trim() === ""}
              >
                {testing ? <Spinner /> : <Send />}
                Send
              </Button>
            </div>
            {testResult && (
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                {testResult}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Verification policy ------------------------------------------------------

function VerificationCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const mailConfigured = settings.mail.enabled;
  const [enabled, setEnabled] = React.useState(
    settings.verification.requireVerifiedSignIn,
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = async (checked: boolean) => {
    setEnabled(checked);
    setLoading(true);
    setError(null);
    try {
      await patch({ verification: { requireVerifiedSignIn: checked } });
    } catch (err) {
      setEnabled(!checked); // revert
      setError(err instanceof ApiError ? err.message : "Could not save the setting.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email verification</CardTitle>
        <CardDescription>
          Control whether a verified email is required before a user can sign in.
          New sign-ups receive a verification link automatically when email is
          configured.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal">
          <div className="flex flex-1 flex-col gap-0.5">
            <FieldLabel htmlFor="require-verified">
              Require a verified email to sign in
            </FieldLabel>
            <FieldDescription>
              {!mailConfigured
                ? "Configure and enable email above before this can be turned on."
                : "When on, unverified accounts are blocked at sign-in until they verify their address."}
            </FieldDescription>
          </div>
          <Switch
            id="require-verified"
            checked={enabled}
            disabled={loading || !mailConfigured}
            onCheckedChange={toggle}
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// --- Server limits ------------------------------------------------------------

function ServerLimitsCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const [maxPorts, setMaxPorts] = React.useState(
    String(settings.serverLimits.maxAdditionalPortsPerServer),
  );
  const [maxDbs, setMaxDbs] = React.useState(
    String(settings.serverLimits.maxDatabasesPerServer),
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const save = async () => {
    const ports = Number(maxPorts);
    const dbs = Number(maxDbs);
    if (!Number.isInteger(ports) || ports < 0 || ports > 100) {
      setError("Max additional ports must be a whole number between 0 and 100.");
      return;
    }
    if (!Number.isInteger(dbs) || dbs < 0 || dbs > 100) {
      setError("Max databases must be a whole number between 0 and 100.");
      return;
    }
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        serverLimits: {
          maxAdditionalPortsPerServer: ports,
          maxDatabasesPerServer: dbs,
        },
      });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save server limits.",
      );
    } finally {
      setLoading(false);
    }
  };

  const unchanged =
    Number(maxPorts) === settings.serverLimits.maxAdditionalPortsPerServer &&
    Number(maxDbs) === settings.serverLimits.maxDatabasesPerServer;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server limits</CardTitle>
        <CardDescription>
          Owner-facing caps on what server owners may self-provision. Set to 0 to
          forbid a behaviour entirely.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="max-additional-ports">
            Max additional ports per server
          </FieldLabel>
          <Input
            id="max-additional-ports"
            type="number"
            min={0}
            max={100}
            value={maxPorts}
            onChange={(e) => setMaxPorts(e.target.value)}
          />
          <FieldDescription>
            How many extra ports an owner may publish beyond the game&apos;s
            built-in ports. Affects every server on the panel.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="max-databases">
            Max databases per server
          </FieldLabel>
          <Input
            id="max-databases"
            type="number"
            min={0}
            max={100}
            value={maxDbs}
            onChange={(e) => setMaxDbs(e.target.value)}
          />
          <FieldDescription>
            How many MySQL databases an owner may provision on the node&apos;s
            shared database server. Set to 0 to disable self-provisioning.
          </FieldDescription>
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        <div>
          <Button onClick={save} disabled={loading || unchanged}>
            {loading && <Spinner />}
            Save server limits
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
