/**
 * Batch-delete tests.
 *
 * `deletePaths` is the one file operation that takes a caller-supplied list, so
 * what matters is the failure shape: a selection must be deleted whole or not
 * at all. A batch that half-completes is the worst outcome. The panel would
 * refresh its listing into a state the user never chose, with no error saying
 * which entries survived.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The data root is a temp directory prepared by the test preload
// (test-setup.ts) before any test module runs, and therefore before any config
// import runs. It is imported here only to learn where it is.
const root = (await import("../test-setup")).testRoot;

const { deletePaths } = await import("./files");
const { config } = await import("./config");
const { HttpError } = await import("./http");

const SERVER_ID = "99999999-8888-7777-6666-555555555555";
const serverDir = join(root, SERVER_ID);

/** Path inside this server's data directory. */
const inServer = (rel: string) => join(serverDir, rel);

/** Null when the path no longer exists. The assertions only need that much. */
const exists = (abs: string) =>
  stat(abs).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  await mkdir(inServer("world/region"), { recursive: true });
  await mkdir(inServer("plugins"), { recursive: true });
  await writeFile(inServer("world/level.dat"), "level");
  await writeFile(inServer("world/region/r.0.0.mca"), "chunk");
  await writeFile(inServer("plugins/jar1.txt"), "jar");
  await writeFile(inServer("plugins/jar2.txt"), "jar");
  await writeFile(inServer("server.properties"), "motd=hi");
  await writeFile(inServer("banned-players.json"), "[]");
  await writeFile(join(root, "outside-secret.txt"), "should never be deleted");
});

/**
 * Expect the call to fail as a 4xx HttpError with nothing in the batch
 * removed. The exact status is the resolver's choice (a traversal is a 403,
 * the data-root and shape refusals are 400s); what matters here is that the
 * whole batch is refused, not half-applied.
 */
async function expectRefused(paths: string[]) {
  const error = await deletePaths(SERVER_ID, paths).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  const status = (error as InstanceType<typeof HttpError>).status;
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
}

describe("deletePaths", () => {
  test("removes every path in the batch, files and directory trees alike", async () => {
    await deletePaths(SERVER_ID, [
      "/server.properties",
      "/plugins",
      "/banned-players.json",
    ]);

    expect(await exists(inServer("server.properties"))).toBe(false);
    expect(await exists(inServer("plugins"))).toBe(false);
    expect(await exists(inServer("plugins/jar1.txt"))).toBe(false);
    expect(await exists(inServer("banned-players.json"))).toBe(false);
    // Untouched entries survive.
    expect(await exists(inServer("world/level.dat"))).toBe(true);
  });

  test("a parent and its descendant in one batch delete without error", async () => {
    await deletePaths(SERVER_ID, ["/world/region", "/world/region/r.0.0.mca"]);

    expect(await exists(inServer("world/region"))).toBe(false);
    expect(await exists(inServer("world/level.dat"))).toBe(true);
  });

  test("a traversal entry fails the whole batch before anything is removed", async () => {
    await expectRefused(["/world/level.dat", "../outside-secret.txt"]);

    expect(await exists(inServer("world/level.dat"))).toBe(true);
    expect(await exists(join(root, "outside-secret.txt"))).toBe(true);
  });

  test("the data directory in a batch is refused, and the rest survives", async () => {
    await expectRefused(["/world", "/"]);

    expect(await exists(inServer("world"))).toBe(true);
  });

  test("rejects an empty batch, non-string entries, and one over the cap", async () => {
    await expectRefused([]);
    await expectRefused(["/world", 42 as unknown as string]);

    const over = Array.from(
      { length: config.maxDirEntries + 1 },
      (_, i) => `/file-${i}`,
    );
    await expectRefused(over);
    // The cap check happens before resolution, so nothing needed to exist.
  });
});
