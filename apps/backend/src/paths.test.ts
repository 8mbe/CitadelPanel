/**
 * Path containment tests.
 *
 * This is the agent's security boundary: a caller who can escape it can read or
 * overwrite any file the agent's user owns, and — via a bind mount — take the
 * host. The traversal cases below are the ones that actually get tried.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts reads the environment at import time, so the root must be set
// before `paths.ts` is pulled in.
const root = await mkdtemp(join(tmpdir(), "citadel-agent-test-"));
process.env.SERVER_DATA_ROOT = root;
process.env.AGENT_TOKEN ??= "test-agent-token-that-is-long-enough-0123456789";

const { isInside, resolveExistingServerPath, resolveServerPath, serverDataPath } =
  await import("./paths");

const SERVER_ID = "11111111-2222-3333-4444-555555555555";

beforeAll(async () => {
  await mkdir(join(root, SERVER_ID, "plugins"), { recursive: true });
  await writeFile(join(root, "outside-secret.txt"), "should never be readable");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isInside", () => {
  test("accepts the base itself and its descendants", () => {
    expect(isInside("/data/srv", "/data/srv")).toBe(true);
    expect(isInside("/data/srv", "/data/srv/world/level.dat")).toBe(true);
  });

  test("rejects a sibling that merely shares a name prefix", () => {
    // The classic off-by-one: "/data/srv-evil" starts with "/data/srv".
    expect(isInside("/data/srv", "/data/srv-evil")).toBe(false);
  });
});

describe("resolveServerPath", () => {
  test("treats a leading slash as relative to the data directory", () => {
    expect(resolveServerPath(SERVER_ID, "/server.properties")).toBe(
      join(root, SERVER_ID, "server.properties"),
    );
    expect(resolveServerPath(SERVER_ID, "server.properties")).toBe(
      join(root, SERVER_ID, "server.properties"),
    );
  });

  test("defaults to the data directory root", () => {
    expect(resolveServerPath(SERVER_ID)).toBe(serverDataPath(SERVER_ID));
  });

  test("normalises interior traversal that stays inside", () => {
    expect(resolveServerPath(SERVER_ID, "/plugins/../server.properties")).toBe(
      join(root, SERVER_ID, "server.properties"),
    );
  });

  test("rejects traversal that escapes the data directory", () => {
    expect(() => resolveServerPath(SERVER_ID, "../outside-secret.txt")).toThrow();
    expect(() => resolveServerPath(SERVER_ID, "/../outside-secret.txt")).toThrow();
    expect(() => resolveServerPath(SERVER_ID, "/plugins/../../../etc/passwd")).toThrow();
  });

  test("rejects an absolute path to elsewhere on the host", () => {
    // Reinterpreted as root-relative, so it lands inside — but must not reach
    // the real /etc/passwd.
    expect(resolveServerPath(SERVER_ID, "/etc/passwd")).toBe(
      join(root, SERVER_ID, "etc/passwd"),
    );
  });

  test("rejects null bytes", () => {
    expect(() => resolveServerPath(SERVER_ID, "/server.properties\0.txt")).toThrow();
  });
});

describe("resolveExistingServerPath", () => {
  test("resolves a real file inside the directory", async () => {
    const path = join(root, SERVER_ID, "server.properties");
    await writeFile(path, "motd=hi");

    await expect(
      resolveExistingServerPath(SERVER_ID, "/server.properties"),
    ).resolves.toBe(path);
  });

  test("rejects a symlink pointing outside the data directory", async () => {
    // The attack a lexical check cannot see: the game server itself plants a
    // symlink inside its own directory.
    await symlink(
      join(root, "outside-secret.txt"),
      join(root, SERVER_ID, "escape-link"),
    );

    await expect(
      resolveExistingServerPath(SERVER_ID, "/escape-link"),
    ).rejects.toThrow();
  });

  test("returns the lexical path when the target does not exist", async () => {
    // Creating a new file must not be blocked by its own absence.
    await expect(
      resolveExistingServerPath(SERVER_ID, "/not-created-yet.txt"),
    ).resolves.toBe(join(root, SERVER_ID, "not-created-yet.txt"));
  });
});
