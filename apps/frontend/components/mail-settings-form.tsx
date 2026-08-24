"use client";

import * as React from "react";

import type { AdminMailSettings, AdminSettingsUpdate, MailProvider } from "@/lib/api";
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
import { Switch } from "@/components/ui/switch";

/**
 * The outbound-email form, shared by the setup wizard and the admin settings
 * page so the two never drift, mirroring `CaptchaSettingsForm`.
 *
 * Both secrets (the SMTP password and the Resend API key) are write-only: the
 * backend stores them encrypted and can never return them. An empty field
 * therefore means "leave the stored one unchanged", which is why the parent
 * passes `hasStoredSmtpPassword` / `hasStoredResendKey`. The form itself cannot
 * tell whether a secret exists.
 */

export interface MailFormValue {
  enabled: boolean;
  provider: MailProvider | null;
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  /** Kept as a string so the input can legitimately be empty. */
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  smtpSecure: boolean;
  resendApiKey: string;
}

export const EMPTY_MAIL: MailFormValue = {
  enabled: false,
  provider: null,
  fromName: "",
  fromEmail: "",
  smtpHost: "",
  smtpPort: "",
  smtpUser: "",
  smtpPassword: "",
  smtpSecure: false,
  resendApiKey: "",
};

/** Seed the form from what the server reports, minus the unreadable secrets. */
export function mailFromSettings(mail: AdminMailSettings): MailFormValue {
  return {
    enabled: mail.enabled,
    provider: mail.provider,
    fromName: mail.fromName ?? "",
    fromEmail: mail.fromEmail ?? "",
    smtpHost: mail.smtpHost ?? "",
    smtpPort: mail.smtpPort?.toString() ?? "",
    smtpUser: mail.smtpUser ?? "",
    smtpPassword: "",
    smtpSecure: mail.smtpSecure,
    resendApiKey: "",
  };
}

/** Translate form state into the API payload, honouring the write-only secrets. */
export function toMailPayload(
  value: MailFormValue,
  hasStoredSmtpPassword: boolean,
  hasStoredResendKey: boolean,
): NonNullable<AdminSettingsUpdate["mail"]> {
  return {
    enabled: value.enabled,
    provider: value.provider,
    fromName: value.fromName.trim() || null,
    fromEmail: value.fromEmail.trim() || null,
    smtpHost: value.smtpHost.trim() || null,
    smtpPort: value.smtpPort === "" ? null : Number(value.smtpPort),
    smtpUser: value.smtpUser.trim() || null,
    // Empty field means "keep the stored secret" when one exists, and "there is
    // nothing to store" when there is not. Never an accidental wipe.
    smtpPassword:
      value.smtpPassword !== ""
        ? value.smtpPassword
        : hasStoredSmtpPassword
          ? undefined
          : null,
    smtpSecure: value.smtpSecure,
    resendApiKey:
      value.resendApiKey !== ""
        ? value.resendApiKey
        : hasStoredResendKey
          ? undefined
          : null,
  };
}

/**
 * What still has to be filled in before this configuration could send anything.
 *
 * Returned as a list rather than a boolean so the caller can both disable its
 * save control *and* say which field is missing. A disabled button with no
 * explanation is a trap.
 */
export function mailIssues(
  value: MailFormValue,
  hasStoredSmtpPassword: boolean,
  hasStoredResendKey: boolean,
): string[] {
  if (!value.enabled) return [];
  const issues: string[] = [];
  if (!value.provider) issues.push("Choose a provider.");
  if (value.fromEmail.trim() === "") issues.push("Add the address mail is sent from.");
  if (value.provider === "smtp") {
    if (value.smtpHost.trim() === "") issues.push("Add the SMTP host.");
    if (value.smtpPort.trim() === "") issues.push("Add the SMTP port.");
  }
  if (value.provider === "resend" && value.resendApiKey === "" && !hasStoredResendKey) {
    issues.push("Add the Resend API key.");
  }
  // An SMTP server without auth is legitimate, so a blank password is only
  // flagged when a username was given: that pairing is always a mistake.
  if (
    value.provider === "smtp" &&
    value.smtpUser.trim() !== "" &&
    value.smtpPassword === "" &&
    !hasStoredSmtpPassword
  ) {
    issues.push("Add the SMTP password for that username.");
  }
  return issues;
}

