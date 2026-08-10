/**
 * File manager for a server's data directory.
 *
 * Every operation goes through `paths.ts`, which is the containment boundary —
 * nothing here resolves a path by itself. Reads and listings additionally go
 * through the symlink-checking variant, because a game server can create a
 * symlink inside its own data directory that a lexical check cannot see.
 *
 * Size and count caps exist so the panel cannot be made to buffer a 40 GB world
 * file or a directory with a million entries into memory.
 */

import { readdir, rm, stat, mkdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { config } from "./config";
import { badRequest, notFound, payloadTooLarge } from "./http";
import {
  resolveExistingServerPath,
  resolveServerPath,
  serverDataPath,
} from "./paths";

export interface FileEntry {
  name: string;
  /** Path relative to the server's data directory, always POSIX-style. */
  path: string;
  type: "file" | "directory" | "other";
  sizeBytes: number;
  modifiedAt: Date;
}

/** Normalise a user-supplied path into a leading-slash POSIX path. */
function displayPath(userPath: string, name?: string): string {
  const base = posix.normalize(`/${userPath}`).replace(/\/+$/, "");
  return name ? posix.join(base || "/", name) : base || "/";
}

/**
 * List a directory.
 *
 * `withFileTypes` avoids a stat per entry for the type, but size and mtime
 * still need one — so listings are capped rather than unbounded.
 */
export async function listDirectory(
  serverId: string,
  userPath = "/",
): Promise<FileEntry[]> {
  const target = await resolveExistingServerPath(serverId, userPath);

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw notFound("Directory not found.");
    if (code === "ENOTDIR") throw badRequest("That path is not a directory.");
    throw error;
  }

  const capped = entries.slice(0, config.maxDirEntries);

  const results = await Promise.all(
    capped.map(async (entry): Promise<FileEntry> => {
      const type = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";

      let sizeBytes = 0;
      let modifiedAt = new Date(0);
      try {
        const info = await stat(join(target, entry.name));
        sizeBytes = info.size;
        modifiedAt = info.mtime;
      } catch {
        // A file deleted between readdir and stat is reported with zeroes
        // rather than failing the whole listing.
      }

      return {
        name: entry.name,
        path: displayPath(userPath, entry.name),
        type,
        sizeBytes,
        modifiedAt,
      };
    }),
  );

  // Directories first, then alphabetical — the ordering a file browser expects.
  return results.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Read a text file, refusing anything above the configured size cap. */
export async function readFile(
  serverId: string,
  userPath: string,
): Promise<string> {
  const target = await resolveExistingServerPath(serverId, userPath);

  const info = await stat(target).catch(() => null);
  if (!info) throw notFound("File not found.");
  if (info.isDirectory()) throw badRequest("That path is a directory.");

  if (info.size > config.maxFileBytes) {
    throw payloadTooLarge(
      `File is ${info.size} bytes, which exceeds the ${config.maxFileBytes}-byte limit.`,
    );
  }

  return Bun.file(target).text();
}

/**
 * Write a text file, creating parent directories as needed.
 *
 * The lexical guard is used rather than the symlink-checking one because the
 * target may legitimately not exist yet; the parent directory is what gets
 * created, and it is still inside the containment boundary.
 */
export async function writeFile(
  serverId: string,
  userPath: string,
  contents: string,
): Promise<void> {
  if (Buffer.byteLength(contents, "utf8") > config.maxFileBytes) {
    throw payloadTooLarge(
      `Contents exceed the ${config.maxFileBytes}-byte limit.`,
    );
  }

  const target = resolveServerPath(serverId, userPath);
  if (target === serverDataPath(serverId)) {
    throw badRequest("Refusing to overwrite the server's data directory.");
  }

  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, contents);
}

/**
 * Delete a file or directory.
 *
 * Deleting the data directory itself is refused: that is `deleteServer`'s job
 * and doing it here would leave a running container with no volume.
 */
export async function deletePath(
  serverId: string,
  userPath: string,
): Promise<void> {
  const target = await resolveExistingServerPath(serverId, userPath);

  if (target === serverDataPath(serverId)) {
    throw badRequest("Refusing to delete the server's data directory.");
  }

  await rm(target, { recursive: true, force: true });
}

/** Create a directory. */
export async function createDirectory(
  serverId: string,
  userPath: string,
): Promise<void> {
  const target = resolveServerPath(serverId, userPath);
  await mkdir(target, { recursive: true });
}
