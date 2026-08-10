"use client";

import * as React from "react";
import { Info } from "lucide-react";

import type { CaptchaProvider, CaptchaSettingsInput } from "@/lib/api";
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
 * The captcha configuration form, shared by the setup wizard and the admin
 * settings page so the two never drift.
 *
 * The `secretKey` is write-only: the backend stores it encrypted and can never
 * return it, so when an existing secret is already stored the field shows a
 * placeholder and an empty submission is read as "leave it unchanged". This is
 * why the parent passes `hasStoredSecret` — the form itself cannot tell whether
 * a secret exists.
 */

interface ProviderMeta {
  value: CaptchaProvider;
  label: string;
  /** Where the operator gets their site/secret keys. */
  hint: string;
  /** Cap is self-hosted, so it needs an endpoint the others infer. */
  needsEndpoint: boolean;
  /** reCAPTCHA v3 has a score threshold; the others do not. */
  hasScore: boolean;
}

const PROVIDERS: ProviderMeta[] = [
  {
    value: "cloudflare-turnstile",
    label: "Cloudflare Turnstile",
    hint: "Create a widget at dash.cloudflare.com → Turnstile. Free, privacy-friendly.",
    needsEndpoint: false,
    hasScore: false,
  },
  {
    value: "google-recaptcha",
    label: "Google reCAPTCHA",
    hint: "Register a site at google.com/recaptcha/admin. v2 checkbox or v3 score both work.",
    needsEndpoint: false,
    hasScore: true,
  },
  {
    value: "cap",
    label: "Cap (self-hosted)",
    hint: "Self-hosted proof-of-work captcha (capjs.js.org / trycap.dev). No third party involved.",
    needsEndpoint: true,
    hasScore: false,
  },
];

export interface CaptchaFormValue {
  enabled: boolean;
  provider: CaptchaProvider | null;
  siteKey: string;
  secretKey: string;
  apiEndpoint: string;
  minScore: number;
}

export const EMPTY_CAPTCHA: CaptchaFormValue = {
  enabled: false,
  provider: null,
  siteKey: "",
  secretKey: "",
  apiEndpoint: "",
  minScore: 0.5,
};

/** Translate the form state into the API payload, honouring the write-only secret. */
export function toCaptchaPayload(
  value: CaptchaFormValue,
  hasStoredSecret: boolean,
): CaptchaSettingsInput {
  return {
    enabled: value.enabled,
    provider: value.provider,
    siteKey: value.siteKey.trim() || null,
    // An empty secret field means "unchanged" when one is already stored, but
    // "clear it" is never needed here — disabling keeps the stored keys.
    secretKey:
      value.secretKey.trim() !== ""
        ? value.secretKey.trim()
        : hasStoredSecret
          ? undefined
          : null,
    apiEndpoint: value.apiEndpoint.trim() || null,
    minScore: value.minScore,
  };
}

export function CaptchaSettingsForm({
  value,
  onChange,
  hasStoredSecret,
}: {
  value: CaptchaFormValue;
  onChange: (next: CaptchaFormValue) => void;
  hasStoredSecret: boolean;
}) {
  const meta = PROVIDERS.find((p) => p.value === value.provider);

  const set = <K extends keyof CaptchaFormValue>(
    key: K,
    v: CaptchaFormValue[K],
  ) => onChange({ ...value, [key]: v });

  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <div className="flex flex-1 flex-col gap-0.5">
          <FieldLabel htmlFor="captcha-enabled">Require a captcha</FieldLabel>
          <FieldDescription>
            Protects sign-in, sign-up and password reset against automated abuse.
          </FieldDescription>
        </div>
        <Switch
          id="captcha-enabled"
          checked={value.enabled}
          onCheckedChange={(checked) => set("enabled", checked)}
        />
      </Field>

      {value.enabled && (
        <>
          <Field>
            <FieldLabel htmlFor="captcha-provider">Provider</FieldLabel>
            <Select
              value={value.provider ?? ""}
              onValueChange={(v) => set("provider", v as CaptchaProvider)}
            >
              <SelectTrigger id="captcha-provider" className="w-full">
                <SelectValue placeholder="Choose a captcha provider" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((provider) => (
                  <SelectItem key={provider.value} value={provider.value}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {meta && (
              <FieldDescription className="flex items-start gap-1.5">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                {meta.hint}
              </FieldDescription>
            )}
          </Field>

          {value.provider && (
            <>
              <Field>
                <FieldLabel htmlFor="captcha-site-key">Site key</FieldLabel>
                <Input
                  id="captcha-site-key"
                  value={value.siteKey}
                  onChange={(e) => set("siteKey", e.target.value)}
                  placeholder="Public key, embedded in the page"
                  autoComplete="off"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="captcha-secret-key">Secret key</FieldLabel>
                <Input
                  id="captcha-secret-key"
                  type="password"
                  value={value.secretKey}
                  onChange={(e) => set("secretKey", e.target.value)}
                  placeholder={
                    hasStoredSecret
                      ? "Stored — leave blank to keep unchanged"
                      : "Server-side key, kept encrypted"
                  }
                  autoComplete="off"
                />
                <FieldDescription>
                  Stored encrypted and never shown again after saving.
                </FieldDescription>
              </Field>

              {meta?.needsEndpoint && (
                <Field>
                  <FieldLabel htmlFor="captcha-endpoint">API endpoint</FieldLabel>
                  <Input
                    id="captcha-endpoint"
                    value={value.apiEndpoint}
                    onChange={(e) => set("apiEndpoint", e.target.value)}
                    placeholder="https://cap.example.com/<site-key>/"
                    autoComplete="off"
                  />
                  <FieldDescription>
                    Your Cap instance URL including the site-key path segment.
                  </FieldDescription>
                </Field>
              )}

              {meta?.hasScore && (
                <Field>
                  <FieldLabel htmlFor="captcha-min-score">
                    Minimum score (reCAPTCHA v3)
                  </FieldLabel>
                  <Input
                    id="captcha-min-score"
                    type="number"
                    min={0}
                    max={1}
                    step={0.1}
                    value={value.minScore}
                    onChange={(e) =>
                      set("minScore", Number(e.target.value) || 0)
                    }
                  />
                  <FieldDescription>
                    Requests scoring below this are rejected. 0.5 is a sensible
                    default; ignored for v2 checkbox widgets.
                  </FieldDescription>
                </Field>
              )}
            </>
          )}
        </>
      )}
    </FieldGroup>
  );
}
