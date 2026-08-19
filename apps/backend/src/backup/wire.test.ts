/**
 * Tests for backup request validation.
 *
 * The agent validates the panel's bodies because its token is root-equivalent
 * for this host: these fields decide which S3 endpoint the node connects to and
 * which identifiers reach SQL. Two cases carry real security weight — a scheme
 * in the endpoint (which would downgrade the bucket credentials to plaintext
 * HTTP) and an absent retention policy (which, if defaulted to all-zero, would
 * make `restic forget` delete every snapshot).
 */

import { describe, expect, test } from "bun:test";
import {
  parseDatabases,
  parseExclude,
  parseReason,
  parseRepoTarget,
  parseRetention,
  parseSnapshotId,
} from "./wire";

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
  test("accepts a well-formed target", () => {
    const target = parseRepoTarget(validRepo());
    expect(target.s3.bucket).toBe("citadel-backups");
    expect(target.password).toBe("a-sixteen-char-or-more-password");
  });

  test("rejects a scheme in the endpoint, which would allow plaintext S3", () => {
    const body = validRepo();
    body.repo.s3.endpoint = "http://minio.local:9000";
    expect(() => parseRepoTarget(body)).toThrow(/bare host/);
  });

  test("rejects an https scheme too — the transport is not the caller's choice", () => {
    const body = validRepo();
    body.repo.s3.endpoint = "https://s3.amazonaws.com";
    expect(() => parseRepoTarget(body)).toThrow(/bare host/);
  });

  test("rejects whitespace or quotes in the endpoint", () => {
    const body = validRepo();
    body.repo.s3.endpoint = 's3.amazonaws.com" ';
    expect(() => parseRepoTarget(body)).toThrow(/whitespace or quotes/);
  });

  test("rejects a bucket name that is not a bucket name", () => {
    const body = validRepo();
    body.repo.s3.bucket = "not/a/bucket";
    expect(() => parseRepoTarget(body)).toThrow(/valid S3 bucket/);
  });

  test("rejects a traversal attempt in the prefix", () => {
    const body = validRepo();
    body.repo.s3.prefix = "panel/../../other-tenant";
    expect(() => parseRepoTarget(body)).toThrow(/must not contain/);
  });

  test("accepts an empty prefix", () => {
    const body = validRepo();
    body.repo.s3.prefix = "";
    expect(parseRepoTarget(body).s3.prefix).toBe("");
  });

  test("rejects a repository password short enough to guess", () => {
    const body = validRepo();
    body.repo.password = "short";
    expect(() => parseRepoTarget(body)).toThrow(/at least 16 characters/);
  });

  test("rejects a missing repo block", () => {
    expect(() => parseRepoTarget({})).toThrow(/"repo" must be an object/);
  });
});

describe("parseRetention", () => {
  test("an absent policy means keep everything, never delete everything", () => {
    // All-zero is the value that would make `restic forget` wipe the repository,
    // so the caller must be able to distinguish it from "not configured".
    expect(parseRetention({})).toEqual({
      keepLast: 0,
      keepDaily: 0,
      keepWeekly: 0,
      keepMonthly: 0,
    });
  });

  test("reads a full policy", () => {
    expect(
      parseRetention({
        retention: { keepLast: 5, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
      }),
    ).toEqual({ keepLast: 5, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
  });

  test("rejects a non-integer or negative rule", () => {
    expect(() =>
      parseRetention({ retention: { keepLast: 1.5, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 } }),
    ).toThrow(/must be an integer/);
    expect(() =>
      parseRetention({ retention: { keepLast: -1, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 } }),
    ).toThrow(/must be an integer/);
  });
});

describe("parseDatabases", () => {
  test("absent means no databases", () => {
    expect(parseDatabases({})).toEqual([]);
  });

  test("reads each database's own scoped credentials", () => {
    expect(
      parseDatabases({
        databases: [{ name: "db_abc123", user: "u_abc123", password: "pw" }],
      }),
    ).toEqual([{ name: "db_abc123", user: "u_abc123", password: "pw" }]);
  });

  test("caps the list so one body cannot spawn unbounded dump containers", () => {
    const databases = Array.from({ length: 33 }, (_, index) => ({
      name: `db_x${index}`,
      user: `u_x${index}`,
      password: "pw",
    }));
    expect(() => parseDatabases({ databases })).toThrow(/at most 32/);
  });

  test("rejects a non-array", () => {
    expect(() => parseDatabases({ databases: "db_one" })).toThrow(/must be an array/);
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
