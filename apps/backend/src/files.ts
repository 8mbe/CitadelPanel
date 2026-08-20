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

import { appendFile, readdir, rm, stat, mkdir, rename, cp } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { config } from "./config";
import { badRequest, conflict, HttpError, notFound, payloadTooLarge } from "./http";
import { ssrfSafeFetch } from "./ssrf";
import {
  resolveExistingServerPath,
  resolveServerPath,
  resolveWritableServerPath,
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
 * The write-safe resolver is used rather than the plain lexical one: the target
 * may legitimately not exist yet, but a symlink planted in an existing parent
 * directory could otherwise redirect the `mkdir`/write outside the containment
 * boundary (see {@link resolveWritableServerPath}).
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

  const target = await resolveWritableServerPath(serverId, userPath);
  if (target === serverDataPath(serverId)) {
    throw badRequest("Refusing to overwrite the server's data directory.");
  }

  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, contents);
}

/**
 * Delete one or more files/directories.
 *
 * Deleting the data directory itself is refused: that is `deleteServer`'s job
 * and doing it here would leave a running container with no volume.
 *
 * Every path is resolved through containment *before* anything is removed, so
 * one bad entry (a traversal, a symlink escape, the data root) fails the whole
 * request instead of half-deleting a selection. A merely-missing entry is a
 * no-op — `rm`'s `force` swallows the ENOENT — matching the single-path
 * behaviour. The batch is capped at the listing cap: a multi-select can never
 * legitimately exceed what one directory listing shows.
 *
 * Overlapping selections (`/plugins` and `/plugins/old.jar`) are harmless for
 * the same reason: the parent's recursive removal takes the descendant with
 * it and the second `rm` finds nothing, which `force` treats as success.
 */
export async function deletePaths(
  serverId: string,
  paths: string[],
): Promise<void> {
  if (paths.some((p) => typeof p !== "string")) {
    throw badRequest('"paths" must be an array of paths.');
  }
  if (paths.length === 0) {
    throw badRequest('"paths" must contain at least one path.');
  }
  if (paths.length > config.maxDirEntries) {
    throw badRequest(`"paths" is limited to ${config.maxDirEntries} entries.`);
  }

  const root = serverDataPath(serverId);
  const targets = new Set<string>();
  for (const userPath of paths) {
    const target = await resolveExistingServerPath(serverId, userPath);
    if (target === root) {
      throw badRequest("Refusing to delete the server's data directory.");
    }
    targets.add(target);
  }

  // Removal is sequential, not parallel: two concurrent recursive `rm`s on
  // overlapping trees (`/plugins` and `/plugins/old.jar`) race — the child
  // vanishing mid-recursion can abort the parent's removal with an ENOENT,
  // leaving a directory the request reported as deleted. In sequence either
  // order is safe: the survivor of the overlap is a no-op that `force`
  // treats as success.
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
  }
}

/** Delete a single file or directory tree. See {@link deletePaths}. */
export async function deletePath(
  serverId: string,
  userPath: string,
): Promise<void> {
  await deletePaths(serverId, [userPath]);
}

/** Create a directory. */
export async function createDirectory(
  serverId: string,
  userPath: string,
): Promise<void> {
  const target = await resolveWritableServerPath(serverId, userPath);
  await mkdir(target, { recursive: true });
}

/**
 * Rename or move a file/directory within a server's data directory.
 *
 * Both the source and destination are resolved through containment — the
 * source through the symlink-checking variant (it must exist), the destination
 * through the lexical variant (it may not exist yet). The data directory root
 * itself is not a valid source or destination.
 *
 * Moving a directory *into itself* is rejected by `node:fs/promises`.rename on
 * most platforms, but we catch it explicitly to give a readable error rather
 * than a platform-dependent ENOTSUP/EBUSY.
 */
