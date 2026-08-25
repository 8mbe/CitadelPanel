"use client";

import * as React from "react";
import {
  Castle,
  Check,
  Clock,
  Mail,
  ServerCog,
  ShieldCheck,
  Users,
} from "lucide-react";

import {
  ApiError,
  completeSetup,
  getAdminSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
  type ApiServerSummary,
  type SetupStatus,
} from "@/lib/api";
import { markSetupComplete } from "@/lib/setup-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { AccessStep } from "./steps/access-step";
import { AdminStep } from "./steps/admin-step";
import { EmailStep } from "./steps/email-step";
import { FinishStep } from "./steps/finish-step";
import { IdentityStep } from "./steps/identity-step";
import { NodeStep, type RegisteredNode } from "./steps/node-step";
import { ServerStep } from "./steps/server-step";
import { ErrorNote } from "./steps/wizard-ui";

/**
 * First-time setup wizard.
 *
 * Reached automatically on a fresh install (the login page redirects here while
 * `needsSetup` is true) and self-closing once done. Six steps, of which only
 * the first is mandatory:
 *
 *   1. Admin account: the one unauthenticated step; claims the first admin.
 *   2. Identity:      what the panel calls itself, and its timezone.
 *   3. Access:        who may sign up, and bot protection.
 *   4. Email:         outbound mail, verified with a real test send.
 *   5. Node:          the machine that runs servers, plus its port pool.
 *   6. First server:  provisioned live, which proves the whole chain works.
 *
 * The panel has far more configuration than this (backups, theming, analytics,
 * the AI helper, the legal pages). Those are all safe by default and are listed
 * on the final screen instead. A wizard that asks thirteen questions before the
 * operator has seen the panel is one they click through without reading, which
 * is worse than not asking.
 *
 * Step 1 signs the browser in (the backend returns a session cookie), so steps
 * 2 onwards authenticate as the freshly-created admin. If an admin already
 * exists when the wizard loads, whether someone else finished step 1 or the
 * account was made by CLI, step 1 is skipped and the server page has already
 * required an admin session.
 */

/**
 * Who the wizard is acting as. Resolved server-side when an admin already
 * exists, and captured from step 1's response when it does not: `/setup` runs
 * outside `SessionProvider`, because it has to work before any session exists.
 */
export interface SetupAdmin {
  id: string;
  email: string;
}

type StepId = "admin" | "identity" | "access" | "email" | "node" | "server";

