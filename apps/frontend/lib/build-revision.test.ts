import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitRevision } from "./build-revision";

const directories: string[] = [];
const first = "a".repeat(40);
const second = "b".repeat(40);

function checkout(head: string): string {
  const directory = mkdtempSync(join(tmpdir(), "citadel-revision-"));
  directories.push(directory);
  mkdirSync(join(directory, "refs", "heads"), { recursive: true });
  writeFileSync(join(directory, "HEAD"), head + "\n");
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reads detached HEAD without Git config or objects", () => {
  expect(readGitRevision(checkout(first))).toBe(first);
  const sha256 = "c".repeat(64);
  expect(readGitRevision(checkout(sha256))).toBe(sha256);
});

test("reads the branch selected by HEAD", () => {
  const directory = checkout("ref: refs/heads/main");
  writeFileSync(join(directory, "refs", "heads", "main"), first + "\n");
  expect(readGitRevision(directory)).toBe(first);
});

test("resolves packed refs by exact name, ignoring headers and peeled tags", () => {
  const directory = checkout("ref: refs/heads/main");
  writeFileSync(join(directory, "packed-refs"),
    `# pack-refs with: peeled fully-peeled sorted\n${second} refs/heads/main-old\n${first} refs/heads/main\n^${second}\n`);
  expect(readGitRevision(directory)).toBe(first);
});

test("a loose branch ref overrides its older packed value", () => {
  const directory = checkout("ref: refs/heads/main");
  writeFileSync(join(directory, "packed-refs"), `${second} refs/heads/main\n`);
  writeFileSync(join(directory, "refs", "heads", "main"), first);
  expect(readGitRevision(directory)).toBe(first);
});

test("missing refs and malformed commits do not invent a revision", () => {
  const directory = checkout("ref: refs/heads/main");
  expect(readGitRevision(directory)).toBeUndefined();
  writeFileSync(join(directory, "refs", "heads", "main"), "not-a-commit");
  expect(readGitRevision(directory)).toBeUndefined();
  expect(readGitRevision(checkout("not-a-head"))).toBeUndefined();
  expect(readGitRevision(join(directory, "missing"))).toBeUndefined();
});

test("HEAD cannot reference a path outside Git metadata", () => {
  const directory = checkout("ref: refs/../../HEAD");
  expect(readGitRevision(directory)).toBeUndefined();
});
