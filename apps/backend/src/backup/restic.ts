/**
 * The restic command layer: repository addressing, argv, environment, and
 * output parsing.
 *
 * Everything here is pure. It computes strings from inputs and touches no I/O,
 * which is what makes the wire format of an external binary unit-testable.
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
 * ## Two scopes, two kinds of repository
 *
 * A server's **files** and a node's **databases** are backed up separately,
 * because they are owned by different people and have different lifetimes:
 *
 *   - `server`: a server's data directory, mounted at `/data`. Taken by the
 *     server's owner, capped at a fixed number of snapshots.
 *   - `node`:   SQL dumps of every database provisioned on one node, staged
 *     and mounted at `/dumps`. Taken by an administrator, who is the only person
 *     with a reason (or the credential) to read every tenant's data at once.
 *
 * Each gets its own repository, namespaced by scope so the two can never
 * collide inside one bucket. Paths inside a snapshot are absolute, so
 * `restic restore --target /` reconstructs them at the same mount points.
 */

/** Which kind of thing a repository holds. */
export type BackupScope = "server" | "node";

/** Mount point for a server's data directory inside the restic container. */
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
   * Host (optionally with a port) of the S3 endpoint, without a scheme. For
   * example `s3.eu-central-1.amazonaws.com`, `minio.example.com:9000`,
   * `192.168.1.120:3900`.
   */
  endpoint: string;
  bucket: string;
  /** Key prefix inside the bucket; may be empty. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Whether to reach the endpoint over TLS.
   *
   * Defaults to on everywhere, and the scheme is a *separate field* rather than
   * something the caller can smuggle into `endpoint`, so plaintext is always a
   * deliberate, visible choice and never a silent downgrade.
   *
   * It has to be possible, though: a self-hosted Garage, MinIO or SeaweedFS on a
   * LAN commonly has no certificate at all, and that is the normal case for the
   * kind of operator who self-hosts this panel. Refusing it outright would just
   * mean no backups.
   */
  useTls: boolean;
}

/** Everything needed to address and unlock one repository. */
export interface RepoTarget {
  s3: S3Target;
  scope: BackupScope;
  /** Server id or node id, matching `scope`. */
  id: string;
  /** Per-repository password. Never persisted on the node. */
  password: string;
}

/** The path segment each scope lives under, inside the bucket prefix. */
function scopeSegment(scope: BackupScope): string {
  return scope === "server" ? "servers" : "nodes";
}

/**
 * Build the `s3:` repository URL for one server or node.
 *
 * One repository per subject, rather than one shared repository with per-subject
 * paths. A shared repository would mean every node holding a password that
 * decrypts every tenant's data, and pruning one server's snapshots would need to
 * reason about another's. Separate repositories cost some deduplication across
 * tenants and buy a blast radius of exactly one subject.
 *
 * The `servers/` and `nodes/` segments keep the two scopes apart even though both
 * ids are UUIDs, so a bucket can be read by a human without guessing which kind
 * of thing a bare UUID is.
 *
 * The scheme comes from `useTls`, not from the endpoint string: a scheme the
 * caller could embed in the host would make a plaintext connection something you
 * could end up with by pasting a URL, whereas a separate boolean makes it a
 * decision somebody took. `endpoint` is stripped of a scheme defensively rather
 * than trusted to be clean.
 */
export function repositoryUrl(s3: S3Target, scope: BackupScope, id: string): string {
  const host = s3.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const prefix = s3.prefix.replace(/^\/+|\/+$/g, "");
  const path = [s3.bucket, prefix, scopeSegment(scope), id]
    .filter((part) => part.length > 0)
    .join("/");
  // restic's S3 backend takes the scheme inline: `s3:https://host/bucket/path`
  // for TLS, `s3:http://host:9000/bucket/path` for a plaintext MinIO or Garage.
  return `s3:${s3.useTls ? "https" : "http"}://${host}/${path}`;
}

/**
 * The environment restic reads its secrets from.
 *
 * Credentials go in the environment rather than in argv because argv is visible
 * to anything that can list processes in the container's PID namespace, and
 * because Docker records the command in the container's own inspect output
 * (which the agent logs on failure). The environment is not in either.
 */
