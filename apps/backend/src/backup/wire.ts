/**
 * Validation of the backup request bodies the panel sends.
 *
 * The agent's token is root-equivalent for this host, so "the panel is the only
 * caller" is not a reason to skip validation — it is the reason to do it. These
 * bodies carry an S3 endpoint the agent will connect to, a MariaDB admin
 * credential, and identifiers that end up in SQL and in shell redirects. A
 * confused panel must produce a 400 here rather than a surprising side effect
 * deeper in.
 *
 * Kept out of `server.ts` because the route table there reads as a list of
 * endpoints, and inlining forty lines of field checks per route would bury it.
 */

import { badRequest } from "../http";
import type { BackupScope, RepoTarget, S3Target } from "./restic";
import type { DbAdminCredential } from "./dumps";

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

/** UUIDs, for the repository subject id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the S3 target.
 *
 * The endpoint must be a bare host: the transport comes from the separate
 * `useTls` flag, so a scheme embedded in the host would be a second, less visible
 * way to choose plaintext. Rejecting it keeps exactly one answer to "is this
 * connection encrypted?".
 *
 * `useTls` itself defaults to **true** when absent. A missing field must never be
 * the reason credentials go out unencrypted.
 */
function parseS3(source: Record<string, unknown>): S3Target {
  const endpoint = str(source, "endpoint", { max: 253 });
  if (/^https?:\/\//i.test(endpoint)) {
    throw badRequest(
      '"endpoint" must be a bare host without a scheme (e.g. "s3.us-east-1.amazonaws.com" ' +
        'or "192.168.1.10:3900"); use "useTls" to choose http or https.',
    );
  }
  if (/[\s"']/.test(endpoint)) {
    throw badRequest('"endpoint" must not contain whitespace or quotes.');
  }
  if (endpoint.includes("/")) {
    throw badRequest(
      '"endpoint" must be a host and optional port only, with no path; put any path ' +
        'inside the bucket in "prefix".',
    );
  }

  const useTls = source.useTls === undefined ? true : source.useTls;
  if (typeof useTls !== "boolean") {
    throw badRequest('"useTls" must be a boolean.');
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
    useTls,
  };
}

/**
 * Parse the repository block: S3 target, scope, subject id, and password.
 *
 * `expectScope` pins what the route is for, so a database-backup body cannot be
 * sent to the server-backup route and end up snapshotting the wrong tree into the
 * wrong repository. The scope decides both the repository path and which host
 * directory gets mounted, so it is not a field to take on trust.
 */
export function parseRepoTarget(
  body: Record<string, unknown>,
  expectScope: BackupScope,
  id: string,
): RepoTarget {
  const repo = object(body, "repo");

  const password = str(repo, "password", { max: 512 });
  if (password.length < 16) {
    throw badRequest(
      '"repo.password" must be at least 16 characters — it is the only thing ' +
        "standing between the S3 bucket's contents and anyone who can read it.",
    );
  }

  if (!UUID_RE.test(id)) {
    throw badRequest("The repository subject id must be a UUID.");
  }

  return { s3: parseS3(object(repo, "s3")), scope: expectScope, id, password };
}

/**
 * Parse the maximum number of snapshots to keep.
 *
 * Absent means unlimited, and so does zero. That default is chosen so a body
 * missing the field can never *delete* anything: the alternative reading — "keep
 * none" — would wipe a repository on a malformed request.
 */
export function parseKeepMax(body: Record<string, unknown>): number {
  if (body.keepMax === undefined) return 0;
  return int(body, "keepMax", 0, 1000);
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
 * Parse the MariaDB admin credential for a database backup or restore.
 *
 * Root-equivalent on the node's database instance, which is why only the
 * admin-scoped routes accept it — the per-server backup path has no field for it
 * and no use for one.
 */
export function parseDbAdmin(body: Record<string, unknown>): DbAdminCredential {
  const admin = object(body, "admin");
  return {
    user: str(admin, "user", { max: 128 }),
    password: str(admin, "password", { max: 512 }),
  };
}

/**
 * Parse the list of database names to dump or import.
 *
 * Shape is enforced later by `assertValidDbIdentifier`, which is the agent's
 * existing SQL-safety gate; this bounds the list so a malformed body cannot ask
 * for a thousand dump containers.
 */
export function parseDatabaseNames(body: Record<string, unknown>): string[] {
  const raw = body.databases;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest('"databases" must be an array.');
  if (raw.length > 500) {
    throw badRequest('"databases" must contain at most 500 entries.');
  }

  return raw.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 64) {
      throw badRequest(`databases[${index}] must be a non-empty string of at most 64 characters.`);
    }
    return entry;
  });
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

/** Parse the scope + id pair the metadata routes address a repository by. */
export function parseSubject(body: Record<string, unknown>): { scope: BackupScope; id: string } {
  const scope = str(body, "scope", { max: 16 });
  if (scope !== "server" && scope !== "node") {
    throw badRequest('"scope" must be "server" or "node".');
  }
  const id = str(body, "id", { max: 64 });
  if (!UUID_RE.test(id)) throw badRequest('"id" must be a UUID.');
  return { scope, id };
}