interface StepMeta {
  id: StepId;
  title: string;
  /** The one-word version, for the cramped mobile rail. */
  short: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepMeta[] = [
  { id: "admin", title: "Admin account", short: "Account", icon: ShieldCheck },
  { id: "identity", title: "Panel identity", short: "Identity", icon: Clock },
  { id: "access", title: "Access", short: "Access", icon: Users },
  { id: "email", title: "Email", short: "Email", icon: Mail },
  { id: "node", title: "First node", short: "Node", icon: ServerCog },
  { id: "server", title: "First server", short: "Server", icon: Castle },
];

export default function SetupWizard({
  initialStatus: status,
  initialAdmin,
}: {
  initialStatus: SetupStatus;
  initialAdmin: SetupAdmin | null;
}) {
  const [admin, setAdmin] = React.useState<SetupAdmin | null>(initialAdmin);

  const [step, setStep] = React.useState<StepId>(
    status.canCreateAdmin ? "admin" : "identity",
  );
  const [adminDone, setAdminDone] = React.useState(!status.canCreateAdmin);

  /**
   * Panel settings, loaded once the caller is an admin. Every step after the
   * first is seeded from this, so a wizard resumed after a reload shows what
   * was already saved instead of blank defaults.
   */
  const [settings, setSettings] = React.useState<AdminSettings | null>(null);
  const [settingsError, setSettingsError] = React.useState<string | null>(null);

  const [node, setNode] = React.useState<RegisteredNode | null>(null);
  const [server, setServer] = React.useState<ApiServerSummary | null>(null);
  const [finished, setFinished] = React.useState(false);
  const [finishError, setFinishError] = React.useState<string | null>(null);

  const loadSettings = React.useCallback(async () => {
    // Nothing is set before the await: a synchronous setState here would make
    // the mount effect cascade a second render before the request even starts.
    try {
      const loaded = await getAdminSettings();
      setSettings(loaded);
      setSettingsError(null);
    } catch (err) {
      setSettingsError(
        err instanceof ApiError
          ? err.message
          : "The panel's current settings could not be read.",
      );
    }
  }, []);

  React.useEffect(() => {
    if (!adminDone) return;
    (async () => {
      await loadSettings();
    })();
  }, [adminDone, loadSettings]);

  const currentIndex = STEPS.findIndex((s) => s.id === step);

  const goTo = (id: StepId) => setStep(id);
  const goNext = () => {
    const next = STEPS[currentIndex + 1];
    if (next) setStep(next.id);
  };

  /**
   * Fold a saved patch into the local copy so later steps and the final summary
   * read the value that was actually stored, without a second round trip.
   */
  const applySaved = async (update: AdminSettingsUpdate) => {
    setSettings((prev) => (prev ? mergeSettings(prev, update) : prev));
    goNext();
  };

  const finish = async (created: ApiServerSummary | null) => {
    setFinishError(null);
    try {
      await completeSetup();
      // Prime the setup-gate cache so no later visit re-checks the backend.
      markSetupComplete();
      if (created) setServer(created);
      setFinished(true);
    } catch (err) {
      setFinishError(
        err instanceof ApiError
          ? err.message
          : "Setup could not be closed out. Everything you configured is saved; try again.",
      );
    }
  };

  if (finished && settings) {
    return (
      <CenteredShell>
        <div className="flex w-full max-w-xl flex-col gap-6">
          <WizardHeader siteName={settings.branding.siteName} done />
          <Card className="w-full">
            <FinishStep
              settings={settings}
              nodeName={node?.name ?? null}
              server={server}
            />
          </Card>
        </div>
      </CenteredShell>
    );
  }

  return (
    <CenteredShell>
      <div className="flex w-full max-w-xl flex-col gap-6">
        <WizardHeader siteName={settings?.branding.siteName ?? null} />

        <Stepper
          steps={STEPS}
          currentIndex={currentIndex}
          adminDone={adminDone}
          onSelect={(id) => {
            // Every later step needs an admin session, so nothing is reachable
            // until the account exists.
            if (adminDone && id !== "admin") goTo(id);
          }}
        />

        <Card className="w-full">
          {step === "admin" ? (
            <AdminStep
              onDone={(created) => {
                setAdmin(created);
                setAdminDone(true);
                goTo("identity");
              }}
            />
          ) : settingsError ? (
            <SettingsUnavailable message={settingsError} onRetry={loadSettings} />
          ) : !settings ? (
            <StepSkeleton />
          ) : step === "identity" ? (
            <IdentityStep settings={settings} onSaved={applySaved} />
          ) : step === "access" ? (
            <AccessStep
              settings={settings}
              onSaved={applySaved}
              onBack={() => goTo("identity")}
            />
          ) : step === "email" ? (
            <EmailStep
              settings={settings}
              adminEmail={admin?.email ?? ""}
              onSaved={async (update) => {
                setSettings((prev) => (prev ? mergeSettings(prev, update) : prev));
              }}
              onContinue={() => goTo("node")}
              onBack={() => goTo("access")}
            />
          ) : step === "node" ? (
            <NodeStep
              registered={node}
              onRegistered={setNode}
              onContinue={() => goTo("server")}
              onSkip={() => goTo("server")}
              onBack={() => goTo("email")}
            />
          ) : (
            <ServerStep
              ownerId={admin?.id ?? ""}
              nodeId={node?.id ?? null}
              nodeReady={Boolean(node?.health.reachable && node?.hasPortPool)}
              onFinish={finish}
              onBack={() => goTo("node")}
            />
          )}

          {finishError && (
            <CardContent className="pt-0">
              <ErrorNote title="Could not finish setup">{finishError}</ErrorNote>
            </CardContent>
          )}
        </Card>
      </div>
    </CenteredShell>
  );
}

/**
 * Apply a saved patch to the in-memory settings.
 *
 * Only the groups the wizard writes are merged. Write-only secrets become the
 * "one is stored" booleans the forms expect, since that is what a re-read would
 * have reported.
 */
function mergeSettings(
  current: AdminSettings,
  update: AdminSettingsUpdate,
): AdminSettings {
  const next: AdminSettings = { ...current };

  if (update.timezone !== undefined) next.timezone = update.timezone;
  if (update.branding) {
    next.branding = { ...next.branding, ...update.branding };
  }
  if (update.registration) {
    next.registration = { ...next.registration, ...update.registration };
  }
  if (update.captcha) {
    const c = update.captcha;
    next.captcha = {
      enabled: c.enabled,
      provider: c.provider ?? null,
      siteKey: c.siteKey ?? null,
      apiEndpoint: c.apiEndpoint ?? null,
      minScore: c.minScore ?? next.captcha.minScore,
      hasSecretKey:
        c.secretKey === undefined
          ? next.captcha.hasSecretKey
          : c.secretKey !== null && c.secretKey !== "",
    };
  }
  if (update.mail) {
    const m = update.mail;
    next.mail = {
      enabled: m.enabled,
      provider: m.provider ?? null,
      fromName: m.fromName ?? null,
      fromEmail: m.fromEmail ?? null,
      smtpHost: m.smtpHost ?? null,
      smtpPort: m.smtpPort ?? null,
      smtpUser: m.smtpUser ?? null,
      smtpSecure: m.smtpSecure ?? next.mail.smtpSecure,
      hasSmtpPassword:
        m.smtpPassword === undefined
          ? next.mail.hasSmtpPassword
          : m.smtpPassword !== null && m.smtpPassword !== "",
      hasResendApiKey:
        m.resendApiKey === undefined
          ? next.mail.hasResendApiKey
          : m.resendApiKey !== null && m.resendApiKey !== "",
    };
  }
  if (update.verification) next.verification = update.verification;

  return next;
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background p-4">
      {children}
    </div>
  );
}