export function repositoryEnv(target: RepoTarget): Record<string, string> {
  return {
    RESTIC_REPOSITORY: repositoryUrl(target.s3, target.scope, target.id),
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

/** `restic init` creates the repository. Fails if one already exists. */
export function initArgs(): string[] {
  return ["init", "--json"];
}

/**
 * `restic cat config` is the cheapest proof that a repository exists and the
 * password opens it. Used both as the "do I need to init?" probe and as the
 * admin-facing connection test.
 */
export function probeArgs(): string[] {
  return ["cat", "config"];
}

/**
 * `restic backup`.
 *
 * `--json` switches restic to newline-delimited JSON so progress is parseable
 * rather than scraped from a redrawn terminal line. Tags carry the scope, the
 * subject id and why the backup ran, so `restic snapshots` stays legible to an
 * operator poking at the repository directly with the CLI.
 *
 * `paths` is explicit rather than derived from the scope: a server backup
 * snapshots `/data` and a node database backup snapshots `/dumps`, and there is
 * no third case worth inferring.
 */
export function backupArgs(options: {
  scope: BackupScope;
  id: string;
  /** Absolute paths inside the container to snapshot. */
  paths: string[];
  /** What triggered this backup, recorded as a tag. */
  reason: string;
  /** Glob patterns to leave out of the snapshot. */
  exclude: string[];
}): string[] {
  const args = [
    "backup",
    "--json",
    "--tag",
    "citadel",
    "--tag",
    `${options.scope}:${options.id}`,
    "--tag",
    `reason:${options.reason}`,
    ...options.paths,
  ];
  for (const pattern of options.exclude) {
    args.push("--exclude", pattern);
  }
  return args;
}

/** `restic snapshots --json` returns the repository's snapshot list. */
export function snapshotsArgs(): string[] {
  return ["snapshots", "--json"];
}

/**
 * `restic stats --mode raw-data --json` reports how much this repository
 * occupies.
 *
 * `raw-data` rather than the default `restore-size`: the default reports how big
 * a restore would be (i.e. the logical size of the newest snapshot), while
 * `raw-data` reports the deduplicated, compressed bytes actually stored. The
 * second is the number that corresponds to what the bucket is billing for, which
 * is the only reason anyone is asking.
 *
 * Run right after a backup, when the repository index is already in the local
 * cache, so it costs a metadata pass rather than a download.
 */
export function statsArgs(): string[] {
  return ["stats", "--mode", "raw-data", "--json"];
}

/**
 * Parse `restic stats --json` into a byte count, or null when it cannot be read.
 *
 * Null rather than zero on failure: zero is a legitimate size for a fresh
 * repository, and reporting "this repository uses nothing" because a stats call
 * timed out would understate the fleet's storage, the one number this exists to
 * get right.
 */
export function parseRepositorySize(output: string): number | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    const size = parsed.total_size;
    return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * `restic restore` one snapshot back over its original mount points.
 *
 * `--target /` works because the snapshot holds absolute paths (`/data` or
 * `/dumps`) and the container mounts the same places. There is deliberately no
 * `--delete`: a restore overlays the snapshot rather than making the target
 * byte-identical to it. Handing a filesystem-wide delete to a tool running as
 * root inside a container is a much worse failure mode than a few stale files,
 * and the owner can clear those from the file manager.
 */
export function restoreArgs(snapshotId: string): string[] {
  return ["restore", snapshotId, "--target", "/", "--json"];
}

/**
 * `restic forget --prune` for an explicit list of snapshot ids.
 *
 * The only form of deletion this system uses. There is no `--keep-*` policy
 * anywhere: retention is a plain count enforced by the caller, which decides
 * *which* snapshots go and passes their ids. That is a deliberate trade. A
 * `--keep-last N` would be one fewer round trip, but `forget` with a policy and
 * no matching snapshots silently deletes everything, and a mistake in that
 * argument is unrecoverable. An explicit id list cannot delete something the
 * caller did not name.
 *
 * `--prune` is what actually reclaims the space in S3; without it `forget` only
 * unlinks snapshots and the bucket keeps growing.
 */
export function forgetSnapshotsArgs(snapshotIds: string[]): string[] {
  if (snapshotIds.length === 0) {
    throw new Error("forgetSnapshotsArgs requires at least one snapshot id");
  }
  return ["forget", ...snapshotIds, "--prune", "--json"];
}

/**
 * Pick the oldest snapshots that have to go for `keepMax` to hold once one more
 * is written.
 *
 * The quota is "at most `keepMax` snapshots exist", and it is enforced *before*
 * the new backup rather than after, so the limit is never briefly exceeded, and
 * a node close to its storage ceiling frees space before asking for more. Which
 * is also what an operator means by "a new backup replaces the oldest".
 *
 * `keepMax <= 0` means unlimited and never deletes anything.
 */
export function snapshotsToForget(
  snapshots: SnapshotInfo[],
  keepMax: number,
): SnapshotInfo[] {
  if (keepMax <= 0) return [];

  // Oldest first. restic returns them oldest-first already, but the ordering is
  // load-bearing here (it decides what gets deleted), so it is not assumed.
  const ordered = [...snapshots].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  );

  // Room for the one about to be written: keep at most keepMax - 1 of the
  // existing snapshots.
  const surplus = ordered.length - (keepMax - 1);
  return surplus > 0 ? ordered.slice(0, surplus) : [];
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
  /** Bytes actually uploaded after dedup and compression, the S3 cost. */
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
 * restic's own messages are good, but two failures an operator actually hits
 * read as low-level S3 errors, so they get named explicitly: wrong credentials,
 * and a repository that was never initialised.
 */
export function explainResticFailure(exitCode: number, output: string): string {
  const tail = output.trim().slice(-1500);

  if (/wrong password|invalid data returned/i.test(tail)) {
    return (
      "restic could not decrypt the repository. The panel's stored repository " +
      "password does not match the one the repository was created with. This " +
      "happens when PANEL_ENCRYPTION_KEY was rotated after the first backup. " +
      `Details: ${tail}`
    );
  }
  if (/SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|403/i.test(tail)) {
    return (
      "S3 rejected the credentials. Check the access key, secret key, region " +
      `and bucket in the panel's backup settings. Details: ${tail}`
    );
  }
  if (/NoSuchBucket|bucket does not exist/i.test(tail)) {
    return (
      "The configured S3 bucket does not exist, or these credentials cannot see it. " +
      "Create the bucket on the storage server first. Nothing here creates one. " +
      `Details: ${tail}`
    );
  }
  // A TLS handshake against a plaintext endpoint is the single most common
  // misconfiguration for a self-hosted Garage or MinIO, and restic's own message
  // for it ("first record does not look like a TLS handshake") tells an operator
  // nothing about which setting to change.
  if (/\btls\b|HTTP response to HTTPS client|handshake|x509|certificate/i.test(tail)) {
    return (
      "The S3 endpoint refused a TLS connection. If this is a self-hosted Garage, " +
      'MinIO or SeaweedFS without a certificate, turn off "Connect over TLS" in the ' +
      "backup destination settings. If it should have TLS, its certificate is not " +
      `trusted by this node. Details: ${tail}`
    );
  }
  if (/no such host|dial tcp|connection refused|i\/o timeout|timeout/i.test(tail)) {
    return (
      "This node could not reach the S3 endpoint. Check the host and port, and that " +
      "the node can route to it. A LAN address reachable from the panel is not " +
      `necessarily reachable from every node. Details: ${tail}`
    );
  }
  // Not an S3 problem at all: restic could not write this node's own
  // filesystem, its cache directory or the staging area. It surfaces as a bare
  // "permission denied" wrapped in a Go stack trace, which says nothing about
  // which directory or whose fault it is, and the answer is always ownership of
  // a path the agent handed to the container. Checked after the network cases so
  // a connection refused *by* a local policy is still reported as a network
  // problem, which is what it is.
  if (/permission denied|operation not permitted/i.test(tail)) {
    return (
      "restic could not write to a directory on this node, its cache or the " +
      "staging area, not S3. The agent's tool containers need the paths under " +
      "BACKUP_STAGING_ROOT and SERVER_DATA_ROOT to be readable and writable by " +
      "them, so check those directories exist, are owned by the user the agent " +
      "runs as, and that nothing (SELinux, a read-only mount) is blocking " +
      `writes. Details: ${tail}`
    );
  }
  // The region is part of the SigV4 signature, not a label, so a self-hosted
  // server that validates it rejects the whole request as malformed. Garage
  // answers a wrong region with a bare `400 Bad Request` that names nothing,
  // and since restic retries it, the operator sees a hang rather than an error.
  // This is the single most common way a working Garage or MinIO still fails,
  // so it is worth naming even though a 400 has other possible causes.
  if (/400 Bad Request|AuthorizationHeaderMalformed|InvalidRegion|\bregion\b/i.test(tail)) {
    return (
      "The storage server rejected the request as malformed. For a self-hosted S3 " +
      "this nearly always means the region is wrong: it is part of the request " +
      'signature, not a label, so it has to match exactly. Garage uses "garage" by ' +
      'default and MinIO accepts anything, but neither ignores it. Check the bucket ' +
      `exists and is spelled correctly too. Details: ${tail}`
    );
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
