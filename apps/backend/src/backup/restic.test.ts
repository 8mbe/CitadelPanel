/**
 * Tests for the restic command layer.
 *
 * These cover the things that break silently: the repository URL (a wrong one
 * writes a tenant's data to the wrong prefix, or over another tenant's), the
 * quota arithmetic (an off-by-one either leaks storage or deletes a backup that
 * should have been kept), and the output parsers (a progress line the parser drops
 * shows a stuck progress bar; a summary it drops fails a backup that succeeded).
 */

import { describe, expect, test } from "bun:test";
import {
  backupArgs,
  explainResticFailure,
  forgetSnapshotsArgs,
  looksUninitialised,
  parseRepositorySize,
  parseResticOutput,
  parseSnapshots,
  repositoryEnv,
  repositoryUrl,
  restoreArgs,
  snapshotsToForget,
  statsArgs,
  type S3Target,
  type SnapshotInfo,
} from "./restic";

const s3: S3Target = {
  endpoint: "s3.eu-central-1.amazonaws.com",
  bucket: "citadel-backups",
  prefix: "panel",
  region: "eu-central-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-value",
  useTls: true,
};

const SERVER = "3f2b7c1e-0000-4000-8000-000000000001";
const NODE = "9a1b2c3d-0000-4000-8000-0000000000ff";

describe("repositoryUrl", () => {
  test("addresses one repository per server under the servers/ segment", () => {
    expect(repositoryUrl(s3, "server", SERVER)).toBe(
      `s3:https://s3.eu-central-1.amazonaws.com/citadel-backups/panel/servers/${SERVER}`,
    );
  });

  test("addresses a node's database repository under nodes/", () => {
    expect(repositoryUrl(s3, "node", NODE)).toBe(
      `s3:https://s3.eu-central-1.amazonaws.com/citadel-backups/panel/nodes/${NODE}`,
    );
  });

  test("keeps the two scopes apart even for the same id", () => {
    // Both ids are UUIDs, so without the scope segment a server and a node could
    // collide on one repository — and a server backup would overwrite a node's
    // database snapshots.
    expect(repositoryUrl(s3, "server", SERVER)).not.toBe(
      repositoryUrl(s3, "node", SERVER),
    );
  });

  test("omits an empty prefix rather than emitting a double slash", () => {
    expect(repositoryUrl({ ...s3, prefix: "" }, "server", SERVER)).toBe(
      `s3:https://s3.eu-central-1.amazonaws.com/citadel-backups/servers/${SERVER}`,
    );
  });

  test("tolerates a prefix with stray slashes", () => {
    expect(repositoryUrl({ ...s3, prefix: "/nested/path/" }, "server", SERVER)).toBe(
      `s3:https://s3.eu-central-1.amazonaws.com/citadel-backups/nested/path/servers/${SERVER}`,
    );
  });

  test("strips a scheme that leaked into the endpoint rather than doubling it", () => {
    expect(
      repositoryUrl({ ...s3, endpoint: "http://minio.local:9000" }, "server", SERVER),
    ).toStartWith("s3:https://minio.local:9000/");
  });

  test("useTls: false addresses a plaintext endpoint", () => {
    // A LAN-local Garage or MinIO commonly has no certificate; forcing TLS would
    // mean no backups at all for that operator.
    expect(
      repositoryUrl({ ...s3, endpoint: "192.168.1.120:3900", useTls: false }, "server", SERVER),
    ).toBe(
      `s3:http://192.168.1.120:3900/citadel-backups/panel/servers/${SERVER}`,
    );
  });

  test("the transport comes from useTls, not from the endpoint string", () => {
    // Otherwise pasting a URL would be a second, less visible way to end up on
    // plaintext.
    expect(
      repositoryUrl({ ...s3, endpoint: "https://minio.local", useTls: false }, "server", SERVER),
    ).toStartWith("s3:http://minio.local/");
  });

  test("gives two servers separate repositories", () => {
    const other = "3f2b7c1e-0000-4000-8000-000000000002";
    expect(repositoryUrl(s3, "server", SERVER)).not.toBe(
      repositoryUrl(s3, "server", other),
    );
  });
});