function WizardHeader({
  siteName,
  done,
}: {
  siteName: string | null;
  done?: boolean;
}) {
  return (
    <header className="flex flex-col items-center gap-2 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
        {done ? <Check className="size-5" /> : <Castle className="size-5" />}
      </span>
      <h1 className="font-heading text-xl font-semibold tracking-tight">
        {done
          ? "You're all set"
          : `Welcome to ${siteName?.trim() || "CitadelPanel"}`}
      </h1>
      <p className="text-sm text-muted-foreground">
        {done
          ? "The wizard is closed. Everything here lives in the admin area from now on."
          : "A few steps to configure your panel. This runs only once."}
      </p>
    </header>
  );
}

/**
 * The progress rail.
 *
 * Six steps do not fit as six labelled dots on a phone, and a rail that wraps
 * reads as broken. So the small screen gets the one thing it needs, which is
 * where the operator is and how much is left, and the labelled rail appears
 * only where there is room for it.
 */
function Stepper({
  steps,
  currentIndex,
  adminDone,
  onSelect,
}: {
  steps: StepMeta[];
  currentIndex: number;
  adminDone: boolean;
  onSelect: (id: StepId) => void;
}) {
  const current = steps[currentIndex];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 sm:hidden">
        <span className="text-sm font-medium">{current?.title}</span>
        <span className="text-xs text-muted-foreground">
          Step {currentIndex + 1} of {steps.length}
        </span>
      </div>
      <Progress
        value={((currentIndex + 1) / steps.length) * 100}
        className="sm:hidden"
      />

      <ol className="hidden sm:flex sm:items-start sm:justify-between">
        {steps.map((meta, index) => {
          const done = index < currentIndex || (meta.id === "admin" && adminDone);
          const active = index === currentIndex;
          const reachable = adminDone && meta.id !== "admin";
          const Icon = meta.icon;
          const isLast = index === steps.length - 1;

          return (
            <li
              key={meta.id}
              className="relative flex flex-1 flex-col items-center gap-2"
            >
              <button
                type="button"
                onClick={() => reachable && onSelect(meta.id)}
                disabled={!reachable}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border-2 text-sm transition-colors",
                  reachable && "cursor-pointer",
                  active &&
                    "border-primary bg-primary text-primary-foreground shadow-sm",
                  done && "border-primary bg-primary text-primary-foreground",
                  !active &&
                    !done &&
                    "border-border bg-background text-muted-foreground",
                )}
              >
                {done ? <Check className="size-4" /> : <Icon className="size-4" />}
              </button>

              <span
                className={cn(
                  "text-center text-xs font-medium leading-none transition-colors",
                  active || done ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {meta.short}
              </span>

              {!isLast && (
                <div
                  className={cn(
                    "absolute left-1/2 top-4 h-0.5 w-full",
                    done ? "bg-primary" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The wizard cannot continue without knowing the current configuration. */
function SettingsUnavailable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <>
      <CardHeader />
      <CardContent>
        <ErrorNote title="Could not read the panel settings" onRetry={onRetry}>
          {message} The admin account was created, so you can also sign in and
          configure the panel from the admin area.
        </ErrorNote>
        <Button variant="ghost" className="mt-3" onClick={onRetry}>
          Reload settings
        </Button>
      </CardContent>
    </>
  );
}

function StepSkeleton() {
  return (
    <>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-9 w-32 self-end" />
      </CardContent>
    </>
  );
}
