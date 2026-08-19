/**
 * The restic command layer: repository addressing, argv, environment, and
 * output parsing.
 *
 * Everything here is pure — it computes strings from inputs and touches no I/O
 * — which is what makes the wire format of an external binary unit-testable.
 * The side-effecting half lives in `run.ts`, which feeds these argv/env pairs
 * to a throwaway container.
 *
 * Why restic at all, rather than streaming a tar into S3 ourselves: a game
 * server's data directory is mostly a world that changes in place, so a
 * full-copy backup re-uploads tens of gigabytes to capture a few hundred
 * megabytes of change. restic content-addresses and deduplicates chunks, so the
 * second snapshot of a 30 GB world costs roughly what actually changed. It also
 * encrypts client-side before anything leaves the node, which means the S3
 * bucket holds no readable tenant data even if its credentials leak. Snapshots
 * are immutable and timestamped, so a corrupted or ransomwared world does not
 * overwrite the good copy the way a sync would.
 *
 * Two paths go into every snapshot, at fixed mount points:
 *   /data   — the server's data directory
 *   /dumps  — SQL dumps of its provisioned databases (see `dumps.ts`)
 * They are absolute inside the container, so `restic restore --target /`
 * reconstructs both at the same mount points on the way back out.
 */

/** Mount point for the server's data directory inside the restic container. */
export const DATA_MOUNT = "/data";

/** Mount point for the database-dump staging directory. */
export const DUMPS_MOUNT = "/dumps";

/** Mount point for restic's local chunk cache. */
export const CACHE_MOUNT = "/cache";

/**
 * How often restic prints a progress line, in frames per second.
 *
 * The agent reads progress by polling the container's log tail, so restic's
 * default (60 lines/second) would be megabytes of JSON for a long backup. One
 * line every five seconds is granular enough for a progress bar and bounded
 * enough to keep in a log.
 */
export const PROGRESS_FPS = "0.2";