describe("repositoryEnv", () => {
  test("carries every credential in the environment, never in argv", () => {
    const env = repositoryEnv({
      s3,
      scope: "server",
      id: SERVER,
      password: "a-repository-password",
    });
    expect(env.RESTIC_PASSWORD).toBe("a-repository-password");
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAEXAMPLE");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret-value");
    expect(env.AWS_DEFAULT_REGION).toBe("eu-central-1");

    // Nothing secret may appear in any command the agent builds.
    const argv = [
      ...backupArgs({
        scope: "server",
        id: SERVER,
        paths: ["/data"],
        reason: "manual",
        exclude: [],
      }),
      ...restoreArgs("abc123ef"),
      ...forgetSnapshotsArgs(["abc123ef"]),
      ...statsArgs(),
    ].join(" ");
    expect(argv).not.toContain("secret-value");
    expect(argv).not.toContain("a-repository-password");
  });

  test("throttles progress output so the log tail stays readable", () => {
    const env = repositoryEnv({
      s3,
      scope: "server",
      id: SERVER,
      password: "a-repository-password",
    });
    expect(Number(env.RESTIC_PROGRESS_FPS)).toBeLessThan(1);
  });
});

describe("backupArgs", () => {
  test("snapshots the given paths and tags the scope and subject", () => {
    const args = backupArgs({
      scope: "server",
      id: SERVER,
      paths: ["/data"],
      reason: "scheduled",
      exclude: [],
    });
    expect(args).toContain("/data");
    expect(args).not.toContain("/dumps");
    expect(args).toContain(`server:${SERVER}`);
    expect(args).toContain("reason:scheduled");
    expect(args).toContain("--json");
  });

  test("a node database backup snapshots the dumps mount, not the data mount", () => {
    const args = backupArgs({
      scope: "node",
      id: NODE,
      paths: ["/dumps"],
      reason: "scheduled",
      exclude: [],
    });
    expect(args).toContain("/dumps");
    expect(args).not.toContain("/data");
    expect(args).toContain(`node:${NODE}`);
  });

  test("passes the admin's exclude patterns through", () => {
    const args = backupArgs({
      scope: "server",
      id: SERVER,
      paths: ["/data"],
      reason: "manual",
      exclude: ["cache/**", "*.tmp"],
    });
    expect(args).toContain("--exclude");
    expect(args).toContain("cache/**");
    expect(args).toContain("*.tmp");
  });
});

describe("forgetSnapshotsArgs", () => {
  test("names every snapshot explicitly and always prunes", () => {
    const args = forgetSnapshotsArgs(["aaaa1111", "bbbb2222"]);
    expect(args).toEqual(["forget", "aaaa1111", "bbbb2222", "--prune", "--json"]);
  });

  test("never emits a --keep policy, which could delete everything", () => {
    // `forget` with a --keep-* policy and no matching snapshots wipes a
    // repository. This system only ever deletes ids it named.
    expect(forgetSnapshotsArgs(["aaaa1111"]).join(" ")).not.toContain("--keep");
  });

  test("refuses an empty list rather than building a policy-less forget", () => {
    expect(() => forgetSnapshotsArgs([])).toThrow(/at least one snapshot id/);
  });
});

