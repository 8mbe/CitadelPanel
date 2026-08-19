/**
 * Tests for the async job registry.
 *
 * The properties that matter are all about not losing information: a failed job
 * must be a readable state rather than a crashed process, the log cursor must
 * never skip a line, and a per-server lock must actually keep two restics off one
 * repository.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  hasRunningJob,
  NODE_DATABASES_SUBJECT,
  readJob,
  resetJobs,
  serverSubject,
  startJob,
} from "./jobs";

const SERVER = serverSubject("3f2b7c1e-0000-4000-8000-000000000001");
const OTHER = serverSubject("3f2b7c1e-0000-4000-8000-000000000002");

/** Let the detached job body run to completion. */
const settle = () => Bun.sleep(10);

afterEach(() => {
  resetJobs();
});

describe("startJob", () => {
  test("returns immediately and reports the job as running", () => {
    const jobId = startJob(SERVER, "backup", async () => {
      await Bun.sleep(50);
    });

    const job = readJob(jobId);
    expect(job.status).toBe("running");
    expect(job.kind).toBe("backup");
    expect(job.subject).toBe(SERVER);
    expect(job.percent).toBe(0);
  });

  test("records a successful result and finishes at 100%", async () => {
    const jobId = startJob(SERVER, "backup", async () => ({
      snapshotId: "abc123",
      bytesAdded: 4096,
      databases: ["db_one", "db_two"],
      forgotten: ["old1111"],
      repoSizeBytes: 987654,
    }));
    await settle();

    const job = readJob(jobId);
    expect(job.status).toBe("succeeded");
    expect(job.phase).toBe("finished");
    expect(job.percent).toBe(100);
    expect(job.result.snapshotId).toBe("abc123");
    expect(job.result.databases).toEqual(["db_one", "db_two"]);
    expect(job.finishedAt).not.toBeNull();
  });

  test("carries the quota deletions and the measured size back to the panel", async () => {
    // The panel cannot infer which snapshots the quota removed without
    // re-listing and diffing the repository, so the job that deleted them
    // reports their ids.
    const jobId = startJob(SERVER, "backup", async () => ({
      snapshotId: "new0000",
      forgotten: ["old1111", "old2222"],
      repoSizeBytes: 1024,
    }));
    await settle();

    const job = readJob(jobId);
    expect(job.result.forgotten).toEqual(["old1111", "old2222"]);
    expect(job.result.repoSizeBytes).toBe(1024);
  });

  test("an unmeasurable repository reports null, not zero", async () => {
    // Zero is a real size for a fresh repository; conflating the two would
    // understate the fleet's storage use.
    const jobId = startJob(SERVER, "backup", async () => ({
      snapshotId: "new0000",
      repoSizeBytes: null,
    }));
    await settle();
    expect(readJob(jobId).result.repoSizeBytes).toBeNull();
  });

  test("a thrown error becomes a failed job, not an unhandled rejection", async () => {
    const jobId = startJob(SERVER, "backup", async () => {
      throw new Error("S3 rejected the credentials");
    });
    await settle();

    const job = readJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("S3 rejected the credentials");
    // The failure is also in the log, which is what the panel shows the operator.
    expect(job.logs.at(-1)?.level).toBe("error");
    expect(job.logs.at(-1)?.message).toContain("S3 rejected the credentials");
  });

  test("a non-Error throw is still reported readably", async () => {
    const jobId = startJob(SERVER, "restore", async () => {
      throw "plain string";
    });
    await settle();
    expect(readJob(jobId).error).toBe("plain string");
  });

  test("a job with no return value still succeeds", async () => {
    const jobId = startJob(SERVER, "restore", async () => undefined);
    await settle();
    expect(readJob(jobId).status).toBe("succeeded");
  });
});