/** S3 connection details, as the panel supplies them per request. */
export interface S3Target {
  /**
   * Host (optionally with a path prefix) of the S3 endpoint, without a scheme
   * — e.g. `s3.eu-central-1.amazonaws.com` or `minio.example.com:9000`.
   */
  endpoint: string;
  bucket: string;
  /** Key prefix inside the bucket; may be empty. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Everything needed to address and unlock one server's repository. */
export interface RepoTarget {
  s3: S3Target;
  /** Per-server repository password. Never persisted on the node. */
  password: string;
}

/**
 * Build the `s3:` repository URL for one server.
 *
 * One repository per server, keyed by server id, rather than one shared
 * repository with per-server paths. A shared repository would mean every node
 * holding a password that decrypts every tenant's data, and `restic forget` for
 * one server would need to reason about another's snapshots. Separate
 * repositories cost some deduplication across tenants and buy a blast radius of
 * exactly one server.
 *
 * The scheme is forced to https — restic accepts `s3:http://…` for a plaintext
 * endpoint, and silently shipping an operator's bucket credentials in the clear
 * is not a mistake worth supporting.
 */
export function repositoryUrl(s3: S3Target, serverId: string): string {
  const host = s3.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const prefix = s3.prefix.replace(/^\/+|\/+$/g, "");
  const path = [s3.bucket, prefix, serverId].filter((part) => part.length > 0).join("/");
  return `s3:https://${host}/${path}`;
}

/**
 * The environment restic reads its secrets from.
 *
 * Credentials go in the environment rather than in argv because argv is visible
 * to anything that can list processes in the container's PID namespace, and
 * because Docker records the command in the container's own inspect output
 * (which the agent logs on failure). The environment is not in either.
 */
export function repositoryEnv(target: RepoTarget, serverId: string): Record<string, string> {
  return {
    RESTIC_REPOSITORY: repositoryUrl(target.s3, serverId),
    RESTIC_PASSWORD: target.password,
    AWS_ACCESS_KEY_ID: target.s3.accessKeyId,
    AWS_SECRET_ACCESS_KEY: target.s3.secretAccessKey,
    AWS_DEFAULT_REGION: target.s3.region,
    RESTIC_PROGRESS_FPS: PROGRESS_FPS,
    // The cache lives on a bind mount that survives between runs, so an
    // incremental backup does not re-read the whole repository index from S3.
    RESTIC_CACHE_DIR: CACHE_MOUNT,
  };
}

/** Retention policy for `restic forget`. Zero means "do not keep by this rule". */
export interface RetentionPolicy {
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

/**
 * Whether a policy would keep anything at all.
 *
 * `restic forget` with no `--keep-*` rule deletes every snapshot, so an
 * all-zero policy must never reach it — the caller skips the prune instead.
 */
export function retainsAnything(policy: RetentionPolicy): boolean {
  return (
    policy.keepLast > 0 ||
    policy.keepDaily > 0 ||
    policy.keepWeekly > 0 ||
    policy.keepMonthly > 0
  );
}

/** `restic init` — create the repository. Fails if one already exists. */
export function initArgs(): string[] {
  return ["init", "--json"];
}

/**
 * `restic cat config` — the cheapest proof that a repository exists and the
 * password opens it. Used both as the "do I need to init?" probe and as the
 * admin-facing connection test.
 */
export function probeArgs(): string[] {
  return ["cat", "config"];
}

/**
 * `restic backup` for one server.
 *
 * `--json` switches restic to newline-delimited JSON so progress is parseable
 * rather than scraped from a redrawn terminal line. Tags carry the server id and
 * why the backup ran, so `restic snapshots` stays legible to an operator poking
 * at the repository directly with the CLI.
 */
export function backupArgs(options: {
  serverId: string;
  /** What triggered this backup, recorded as a tag. */
  reason: string;
  /** Include the dumps mount. False when the server has no databases. */
  includeDumps: boolean;
  /** Paths, relative to the data mount, to leave out of the snapshot. */
  exclude: string[];
}): string[] {
  const args = [
    "backup",
    "--json",
    "--tag",
    `citadel`,
    "--tag",
    `server:${options.serverId}`,
    "--tag",
    `reason:${options.reason}`,
    DATA_MOUNT,
  ];
  if (options.includeDumps) args.push(DUMPS_MOUNT);
  for (const pattern of options.exclude) {
    args.push("--exclude", pattern);
  }
  return args;
}

/** `restic snapshots --json` — the repository's snapshot list. */
export function snapshotsArgs(): string[] {
  return ["snapshots", "--json"];
}

/**
 * `restic restore` one snapshot back over its original mount points.
 *
 * `--target /` works because the snapshot holds absolute `/data` and `/dumps`
 * paths and the container mounts the same two places. There is deliberately no
 * `--delete`: a restore overlays the snapshot rather than making the data
 * directory byte-identical to it. Handing a filesystem-wide delete to a tool
 * running as root inside a container is a much worse failure mode than a few
 * stale files, and the owner can clear those from the file manager.
 */
export function restoreArgs(snapshotId: string): string[] {
  return ["restore", snapshotId, "--target", "/", "--json"];
}

/**
 * `restic forget --prune` — apply the retention policy and reclaim the space.
 *
 * Scoped with `--tag citadel` so a repository an operator also uses by hand is
 * not pruned on our rules. `--prune` is what actually deletes data from S3;
 * without it `forget` only unlinks snapshots and the bucket keeps growing.
 */
export function forgetArgs(policy: RetentionPolicy): string[] {
  const args = ["forget", "--prune", "--json", "--tag", "citadel"];
  if (policy.keepLast > 0) args.push("--keep-last", String(policy.keepLast));
  if (policy.keepDaily > 0) args.push("--keep-daily", String(policy.keepDaily));
  if (policy.keepWeekly > 0) args.push("--keep-weekly", String(policy.keepWeekly));
  if (policy.keepMonthly > 0) args.push("--keep-monthly", String(policy.keepMonthly));
  return args;
}

/** Drop one snapshot by id, then reclaim its unreferenced chunks. */
export function forgetSnapshotArgs(snapshotId: string): string[] {
  return ["forget", snapshotId, "--prune", "--json"];
}

// --- Output parsing -------------------------------------------------------------

/** A progress reading taken mid-backup. */
export interface BackupProgress {
  /** 0-100, rounded. */
  percent: number;
  filesDone: number;
  bytesDone: number;
  /** Seconds remaining, as restic estimates them; null before it can. */
  secondsRemaining: number | null;
}

/** The totals restic reports once a backup completes. */
export interface BackupSummary {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  /** Bytes read from disk this run. */
  bytesProcessed: number;
  /** Bytes actually uploaded after dedup and compression — the S3 cost. */
  bytesAdded: number;
  durationSeconds: number;
}

/**
 * Parse restic's newline-delimited JSON output.
 *
 * Tolerant by design: the log tail this reads from is polled while the container
 * runs, so the first line may be a fragment of a line written before the poll
 * window and the last may be truncated mid-write. Anything that is not valid
 * JSON is skipped rather than failing the parse, and non-JSON lines (restic
 * writes warnings to stderr in plain text even under `--json`) are returned
 * separately so the caller can surface them.
 */
export function parseResticOutput(output: string): {
  progress: BackupProgress | null;
  summary: BackupSummary | null;
  errors: string[];
  /** Plain-text lines restic wrote outside the JSON stream. */
  messages: string[];
} {
  let progress: BackupProgress | null = null;
  let summary: BackupSummary | null = null;
  const errors: string[] = [];
  const messages: string[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (!trimmed.startsWith("{")) {
      messages.push(trimmed);
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // A fragment of a line the poll window cut in half.
    }

    switch (parsed.message_type) {
      case "status": {
        // percent_done is 0..1; files_done and bytes_done are absent until the
        // first file finishes, so both default to zero rather than NaN.
        const fraction = numberOr(parsed.percent_done, 0);
        progress = {
          percent: Math.max(0, Math.min(100, Math.round(fraction * 100))),
          filesDone: numberOr(parsed.files_done, 0),
          bytesDone: numberOr(parsed.bytes_done, 0),
          secondsRemaining:
            typeof parsed.seconds_remaining === "number" && parsed.seconds_remaining > 0
              ? parsed.seconds_remaining
              : null,
        };
        break;
      }
      case "summary": {
        summary = {
          snapshotId: typeof parsed.snapshot_id === "string" ? parsed.snapshot_id : "",
          filesNew: numberOr(parsed.files_new, 0),
          filesChanged: numberOr(parsed.files_changed, 0),
          bytesProcessed: numberOr(parsed.total_bytes_processed, 0),
          bytesAdded: numberOr(parsed.data_added, 0),
          durationSeconds: numberOr(parsed.total_duration, 0),
        };
        break;
      }
      case "error": {
        // restic reports per-file errors without aborting the run (an
        // unreadable file is a warning about that file, not a failed backup),
        // so these are collected and surfaced rather than thrown.
        const detail =
          typeof parsed.error === "object" && parsed.error !== null
            ? String((parsed.error as { message?: unknown }).message ?? "")
            : String(parsed.error ?? "");
        const during = typeof parsed.during === "string" ? parsed.during : "";
        const item = typeof parsed.item === "string" ? parsed.item : "";
        errors.push([during, item, detail].filter(Boolean).join(": "));
        break;
      }
      default:
        break;
    }
  }

  return { progress, summary, errors, messages };
}

/** One snapshot as `restic snapshots --json` reports it. */
export interface SnapshotInfo {
  id: string;
  time: string;
  tags: string[];
}

/** Parse `restic snapshots --json`, which is one JSON array (not ndjson). */
export function parseSnapshots(output: string): SnapshotInfo[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry): SnapshotInfo[] => {
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string") return [];
    return [
      {
        id: row.id,
        time: typeof row.time === "string" ? row.time : "",
        tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [],
      },
    ];
  });
}

