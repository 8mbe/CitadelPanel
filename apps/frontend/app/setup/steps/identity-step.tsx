"use client";

import * as React from "react";

import {
  ApiError,
  updateSetupSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
} from "@/lib/api";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { guessTimezone, listTimezones } from "@/lib/timezones";

import { BlockingIssues, ErrorNote, StepNav } from "./wizard-ui";

/**
 * Step 2: what the panel calls itself and which clock it shows.
 *
 * Branding and timezone are one step because they are the same decision from
 * the operator's side: how this install presents itself. Both are pre-filled
 * (the site name from its default, the timezone from the browser), so the
 * common case is a glance and a click rather than two forms.
 */
export function IdentityStep({
  settings,
  onSaved,
  onBack,
}: {
  settings: AdminSettings;
  onSaved: (update: AdminSettingsUpdate) => Promise<void>;
  onBack?: () => void;
}) {
  const detected = React.useMemo(() => guessTimezone(), []);
  const zones = React.useMemo(() => listTimezones(), []);

  const [siteName, setSiteName] = React.useState(settings.branding.siteName);
  const [tagline, setTagline] = React.useState(settings.branding.tagline);
  // An untouched stored value is still the seeded default, so suggest the
  // browser's zone instead of making the operator find their own in the list.
  const [timezone, setTimezone] = React.useState(
    settings.timezone && settings.timezone !== "UTC" ? settings.timezone : detected,
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const issues: string[] = [];
  if (siteName.trim() === "") issues.push("Give the panel a name.");

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      await updateSetupSettings({
        branding: { siteName: siteName.trim(), tagline: tagline.trim() },
        timezone,
      });
      await onSaved({
        branding: { siteName: siteName.trim(), tagline: tagline.trim() },
        timezone,
      });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "The settings could not be saved. Check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <CardHeader>
        <CardTitle>Name your panel</CardTitle>
        <CardDescription>
          The name and tagline appear on the sign-in page, in the sidebar and in
          the browser tab. The timezone decides how every timestamp in the panel
          is rendered.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="setup-site-name">Panel name</FieldLabel>
            <Input
              id="setup-site-name"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="CitadelPanel"
              maxLength={64}
            />
            <FieldDescription>
              {siteName.trim() === ""
                ? "Required. Shown wherever the panel names itself."
                : `Sign-in will read "Sign in to ${siteName.trim()}".`}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="setup-tagline">Tagline</FieldLabel>
            <Input
              id="setup-tagline"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Game servers, under control"
              maxLength={160}
            />
            <FieldDescription>
              Optional. A single line under the panel name. {tagline.length}/160
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="setup-timezone">Timezone</FieldLabel>
            <Select
              value={timezone}
              onValueChange={(value) => setTimezone(value ?? "UTC")}
            >
              <SelectTrigger id="setup-timezone" className="w-full">
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
              {timezone === detected
                ? `Detected from your browser. Stored data stays in UTC; this only affects display.`
                : `Your browser reports ${detected}. Stored data stays in UTC; this only affects display.`}
            </FieldDescription>
          </Field>
        </FieldGroup>

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
