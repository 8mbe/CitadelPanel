"use client";

import * as React from "react";
import { Clock, CloudUpload, HardDrive, Plug } from "lucide-react";

import {
  ApiError,
  getAdminSettings,
  getBackupStorage,
  previewBackupSchedule,
  testBackupDestination,
  updateAdminSettings,
  type AdminSettings,
  type AdminSettingsUpdate,
  type BackupStorageReport,
} from "@/lib/api";
import { DatabaseBackupsSection } from "@/components/admin/database-backups-card";
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
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CRON_PRESETS } from "@/lib/cron";
import { formatBytes } from "@/lib/format";

/** How long to wait after a keystroke before asking the server to parse a cron. */
const PREVIEW_DEBOUNCE_MS = 400;

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
 * commonly wants one without the other. A working "Back up now" button with no
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
          Where snapshots go, when they are taken, and how many are kept. Server
          backups hold files and are taken by their owners; database backups sweep
          every database on a node and are yours alone.
        </p>
      </div>

      <DestinationCard settings={settings} patch={patch} />
      <ScheduleCard settings={settings} patch={patch} />
      <DatabaseBackupsSection settings={settings} patch={patch} />
      <StorageCard settings={settings} patch={patch} />
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
  const [useTls, setUseTls] = React.useState(s.useTls);
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
      // An operator will paste a console URL sooner or later. Rather than rejecting
      // the form, strip the scheme, and let an explicit `http://` *set the toggle*,
      // since that is unambiguously what they meant. The switch visibly moves, so
      // this is a suggestion they can see and undo, not a silent downgrade.
      const raw = endpoint.trim();
      const pastedScheme = /^(https?):\/\//i.exec(raw)?.[1]?.toLowerCase();
      const cleaned = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      const tls = pastedScheme ? pastedScheme === "https" : useTls;
      if (cleaned !== raw) setEndpoint(cleaned);
      if (tls !== useTls) setUseTls(tls);

      await patch({
        backups: {
          enabled,
          endpoint: cleaned || null,
          useTls: tls,
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
          Any S3-compatible bucket: AWS, Backblaze B2, Cloudflare R2, MinIO,
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

          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="backups-tls">Connect over TLS</FieldLabel>
              <FieldDescription>
                {useTls
                  ? "Nodes reach the endpoint over https. Leave this on for any storage reachable from the internet."
                  : "Nodes will reach the endpoint over plain http. Only do this on a trusted network. The bucket credentials and API traffic are unencrypted in transit. Snapshot contents stay encrypted either way, because that happens on the node before upload."}
              </FieldDescription>
            </div>
            <Switch
              id="backups-tls"
              checked={useTls}
              onCheckedChange={(checked) => setUseTls(checked === true)}
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
              Host and optional port, e.g. <code>s3.us-east-1.amazonaws.com</code> or{" "}
              <code>192.168.1.120:3900</code>. Pasting a full URL is fine. Its scheme
              sets the TLS switch above.
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
              Part of the request signature, so a wrong value fails authentication
              rather than being ignored. Garage uses <code>garage</code> unless
              configured otherwise; MinIO accepts anything.
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
          contents are unreadable without the panel&apos;s own key. That cuts both
          ways. Rotating <code>PANEL_ENCRYPTION_KEY</code> makes every existing
          snapshot permanently unreadable.
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
          The test runs on one of your nodes, not on the panel. A node is what has
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
  const [cron, setCron] = React.useState(s.servers.schedule);
  const [concurrency, setConcurrency] = React.useState(String(s.servers.concurrency));
  const [maxPerServer, setMaxPerServer] = React.useState(String(s.servers.maxPerServer));
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
  // same parser the scheduler does, so a schedule can never preview one thing
  // and then do another. Debounced so typing does not fire a request per
  // keystroke, though not on the way in. There is nothing to debounce when the
  // value is the stored schedule, and waiting made the card sit empty for the
  // delay on every page load.
  const previewedOnce = React.useRef(false);
  React.useEffect(() => {
    let cancelled = false;
    const delay = previewedOnce.current ? PREVIEW_DEBOUNCE_MS : 0;
    previewedOnce.current = true;
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
    }, delay);

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
          servers: {
            schedule: cron.trim(),
            concurrency: Number(concurrency) || 1,
            maxPerServer: Math.max(0, Number(maxPerServer) || 0),
          },
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
          Server backup schedule
        </CardTitle>
        <CardDescription>
          A standard five-field cron expression, evaluated in the panel&apos;s
          timezone, covering every server&apos;s <em>files</em>. Leave it empty for
          manual backups only. Owners can opt an individual server out from its own
          backups tab. Database backups have their own schedule below.
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
          <FieldLabel htmlFor="backups-max-per-server">Backups kept per server</FieldLabel>
          <Input
            id="backups-max-per-server"
            type="number"
            min={0}
            max={1000}
            value={maxPerServer}
            onChange={(e) => setMaxPerServer(e.target.value)}
          />
          <FieldDescription>
            Once a server has this many, taking a new backup removes its oldest one
            first, so the count never exceeds the limit. Snapshots deduplicate
            against each other, so five costs far less than five full copies. 0 means
            unlimited.
          </FieldDescription>
        </Field>

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

// --- Storage ---------------------------------------------------------------------

/**
 * Storage: the one-line used / allowed / total report, plus the two limits behind it.
 *
 * `used` is measured (restic's deduplicated repository size, recorded after each
 * backup). `allowed` is enforced. New backups are refused once it is reached.
 * `total` is **declared by the operator**, because S3 exposes no capacity API: the
 * size of their storage plan is something only they know, so the panel asks rather
 * than pretending to have discovered it.
 */
function StorageCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const s = settings.backups;
  const [quotaGb, setQuotaGb] = React.useState(bytesToGb(s.storage.quotaBytes));
  const [capacityGb, setCapacityGb] = React.useState(bytesToGb(s.storage.capacityBytes));
  const [exclude, setExclude] = React.useState(s.servers.exclude.join("\n"));
  const [report, setReport] = React.useState<BackupStorageReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getBackupStorage();
        if (!cancelled) setReport(data);
      } catch {
        // The line is informational; a failed read leaves it hidden rather than
        // blocking the limits form underneath it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const patterns = exclude
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      await patch({
        backups: {
          enabled: s.enabled,
          storage: {
            quotaBytes: gbToBytes(quotaGb),
            capacityBytes: gbToBytes(capacityGb),
          },
          servers: { exclude: patterns },
        },
      });
      setSaved(true);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save storage settings.");
    } finally {
      setLoading(false);
    }
  };

  // Progress is against the allowed figure when one is set, otherwise against the
  // declared capacity. With neither there is nothing to be a fraction of, so the
  // bar is hidden rather than shown at an arbitrary zero.
  const denominator =
    report && report.quotaBytes > 0
      ? report.quotaBytes
      : report && report.capacityBytes > 0
        ? report.capacityBytes
        : 0;
  const percent =
    report && denominator > 0
      ? Math.min(100, Math.round((report.usedBytes / denominator) * 100))
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" />
          Storage
        </CardTitle>
        <CardDescription>
          How much the fleet&apos;s backups occupy, and the ceiling they may not pass.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {report && (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2.5">
            <p className="text-sm tabular-nums">
              <span className="font-medium">{formatBytes(report.usedBytes)}</span> used
              <span className="text-muted-foreground"> · </span>
              <span className="font-medium">
                {report.quotaBytes > 0 ? formatBytes(report.quotaBytes) : "unlimited"}
              </span>{" "}
              allowed
              <span className="text-muted-foreground"> · </span>
              <span className="font-medium">
                {report.capacityBytes > 0 ? formatBytes(report.capacityBytes) : "unknown"}
              </span>{" "}
              total
            </p>
            {percent !== null && <Progress value={percent} />}
            <p className="text-xs text-muted-foreground">
              Across {report.repositories} repositor
              {report.repositories === 1 ? "y" : "ies"}, measured after each backup.
              {report.unmeasured > 0 &&
                ` ${report.unmeasured} not yet measured, so the figure is a floor.`}
              {report.overQuota &&
                " The limit has been reached. New backups are refused until you delete some or raise it."}
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="backups-quota">Storage limit (GB)</FieldLabel>
            <Input
              id="backups-quota"
              type="number"
              min={0}
              step={1}
              value={quotaGb}
              onChange={(e) => setQuotaGb(e.target.value)}
            />
            <FieldDescription>
              Enforced: once backups reach this, new ones are refused with an
              explanation instead of the overage turning up on an invoice. Deleting
              always works, so you can never be locked out of getting back under it.
              0 means no limit.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="backups-capacity">Bucket capacity (GB)</FieldLabel>
            <Input
              id="backups-capacity"
              type="number"
              min={0}
              step={1}
              value={capacityGb}
              onChange={(e) => setCapacityGb(e.target.value)}
            />
            <FieldDescription>
              Shown for context only. S3 has no way to report how big a bucket may
              get, so this is whatever your storage plan gives you. 0 leaves it
              unknown.
            </FieldDescription>
          </Field>
        </div>

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
            One glob per line, relative to each server&apos;s data directory. Applies to
            server file backups on every server. Excluding regenerable data (caches,
            logs) shrinks every snapshot in the fleet. Database backups have nothing
            to exclude.
          </FieldDescription>
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        )}

        <div>
          <Button onClick={save} disabled={loading}>
            {loading && <Spinner />}
            Save storage settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Bytes to a whole-GB string for the form. 0 renders as "0", not "". */
function bytesToGb(bytes: number): string {
  if (bytes <= 0) return "0";
  return String(Math.round(bytes / 1024 ** 3));
}

function gbToBytes(value: string): number {
  const gb = Number(value);
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  return Math.round(gb) * 1024 ** 3;
}
