"use client";

import * as React from "react";
import {
  ChartLine,
  Globe,
  Info,
  Mail,
  Send,
  Sparkles,
  Type,
  UserPlus,
} from "lucide-react";

import {
  ApiError,
  fetchAiModels,
  getAdminSettings,
  sendTestEmail,
  testAi,
  updateAdminSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
  type AnalyticsProvider,
  type MailProvider,
} from "@/lib/api";
import { ThemeCard } from "@/components/admin/theme-card";
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
 * Admin general settings. Independent cards, each saving on its own so a captcha
 * change never implies a mail change. Loaded once from
 * `GET /api/admin/settings`; updates go to `PATCH /api/admin/settings`.
 *
 * The terms of service and privacy policy are deliberately *not* here — they are
 * documents rather than settings and get their own editor at `/admin/legal`.
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

      <BrandingCard settings={settings} patch={patch} />
      <ThemeCard settings={settings} patch={patch} />
      <GeneralCard settings={settings} patch={patch} />
      <RegistrationCard settings={settings} patch={patch} />
      <CaptchaCard settings={settings} patch={patch} />
      <MailCard settings={settings} patch={patch} />
      <AiCard settings={settings} patch={patch} />
      <VerificationCard settings={settings} patch={patch} />
      <ServerLimitsCard settings={settings} patch={patch} />
      <SeoCard settings={settings} patch={patch} />
      <AnalyticsCard settings={settings} patch={patch} />
    </div>
  );
}

// --- Branding -----------------------------------------------------------------

function BrandingCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const [siteName, setSiteName] = React.useState(settings.branding.siteName);
  const [tagline, setTagline] = React.useState(settings.branding.tagline);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({ branding: { siteName: siteName.trim(), tagline: tagline.trim() } });
      setSaved(true);
      // The name is baked into the server-rendered header, the document title,
      // and outbound email, so a reload is what actually makes the change
      // visible everywhere rather than just in this form.
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the branding.");
    } finally {
      setLoading(false);
    }
  };

  const unchanged =
    siteName.trim() === settings.branding.siteName &&
    tagline.trim() === settings.branding.tagline;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Type className="size-4" />
          Site identity
        </CardTitle>
        <CardDescription>
          The name shown in the header, on the sign-in page, in every browser tab
          title, and in outbound email.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="site-name">Site name</FieldLabel>
          <Input
            id="site-name"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="CitadelPanel"
            maxLength={64}
          />
          <FieldDescription>
            Page titles read &ldquo;Console ·{" "}
            {siteName.trim() || "CitadelPanel"}&rdquo;.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="site-tagline">Tagline</FieldLabel>
          <Input
            id="site-tagline"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="Self-hosted game server management."
            maxLength={160}
          />
          <FieldDescription>
            One line under the name on the sign-in page. Also the fallback meta
            description when the SEO description below is empty.
          </FieldDescription>
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        <div>
          <Button onClick={save} disabled={loading || unchanged || !siteName.trim()}>
            {loading && <Spinner />}
            Save site identity
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Registration -------------------------------------------------------------

function RegistrationCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const [enabled, setEnabled] = React.useState(settings.registration.enabled);
  const [message, setMessage] = React.useState(
    settings.registration.disabledMessage,
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        registration: { enabled, disabledMessage: message.trim() },
      });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save the setting.",
      );
    } finally {
      setLoading(false);
    }
  };

  const unchanged =
    enabled === settings.registration.enabled &&
    message.trim() === settings.registration.disabledMessage;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="size-4" />
          Registration
        </CardTitle>
        <CardDescription>
          Whether visitors may create their own accounts. Turning this off makes
          the panel invite-only: the sign-up endpoint refuses, not just the form.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="registration-enabled">
                Allow public sign-up
              </FieldLabel>
              <FieldDescription>
                When off, the &ldquo;Create account&rdquo; tab disappears and{" "}
                <code>/api/auth/sign-up/email</code> returns 403. Existing users
                are unaffected, and first-time setup can still claim the initial
                admin account.
              </FieldDescription>
            </div>
            <Switch
              id="registration-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </Field>

          {!enabled && (
            <Field>
              <FieldLabel htmlFor="registration-message">
                Message on the sign-in page
              </FieldLabel>
              <Input
                id="registration-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Registration is closed. Ask an administrator for an account."
                maxLength={240}
              />
              <FieldDescription>
                Shown where the sign-up tab would be, and returned as the error
                if someone posts to the endpoint anyway. Use it to point people
                at however they actually get an account.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        <div>
          <Button onClick={save} disabled={loading || unchanged}>
            {loading && <Spinner />}
            Save registration
          </Button>
        </div>
      </CardContent>
    </Card>
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

// --- AI assistant -------------------------------------------------------------

interface AiFormValue {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  model: string;
}

function AiCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const a = settings.ai;
  const [value, setValue] = React.useState<AiFormValue>({
    enabled: a.enabled,
    apiUrl: a.apiUrl ?? "",
    apiKey: "",
    model: a.model ?? "",
  });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Fetched model list + fetch state.
  const [models, setModels] = React.useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [modelsError, setModelsError] = React.useState<string | null>(null);

  // Test-connection state.
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<string | null>(null);

  const set = <K extends keyof AiFormValue>(key: K, v: AiFormValue[K]) =>
    setValue((prev) => ({ ...prev, [key]: v }));

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        ai: {
          enabled: value.enabled,
          apiUrl: value.apiUrl.trim() || null,
          // Empty field ⇒ keep stored (omit) when one exists, else clear.
          apiKey: value.apiKey === "" ? undefined : value.apiKey,
          model: value.model.trim() || null,
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save AI settings.");
    } finally {
      setLoading(false);
    }
  };

  // Fetch the provider's model list. Uses the form's current apiUrl/apiKey so
  // an admin can probe a provider before saving it; falls back to the stored
  // key when the apiKey field is left blank (the server side resolves that).
  const fetchModels = async () => {
    setFetchingModels(true);
    setModelsError(null);
    try {
      const list = await fetchAiModels({
        apiUrl: value.apiUrl.trim() || undefined,
        apiKey: value.apiKey === "" ? undefined : value.apiKey,
      });
      setModels(list);
      // Pre-select the first model if none is chosen yet, to smooth the flow.
      if (!value.model && list.length > 0) set("model", list[0]);
    } catch (err) {
      setModelsError(
        err instanceof ApiError ? err.message : "Could not fetch models.",
      );
    } finally {
      setFetchingModels(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testAi({
        apiUrl: value.apiUrl.trim() || undefined,
        apiKey: value.apiKey === "" ? undefined : value.apiKey,
        model: value.model.trim() || undefined,
      });
      setTestResult(res.reply);
    } catch (err) {
      setTestResult(
        err instanceof ApiError ? err.message : "The test failed.",
      );
    } finally {
      setTesting(false);
    }
  };

  const canTest = Boolean(
    (value.apiUrl.trim() || a.apiUrl) &&
      (a.hasApiKey || value.apiKey !== "") &&
      (value.model.trim() || a.model),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" />
          AI assistant
        </CardTitle>
        <CardDescription>
          An OpenAI-compatible chat endpoint the panel calls server-side to help
          users read their console output. The API key is stored encrypted and
          never shown again. When off, the console helper is hidden from users.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="ai-enabled">Enable AI assistant</FieldLabel>
              <FieldDescription>
                When on, a helper button appears on every server console. The
                panel composes the prompt (logs, game, version); the browser only
                sends the user&apos;s question.
              </FieldDescription>
            </div>
            <Switch
              id="ai-enabled"
              checked={value.enabled}
              onCheckedChange={(c) => set("enabled", c)}
            />
          </Field>

          {value.enabled && (
            <>
              <Field>
                <FieldLabel htmlFor="ai-api-url">API URL</FieldLabel>
                <Input
                  id="ai-api-url"
                  value={value.apiUrl}
                  onChange={(e) => set("apiUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  maxLength={1024}
                  autoComplete="off"
                />
                <FieldDescription>
                  The OpenAI-compatible base URL. The panel appends{" "}
                  <code>/models</code> and <code>/chat/completions</code>.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="ai-api-key">API key</FieldLabel>
                <Input
                  id="ai-api-key"
                  type="password"
                  value={value.apiKey}
                  onChange={(e) => set("apiKey", e.target.value)}
                  placeholder={
                    a.hasApiKey
                      ? "Stored — leave blank to keep unchanged"
                      : "sk-..."
                  }
                  autoComplete="off"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="ai-model">Model</FieldLabel>
                <div className="flex gap-2">
                  {models.length > 0 ? (
                    <Select
                      value={value.model}
                      onValueChange={(v) => set("model", v ?? "")}
                    >
                      <SelectTrigger id="ai-model" className="w-full">
                        <SelectValue placeholder="Choose a model" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {models.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id="ai-model"
                      value={value.model}
                      onChange={(e) => set("model", e.target.value)}
                      placeholder={
                        a.model ?? "Fetch models or type a model id"
                      }
                      autoComplete="off"
                    />
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={fetchModels}
                    disabled={
                      fetchingModels ||
                      (!value.apiUrl.trim() && !a.apiUrl) ||
                      (!a.hasApiKey && value.apiKey === "")
                    }
                  >
                    {fetchingModels ? <Spinner /> : <Sparkles />}
                    Fetch models
                  </Button>
                </div>
                {modelsError && (
                  <p className="text-sm text-destructive">{modelsError}</p>
                )}
              </Field>
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
            Save AI
          </Button>
        </div>

        {value.enabled && (
          <div className="flex flex-col gap-2 border-t pt-4">
            <FieldLabel htmlFor="ai-test">Test the connection</FieldLabel>
            <div className="flex gap-2">
              <Button
                id="ai-test"
                type="button"
                variant="outline"
                onClick={runTest}
                disabled={testing || !canTest}
                className="w-fit"
              >
                {testing ? <Spinner /> : <Send />}
                {testing ? "Waiting for response…" : "Send test message"}
              </Button>
            </div>
            {testResult && (
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span className="whitespace-pre-wrap">{testResult}</span>
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

// --- SEO ----------------------------------------------------------------------

function SeoCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const s = settings.seo;
  const [allowIndexing, setAllowIndexing] = React.useState(s.allowIndexing);
  const [siteUrl, setSiteUrl] = React.useState(s.siteUrl ?? "");
  const [description, setDescription] = React.useState(s.description);
  const [keywords, setKeywords] = React.useState(s.keywords.join(", "));
  const [ogImageUrl, setOgImageUrl] = React.useState(s.ogImageUrl ?? "");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const parsedKeywords = keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        seo: {
          allowIndexing,
          siteUrl: siteUrl.trim() || null,
          description: description.trim(),
          keywords: parsedKeywords,
          ogImageUrl: ogImageUrl.trim() || null,
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save SEO settings.");
    } finally {
      setLoading(false);
    }
  };

  const unchanged =
    allowIndexing === s.allowIndexing &&
    (siteUrl.trim() || null) === s.siteUrl &&
    description.trim() === s.description &&
    parsedKeywords.join(",") === s.keywords.join(",") &&
    (ogImageUrl.trim() || null) === s.ogImageUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4" />
          Search engines &amp; sharing
        </CardTitle>
        <CardDescription>
          What crawlers and link previews see. The page title comes from the site
          name above; these fields fill in the rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="seo-indexing">
                Allow search engines to index this panel
              </FieldLabel>
              <FieldDescription>
                Off by default. A control panel is an authenticated surface with
                nothing to rank, and indexed URLs advertise that this host runs
                one. When off, <code>robots.txt</code> is <code>Disallow: /</code>{" "}
                and every page carries <code>noindex</code>. Turn it on only if
                you want the sign-in page and your legal documents listed.
              </FieldDescription>
            </div>
            <Switch
              id="seo-indexing"
              checked={allowIndexing}
              onCheckedChange={setAllowIndexing}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="seo-site-url">Public site URL</FieldLabel>
            <Input
              id="seo-site-url"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://panel.example.com"
              maxLength={512}
              autoComplete="off"
            />
            <FieldDescription>
              The origin visitors actually reach. Used for canonical and preview
              URLs and in <code>sitemap.xml</code>. Falls back to{" "}
              <code>FRONTEND_URL</code> when blank.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="seo-description">Description</FieldLabel>
            <Input
              id="seo-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={settings.branding.tagline || "A short description of your service."}
              maxLength={300}
            />
            <FieldDescription>
              The meta and link-preview description. Defaults to the tagline.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="seo-keywords">Keywords</FieldLabel>
            <Input
              id="seo-keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="game hosting, minecraft, server panel"
            />
            <FieldDescription>
              Comma-separated, up to 20. Most search engines ignore these; they
              are here for the ones that do not.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="seo-og-image">Social preview image</FieldLabel>
            <Input
              id="seo-og-image"
              value={ogImageUrl}
              onChange={(e) => setOgImageUrl(e.target.value)}
              placeholder="/og.png or https://cdn.example.com/og.png"
              maxLength={512}
              autoComplete="off"
            />
            <FieldDescription>
              Shown when a link to the panel is shared. A relative path resolves
              against the site URL above; 1200×630 is the usual size.
            </FieldDescription>
          </Field>
        </FieldGroup>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        <div>
          <Button onClick={save} disabled={loading || unchanged}>
            {loading && <Spinner />}
            Save SEO settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Analytics ----------------------------------------------------------------

function AnalyticsCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const a = settings.analytics;
  const [enabled, setEnabled] = React.useState(a.enabled);
  const [provider, setProvider] = React.useState<AnalyticsProvider | null>(
    a.provider,
  );
  const [plausibleDomain, setPlausibleDomain] = React.useState(
    a.plausibleDomain ?? "",
  );
  const [plausibleScriptUrl, setPlausibleScriptUrl] = React.useState(
    a.plausibleScriptUrl ?? "",
  );
  const [googleMeasurementId, setGoogleMeasurementId] = React.useState(
    a.googleMeasurementId ?? "",
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        analytics: {
          enabled,
          provider,
          plausibleDomain: plausibleDomain.trim() || null,
          plausibleScriptUrl: plausibleScriptUrl.trim() || null,
          googleMeasurementId: googleMeasurementId.trim() || null,
        },
      });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save analytics settings.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartLine className="size-4" />
          Analytics
        </CardTitle>
        <CardDescription>
          Optional page-view analytics. When off, the panel loads no third-party
          script at all — not a disabled one.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="analytics-enabled">Enable analytics</FieldLabel>
              <FieldDescription>
                Injects the provider&apos;s script into every page, including the
                sign-in page.
              </FieldDescription>
            </div>
            <Switch
              id="analytics-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </Field>

          {enabled && (
            <>
              <Field>
                <FieldLabel htmlFor="analytics-provider">Provider</FieldLabel>
                <Select
                  value={provider ?? ""}
                  onValueChange={(v) => setProvider((v as AnalyticsProvider) || null)}
                >
                  <SelectTrigger id="analytics-provider" className="w-full">
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plausible">Plausible</SelectItem>
                    <SelectItem value="google">Google Analytics 4</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {provider === "plausible" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="analytics-plausible-domain">
                      Site domain
                    </FieldLabel>
                    <Input
                      id="analytics-plausible-domain"
                      value={plausibleDomain}
                      onChange={(e) => setPlausibleDomain(e.target.value)}
                      placeholder="panel.example.com"
                      maxLength={253}
                      autoComplete="off"
                    />
                    <FieldDescription>
                      Exactly as registered in Plausible — this becomes the
                      script&apos;s <code>data-domain</code>.
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="analytics-plausible-script">
                      Script URL
                    </FieldLabel>
                    <Input
                      id="analytics-plausible-script"
                      value={plausibleScriptUrl}
                      onChange={(e) => setPlausibleScriptUrl(e.target.value)}
                      placeholder="https://plausible.io/js/script.js"
                      maxLength={512}
                      autoComplete="off"
                    />
                    <FieldDescription>
                      Point this at your own instance if you self-host Plausible.
                      Blank uses plausible.io.
                    </FieldDescription>
                  </Field>
                </>
              )}

              {provider === "google" && (
                <Field>
                  <FieldLabel htmlFor="analytics-ga-id">Measurement ID</FieldLabel>
                  <Input
                    id="analytics-ga-id"
                    value={googleMeasurementId}
                    onChange={(e) => setGoogleMeasurementId(e.target.value)}
                    placeholder="G-XXXXXXXXXX"
                    maxLength={64}
                    autoComplete="off"
                  />
                  <FieldDescription>
                    A GA4 measurement id. Container (<code>GTM-</code>) and legacy
                    (<code>UA-</code>) ids are not supported. Google Analytics
                    sets cookies and shares data with Google — in many
                    jurisdictions that needs consent, and needs saying in your{" "}
                    <a
                      href="/admin/legal"
                      className="underline underline-offset-4 hover:text-primary"
                    >
                      privacy policy
                    </a>
                    .
                  </FieldDescription>
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
            {enabled ? "Save analytics" : "Save (analytics off)"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