describe("progress reporting", () => {
  test("phase and percent are visible while the job runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const jobId = startJob(SERVER, "backup", async (reporter) => {
      reporter.phase("uploading");
      reporter.progress(42);
      reporter.log("halfway");
      await gate;
    });
    await settle();

    const job = readJob(jobId);
    expect(job.phase).toBe("uploading");
    expect(job.percent).toBe(42);
    expect(job.logs.map((line) => line.message)).toContain("halfway");

    release();
  });

  test("percent is clamped and rounded", async () => {
    // Each reading is checked from outside the job, between gates, because a
    // completed job is forced to 100 and would mask the clamping.
    const readings: number[] = [];
    let step!: () => void;
    let gate = new Promise<void>((resolve) => {
      step = resolve;
    });
    const advance = async () => {
      const release = step;
      gate = new Promise<void>((resolve) => {
        step = resolve;
      });
      release();
      await Bun.sleep(5);
    };

    const jobId = startJob(SERVER, "backup", async (reporter) => {
      reporter.progress(150);
      await gate;
      reporter.progress(-10);
      await gate;
      reporter.progress(33.6);
      await gate;
    });

    await Bun.sleep(5);
    readings.push(readJob(jobId).percent);
    await advance();
    readings.push(readJob(jobId).percent);
    await advance();
    readings.push(readJob(jobId).percent);
    await advance();

    expect(readings).toEqual([100, 0, 34]);
  });
});

describe("log draining", () => {
  test("afterSeq returns only newer lines and never skips one", async () => {
    const jobId = startJob(SERVER, "backup", async (reporter) => {
      reporter.log("one");
      reporter.log("two");
      reporter.log("three");
    });
    await settle();

    const first = readJob(jobId, 0);
    expect(first.logs.map((line) => line.message)).toEqual([
      "one",
      "two",
      "three",
      "Backup completed.",
    ]);

    // Draining from the cursor the previous read reported yields nothing new.
    expect(readJob(jobId, first.latestSeq).logs).toEqual([]);

    // A partial drain picks up exactly the remainder.
    expect(readJob(jobId, 2).logs.map((line) => line.message)).toEqual([
      "three",
      "Backup completed.",
    ]);
  });

  test("sequence numbers are strictly increasing", async () => {
    const jobId = startJob(SERVER, "backup", async (reporter) => {
      for (let index = 0; index < 5; index += 1) reporter.log(`line ${index}`);
    });
    await settle();

    const seqs = readJob(jobId).logs.map((line) => line.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("a re-read of the same window is idempotent", async () => {
    const jobId = startJob(SERVER, "backup", async (reporter) => {
      reporter.log("only");
    });
    await settle();

    expect(readJob(jobId, 0).logs).toEqual(readJob(jobId, 0).logs);
  });

  test("levels are carried through so warnings render differently", async () => {
    const jobId = startJob(SERVER, "backup", async (reporter) => {
      reporter.log("careful", "warn");
    });
    await settle();

    expect(readJob(jobId).logs.find((line) => line.message === "careful")?.level).toBe("warn");
  });

  test("a very long line is truncated rather than dominating the buffer", async () => {
    const jobId = startJob(SERVER, "backup", async (reporter) => {
      reporter.log("x".repeat(5000));
    });
    await settle();

    expect(readJob(jobId).logs[0]!.message.length).toBe(2000);
  });
});

describe("hasRunningJob", () => {
  test("reports a job in flight for that subject only", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startJob(SERVER, "backup", async () => {
      await gate;
    });

    expect(hasRunningJob(SERVER)).toBe(true);
    // A busy server must not block backups of a different one, nor the node's
    // own database backup — the two scopes write to different repositories.
    expect(hasRunningJob(OTHER)).toBe(false);
    expect(hasRunningJob(NODE_DATABASES_SUBJECT)).toBe(false);

    release();
    await settle();
    expect(hasRunningJob(SERVER)).toBe(false);
  });

  test("the node database subject locks independently of any server", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startJob(NODE_DATABASES_SUBJECT, "backup", async () => {
      await gate;
    });

    expect(hasRunningJob(NODE_DATABASES_SUBJECT)).toBe(true);
    expect(hasRunningJob(SERVER)).toBe(false);

    release();
    await settle();
    expect(hasRunningJob(NODE_DATABASES_SUBJECT)).toBe(false);
  });

  test("subject keys namespace servers apart from the node", () => {
    expect(serverSubject("abc")).toBe("server:abc");
    expect(NODE_DATABASES_SUBJECT).not.toBe(serverSubject("abc"));
  });

  test("a failed job no longer counts as running", async () => {
    startJob(SERVER, "backup", async () => {
      throw new Error("nope");
    });
    await settle();
    expect(hasRunningJob(SERVER)).toBe(false);
  });
});

describe("readJob", () => {
  test("an unknown job id is a 404 the panel can act on", () => {
    expect(() => readJob("00000000-0000-4000-8000-000000000000")).toThrow(/No such backup job/);
  });
});