export function MailSettingsForm({
  value,
  onChange,
  hasStoredSmtpPassword,
  hasStoredResendKey,
  idPrefix = "mail",
}: {
  value: MailFormValue;
  onChange: (next: MailFormValue) => void;
  hasStoredSmtpPassword: boolean;
  hasStoredResendKey: boolean;
  /** Distinguishes the wizard's inputs from the settings page's on one DOM. */
  idPrefix?: string;
}) {
  const set = <K extends keyof MailFormValue>(key: K, v: MailFormValue[K]) =>
    onChange({ ...value, [key]: v });

  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <div className="flex flex-1 flex-col gap-0.5">
          <FieldLabel htmlFor={id("enabled")}>Enable email</FieldLabel>
          <FieldDescription>
            When off, the panel runs without email: signup works, password reset
            is unavailable, and email changes apply immediately.
          </FieldDescription>
        </div>
        <Switch
          id={id("enabled")}
          checked={value.enabled}
          onCheckedChange={(checked) => set("enabled", checked)}
        />
      </Field>

      {value.enabled && (
        <>
          <Field>
            <FieldLabel htmlFor={id("provider")}>Provider</FieldLabel>
            <Select
              value={value.provider ?? ""}
              onValueChange={(v) => set("provider", (v as MailProvider) || null)}
            >
              <SelectTrigger id={id("provider")} className="w-full">
                <SelectValue placeholder="Choose a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smtp">SMTP</SelectItem>
                <SelectItem value="resend">Resend (HTTP API)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor={id("from-name")}>From name</FieldLabel>
            <Input
              id={id("from-name")}
              value={value.fromName}
              onChange={(e) => set("fromName", e.target.value)}
              placeholder="CitadelPanel"
              maxLength={128}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("from-email")}>From email</FieldLabel>
            <Input
              id={id("from-email")}
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
                <FieldLabel htmlFor={id("smtp-host")}>SMTP host</FieldLabel>
                <Input
                  id={id("smtp-host")}
                  value={value.smtpHost}
                  onChange={(e) => set("smtpHost", e.target.value)}
                  placeholder="smtp.example.com"
                  maxLength={255}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={id("smtp-port")}>SMTP port</FieldLabel>
                <Input
                  id={id("smtp-port")}
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
                <FieldLabel htmlFor={id("smtp-user")}>SMTP username</FieldLabel>
                <Input
                  id={id("smtp-user")}
                  value={value.smtpUser}
                  onChange={(e) => set("smtpUser", e.target.value)}
                  placeholder="Leave blank if your server needs no auth"
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={id("smtp-password")}>SMTP password</FieldLabel>
                <Input
                  id={id("smtp-password")}
                  type="password"
                  value={value.smtpPassword}
                  onChange={(e) => set("smtpPassword", e.target.value)}
                  placeholder={
                    hasStoredSmtpPassword
                      ? "Stored, leave blank to keep unchanged"
                      : "Server password"
                  }
                  autoComplete="off"
                />
              </Field>
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-0.5">
                  <FieldLabel htmlFor={id("smtp-secure")}>Use TLS</FieldLabel>
                  <FieldDescription>
                    Implicit TLS on port 465; off for STARTTLS on 587/25.
                  </FieldDescription>
                </div>
                <Switch
                  id={id("smtp-secure")}
                  checked={value.smtpSecure}
                  onCheckedChange={(checked) => set("smtpSecure", checked)}
                />
              </Field>
            </>
          )}

          {value.provider === "resend" && (
            <Field>
              <FieldLabel htmlFor={id("resend-key")}>Resend API key</FieldLabel>
              <Input
                id={id("resend-key")}
                type="password"
                value={value.resendApiKey}
                onChange={(e) => set("resendApiKey", e.target.value)}
                placeholder={
                  hasStoredResendKey
                    ? "Stored, leave blank to keep unchanged"
                    : "re_xxxxxxxxxxxx"
                }
                autoComplete="off"
              />
            </Field>
          )}
        </>
      )}
    </FieldGroup>
  );
}
