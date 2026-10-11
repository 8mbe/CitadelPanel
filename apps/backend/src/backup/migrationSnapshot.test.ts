import { expect, test } from "bun:test";

// Isolate tool mocks from other backend tests; no Docker or S3 operation runs.
test.each([
  [true, 3, "failed"],
  [false, 3, "succeeded"],
  [true, 0, "succeeded"],
] as const)("snapshot completeness=%s, restic exit=%s yields %s", (requireComplete, exitCode, expected) => {
  const code = `
    import { mock } from "bun:test";
    process.env.BACKUP_STAGING_ROOT = process.env.SERVER_DATA_ROOT + "/.backup-staging";
    const userns = await import("./src/docker/userns");
    mock.module("./src/docker/userns", () => ({ ...userns, alignOwnership: async () => {} }));
    const data = await import("./src/dataRoot");
    mock.module("./src/dataRoot", () => ({ ...data, ensureServerDataDir: async () => {} }));
    mock.module("./src/backup/toolContainer", () => ({ runToolContainer: async spec => ({
      exitCode: spec.command[0] === "backup" ? ${exitCode} : 0, timedOut: false,
      output: spec.command[0] === "backup"
        ? JSON.stringify({ message_type: "summary", snapshot_id: "a".repeat(64), total_bytes_processed: 10, data_added: 10 })
        : JSON.stringify({ total_size: 10 }),
    }) }));
    const { startServerBackup } = await import("./src/backup/run");
    const { readJob } = await import("./src/backup/jobs");
    const id = "99999999-1111-2222-3333-444444444444";
    const jobId = startServerBackup(id, { keepMax: 0, reason: "manual", exclude: [], requireComplete: ${requireComplete},
      repo: { scope: "server", id, password: "test-password-000000000000000", s3: {
        endpoint: "s3.test", bucket: "backups", prefix: "", region: "us-east-1",
        useTls: false, accessKeyId: "test", secretAccessKey: "test",
      } },
    });
    for (let i = 0; i < 100; i++) {
      const job = readJob(jobId);
      if (job.status !== "running") { console.log(JSON.stringify({ status: job.status, error: job.error })); process.exit(0); }
      await Bun.sleep(1);
    }
    throw new Error("Backup test job did not settle");
  `;
  const child = Bun.spawnSync({
    cmd: [process.execPath, "--preload", "./test-setup.ts", "--eval", code],
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(new TextDecoder().decode(child.stdout));
  expect(result.status).toBe(expected);
  if (expected === "failed") expect(result.error).toContain("incomplete snapshot");
});