/**
 * Turn a restic failure into something an operator can act on.
 *
 * restic's own messages are good, but the two failures an operator actually
 * hits — wrong credentials and a repository that was never initialised — read
 * as low-level S3 errors, so they get named explicitly.
 */
export function explainResticFailure(exitCode: number, output: string): string {
  const tail = output.trim().slice(-1500);

  if (/wrong password|invalid data returned/i.test(tail)) {
    return (
      "restic could not decrypt the repository. The panel's stored repository " +
      "password for this server does not match the one the repository was " +
      "created with — this happens when PANEL_ENCRYPTION_KEY was rotated after " +
      `the first backup. Details: ${tail}`
    );
  }
  if (/SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|403/i.test(tail)) {
    return (
      "S3 rejected the credentials. Check the access key, secret key, region " +
      `and bucket in the panel's backup settings. Details: ${tail}`
    );
  }
  if (/NoSuchBucket|does not exist/i.test(tail)) {
    return `The configured S3 bucket does not exist or is not reachable. Details: ${tail}`;
  }
  if (/no such host|dial tcp|connection refused|timeout/i.test(tail)) {
    return `This node could not reach the S3 endpoint. Details: ${tail}`;
  }
  return `restic exited with code ${exitCode}: ${tail}`;
}

/** True when a probe failure means "no repository here yet", not "broken". */
export function looksUninitialised(output: string): boolean {
  return /unable to open config file|repository does not exist|does not exist.*config/i.test(
    output,
  );
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
