"use client";

import * as React from "react";
import { Archive, Clock, CloudUpload, Plug } from "lucide-react";

import {
  ApiError,
  getAdminSettings,
  previewBackupSchedule,
  testBackupDestination,
  updateAdminSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
} from "@/lib/api";
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
import { CRON_PRESETS } from "@/lib/cron";

/**
 * Admin backup settings.
 *
 * Its own page rather than another card on the general settings screen: this is
 * three related-but-separate decisions (where snapshots go, when they are taken,
 * how long they are kept), each with its own save, and the general page is
 * already long. It also earns its own URL for the same reason the server sections
 * do.
 *
 * The destination and the schedule are deliberately separate cards. An operator
 * commonly wants one without the other — a working "Back up now" button with no
 * cron behind it is a legitimate configuration, and so is temporarily clearing
 * the schedule without discarding the credentials that read the existing
 * snapshots.
 */
export function AdminBackupSettings() {
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
          setError(err instanceof ApiError ? err.message : "Could not load settings.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!settings) return <Skeleton className="h-96 w-full" />;

  const patch = async (update: AdminSettingsUpdate): Promise<AdminSettings> => {
    const next = await updateAdminSettings(update);
    setSettings(next);
    return next;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Backups</h1>
        <p className="text-sm text-muted-foreground">
          Where every server&apos;s snapshots go, when they are taken, and how long
          they are kept. Each server&apos;s files and its databases go into one
          snapshot together.
        </p>
      </div>

      <DestinationCard settings={settings} patch={patch} />
      <ScheduleCard settings={settings} patch={patch} />
      <RetentionCard settings={settings} patch={patch} />
    </div>
  );
}

// --- Destination ----------------------------------------------------------------

function DestinationCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const s = settings.backups;
  const [enabled, setEnabled] = React.useState(s.enabled);
  const [endpoint, setEndpoint] = React.useState(s.endpoint ?? "");
  const [region, setRegion] = React.useState(s.region);
  const [bucket, setBucket] = React.useState(s.bucket ?? "");
  const [prefix, setPrefix] = React.useState(s.prefix);
  const [accessKeyId, setAccessKeyId] = React.useState(s.accessKeyId ?? "");
  const [secretAccessKey, setSecretAccessKey] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; detail: string } | null>(
    null,
  );

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        backups: {
          enabled,
          // An operator will paste a console URL sooner or later; strip the
          // scheme here rather than rejecting the whole form over it.
          endpoint: endpoint.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "") || null,
          region: region.trim() || null,
          bucket: bucket.trim() || null,
          prefix: prefix.trim(),
          accessKeyId: accessKeyId.trim() || null,
          // Omitted keeps the stored secret; the field is blank on load because
          // the stored value is encrypted and never sent back.
          ...(secretAccessKey.length > 0 ? { secretAccessKey } : {}),
        },
      });
      setSecretAccessKey("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the destination.");
    } finally {
      setLoading(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testBackupDestination();
      setTestResult({ ok: result.reachable, detail: result.detail });
    } catch (err) {
      setTestResult({
        ok: false,
        detail: err instanceof ApiError ? err.message : "The test could not be run.",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudUpload className="size-4" />
          S3 destination
        </CardTitle>
        <CardDescription>
          Any S3-compatible bucket — AWS, Backblaze B2, Cloudflare R2, MinIO,
          Wasabi. Each server gets its own encrypted repository inside it, so one
          server&apos;s key never opens another&apos;s snapshots.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="backups-enabled">Enable backups</FieldLabel>
              <FieldDescription>
                Off by default. Turning this on requires a complete destination
                below. Turning it off later keeps the credentials, so existing
                snapshots stay readable.
              </FieldDescription>
            </div>
            <Switch
              id="backups-enabled"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked === true)}
            />
          </Field>
        </FieldGroup>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="backups-endpoint">Endpoint</FieldLabel>
            <Input
              id="backups-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="s3.us-east-1.amazonaws.com"
            />
            <FieldDescription>
              Host only, no <code>https://</code>. Nodes always connect over TLS.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="backups-region">Region</FieldLabel>
            <Input
              id="backups-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1"
            />
            <FieldDescription>
              Providers without regions (MinIO) accept any value.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="backups-bucket">Bucket</FieldLabel>
            <Input
              id="backups-bucket"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              placeholder="citadel-backups"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="backups-prefix">
              Prefix <span className="text-muted-foreground/70">(optional)</span>
            </FieldLabel>
            <Input
              id="backups-prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="citadel"
            />
            <FieldDescription>
              A folder inside the bucket, so backups can share it with other data.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="backups-access-key">Access key ID</FieldLabel>
            <Input
              id="backups-access-key"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              autoComplete="off"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="backups-secret-key">Secret access key</FieldLabel>
            <Input
              id="backups-secret-key"
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              autoComplete="off"
              placeholder={s.hasSecretAccessKey ? "•••••••• (unchanged)" : ""}
            />
            <FieldDescription>
              {s.hasSecretAccessKey
                ? "A key is stored. Leave blank to keep it; type a new one to replace it."
                : "Stored encrypted and never shown again."}
            </FieldDescription>
          </Field>
        </div>

        <FieldDescription>
          Give these credentials write access to this bucket and nothing else. Data
          is encrypted on the node before it is uploaded, so the bucket&apos;s
          contents are unreadable without the panel&apos;s own key — which means the
          reverse is also true: rotating <code>PANEL_ENCRYPTION_KEY</code> makes
          every existing snapshot permanently unreadable.
        </FieldDescription>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}
        {testResult && (
          <p
            className={
              testResult.ok
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-sm text-destructive"
            }
          >
            {testResult.detail}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={loading}>
            {loading && <Spinner />}
            Save destination
          </Button>
          <Button variant="outline" onClick={test} disabled={testing}>
            {testing ? <Spinner /> : <Plug />}
            Test connection
          </Button>
        </div>
        <FieldDescription>
          The test runs on one of your nodes, not on the panel — a node is what has
          to reach S3, and it may sit behind a different egress path. Save first.
        </FieldDescription>
      </CardContent>
    </Card>
  );
}

// --- Schedule -------------------------------------------------------------------

function ScheduleCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const s = settings.backups;
  const [cron, setCron] = React.useState(s.schedule);
  const [concurrency, setConcurrency] = React.useState(String(s.concurrency));
  const [loading, setLoading] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{
    description: string;
    nextRuns: string[];
    timezone: string;
  } | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  // The preview is computed server-side so it uses the panel's timezone and the
  // same parser the scheduler does — a schedule can never preview one thing and
  // then do another. Debounced so typing does not fire a request per keystroke.
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await previewBackupSchedule(cron);
        if (!cancelled) {
          setPreview(result);
          setPreviewError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(err instanceof ApiError ? err.message : "Invalid schedule.");
        }
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cron]);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        backups: {
          enabled: s.enabled,
          schedule: cron.trim(),
          concurrency: Number(concurrency) || 1,
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the schedule.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="size-4" />
          Schedule
        </CardTitle>
        <CardDescription>
          A standard five-field cron expression, evaluated in the panel&apos;s
          timezone. Leave it empty for manual backups only. Owners can opt an
          individual server out from its own backups tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="backups-cron">Cron expression</FieldLabel>
          <Input
            id="backups-cron"
            className="font-mono"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 4 * * *"
          />
          <FieldDescription>
            <span className="font-mono">minute hour day-of-month month day-of-week</span>
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="backups-preset">Or pick a common schedule</FieldLabel>
          <Select value="" onValueChange={(value) => value && setCron(value)}>
            <SelectTrigger id="backups-preset">
              <SelectValue placeholder="Choose a preset…" />
            </SelectTrigger>
            <SelectContent>
              {CRON_PRESETS.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {previewError ? (
          <p className="text-sm text-destructive">{previewError}</p>
        ) : (
          preview && (
            <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
              <span className="text-sm font-medium">{preview.description}</span>
              {preview.nextRuns.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  Next runs ({preview.timezone}):{" "}
                  {preview.nextRuns
                    .slice(0, 3)
                    .map((iso) => new Date(iso).toLocaleString())
                    .join(" · ")}
                </span>
              )}
            </div>
          )
        )}

        <Field>
          <FieldLabel htmlFor="backups-concurrency">Servers backed up at once</FieldLabel>
          <Input
            id="backups-concurrency"
            type="number"
            min={1}
            max={32}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
          />
          <FieldDescription>
            Each concurrent backup reads a disk and saturates a node&apos;s upstream
            bandwidth, so on a large fleet the schedule trickles rather than
            stampedes. Two is a good default.
          </FieldDescription>
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}

        <div>
          <Button onClick={save} disabled={loading || previewError !== null}>
            {loading && <Spinner />}
            Save schedule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Retention ------------------------------------------------------------------

function RetentionCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const s = settings.backups;
  const [keepLast, setKeepLast] = React.useState(String(s.retention.keepLast));
  const [keepDaily, setKeepDaily] = React.useState(String(s.retention.keepDaily));
  const [keepWeekly, setKeepWeekly] = React.useState(String(s.retention.keepWeekly));
  const [keepMonthly, setKeepMonthly] = React.useState(String(s.retention.keepMonthly));
  const [exclude, setExclude] = React.useState(s.exclude.join("\n"));
  const [loading, setLoading] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const patterns = exclude
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const allZero =
    Number(keepLast) === 0 &&
    Number(keepDaily) === 0 &&
    Number(keepWeekly) === 0 &&
    Number(keepMonthly) === 0;

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        backups: {
          enabled: s.enabled,
          retention: {
            keepLast: Number(keepLast) || 0,
            keepDaily: Number(keepDaily) || 0,
            keepWeekly: Number(keepWeekly) || 0,
            keepMonthly: Number(keepMonthly) || 0,
          },
          exclude: patterns,
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save retention.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="size-4" />
          Retention &amp; exclusions
        </CardTitle>
        <CardDescription>
          Applied after every backup. Snapshots deduplicate against each other, so
          keeping a month of history costs far less than a month of full copies.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="keep-last">Most recent</FieldLabel>
            <Input
              id="keep-last"
              type="number"
              min={0}
              max={1000}
              value={keepLast}
              onChange={(e) => setKeepLast(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="keep-daily">Daily</FieldLabel>
            <Input
              id="keep-daily"
              type="number"
              min={0}
              max={1000}
              value={keepDaily}
              onChange={(e) => setKeepDaily(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="keep-weekly">Weekly</FieldLabel>
            <Input
              id="keep-weekly"
              type="number"
              min={0}
              max={1000}
              value={keepWeekly}
              onChange={(e) => setKeepWeekly(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="keep-monthly">Monthly</FieldLabel>
            <Input
              id="keep-monthly"
              type="number"
              min={0}
              max={1000}
              value={keepMonthly}
              onChange={(e) => setKeepMonthly(e.target.value)}
            />
          </Field>
        </div>

        <FieldDescription>
          {allZero
            ? "All zero: every backup is kept forever and nothing is ever pruned. Storage grows without bound."
            : "Keeping the most recent N as well as the calendar rules guarantees a very " +
              "fresh backup survives even if the schedule or the clock is misconfigured."}
        </FieldDescription>

        <Field>
          <FieldLabel htmlFor="backups-exclude">
            Excluded paths <span className="text-muted-foreground/70">(optional)</span>
          </FieldLabel>
          <textarea
            id="backups-exclude"
            className="min-h-24 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
            placeholder={"cache/**\n*.tmp\nlogs/**"}
          />
          <FieldDescription>
            One glob per line, relative to each server&apos;s data directory.
            Excluding regenerable data (caches, logs) shrinks every snapshot on
            every server.
          </FieldDescription>
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}

        <div>
          <Button onClick={save} disabled={loading}>
            {loading && <Spinner />}
            Save retention
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
