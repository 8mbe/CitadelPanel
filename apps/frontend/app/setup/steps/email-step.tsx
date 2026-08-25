"use client";

import * as React from "react";
import { Send } from "lucide-react";

import {
  ApiError,
  sendTestEmail,
  updateSetupSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
} from "@/lib/api";
import {
  MailSettingsForm,
  mailFromSettings,
  mailIssues,
  toMailPayload,
  type MailFormValue,
} from "@/components/mail-settings-form";
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
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

import {
  BlockingIssues,
  ErrorNote,
  StepNav,
  SuccessNote,
  WarningNote,
} from "./wizard-ui";

/**
 * Step 4: outbound email, and whether sign-in requires a verified address.
 *
 * The step exists mainly so the operator finds out here, rather than the first
 * time a user forgets a password, that the panel cannot send mail. It carries
 * the test-send probe for exactly that reason: mail configuration is the kind
 * that looks saved and still does not work, so the step lets the operator prove
 * it end to end before moving on.
 *
 * Verification lives here because it depends on mail: requiring a verified
 * address with no way to send the verification email locks everyone out, so the
 * control is disabled until mail is on.
 */
export function EmailStep({
  settings,
  adminEmail,
  onSaved,
  onContinue,
  onBack,
}: {
  settings: AdminSettings;
  /** Pre-fills the test-send field: the operator's own inbox is the one they can check. */
  adminEmail: string;
  onSaved: (update: AdminSettingsUpdate) => Promise<void>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [value, setValue] = React.useState<MailFormValue>(() =>
    mailFromSettings(settings.mail),
  );
  const [requireVerified, setRequireVerified] = React.useState(
    settings.verification.requireVerifiedSignIn,
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [testTo, setTestTo] = React.useState(adminEmail);
  const [testing, setTesting] = React.useState(false);
  const [testOk, setTestOk] = React.useState<boolean | null>(null);
  const [testMessage, setTestMessage] = React.useState<string | null>(null);

  const hasSmtpPassword = settings.mail.hasSmtpPassword;
  const hasResendKey = settings.mail.hasResendApiKey;
  const issues = mailIssues(value, hasSmtpPassword, hasResendKey);

  const buildUpdate = (): AdminSettingsUpdate => ({
    mail: toMailPayload(value, hasSmtpPassword, hasResendKey),
    // Never leave the panel demanding a verification email it cannot send.
    verification: { requireVerifiedSignIn: value.enabled && requireVerified },
  });

  const save = async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const update = buildUpdate();
    try {
      await updateSetupSettings(update);
      await onSaved(update);
      return true;
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "The email settings could not be saved. Check your connection and try again.",
      );
      return false;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Save first, then send. The probe runs against stored settings, so testing
   * un-saved form values would report on the previous configuration and be
   * quietly, confusingly wrong.
   */
  const saveAndTest = async () => {
    setTesting(true);
    setTestOk(null);
    setTestMessage(null);
    const ok = await save();
    if (!ok) {
      setTesting(false);
      return;
    }
    try {
      const result = await sendTestEmail(testTo.trim());
      setTestOk(result.ok);
      setTestMessage(
        result.ok
          ? `Sent to ${testTo.trim()}. Check the inbox, and the spam folder.`
          : "The provider accepted the settings but refused the message. Check the from-address is one the provider allows you to send as.",
      );
    } catch (err) {
      setTestOk(false);
      setTestMessage(
        err instanceof ApiError
          ? err.message
          : "The test email could not be sent. Check the host, port and credentials above.",
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <CardHeader>
        <CardTitle>Outbound email</CardTitle>
        <CardDescription>
          Optional. Without it the panel still works, but password resets are
          unavailable and nothing can be verified by email. You can add it later
          in settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <MailSettingsForm
          value={value}
          onChange={(next) => {
            setValue(next);
            // Any edit invalidates the previous probe: a green tick under
            // changed credentials is a lie.
            setTestOk(null);
            setTestMessage(null);
          }}
          hasStoredSmtpPassword={hasSmtpPassword}
          hasStoredResendKey={hasResendKey}
          idPrefix="setup-mail"
        />

        {value.enabled && (
          <>
            <Separator />
            <Field>
              <FieldLabel htmlFor="setup-mail-test">
                Send a test email
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="setup-mail-test"
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@example.com"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={saveAndTest}
                  disabled={
                    testing || loading || issues.length > 0 || testTo.trim() === ""
                  }
                >
                  {testing ? <Spinner /> : <Send />}
                  Send
                </Button>
              </div>
              <FieldDescription>
                Saves these settings, then sends one message through them. The
                only way to know email works before a user needs it.
              </FieldDescription>
            </Field>

            {testOk === true && testMessage && (
              <SuccessNote>{testMessage}</SuccessNote>
            )}
            {testOk === false && testMessage && (
              <ErrorNote
                title="The test email did not go out"
                onRetry={saveAndTest}
                retrying={testing}
                retryLabel="Send again"
              >
                {testMessage}
              </ErrorNote>
            )}

            <Separator />

            <Field orientation="horizontal">
              <div className="flex flex-1 flex-col gap-0.5">
                <FieldLabel htmlFor="setup-require-verified">
                  Require a verified email to sign in
                </FieldLabel>
                <FieldDescription>
                  New accounts must click a link in their inbox before their
                  first sign-in.
                </FieldDescription>
              </div>
              <Switch
                id="setup-require-verified"
                checked={requireVerified}
                onCheckedChange={setRequireVerified}
              />
            </Field>

            {requireVerified && testOk !== true && (
              <WarningNote>
                Send the test email first. If mail does not actually work, every
                new account, including any you create, will be unable to sign in.
              </WarningNote>
            )}
          </>
        )}

        {error && (
          <ErrorNote title="Could not save" onRetry={save} retrying={loading}>
            {error}
          </ErrorNote>
        )}
        <BlockingIssues issues={issues} />

        <StepNav
          onBack={onBack}
          onNext={async () => {
            if (await save()) onContinue();
          }}
          loading={loading}
          nextDisabled={issues.length > 0}
          nextLabel={value.enabled ? "Save and continue" : "Continue without email"}
        />
      </CardContent>
    </>
  );
}