export async function renamePath(
  serverId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const root = serverDataPath(serverId);
  const source = await resolveExistingServerPath(serverId, fromPath);
  const dest = resolveServerPath(serverId, toPath);

  if (source === root) throw badRequest("Refusing to move the server's data directory.");
  if (dest === root) throw badRequest("Refusing to overwrite the server's data directory.");

  // Moving a directory into one of its own descendants would corrupt the tree.
  if (dest === source || dest.startsWith(source + "/")) {
    throw badRequest("Cannot move a path into itself or one of its descendants.");
  }

  // A name collision is surfaced as a 409 rather than letting rename silently
  // overwrite it (which on POSIX replaces an existing file, or fails on a
  // non-empty directory — both surprising for a file manager).
  const exists = await stat(dest).catch(() => null);
  if (exists) throw conflict("A file or folder with that name already exists.");

  await mkdir(dirname(dest), { recursive: true });
  await rename(source, dest);
}

/**
 * Copy a file or directory (recursively) within a server's data directory.
 *
 * Uses `node:fs/promises`.cp with `recursive: true`, which copies directory
 * trees including their contents. Symlinks inside the tree are dereferenced
 * (the default), which keeps everything inside the containment boundary after
 * the copy — a symlink that pointed outside the data dir becomes a real copy,
 * not a re-created escape.
 *
 * The destination must not already exist (same 409 posture as rename), and
 * copying a path into itself is rejected.
 */
export async function copyPath(
  serverId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const root = serverDataPath(serverId);
  const source = await resolveExistingServerPath(serverId, fromPath);
  const dest = resolveServerPath(serverId, toPath);

  if (source === root) throw badRequest("Refusing to copy the server's data directory.");
  if (dest === root) throw badRequest("Refusing to overwrite the server's data directory.");

  if (dest === source || dest.startsWith(source + "/")) {
    throw badRequest("Cannot copy a path into itself or one of its descendants.");
  }

  const exists = await stat(dest).catch(() => null);
  if (exists) throw conflict("A file or folder with that name already exists.");

  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true });
}

/**
 * Stat a file/directory for streaming or download size, after containment.
 *
 * Returns the resolved absolute path and its stat so the caller can decide how
 * to stream it (single file vs. a zipped tree) without re-resolving.
 */
export async function resolveForDownload(
  serverId: string,
  userPath: string,
): Promise<{ absPath: string; info: { isDirectory: boolean; size: number; name: string } }> {
  const target = await resolveExistingServerPath(serverId, userPath);
  const info = await stat(target).catch(() => null);
  if (!info) throw notFound("File or directory not found.");
  const name = posix.basename(posix.normalize(`/${userPath}`)) || serverId;
  return { absPath: target, info: { isDirectory: info.isDirectory(), size: info.size, name } };
}

// --- Uploads ----------------------------------------------------------------

/**
 * Resolve where an upload should land, enforcing containment and rejecting the
 * data root. Shared by {@link uploadFile} and {@link pullFromUrl} so both code
 * paths apply the same guards before any bytes are written.
 */
async function resolveUploadTarget(
  serverId: string,
  userPath: string,
): Promise<string> {
  if (userPath.includes("\0")) {
    throw badRequest("Path must not contain null bytes.");
  }
  const target = await resolveWritableServerPath(serverId, userPath);
  if (target === serverDataPath(serverId)) {
    throw badRequest("Refusing to overwrite the server's data directory.");
  }
  return target;
}

/**
 * Atomically replace `target` with `staged`, cleaning up the temp file on
 * failure. `mkdir -p` the parent first so an upload into a not-yet-existing
 * folder works (mirroring `writeFile`'s behaviour).
 *
 * Returns the byte size of the final file, for the response body.
 */
async function finalizeStagedFile(
  staged: string,
  target: string,
): Promise<number> {
  try {
    await mkdir(dirname(target), { recursive: true });
    await rename(staged, target);
    return (await stat(target)).size;
  } catch (error) {
    // Best-effort cleanup; the rename failure is the real error.
    await rm(staged, { force: true });
    throw error;
  }
}

