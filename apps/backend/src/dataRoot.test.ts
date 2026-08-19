/**
 * Data-root readiness tests.
 *
 * The failure these cover is the one that actually happened: an agent whose data
 * root it cannot write to used to throw a raw `EACCES` out of `mkdir`, which the
 * panel showed the admin as "Internal agent error". What matters is that the
 * refusal is a 503 naming the path and the fix.
 *
 * The filesystem cases go through the path-taking helpers rather than the
 * config-reading wrappers: `config.serverDataRoot` is resolved once per process
 * and the test files share that process, so a test that depended on it would be
 * at the mercy of which file set the environment first.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_TOKEN ??= "test-agent-token-that-is-long-enough-0123456789";

const {
  directoryOwner,
  ensureDirectory,
  explainDataRootError,
  probeDirectoryWritable,
} = await import("./dataRoot");
const { HttpError } = await import("./http");

const root = await mkdtemp(join(tmpdir(), "citadel-dataroot-test-"));

// root ignores permission bits, so the unwritable-directory cases cannot be
// expressed when the suite runs as uid 0.
const asRoot = (process.getuid?.() ?? 0) === 0;

afterAll(async () => {
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("probeDirectoryWritable", () => {
  test("creates a missing directory and reports it writable", async () => {
    const fresh = join(root, "fresh");
    const status = await probeDirectoryWritable(fresh);

    expect(status).toEqual({ path: fresh, writable: true });
    // The probe file must not survive: it would litter every node's data root.
    expect(
      await Array.fromAsync(new Bun.Glob("*").scan({ cwd: fresh, dot: true })),
    ).toEqual([]);
  });

  test.skipIf(asRoot)("reports an unwritable directory with the fix", async () => {
    const locked = join(root, "locked");
    await probeDirectoryWritable(locked);
    await chmod(locked, 0o500);
    try {
      const status = await probeDirectoryWritable(locked);

      expect(status.writable).toBe(false);
      expect(status.path).toBe(locked);
      // The message has to be enough to act on: which path, and what to run.
      expect(status.error).toContain(locked);
      expect(status.error).toContain("chown");
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("ensureDirectory", () => {
  test("creates the directory and returns its path", async () => {
    const path = join(root, "servers", "11111111-2222-3333-4444-555555555555");
    expect(await ensureDirectory(path, "a data directory")).toBe(path);
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  test.skipIf(asRoot)("refuses with 503 rather than a raw fs error", async () => {
    const parent = join(root, "readonly-parent");
    await probeDirectoryWritable(parent);
    await chmod(parent, 0o500);
    try {
      const attempt = () => ensureDirectory(join(parent, "child"), "a data directory");

      // "EACCES: permission denied, mkdir ..." is what the admin used to get.
      await expect(attempt()).rejects.toBeInstanceOf(HttpError);
      await expect(attempt()).rejects.toMatchObject({ status: 503 });
      await expect(attempt()).rejects.toThrow(/not allowed to write/);
    } finally {
      await chmod(parent, 0o700);
    }
  });
});

describe("explainDataRootError", () => {
  test("distinguishes causes whose remedies differ", () => {
    const permission = explainDataRootError({ code: "EACCES", path: root }, root);
    expect(permission).toContain("chown");

    // A read-only mount is not fixed by chown, so it must not suggest one.
    const readOnly = explainDataRootError({ code: "EROFS", path: root }, root);
    expect(readOnly).toContain("read-only");
    expect(readOnly).not.toContain("chown");

    expect(explainDataRootError({ code: "ENOSPC", path: root }, root)).toContain(
      "full",
    );
  });

  test("falls back to the supplied path when the error carries none", () => {
    expect(explainDataRootError(new Error("boom"), root)).toContain(root);
  });
});

describe("directoryOwner", () => {
  test("reports the owner of the directory, not the agent's assumption", async () => {
    const path = join(root, "owned");
    await ensureDirectory(path, "a data directory");
    const info = await stat(path);

    expect(await directoryOwner(path)).toBe(`${info.uid}:${info.gid}`);
  });

  test("falls back to the agent's own ids when the path cannot be read", async () => {
    // The install container has to be given *some* user; refusing to answer here
    // would turn an unstattable directory into a provision that never starts.
    expect(await directoryOwner(join(root, "does-not-exist"))).toBe(
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    );
  });
});
