/**
 * Symlink-escape regression tests for the *write* file operations.
 *
 * The attack these pin down: the game server (which owns its data directory)
 * plants `ln -s /somewhere/outside escape` inside it, and a later panel- or
 * SFTP-triggered write to `escape/<name>` follows the link, executed by the
 * agent, whose filesystem access on the node is root-equivalent. Reads catch
 * this via `resolveExistingServerPath`; these tests hold the write paths
 * (rename/copy destinations, the ones the 2026-08 audit fix missed) to the
 * same standard.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";

const root = (await import("../test-setup")).testRoot;

const { copyPath, renamePath } = await import("./files");
const { HttpError } = await import("./http");

const SERVER_ID = "44444444-3333-2222-1111-000000000000";
const serverDir = join(root, SERVER_ID);
/** Outside the server's tree but inside the (temp) data root's parent. */
const outsideDir = join(root, "write-escape-outside");

const exists = (abs: string) =>
  import("node:fs/promises").then(({ stat }) =>
    stat(abs).then(
      () => true,
      () => false,
    ),
  );

beforeAll(async () => {
  await mkdir(join(serverDir, "plugins"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await fsWriteFile(join(serverDir, "victim.txt"), "world data");
  // What the tenant plants: a directory-shaped symlink pointing out of jail.
  await symlink(outsideDir, join(serverDir, "escape"));
});

/** The op must fail 4xx and nothing may appear outside the boundary. */
async function expectContained(op: Promise<unknown>, leakedPath: string) {
  const error = await op.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect(await exists(leakedPath)).toBe(false);
}

describe("write operations through a planted symlink", () => {
  test("renamePath refuses a destination under a symlinked parent", async () => {
    await expectContained(
      renamePath(SERVER_ID, "victim.txt", "escape/victim.txt"),
      join(outsideDir, "victim.txt"),
    );
    // The source must survive the refused move.
    expect(await exists(join(serverDir, "victim.txt"))).toBe(true);
  });

  test("copyPath refuses a destination under a symlinked parent", async () => {
    await expectContained(
      copyPath(SERVER_ID, "victim.txt", "escape/copied.txt"),
      join(outsideDir, "copied.txt"),
    );
  });

  test("a legitimate rename into a real subdirectory still works", async () => {
    await renamePath(SERVER_ID, "victim.txt", "plugins/victim.txt");
    expect(await exists(join(serverDir, "plugins/victim.txt"))).toBe(true);
  });
});
