/**
 * Tests for backup request validation.
 *
 * The agent validates the panel's bodies because its token is root-equivalent for
 * this host: these fields decide which S3 endpoint the node connects to, which
 * host directory gets mounted, and which identifiers reach SQL. Three cases carry
 * real weight. A scheme in the endpoint (which would downgrade the bucket
 * credentials to plaintext HTTP), a mismatched scope (which would mount the wrong
 * tree into the wrong repository), and an absent `keepMax` (which must not be read
 * as "keep none").
 */

import { describe, expect, test } from "bun:test";
import {
  parseDatabaseNames,
  parseDbAdmin,
  parseExclude,
  parseKeepMax,
  parseReason,
  parseRepoTarget,
  parseSnapshotId,
  parseSubject,
} from "./wire";

const SERVER = "3f2b7c1e-0000-4000-8000-000000000001";
const NODE = "9a1b2c3d-0000-4000-8000-0000000000ff";

const validRepo = () => ({
  repo: {
    password: "a-sixteen-char-or-more-password",
    s3: {
      endpoint: "s3.us-east-1.amazonaws.com",
      bucket: "citadel-backups",
      prefix: "panel",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
    },
  },
});

describe("parseRepoTarget", () => {
  test("accepts a well-formed target and stamps the route's scope", () => {
    const target = parseRepoTarget(validRepo(), "server", SERVER);
    expect(target.s3.bucket).toBe("citadel-backups");
    expect(target.password).toBe("a-sixteen-char-or-more-password");
    expect(target.scope).toBe("server");
    expect(target.id).toBe(SERVER);
  });

  test("the scope comes from the route, not the body", () => {
    // A body cannot talk the server-backup route into writing into a node's
    // database repository. The scope decides both the repository path and
    // which host directory is mounted, so it is never taken from the caller.
    const body = { ...validRepo(), scope: "node" } as Record<string, unknown>;
    expect(parseRepoTarget(body, "server", SERVER).scope).toBe("server");
  });

  test("accepts a node-scoped target", () => {
    expect(parseRepoTarget(validRepo(), "node", NODE).scope).toBe("node");
  });

  test("rejects a subject id that is not a UUID", () => {
    expect(() => parseRepoTarget(validRepo(), "server", "../../etc")).toThrow(/must be a UUID/);
  });

  test("rejects a scheme in the endpoint: the transport is its own field", () => {
    const body = validRepo();
    body.repo.s3.endpoint = "http://minio.local:9000";
    expect(() => parseRepoTarget(body, "server", SERVER)).toThrow(/bare host/);
  });

  test("rejects an https scheme too, so there is one answer to 'is this encrypted?'", () => {
    const body = validRepo();
    body.repo.s3.endpoint = "https://s3.amazonaws.com";
    expect(() => parseRepoTarget(body, "server", SERVER)).toThrow(/bare host/);
  });

  test("rejects a path in the endpoint", () => {
    const body = validRepo();
    body.repo.s3.endpoint = "minio.local:9000/some/path";
    expect(() => parseRepoTarget(body, "server", SERVER)).toThrow(/no path/);
  });

  test("accepts a host:port, which is what a self-hosted Garage looks like", () => {
    const body = validRepo();
    body.repo.s3.endpoint = "192.168.1.120:3900";
    expect(parseRepoTarget(body, "server", SERVER).s3.endpoint).toBe("192.168.1.120:3900");
  });

  test("useTls defaults to true when the field is absent", () => {
    // A missing field must never be the reason credentials go out unencrypted.
    const body = validRepo();
    expect(parseRepoTarget(body, "server", SERVER).s3.useTls).toBe(true);
  });

  test("useTls: false is honoured, for a LAN endpoint with no certificate", () => {
    const body = validRepo() as { repo: { s3: Record<string, unknown> } };
    body.repo.s3.useTls = false;
    expect(parseRepoTarget(body as never, "server", SERVER).s3.useTls).toBe(false);
  });

  test("rejects a non-boolean useTls rather than coercing it", () => {
    const body = validRepo() as { repo: { s3: Record<string, unknown> } };
    body.repo.s3.useTls = "no";
    expect(() => parseRepoTarget(body as never, "server", SERVER)).toThrow(/must be a boolean/);
  });

  test("rejects whitespace or quotes in the endpoint", () => {
    const body = validRepo();
    body.repo.s3.endpoint = 's3.amazonaws.com" ';
    expect(() => parseRepoTarget(body, "server", SERVER)).toThrow(/whitespace or quotes/);
  });

  test("rejects a bucket name that is not a bucket name", () => {
    const body = validRepo();
    body.repo.s3.bucket = "not/a/bucket";
    expect(() => parseRepoTarget(body, "server", SERVER)).toThrow(/valid S3 bucket/);
  });

  test("rejects a traversal attempt in the prefix", () => {
    const body = validRepo();
    body.repo.s3.prefix = "panel/../../other-tenant";
    expect(() => parseRepoTarget(body, "server", SERVER)).toThrow(/must not contain/);
  });

  test("accepts an empty prefix", () => {
    const body = validRepo();
    body.repo.s3.prefix = "";
    expect(parseRepoTarget(body, "server", SERVER).s3.prefix).toBe("");
  });

  test("rejects a repository password short enough to guess", () => {
    const body = validRepo();
    body.repo.password = "short";
    expect(() => parseRepoTarget(body, "server", SERVER)).toThrow(/at least 16 characters/);
  });

  test("rejects a missing repo block", () => {
    expect(() => parseRepoTarget({}, "server", SERVER)).toThrow(/"repo" must be an object/);
  });
});