/**
 * Stream an upload body to the server's data directory.
 *
 * The body is written to a sibling temp file first, then `rename`d into place
 * so a partial upload never appears as a half-written file to the game server
 * (which could load a truncated world or plugin). The temp file lives next to
 * the target rather than in `/tmp` so the rename is guaranteed to be on the
 * same filesystem — a cross-device rename fails with EXDEV.
 *
 * `content-length` is checked up front when present (cheap rejection of an
 * obviously-oversized upload), and the running total is checked during the
 * stream so a client that lies about the length — or sends no length at all —
 * is still cut off at the cap.
 */
export async function uploadFile(
  serverId: string,
  userPath: string,
  body: ReadableStream<Uint8Array>,
  contentLength: number | null,
): Promise<{ path: string; sizeBytes: number }> {
  if (contentLength !== null && contentLength > config.maxUploadBytes) {
    throw payloadTooLarge(
      `Upload is ${contentLength} bytes, which exceeds the ${config.maxUploadBytes}-byte limit.`,
    );
  }

  const target = await resolveUploadTarget(serverId, userPath);
  const staged = `${target}.upload-${process.pid}-${Date.now()}.tmp`;

  try {
    const reader = body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > config.maxUploadBytes) {
          // Cancel the stream so the client stops sending, then surface the
          // cap as a 413 rather than a truncated file.
          await reader.cancel().catch(() => undefined);
          throw payloadTooLarge(
            `Upload exceeds the ${config.maxUploadBytes}-byte limit.`,
          );
        }
        await appendFile(staged, value);
      }
    } finally {
      reader.releaseLock();
    }

    if (received === 0) {
      throw badRequest("Upload body was empty.");
    }

    const sizeBytes = await finalizeStagedFile(staged, target);
    return { path: userPath, sizeBytes };
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

/**
 * Fetch a remote URL and save it into the server's data directory.
 *
 * The agent performs the fetch (rather than the panel) so the bytes cross the
 * network once, directly to where they need to land. The panel applies its own
 * SSRF guardrail before forwarding, and the agent applies its own again here
 * ({@link ssrfSafeFetch}) — resolving the host and re-checking every redirect
 * hop, because the agent is where the request actually leaves the node and
 * where redirects are followed. The agent still re-checks the final size
 * against the upload cap.
 *
 * Same staged-write posture as {@link uploadFile}: a temp file is renamed
 * into place only after the full download succeeds, so a truncated pull never
 * appears as a real file.
 */
export async function pullFromUrl(
  serverId: string,
  userPath: string,
  url: string,
): Promise<{ path: string; sizeBytes: number }> {
  const target = await resolveUploadTarget(serverId, userPath);
  const staged = `${target}.pull-${process.pid}-${Date.now()}.tmp`;

  let response: Response;
  try {
    response = await ssrfSafeFetch(url);
  } catch (error) {
    await rm(staged, { force: true });
    // A guard rejection (HttpError) already carries a clear message; surface it
    // as-is rather than wrapping it in "Could not fetch that URL".
    if (error instanceof HttpError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw badRequest(`Could not fetch that URL: ${reason}`);
  }

  if (!response.ok) {
    await rm(staged, { force: true });
    throw badRequest(`The URL responded with status ${response.status}.`);
  }
  if (!response.body) {
    await rm(staged, { force: true });
    throw badRequest("The URL returned no body.");
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > config.maxUploadBytes) {
    await rm(staged, { force: true });
    throw payloadTooLarge(
      `The URL is ${declared} bytes, which exceeds the ${config.maxUploadBytes}-byte limit.`,
    );
  }

  try {
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > config.maxUploadBytes) {
          await reader.cancel().catch(() => undefined);
          throw payloadTooLarge(
            `The URL exceeds the ${config.maxUploadBytes}-byte limit.`,
          );
        }
        await appendFile(staged, value);
      }
    } finally {
      reader.releaseLock();
    }

    if (received === 0) {
      throw badRequest("The URL returned an empty body.");
    }

    const sizeBytes = await finalizeStagedFile(staged, target);
    return { path: userPath, sizeBytes };
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}
