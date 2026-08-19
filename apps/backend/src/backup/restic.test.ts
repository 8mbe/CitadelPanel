/**
 * Tests for the restic command layer.
 *
 * These cover the two things that break silently: the repository URL (a wrong
 * one writes a tenant's data to the wrong prefix, or over another tenant's) and
 * the output parser (a progress line the parser drops shows a stuck progress
 * bar; a summary it drops fails a backup that actually succeeded).
 */

import { describe, expect, test } from "bun:test";
import {
  backupArgs,
  explainResticFailure,
  forgetArgs,
  looksUninitialised,
  parseResticOutput,
  parseSnapshots,
  repositoryEnv,
  repositoryUrl,
  restoreArgs,
  retainsAnything,
  type S3Target,
} from "./restic";

const s3: S3Target = {
  endpoint: "s3.eu-central-1.amazonaws.com",
  bucket: "citadel-backups",
  prefix: "panel",
  region: "eu-central-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-value",
};

const SERVER = "3f2b7c1e-0000-4000-8000-000000000001";

describe("repositoryUrl", () => {
  test("addresses one repository per server under the prefix", () => {
    expect(repositoryUrl(s3, SERVER)).toBe(
      `s3:https://s3.eu-central-1.amazonaws.com/citadel-backups/panel/${SERVER}`,
    );
  });

  test("omits an empty prefix rather than emitting a double slash", () => {
    expect(repositoryUrl({ ...s3, prefix: "" }, SERVER)).toBe(
      `s3:https://s3.eu-central-1.amazonaws.com/citadel-backups/${SERVER}`,
    );
  });

  test("tolerates a prefix with stray slashes", () => {
    expect(repositoryUrl({ ...s3, prefix: "/nested/path/" }, SERVER)).toBe(
      `s3:https://s3.eu-central-1.amazonaws.com/citadel-backups/nested/path/${SERVER}`,
    );
  });

  test("forces https even if a scheme leaked into the endpoint", () => {
    expect(repositoryUrl({ ...s3, endpoint: "http://minio.local:9000" }, SERVER)).toStartWith(
      "s3:https://minio.local:9000/",
    );
  });

  test("gives two servers separate repositories", () => {
    const other = "3f2b7c1e-0000-4000-8000-000000000002";
    expect(repositoryUrl(s3, SERVER)).not.toBe(repositoryUrl(s3, other));
  });
});

describe("repositoryEnv", () => {
  test("carries every credential in the environment, never in argv", () => {
    const env = repositoryEnv({ s3, password: "a-repository-password" }, SERVER);
    expect(env.RESTIC_PASSWORD).toBe("a-repository-password");
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAEXAMPLE");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret-value");
    expect(env.AWS_DEFAULT_REGION).toBe("eu-central-1");

    // Nothing secret may appear in any command the agent builds.
    const argv = [
      ...backupArgs({ serverId: SERVER, reason: "manual", includeDumps: true, exclude: [] }),
      ...restoreArgs("abc123ef"),
      ...forgetArgs({ keepLast: 5, keepDaily: 7, keepWeekly: 0, keepMonthly: 0 }),
    ].join(" ");
    expect(argv).not.toContain("secret-value");
    expect(argv).not.toContain("a-repository-password");
  });

  test("throttles progress output so the log tail stays readable", () => {
    const env = repositoryEnv({ s3, password: "a-repository-password" }, SERVER);
    expect(Number(env.RESTIC_PROGRESS_FPS)).toBeLessThan(1);
  });
});

describe("backupArgs", () => {
  test("snapshots the data mount and tags the server", () => {
    const args = backupArgs({
      serverId: SERVER,
      reason: "scheduled",
      includeDumps: false,
      exclude: [],
    });
    expect(args).toContain("/data");
    expect(args).not.toContain("/dumps");
    expect(args).toContain(`server:${SERVER}`);
    expect(args).toContain("reason:scheduled");
    expect(args).toContain("--json");
  });

  test("includes the dumps mount only when there are databases", () => {
    const args = backupArgs({
      serverId: SERVER,
      reason: "manual",
      includeDumps: true,
      exclude: ["cache/**"],
    });
    expect(args).toContain("/dumps");
    expect(args).toContain("--exclude");
    expect(args).toContain("cache/**");
  });
});

describe("retention", () => {
  test("an all-zero policy retains nothing and must not reach forget", () => {
    expect(retainsAnything({ keepLast: 0, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 })).toBe(
      false,
    );
  });

  test("any non-zero rule is a real policy", () => {
    expect(retainsAnything({ keepLast: 0, keepDaily: 0, keepWeekly: 1, keepMonthly: 0 })).toBe(
      true,
    );
  });

  test("forget only emits the rules that are set, and always prunes", () => {
    const args = forgetArgs({ keepLast: 3, keepDaily: 0, keepWeekly: 0, keepMonthly: 6 });
    expect(args).toContain("--prune");
    expect(args).toContain("--keep-last");
    expect(args).toContain("3");
    expect(args).toContain("--keep-monthly");
    expect(args).toContain("6");
    expect(args).not.toContain("--keep-daily");
    expect(args).not.toContain("--keep-weekly");
  });

  test("forget is scoped to our own tag so a shared repository is safe", () => {
    expect(forgetArgs({ keepLast: 1, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 })).toContain(
      "citadel",
    );
  });
});

describe("restoreArgs", () => {
  test("restores to / so absolute mount paths land back where they came from", () => {
    const args = restoreArgs("deadbeef");
    expect(args).toEqual(["restore", "deadbeef", "--target", "/", "--json"]);
  });

  test("never passes --delete: a restore overlays rather than wipes", () => {
    expect(restoreArgs("deadbeef")).not.toContain("--delete");
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
      "Warning: enable_icc is off\n" +
        '{"message_type":"summary","snapshot_id":"aa","total_bytes_processed":0,"data_added":0}',
    );
    expect(messages).toEqual(["Warning: enable_icc is off"]);
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
