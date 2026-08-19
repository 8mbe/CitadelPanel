/**
 * Validation of the backup request bodies the panel sends.
 *
 * The agent's token is root-equivalent for this host, so "the panel is the only
 * caller" is not a reason to skip validation — it is the reason to do it. These
 * bodies carry an S3 endpoint the agent will connect to and database identifiers
 * that end up in SQL, and a confused panel must produce a 400 here rather than a
 * surprising side effect deeper in.
 *
 * Kept out of `server.ts` because the route table there reads as a list of
 * endpoints, and inlining forty lines of field checks per route would bury it.
 */

import { badRequest } from "../http";
import type { RepoTarget, RetentionPolicy, S3Target } from "./restic";
import type { DatabaseCredential } from "./dumps";

function str(
  source: Record<string, unknown>,
  key: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): string {
  const value = source[key];
  if (typeof value !== "string") throw badRequest(`"${key}" must be a string.`);
  if (!options.allowEmpty && value.length === 0) {
    throw badRequest(`"${key}" must not be empty.`);
  }
  if (value.length > (options.max ?? 512)) {
    throw badRequest(`"${key}" must be at most ${options.max ?? 512} characters.`);
  }
  return value;
}

function int(source: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`"${key}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function object(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`"${key}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse the S3 target.
 *
 * The endpoint is checked to be a bare host (no scheme, no path beyond a
 * prefix) because `restic.repositoryUrl` prepends `https://` — accepting a
 * scheme here would let a caller downgrade the connection to plaintext and ship
 * the bucket credentials in the clear.
 */
function parseS3(source: Record<string, unknown>): S3Target {
  const endpoint = str(source, "endpoint", { max: 253 });
  if (/^https?:\/\//i.test(endpoint)) {
    throw badRequest(
      '"endpoint" must be a bare host without a scheme (e.g. "s3.us-east-1.amazonaws.com"); ' +
        "the connection is always https.",
    );
  }
  if (/[\s"']/.test(endpoint)) {
    throw badRequest('"endpoint" must not contain whitespace or quotes.');
  }

  const bucket = str(source, "bucket", { max: 255 });
  if (!/^[a-z0-9][a-z0-9.\-]{1,254}$/i.test(bucket)) {
    throw badRequest('"bucket" is not a valid S3 bucket name.');
  }

  const prefix = str(source, "prefix", { max: 255, allowEmpty: true });
  if (prefix.includes("..")) {
    throw badRequest('"prefix" must not contain "..".');
  }

  return {
    endpoint,
    bucket,
    prefix,
    region: str(source, "region", { max: 64 }),
    accessKeyId: str(source, "accessKeyId", { max: 256 }),
    secretAccessKey: str(source, "secretAccessKey", { max: 512 }),
  };
}

/** Parse the repository block: S3 target plus this server's repository password. */
export function parseRepoTarget(body: Record<string, unknown>): RepoTarget {
  const repo = object(body, "repo");
  const password = str(repo, "password", { max: 512 });
  if (password.length < 16) {
    throw badRequest(
      '"repo.password" must be at least 16 characters — it is the only thing ' +
        "standing between the S3 bucket's contents and anyone who can read it.",
    );
  }
  return { s3: parseS3(object(repo, "s3")), password };
}

/**
 * Parse the per-database credentials.
 *
 * Identifier *shape* is enforced later by `assertValidDbIdentifier`, which is
 * the agent's existing SQL-safety gate; this only bounds the list so a malformed
 * body cannot ask for a thousand dump containers.
 */
export function parseDatabases(body: Record<string, unknown>): DatabaseCredential[] {
  const raw = body.databases;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest('"databases" must be an array.');
  if (raw.length > 32) {
    throw badRequest('"databases" must contain at most 32 entries.');
  }

  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw badRequest(`databases[${index}] must be an object.`);
    }
    const database = entry as Record<string, unknown>;
    return {
      name: str(database, "name", { max: 64 }),
      user: str(database, "user", { max: 64 }),
      password: str(database, "password", { max: 512 }),
    };
  });
}

/**
 * Parse the retention policy, defaulting to "keep everything".
 *
 * An absent policy must mean keep-everything rather than an all-zero policy,
 * because `restic forget` with no keep rule deletes every snapshot — a default
 * that quietly destroys data is not a default.
 */
export function parseRetention(body: Record<string, unknown>): RetentionPolicy {
  if (body.retention === undefined) {
    return { keepLast: 0, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 };
  }
  const retention = object(body, "retention");
  return {
    keepLast: int(retention, "keepLast", 0, 1000),
    keepDaily: int(retention, "keepDaily", 0, 1000),
    keepWeekly: int(retention, "keepWeekly", 0, 1000),
    keepMonthly: int(retention, "keepMonthly", 0, 1000),
  };
}

/** Parse the exclude patterns. Absent means "back up everything". */
export function parseExclude(body: Record<string, unknown>): string[] {
  const raw = body.exclude;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest('"exclude" must be an array.');
  if (raw.length > 64) throw badRequest('"exclude" must contain at most 64 patterns.');

  return raw.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
      throw badRequest(`exclude[${index}] must be a non-empty string of at most 256 characters.`);
    }
    return entry;
  });
}

/** Parse the trigger tag. Anything unrecognised is rejected rather than passed through. */
export function parseReason(body: Record<string, unknown>): string {
  const reason = body.reason === undefined ? "manual" : str(body, "reason", { max: 32 });
  if (reason !== "manual" && reason !== "scheduled") {
    throw badRequest('"reason" must be "manual" or "scheduled".');
  }
  return reason;
}

/**
 * Parse a restic snapshot id.
 *
 * Hex only: the id becomes an argv element for restic, and while argv is not a
 * shell there is no reason to forward anything that is not the shape restic
 * itself produces.
 */
export function parseSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8,64}$/i.test(value)) {
    throw badRequest('"snapshotId" must be a hexadecimal restic snapshot id.');
  }
  return value;
}