describe("parseKeepMax", () => {
  test("absent means unlimited, never keep-none", () => {
    // The alternative reading of a missing field, "keep zero snapshots", would
    // wipe a repository on a malformed request.
    expect(parseKeepMax({})).toBe(0);
  });

  test("reads a configured limit", () => {
    expect(parseKeepMax({ keepMax: 5 })).toBe(5);
  });

  test("zero is accepted and means unlimited", () => {
    expect(parseKeepMax({ keepMax: 0 })).toBe(0);
  });

  test("rejects a negative or fractional limit", () => {
    expect(() => parseKeepMax({ keepMax: -1 })).toThrow(/must be an integer/);
    expect(() => parseKeepMax({ keepMax: 2.5 })).toThrow(/must be an integer/);
  });
});

describe("parseDbAdmin", () => {
  test("reads the node's MariaDB admin credential", () => {
    expect(parseDbAdmin({ admin: { user: "root", password: "s3cret" } })).toEqual({
      user: "root",
      password: "s3cret",
    });
  });

  test("rejects a missing credential rather than defaulting to root", () => {
    expect(() => parseDbAdmin({})).toThrow(/"admin" must be an object/);
    expect(() => parseDbAdmin({ admin: { user: "root" } })).toThrow(/"password"/);
  });
});

describe("parseDatabaseNames", () => {
  test("absent means no databases", () => {
    expect(parseDatabaseNames({})).toEqual([]);
  });

  test("reads the names", () => {
    expect(parseDatabaseNames({ databases: ["db_abc123", "db_def456"] })).toEqual([
      "db_abc123",
      "db_def456",
    ]);
  });

  test("caps the list so one body cannot spawn unbounded dump containers", () => {
    const databases = Array.from({ length: 501 }, (_, index) => `db_x${index}`);
    expect(() => parseDatabaseNames({ databases })).toThrow(/at most 500/);
  });

  test("rejects a non-array", () => {
    expect(() => parseDatabaseNames({ databases: "db_one" })).toThrow(/must be an array/);
  });

  test("rejects an empty name", () => {
    expect(() => parseDatabaseNames({ databases: [""] })).toThrow(/non-empty/);
  });
});

describe("parseReason", () => {
  test("defaults to manual", () => {
    expect(parseReason({})).toBe("manual");
  });

  test("accepts the scheduled trigger", () => {
    expect(parseReason({ reason: "scheduled" })).toBe("scheduled");
  });

  test("rejects an arbitrary tag rather than forwarding it into restic", () => {
    expect(() => parseReason({ reason: "whatever" })).toThrow(/"manual" or "scheduled"/);
  });
});

describe("parseExclude", () => {
  test("absent means back up everything", () => {
    expect(parseExclude({})).toEqual([]);
  });

  test("reads the patterns", () => {
    expect(parseExclude({ exclude: ["cache/**", "*.tmp"] })).toEqual(["cache/**", "*.tmp"]);
  });

  test("rejects an empty pattern, which would exclude nothing usefully", () => {
    expect(() => parseExclude({ exclude: [""] })).toThrow(/non-empty/);
  });

  test("caps the pattern count", () => {
    const exclude = Array.from({ length: 65 }, (_, index) => `p${index}/**`);
    expect(() => parseExclude({ exclude })).toThrow(/at most 64/);
  });
});

describe("parseSubject", () => {
  test("reads a server subject", () => {
    expect(parseSubject({ scope: "server", id: SERVER })).toEqual({
      scope: "server",
      id: SERVER,
    });
  });

  test("reads a node subject", () => {
    expect(parseSubject({ scope: "node", id: NODE })).toEqual({ scope: "node", id: NODE });
  });

  test("rejects an unknown scope", () => {
    expect(() => parseSubject({ scope: "fleet", id: SERVER })).toThrow(/"server" or "node"/);
  });

  test("rejects a non-UUID id", () => {
    expect(() => parseSubject({ scope: "server", id: "latest" })).toThrow(/must be a UUID/);
  });
});

describe("parseSnapshotId", () => {
  test("accepts a restic-shaped hex id", () => {
    expect(parseSnapshotId("a1b2c3d4")).toBe("a1b2c3d4");
  });

  test("rejects anything that is not hex", () => {
    expect(() => parseSnapshotId("latest")).toThrow(/hexadecimal/);
    expect(() => parseSnapshotId("../../etc")).toThrow(/hexadecimal/);
    expect(() => parseSnapshotId(undefined)).toThrow(/hexadecimal/);
  });

  test("rejects an id too short to be one", () => {
    expect(() => parseSnapshotId("ab")).toThrow(/hexadecimal/);
  });
});