describe("snapshotsToForget", () => {
  const snap = (id: string, iso: string): SnapshotInfo => ({ id, time: iso, tags: [] });

  const five = [
    snap("s1", "2026-08-15T00:00:00Z"),
    snap("s2", "2026-08-16T00:00:00Z"),
    snap("s3", "2026-08-17T00:00:00Z"),
    snap("s4", "2026-08-18T00:00:00Z"),
    snap("s5", "2026-08-19T00:00:00Z"),
  ];

  test("at the limit, the single oldest goes to make room for the new one", () => {
    expect(snapshotsToForget(five, 5).map((s) => s.id)).toEqual(["s1"]);
  });

  test("below the limit, nothing is deleted", () => {
    expect(snapshotsToForget(five.slice(0, 4), 5)).toEqual([]);
  });

  test("an empty repository deletes nothing", () => {
    expect(snapshotsToForget([], 5)).toEqual([]);
  });

  test("over the limit (a lowered setting), it catches up in one pass", () => {
    // Limit dropped from 5 to 3: two must go now, plus one for the incoming
    // snapshot, leaving 2 existing + 1 new = 3.
    expect(snapshotsToForget(five, 3).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  test("a limit of 1 clears the way for the new snapshot to stand alone", () => {
    expect(snapshotsToForget(five, 1).map((s) => s.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
    ]);
  });

  test("zero means unlimited and never deletes", () => {
    expect(snapshotsToForget(five, 0)).toEqual([]);
  });

  test("a negative limit is treated as unlimited, not as delete-everything", () => {
    expect(snapshotsToForget(five, -1)).toEqual([]);
  });

  test("oldest-first is decided by timestamp, not by input order", () => {
    const shuffled = [five[2]!, five[0]!, five[4]!, five[1]!, five[3]!];
    expect(snapshotsToForget(shuffled, 5).map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("restoreArgs", () => {
  test("restores to / so absolute mount paths land back where they came from", () => {
    expect(restoreArgs("deadbeef")).toEqual([
      "restore",
      "deadbeef",
      "--target",
      "/",
      "--json",
    ]);
  });

  test("never passes --delete: a restore overlays rather than wipes", () => {
    expect(restoreArgs("deadbeef")).not.toContain("--delete");
  });
});

describe("statsArgs", () => {
  test("measures stored bytes, not restore size", () => {
    // The default mode reports how big a restore would be; only raw-data
    // corresponds to what the bucket is actually billing for.
    expect(statsArgs()).toEqual(["stats", "--mode", "raw-data", "--json"]);
  });
});

describe("parseRepositorySize", () => {
  test("reads total_size", () => {
    expect(parseRepositorySize('{"total_size":123456,"total_blob_count":42}')).toBe(123456);
  });

  test("tolerates surrounding log noise", () => {
    expect(parseRepositorySize('warn: locked\n{"total_size":7}\n')).toBe(7);
  });

  test("zero is a real size, not a failure", () => {
    expect(parseRepositorySize('{"total_size":0}')).toBe(0);
  });

  test("unreadable output is null, so it is never mistaken for empty", () => {
    expect(parseRepositorySize("Fatal: unable to open repository")).toBeNull();
    expect(parseRepositorySize('{"total_size":"lots"}')).toBeNull();
    expect(parseRepositorySize("")).toBeNull();
  });
});

describe("parseResticOutput", () => {
  test("reads the newest status line as progress", () => {
    const output = [
      '{"message_type":"status","percent_done":0.1,"files_done":10,"bytes_done":1024}',
      '{"message_type":"status","percent_done":0.755,"files_done":90,"bytes_done":8192,"seconds_remaining":42}',
    ].join("\n");

    const { progress } = parseResticOutput(output);
    expect(progress).toEqual({
      percent: 76,
      filesDone: 90,
      bytesDone: 8192,
      secondsRemaining: 42,
    });
  });

  test("treats a missing seconds_remaining as unknown, not zero", () => {
    const { progress } = parseResticOutput(
      '{"message_type":"status","percent_done":0.5,"seconds_remaining":0}',
    );
    expect(progress?.secondsRemaining).toBeNull();
  });

  test("extracts the summary, including the deduplicated upload size", () => {
    const output =
      '{"message_type":"status","percent_done":1}\n' +
      '{"message_type":"summary","snapshot_id":"a1b2c3d4","files_new":12,' +
      '"files_changed":3,"total_bytes_processed":5000,"data_added":900,"total_duration":12.5}';

    const { summary } = parseResticOutput(output);
    expect(summary).toEqual({
      snapshotId: "a1b2c3d4",
      filesNew: 12,
      filesChanged: 3,
      bytesProcessed: 5000,
      bytesAdded: 900,
      durationSeconds: 12.5,
    });
  });

  test("collects per-file errors without discarding the summary", () => {
    const output = [
      '{"message_type":"error","error":{"message":"permission denied"},"during":"archival","item":"/data/locked"}',
      '{"message_type":"summary","snapshot_id":"ff00","total_bytes_processed":1,"data_added":1}',
    ].join("\n");

    const { errors, summary } = parseResticOutput(output);
    expect(errors).toEqual(["archival: /data/locked: permission denied"]);
    expect(summary?.snapshotId).toBe("ff00");
  });

  test("survives a line the polled log tail cut in half", () => {
    // The first line is a fragment: the poll window started mid-write.
    const output =
      'ssage_type":"status","percent_done":0.2}\n' +
      '{"message_type":"summary","snapshot_id":"beef","total_bytes_processed":2,"data_added":2}';

    const { summary, progress } = parseResticOutput(output);
    expect(summary?.snapshotId).toBe("beef");
    // The fragment is not valid JSON and is not misread as progress.
    expect(progress).toBeNull();
  });

  test("keeps plain-text warnings restic writes outside the JSON stream", () => {
    const { messages } = parseResticOutput(
      "Warning: repository is locked\n" +
        '{"message_type":"summary","snapshot_id":"aa","total_bytes_processed":0,"data_added":0}',
    );
    expect(messages).toEqual(["Warning: repository is locked"]);
  });

  test("empty output yields nothing rather than throwing", () => {
    expect(parseResticOutput("")).toEqual({
      progress: null,
      summary: null,
      errors: [],
      messages: [],
    });
  });
});

describe("parseSnapshots", () => {
  test("reads the snapshot array", () => {
    const output =
      'unrelated log line\n[{"id":"aaaa","time":"2026-08-19T10:00:00Z","tags":["citadel"]},' +
      '{"id":"bbbb","time":"2026-08-18T10:00:00Z","tags":[]}]';

    expect(parseSnapshots(output)).toEqual([
      { id: "aaaa", time: "2026-08-19T10:00:00Z", tags: ["citadel"] },
      { id: "bbbb", time: "2026-08-18T10:00:00Z", tags: [] },
    ]);
  });

  test("an empty repository is an empty list", () => {
    expect(parseSnapshots("[]")).toEqual([]);
  });

  test("unparseable output is an empty list, not a crash", () => {
    expect(parseSnapshots("Fatal: unable to open repository")).toEqual([]);
  });
});

describe("failure explanation", () => {
  test("names a rotated encryption key rather than echoing restic's wording", () => {
    const message = explainResticFailure(1, "Fatal: wrong password or no key found");
    expect(message).toContain("PANEL_ENCRYPTION_KEY");
  });

  test("names the credentials when S3 rejects the signature", () => {
    expect(explainResticFailure(1, "SignatureDoesNotMatch")).toContain("access key");
  });

  test("names the network when the endpoint is unreachable", () => {
    expect(explainResticFailure(1, "dial tcp: lookup failed")).toContain("could not reach");
  });

  test("points at the TLS toggle when the endpoint speaks plaintext", () => {
    // restic's own wording for this says nothing about which setting to change.
    const message = explainResticFailure(
      1,
      "Fatal: server gave HTTP response to HTTPS client",
    );
    expect(message).toContain("Connect over TLS");
  });

  test("names the region for a self-hosted server that validates it", () => {
    const message = explainResticFailure(1, "InvalidRegion: wrong region for bucket");
    expect(message).toContain("garage");
  });

  test("says a missing bucket has to be created by hand", () => {
    expect(explainResticFailure(1, "NoSuchBucket")).toContain("Create the bucket");
  });

  test("falls back to the exit code and output tail", () => {
    expect(explainResticFailure(7, "something unexpected")).toContain("exited with code 7");
  });
});

describe("looksUninitialised", () => {
  test("recognises a repository that does not exist yet", () => {
    expect(looksUninitialised("Fatal: unable to open config file: Stat: ...")).toBe(true);
  });

  test("does not mistake a credential failure for a missing repository", () => {
    expect(looksUninitialised("Fatal: SignatureDoesNotMatch")).toBe(false);
  });
});
