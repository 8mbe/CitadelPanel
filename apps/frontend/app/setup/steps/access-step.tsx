"use client";

import * as React from "react";

import {
  ApiError,
  updateSetupSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
} from "@/lib/api";
import {
  CaptchaSettingsForm,
  toCaptchaPayload,
  type CaptchaFormValue,
} from "@/components/captcha-settings-form";
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
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

import { BlockingIssues, ErrorNote, StepNav, WarningNote } from "./wizard-ui";

/**
 * Step 3: who may create an account, and what stands between a bot and the
 * sign-in form.
 *
 * These two settings are one step because they are one decision. Open
 * registration on a public panel without a captcha is the combination that
 * fills a database with junk accounts overnight, and pairing them here is the
 * only place the operator sees both at once.
 *
 * Registration defaults to open, which is the riskier default, so this step is
 * shown rather than hidden behind "advanced".
 */
export function AccessStep({
  settings,
  onSaved,
  onBack,
}: {
  settings: AdminSettings;
  onSaved: (update: AdminSettingsUpdate) => Promise<void>;
  onBack: () => void;
}) {
  const [registrationOpen, setRegistrationOpen] = React.useState(
    settings.registration.enabled,
  );
  const [disabledMessage, setDisabledMessage] = React.useState(
    settings.registration.disabledMessage,
  );
  const [captcha, setCaptcha] = React.useState<CaptchaFormValue>({
    enabled: settings.captcha.enabled,
    provider: settings.captcha.provider,
    siteKey: settings.captcha.siteKey ?? "",
    secretKey: "",
    apiEndpoint: settings.captcha.apiEndpoint ?? "",
    minScore: settings.captcha.minScore,
  });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const hasStoredSecret = settings.captcha.hasSecretKey;

  const issues: string[] = [];
  if (captcha.enabled) {
    if (!captcha.provider) issues.push("Choose a captcha provider, or turn the captcha off.");
    if (captcha.siteKey.trim() === "") issues.push("Add the captcha site key.");
    if (captcha.secretKey.trim() === "" && !hasStoredSecret) {
      issues.push("Add the captcha secret key.");
    }
    if (captcha.provider === "cap" && captcha.apiEndpoint.trim() === "") {
      issues.push("Add the Cap API endpoint.");
    }
  }

  const save = async () => {
    setLoading(true);
    setError(null);
    const update: AdminSettingsUpdate = {
      registration: {
        enabled: registrationOpen,
        disabledMessage: disabledMessage.trim(),
      },
      captcha: toCaptchaPayload(captcha, hasStoredSecret),
    };
    try {
      await updateSetupSettings(update);
      await onSaved(update);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "The access settings could not be saved. Check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <CardHeader>
        <CardTitle>Who can get in</CardTitle>
        <CardDescription>
          Whether strangers may create their own accounts, and whether the
          sign-in forms are protected against automated abuse. Both can be
          changed later in settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="setup-registration">
                Allow public sign-up
              </FieldLabel>
              <FieldDescription>
                When off, only you can create accounts, from the admin area.
              </FieldDescription>
            </div>
            <Switch
              id="setup-registration"
              checked={registrationOpen}
              onCheckedChange={setRegistrationOpen}
            />
          </Field>

          {!registrationOpen && (
            <Field>
              <FieldLabel htmlFor="setup-registration-message">
                Message on the sign-up page
              </FieldLabel>
              <Input
                id="setup-registration-message"
                value={disabledMessage}
                onChange={(e) => setDisabledMessage(e.target.value)}
                placeholder="Registration is invite-only. Ask an administrator for an account."
                maxLength={256}
              />
              <FieldDescription>
                Shown to anyone who reaches sign-up. Tell them how to ask for
                access, or they will assume the panel is broken.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>

        {registrationOpen && !captcha.enabled && (
          <WarningNote>
            Anyone who can reach this panel can create an account. That is fine
            on a private network. If this panel is on the public internet, turn
            on a captcha below or close sign-up.
          </WarningNote>
        )}

        <Separator />

        <CaptchaSettingsForm
          value={captcha}
          onChange={setCaptcha}
          hasStoredSecret={hasStoredSecret}
        />

        {error && (
          <ErrorNote title="Could not save" onRetry={save} retrying={loading}>
            {error}
          </ErrorNote>
        )}
        <BlockingIssues issues={issues} />

        <StepNav
          onBack={onBack}
          onNext={save}
          loading={loading}
          nextDisabled={issues.length > 0}
          nextLabel="Save and continue"
        />
      </CardContent>
    </>
  );
}
