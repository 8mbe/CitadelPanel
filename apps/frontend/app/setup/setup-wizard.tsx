"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Castle,
  Check,
  Clock,
  Copy,
  KeyRound,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import {
  adminCreateNode,
  completeSetup,
  setupCreateAdmin,
  updateSetupSettings,
  type SetupStatus,
} from "@/lib/api";
import { guessTimezone, listTimezones } from "@/lib/timezones";
import { markSetupComplete } from "@/lib/setup-gate";
import {
  CaptchaSettingsForm,
  EMPTY_CAPTCHA,
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
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * First-time setup wizard.
 *
 * Reached automatically on a fresh install (the login page redirects here while
 * `needsSetup` is true) and self-closing once done. Four steps, of which only
 * the first two are mandatory:
 *
 *   1. Admin account   — the one unauthenticated step; claims the first admin.
 *   2. Timezone        — how the panel renders timestamps.
 *   3. Captcha         — optional bot protection for the auth endpoints.
 *   4. First node      — optional; an operator without a node yet can skip it.
 *
 * Step 1 signs the browser in (the backend returns a session cookie), so steps
 * 2–4 authenticate as the freshly-created admin. If an admin already exists when
 * the wizard loads — someone else finished step 1, or the account was made by
 * CLI — step 1 is skipped and the wizard asks the operator to sign in.
 *
 * The server page reads setup status before this component is rendered. That
 * prevents a completed installation from ever serving the wizard UI.
 */

type StepId = "admin" | "timezone" | "captcha" | "node";

interface StepMeta {
  id: StepId;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepMeta[] = [
  { id: "admin", title: "Admin account", icon: ShieldCheck },
  { id: "timezone", title: "Timezone", icon: Clock },
  { id: "captcha", title: "Bot protection", icon: KeyRound },
  { id: "node", title: "First node", icon: ServerCog },
];

export default function SetupWizard({
  initialStatus: status,
}: {
  initialStatus: SetupStatus;
}) {
  // When an admin already exists, the server page has verified the caller's
  // admin session before rendering this component.
  const [step, setStep] = React.useState<StepId>(
    status.canCreateAdmin ? "admin" : "timezone",
  );
  const [adminDone, setAdminDone] = React.useState(!status.canCreateAdmin);

  const currentIndex = STEPS.findIndex((s) => s.id === step);

  const goNext = () => {
    const next = STEPS[currentIndex + 1];
    if (next) setStep(next.id);
  };

  return (
    <CenteredShell>
      <div className="flex w-full max-w-xl flex-col gap-6">
        <header className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Castle className="size-5" />
          </span>
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Welcome to CitadelPanel
          </h1>
          <p className="text-sm text-muted-foreground">
            A few steps to configure your panel. This runs only once.
          </p>
        </header>

        <Stepper steps={STEPS} currentIndex={currentIndex} adminDone={adminDone} />

        <Card className="w-full">
          {step === "admin" && (
            <AdminStep
              onDone={() => {
                setAdminDone(true);
                goNext();
              }}
            />
          )}
          {step === "timezone" && (
            <TimezoneStep
              initial={status.timezone}
              onDone={goNext}
              onBack={undefined}
            />
          )}
          {step === "captcha" && (
            <CaptchaStep onDone={goNext} onBack={() => setStep("timezone")} />
          )}
          {step === "node" && (
            <NodeStep onBack={() => setStep("captcha")} />
          )}
        </Card>
      </div>
    </CenteredShell>
  );
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background p-4">
      {children}
    </div>
  );
}

/** The progress rail across the top of the card. */
function Stepper({
  steps,
  currentIndex,
  adminDone,
}: {
  steps: StepMeta[];
  currentIndex: number;
  adminDone: boolean;
}) {
  return (
    <ol className="flex flex-col gap-0 sm:flex-row sm:items-start sm:justify-between">
      {steps.map((meta, index) => {
        const done = index < currentIndex || (meta.id === "admin" && adminDone);
        const active = index === currentIndex;
        const Icon = meta.icon;
        const isLast = index === steps.length - 1;

        return (
          <li
            key={meta.id}
            className="group relative flex items-start gap-3 sm:flex-1 sm:flex-col sm:items-center sm:gap-2"
          >
            <div
              className={cn(
                "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border-2 text-sm transition-colors",
                active &&
                  "border-primary bg-primary text-primary-foreground shadow-sm",
                done && "border-primary bg-primary text-primary-foreground",
                !active &&
                  !done &&
                  "border-border bg-background text-muted-foreground",
              )}
            >
              {done ? <Check className="size-4" /> : <Icon className="size-4" />}
            </div>

            <div className="flex flex-col pt-1.5 sm:items-center sm:pt-0">
              <span
                className={cn(
                  "text-sm font-medium leading-none transition-colors",
                  active && "text-foreground",
                  done && "text-foreground",
                  !active && !done && "text-muted-foreground",
                )}
              >
                {meta.title}
              </span>
            </div>

            {!isLast && (
              <div
                className={cn(
                  "absolute left-4 top-9 w-0.5 -translate-x-1/2 sm:left-1/2 sm:top-4 sm:h-0.5 sm:w-full sm:-translate-x-0",
                  done ? "bg-primary" : "bg-border",
                )}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// --- Step 1: admin account ---------------------------------------------------

function AdminStep({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const data = new FormData(e.currentTarget);
    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirm") ?? "");

    if (password !== confirm) {
      setError("The two passwords do not match.");
      setLoading(false);
      return;
    }

    try {
      await setupCreateAdmin({
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        password,
      });
      onDone();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create the account.",
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
          and reviews security flags. There is no default password — you set the
          only credential now.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="admin-name">Name</FieldLabel>
              <Input id="admin-name" name="name" required placeholder="Ada Lovelace" />
            </Field>
            <Field>
              <FieldLabel htmlFor="admin-email">Email</FieldLabel>
              <Input
                id="admin-email"
                name="email"
                type="email"
                required
                placeholder="you@example.com"
                autoComplete="email"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="admin-password">Password</FieldLabel>
              <Input
                id="admin-password"
                name="password"
                type="password"
                required
                minLength={12}
                placeholder="At least 12 characters"
                autoComplete="new-password"
              />
              <FieldDescription>
                Minimum 12 characters. Choose something you have not used
                elsewhere.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="admin-confirm">Confirm password</FieldLabel>
              <Input
                id="admin-confirm"
                name="confirm"
                type="password"
                required
                minLength={12}
                placeholder="Repeat the password"
                autoComplete="new-password"
              />
            </Field>
          </FieldGroup>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={loading} className="w-full">
            {loading && <Spinner />}
            Create account and continue
            {!loading && <ArrowRight />}
          </Button>
        </form>
      </CardContent>
    </>
  );
}

// --- Step 2: timezone --------------------------------------------------------

function TimezoneStep({
  initial,
  onDone,
  onBack,
}: {
  initial: string;
  onDone: () => void;
  onBack?: () => void;
}) {
  // Prefer the stored value, but if it is still the untouched default, suggest
  // the browser's zone so the operator usually just confirms.
  const [timezone, setTimezone] = React.useState(
    initial && initial !== "UTC" ? initial : guessTimezone(),
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const zones = React.useMemo(() => listTimezones(), []);

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      await updateSetupSettings({ timezone });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the timezone.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <CardHeader>
        <CardTitle>Panel timezone</CardTitle>
        <CardDescription>
          How timestamps are displayed across the panel — audit logs, activity,
          heartbeat times. Stored data stays in UTC; this only affects display.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
          <Select
            value={timezone}
            onValueChange={(value) => setTimezone(value ?? "UTC")}
          >
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
          <FieldDescription>
            Detected: {guessTimezone()}. You can change this later in settings.
          </FieldDescription>
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <StepNav onBack={onBack} onNext={save} loading={loading} nextLabel="Save and continue" />
      </CardContent>
    </>
  );
}

// --- Step 3: captcha ---------------------------------------------------------

function CaptchaStep({
  onDone,
  onBack,
}: {
  onDone: () => void;
  onBack: () => void;
}) {
  const [value, setValue] = React.useState<CaptchaFormValue>(EMPTY_CAPTCHA);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      // During setup there is never a previously-stored secret.
      await updateSetupSettings({ captcha: toCaptchaPayload(value, false) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save captcha settings.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <CardHeader>
        <CardTitle>Bot protection</CardTitle>
        <CardDescription>
          Optional. Add a captcha to sign-in, sign-up and password reset. You can
          enable this later, or leave it off if the panel is on a private
          network.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <CaptchaSettingsForm
          value={value}
          onChange={setValue}
          hasStoredSecret={false}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <StepNav
          onBack={onBack}
          onNext={save}
          loading={loading}
          nextLabel={value.enabled ? "Save and continue" : "Skip for now"}
        />
      </CardContent>
    </>
  );
}

// --- Step 4: first node ------------------------------------------------------

function NodeStep({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    token?: string;
    warning?: string;
    reachable: boolean;
  } | null>(null);

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      await completeSetup();
      // Prime the setup-gate cache so no later visit re-checks the backend.
      markSetupComplete();
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish setup.");
      setFinishing(false);
    }
  };

  const registerNode = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const data = new FormData(e.currentTarget);
    const token = String(data.get("token") ?? "").trim();
    const diskTotalGb = Number(data.get("diskTotalGb") ?? 0);

    try {
      const response = await adminCreateNode({
        name: String(data.get("name") ?? ""),
        hostname: String(data.get("hostname") ?? ""),
        apiUrl: String(data.get("apiUrl") ?? ""),
        token: token || undefined,
        // The form asks for GB — the friendlier unit — and converts to the MB
        // the API expects. CPU and memory are omitted on purpose: the backend
        // probes them from the agent when reachable and falls back to defaults
        // when it is not, so an offline node still registers.
        diskTotalMb: Math.round(diskTotalGb * 1024),
      });
      setResult({
        token: response.token,
        warning: response.warning,
        reachable: response.health.reachable,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register the node.");
    } finally {
      setLoading(false);
    }
  };

  // Once a node is registered, the step turns into a confirmation with the
  // one-time token (if generated) and a single button to finish.
  if (result) {
    return (
      <>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Check className="size-5 text-primary" />
            Node registered
          </CardTitle>
          <CardDescription>
            {result.reachable
              ? "The agent responded and its capacity was recorded."
              : "The node was saved, but its agent did not respond yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {result.token && <GeneratedToken token={result.token} />}
          {result.warning && !result.token && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <span className="text-muted-foreground">{result.warning}</span>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={finish} disabled={finishing} className="w-full">
            {finishing && <Spinner />}
            Finish setup
            {!finishing && <ArrowRight />}
          </Button>
        </CardContent>
      </>
    );
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Add your first node</CardTitle>
        <CardDescription>
          A node is a machine running the CitadelPanel agent that hosts game
          servers. You need at least one to provision servers — but you can skip
          this now and add one later from the admin area.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form onSubmit={registerNode} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="node-name">Display name</FieldLabel>
              <Input id="node-name" name="name" required placeholder="Aurora 1" />
            </Field>
            <Field>
              <FieldLabel htmlFor="node-hostname">Hostname</FieldLabel>
              <Input
                id="node-hostname"
                name="hostname"
                required
                placeholder="aurora1.example.com"
              />
              <FieldDescription>
                The address players connect to, not the agent.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="node-api-url">Agent URL</FieldLabel>
              <Input
                id="node-api-url"
                name="apiUrl"
                required
                placeholder="https://10.0.1.20:8081"
              />
              <FieldDescription>
                Where the node agent listens. Keep it on a private network or
                behind TLS — the token below is root-equivalent for that machine.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="node-token">Agent token</FieldLabel>
              <Input
                id="node-token"
                name="token"
                type="password"
                placeholder="Leave blank to generate one"
                autoComplete="off"
              />
              <FieldDescription>
                The agent&apos;s AGENT_TOKEN. Leave blank to have one generated
                and shown once.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="node-disk">Disk capacity (GB)</FieldLabel>
              <Input
                id="node-disk"
                name="diskTotalGb"
                type="number"
                min={1}
                required
                defaultValue={100}
              />
              <FieldDescription>
                CPU and memory are read from the agent automatically when it is
                reachable.
              </FieldDescription>
            </Field>
          </FieldGroup>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={finish}
              disabled={finishing}
              className="ml-auto"
            >
              {finishing && <Spinner />}
              Skip — I&apos;ll add one later
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Spinner />}
              Register node
            </Button>
          </div>
        </form>
      </CardContent>
    </>
  );
}

/** The one-time generated agent token, with copy-to-clipboard. */
function GeneratedToken({ token }: { token: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the operator can still select the text manually.
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2 text-sm">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span className="text-muted-foreground">
          Copy this token now — it is stored encrypted and cannot be shown again.
          Set it as <code className="text-foreground">AGENT_TOKEN</code> on the
          node and restart its agent.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {token}
        </code>
        <Button type="button" size="icon" variant="outline" onClick={copy}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/** Shared back/next control for the middle steps. */
function StepNav({
  onBack,
  onNext,
  loading,
  nextLabel,
}: {
  onBack?: () => void;
  onNext: () => void;
  loading: boolean;
  nextLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {onBack && (
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      )}
      <Button
        type="button"
        onClick={onNext}
        disabled={loading}
        className="ml-auto"
      >
        {loading && <Spinner />}
        {nextLabel}
        {!loading && <ArrowRight />}
      </Button>
    </div>
  );
}
