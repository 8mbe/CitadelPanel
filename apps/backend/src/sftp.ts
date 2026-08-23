/**
 * Custom SFTP server.
 *
 * Runs an `ssh2` `Server` in the same Bun process as the HTTP/WS agent, on its
 * own TCP port (`config.sftpPort`, default 8022). Each client authenticates with
 * a per-(user, server) credential the panel issued; the agent validates it via a
 * panel callback (`sftpAuth.ts`) and then chroots the SFTP session to that
 * server's data directory.
 *
 * Containment reuses `paths.ts`, the same boundary the file-manager HTTP routes
 * use. The SFTP virtual root `/` maps to `serverDataPath(serverId)`; reads
 * resolve through `resolveExistingServerPath` and writes/creates through
 * `resolveWritableServerPath`, so `..` traversal and symlink escapes (including
 * a symlink planted in an existing parent of a new path) are caught by the
 * existing checks rather than reimplemented here.
 *
 * The agent stays stateless about users: it holds open file handles for the
 * duration of an SFTP session (ssh2 requires it) but validates the credential
 * fresh on every SSH connection. No session table, no cached auth.
 */

import {
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { open as openFile, readdir, readlink, rename, rm, rmdir, symlink, utimes, lstat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { constants as fsConstants, type Stats, type Dirent } from "node:fs";
import { Server, type SFTPWrapper, type Attributes } from "ssh2";
import { config } from "./config";
import { docker } from "./docker/client";
import { alignOwnership } from "./docker/userns";
import { requireServerId } from "./http";
import {
  resolveExistingServerPath,
  resolveServerPath,
  resolveWritableServerPath,
  serverDataPath,
} from "./paths";
import { validateSftpCredentials } from "./sftpAuth";

/** SFTP status codes (ssh2 exposes them as `STATUS_CODE` on the wrapper). */
const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  OP_UNSUPPORTED: 8,
} as const;

/**
 * Generate and persist an RSA-2048 host key if none exists at the configured path.
 *
 * The key is reused across restarts so clients see a stable fingerprint. RSA
 * rather than ed25519 because ssh2's server host-key loading is broadest there
 * (and OpenSSH clients accept it universally). The key file is created with
 * 0600 perms, because it is a private key.
 */
async function ensureHostKey(): Promise<Buffer> {
  const path = config.sftpHostKeyPath;
  const existing = await readFile(path).catch(() => null);
  if (existing) return existing;

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, pem, { mode: 0o600 });
  // writeFile honours the process umask for the mode on creation but not on
  // overwrite, so chmod explicitly to be certain the perms are tight.
  await chmod(path, 0o600);
  return Buffer.from(pem);
}

/**
 * A handle for an open file or directory within one SFTP session.
 *
 * ssh2 hands the client an opaque `Buffer` handle; we map it back to one of
 * these via a per-session Map. Files carry an open `FileHandle` (for streamed
 * reads/writes at an offset); directories carry a pre-read entry list so
 * READDIR can page through it.
 */
interface SftpHandle {
  kind: "file";
  fd: FileHandle;
  path: string;
  flags: number;
}

interface SftpDirHandle {
  kind: "directory";
  /** Pre-read entries, paged out by successive READDIR calls. */
  entries: { filename: string; longname: string; attrs: Attributes }[];
  /** Index of the next entry to send. */
  cursor: number;
}

type AnyHandle = SftpHandle | SftpDirHandle;

/**
 * Per-session state, stashed on the connection so every SFTP event handler can
 * reach it without a module-level map.
 *
 * `serverId` is bound at SSH auth time and is the containment root for the whole
 * session; `handles` is the open-file/dir table; `nextHandleId` generates the
 * opaque Buffer keys.
 */
interface SessionState {
  serverId: string;
  userId: string;
  handles: Map<string, AnyHandle>;
  nextHandleId: number;
}

/**
 * Build the ssh2 server. Returned to `server.ts` to be `listen()`ed.
 *
 * `ensureHostKey` runs first, so the server is constructed with the host key
 * already loaded and `listen` can be called synchronously right after.
 */
export async function createSftpServer(): Promise<Server> {
  const hostKey = await ensureHostKey();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    const state = {
      serverId: "",
      userId: "",
      handles: new Map<string, AnyHandle>(),
      nextHandleId: 0,
    } satisfies SessionState;

    client.on("authentication", async (ctx) => {
      // Only password auth is supported. Publickey and keyboard-interactive
      // would require shipping a key to the user, which defeats the "generate a
      // password in the panel" UX.
      if (ctx.method !== "password") {
        ctx.reject(["password"]);
        return;
      }

      try {
        const result = await validateSftpCredentials(ctx.username, ctx.password);
        state.serverId = result.serverId;
        state.userId = result.userId;
        ctx.accept();
      } catch {
        // Any rejection is a generic auth failure to the client, whether it
        // was a bad password, an unknown user, no access, or the panel being
        // down. We do not distinguish, so an attacker cannot enumerate valid
        // usernames from the error.
        ctx.reject(["password"]);
      }
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (accept) => {
          const sftp = accept();
          wireSftpEvents(sftp, state);
        });
      });
    });

    client.on("error", (error) => {
      // A client that disconnects mid-handshake or sends a malformed packet
      // lands here; log so it is visible without crashing the server.
      console.error("[sftp] client error:", error.message);
    });

    client.on("close", () => {
      // The connection is gone. Close any file handles the client left open.
      // ssh2 does not synthesize CLOSE events for a dropped connection, so
      // without this a client that disconnects mid-transfer would leak one fd
      // per open file. Directory handles need no cleanup (they're just arrays).
      for (const handle of state.handles.values()) {
        if (handle.kind === "file") {
          void handle.fd.close().catch(() => undefined);
        }
      }
      state.handles.clear();
    });
  });

  return server;
}

/**
 * Translate an SFTP client path (rooted at `/`, the server's data dir) into a
 * host path through containment. Lexical-only; callers that touch existing
 * files should use {@link resolveExisting}.
 *
 * `requireServerId` is a belt-and-braces check: the serverId was validated by
 * the panel callback already, but `paths.ts`'s guarantees depend on it being a
 * UUID, so we re-check before building any path.
 */
function resolveSafe(state: SessionState, clientPath: string): string {
  requireServerId(state.serverId);
  return resolveServerPath(state.serverId, clientPath);
}

/** Resolve + symlink-check an existing path. */
async function resolveExisting(state: SessionState, clientPath: string): Promise<string> {
  requireServerId(state.serverId);
  return resolveExistingServerPath(state.serverId, clientPath);
}

/**
 * Resolve a path that is about to be **written or created**.
 *
 * The lexical {@link resolveSafe} is not enough for these: the game can plant
 * `ln -s /etc plugins` inside its own data dir, and a later create of
 * `plugins/x` would follow the symlinked parent and land outside the boundary,
 * as this process, whose access on the node is root-equivalent. Same reasoning
 * (and same resolver) as `writeFile` in `files.ts`.
 */
async function resolveWritable(state: SessionState, clientPath: string): Promise<string> {
  requireServerId(state.serverId);
  return resolveWritableServerPath(state.serverId, clientPath);
}

/**
 * Convert a `node:fs` `Stats` to the ssh2 `Attributes` shape.
 *
 * Times are seconds (SFTP's wire format), not ms. Mode is the full st_mode
 * including type bits, which ssh2 expects.
 */
function toAttrs(info: Stats): Attributes {
  return {
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    atime: Math.floor(info.atimeMs / 1000),
    mtime: Math.floor(info.mtimeMs / 1000),
  };
}

/** Build an `ls -l`-style longname for a READDIR entry. Best-effort, not parsed by clients. */
function longname(name: string, info: Stats): string {
  const type = info.isDirectory() ? "d" : info.isSymbolicLink() ? "l" : "-";
  // Octal perms are fine here. This string is display-only, never parsed.
  const perms = (info.mode & 0o777).toString(8).padStart(3, "0");
  return `${type}${perms} ${info.size} ${name}`;
}

/** Mint a fresh opaque handle Buffer and register the underlying handle. */
function registerHandle(state: SessionState, handle: AnyHandle): Buffer {
  const id = String(state.nextHandleId++);
  state.handles.set(id, handle);
  return Buffer.from(id);
}

/** Look up a handle by its Buffer key, or return null if the client sent a stale one. */
function lookupHandle(state: SessionState, handle: Buffer): AnyHandle | null {
  return state.handles.get(handle.toString()) ?? null;
}

/** A zeroed Attributes for responses that don't carry real stat info (realpath/readlink). */
const ZERO_ATTRS: Attributes = {
  mode: 0,
  uid: 0,
  gid: 0,
  size: 0,
  atime: 0,
  mtime: 0,
};

/** Decode ssh2's numeric open-flags into a Node `O_*` mask. */
function flagsToNode(flags: number): number {
  // SSH_FXF_* bit positions (RFC 4254 §6.3):
  const READ = 0x00000001;
  const WRITE = 0x00000002;
  const APPEND = 0x00000004;
  const CREATE = 0x00000008;
  const TRUNC = 0x00000010;
  const EXCL = 0x00000020;

  let node = 0;
  const wantRead = (flags & READ) !== 0;
  const wantWrite = (flags & WRITE) !== 0;
  node |= wantRead && wantWrite ? fsConstants.O_RDWR : wantWrite ? fsConstants.O_WRONLY : fsConstants.O_RDONLY;
  if (flags & CREATE) node |= fsConstants.O_CREAT;
  if (flags & TRUNC) node |= fsConstants.O_TRUNC;
  if (flags & APPEND) node |= fsConstants.O_APPEND;
  if (flags & EXCL) node |= fsConstants.O_EXCL;
  return node;
}

/**
 * Wire all SFTP subsystem events to the filesystem, scoped to one session.
 *
 * Every handler resolves the client path through containment before touching
 * disk, and translates `node:fs` errors into SFTP status codes. The session's
 * `serverId` is the chroot root; the client never sees a path outside it.
 */
function wireSftpEvents(sftp: SFTPWrapper, state: SessionState): void {
  // --- Path canonicalisation -------------------------------------------------
  sftp.on("REALPATH", (reqId, clientPath) => {
    // The client asks for the canonical form of a path; within a chroot the
    // answer is the normalised POSIX path itself. Resolve through containment
    // so a path that would escape is rejected rather than normalised to `/`.
    try {
      const resolved = resolveSafe(state, clientPath);
      const relative = posix.relative(serverDataPath(state.serverId), resolved);
      sftp.name(reqId, [{ filename: "/" + relative, longname: "", attrs: ZERO_ATTRS }]);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
    }
  });

  // --- Stat (follows symlinks) / Lstat (does not) ---------------------------
  const statHandler = (follow: boolean) =>
    async (reqId: number, clientPath: string) => {
      let hostPath: string;
      try {
        hostPath = await resolveExisting(state, clientPath);
      } catch {
        sftp.status(reqId, STATUS.PERMISSION_DENIED);
        return;
      }
      const info = await (follow ? stat : lstatSafe)(hostPath).catch(() => null);
      if (!info) {
        sftp.status(reqId, STATUS.NO_SUCH_FILE);
        return;
      }
      sftp.attrs(reqId, toAttrs(info));
    };

  sftp.on("STAT", statHandler(true));
  sftp.on("LSTAT", statHandler(false));

  // --- FSTAT (stat by open handle) ------------------------------------------
  sftp.on("FSTAT", async (reqId, handle) => {
    const h = lookupHandle(state, handle);
    if (!h || h.kind !== "file") {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    const info = await stat(h.path).catch(() => null);
    if (!info) {
      sftp.status(reqId, STATUS.NO_SUCH_FILE);
      return;
    }
    sftp.attrs(reqId, toAttrs(info));
  });

  // --- Open file ------------------------------------------------------------
  sftp.on("OPEN", async (reqId, clientPath, flags) => {
    const creating = (flags & 0x00000008) /* CREATE */ !== 0;
    let hostPath: string;
    try {
      // Creates go through the write-safe resolver (a symlink planted in an
      // existing parent must not redirect the new file outside the boundary);
      // plain opens use the existing-path variant, which realpath-checks the
      // target itself.
      hostPath = creating
        ? await resolveWritable(state, clientPath)
        : await resolveExisting(state, clientPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }

    const fd = await openFile(hostPath, flagsToNode(flags)).catch((error: { code?: string }) => {
      if (error.code === "ENOENT") sftp.status(reqId, STATUS.NO_SUCH_FILE);
      else if (error.code === "EACCES") sftp.status(reqId, STATUS.PERMISSION_DENIED);
      else sftp.status(reqId, STATUS.FAILURE);
      return null;
    });
    if (!fd) return;

    // A file this session may have just created belongs to the container-side
    // data owner, not to the agent (a no-op off userns-remap).
    if (creating) await alignOwnership(docker, hostPath);

    const handle: SftpHandle = { kind: "file", fd, path: hostPath, flags };
    sftp.handle(reqId, registerHandle(state, handle));
  });

  // --- Read from an open file -----------------------------------------------
  sftp.on("READ", async (reqId, handle, offset, length) => {
    const h = lookupHandle(state, handle);
    if (!h || h.kind !== "file") {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    // Cap the read so a client cannot request a multi-GB buffer in one call.
    const len = Math.min(length, 256 * 1024);
    const { buffer } = await h.fd.read(
      Buffer.alloc(len),
      0,
      len,
      offset,
    ).catch(() => ({ buffer: null as Buffer | null }));
    if (!buffer || buffer.length === 0) {
      sftp.status(reqId, STATUS.EOF);
      return;
    }
    sftp.data(reqId, buffer.length === len ? buffer : buffer.subarray(0, buffer.length));
  });

  // --- Write to an open file ------------------------------------------------
  sftp.on("WRITE", async (reqId, handle, offset, data) => {
    const h = lookupHandle(state, handle);
    if (!h || h.kind !== "file") {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    try {
      await h.fd.write(data, 0, data.length, offset);
      sftp.status(reqId, STATUS.OK);
    } catch {
      sftp.status(reqId, STATUS.FAILURE);
    }
  });

  // --- Close a handle -------------------------------------------------------
  sftp.on("CLOSE", async (reqId, handle) => {
    const h = lookupHandle(state, handle);
    if (!h) {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    state.handles.delete(handle.toString());
    if (h.kind === "file") {
      await h.fd.close().catch(() => undefined);
    }
    sftp.status(reqId, STATUS.OK);
  });

  // --- Open directory -------------------------------------------------------
  sftp.on("OPENDIR", async (reqId, clientPath) => {
    let hostPath: string;
    try {
      hostPath = await resolveExisting(state, clientPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(hostPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") sftp.status(reqId, STATUS.NO_SUCH_FILE);
      else if (code === "ENOTDIR") sftp.status(reqId, STATUS.FAILURE);
      else sftp.status(reqId, STATUS.FAILURE);
      return;
    }

    // Materialise the entry list with stats now, so READDIR is a simple cursor.
    // Cap to the same limit as the file-manager HTTP route for consistency.
    const capped = entries.slice(0, config.maxDirEntries);
    const built: SftpDirHandle["entries"] = await Promise.all(
      capped.map(async (entry) => {
        const full = posix.join(hostPath, entry.name);
        const info = await stat(full).catch(() => null);
        const attrs: Attributes = info
          ? toAttrs(info)
          : { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
        return {
          filename: entry.name,
          longname: info ? longname(entry.name, info) : entry.name,
          attrs,
        };
      }),
    );

    const dirHandle: SftpDirHandle = { kind: "directory", entries: built, cursor: 0 };
    sftp.handle(reqId, registerHandle(state, dirHandle));
  });

  // --- Read directory entries (paged) ---------------------------------------
  sftp.on("READDIR", (reqId, handle) => {
    const h = lookupHandle(state, handle);
    if (!h || h.kind !== "directory") {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    if (h.cursor >= h.entries.length) {
      // A second READDIR after the stream is exhausted is how the client
      // learns the listing is done, so respond with EOF.
      sftp.status(reqId, STATUS.EOF);
      return;
    }
    // Send a batch; ssh2 clients tolerate the full remainder in one response.
    const batch = h.entries.slice(h.cursor);
    h.cursor = h.entries.length;
    sftp.name(reqId, batch);
  });

  // --- Filesystem mutations -------------------------------------------------
  sftp.on("REMOVE", async (reqId, clientPath) => {
    let hostPath: string;
    try {
      hostPath = await resolveExisting(state, clientPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    // Refuse to delete the data root itself, same guard as files.ts.
    if (hostPath === serverDataPath(state.serverId)) {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    try {
      await rm(hostPath, { force: false });
      sftp.status(reqId, STATUS.OK);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") sftp.status(reqId, STATUS.NO_SUCH_FILE);
      else sftp.status(reqId, STATUS.FAILURE);
    }
  });

  sftp.on("MKDIR", async (reqId, clientPath) => {
    let hostPath: string;
    try {
      // Write-safe: `mkdir` under a symlinked parent would create the
      // directory outside the boundary (see resolveWritable).
      hostPath = await resolveWritable(state, clientPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    try {
      await mkdir(hostPath, { recursive: false });
      await alignOwnership(docker, hostPath);
      sftp.status(reqId, STATUS.OK);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EEXIST") sftp.status(reqId, STATUS.FAILURE);
      else sftp.status(reqId, STATUS.FAILURE);
    }
  });

  sftp.on("RMDIR", async (reqId, clientPath) => {
    let hostPath: string;
    try {
      hostPath = await resolveExisting(state, clientPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    if (hostPath === serverDataPath(state.serverId)) {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    try {
      await rmdir(hostPath);
      sftp.status(reqId, STATUS.OK);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") sftp.status(reqId, STATUS.NO_SUCH_FILE);
      else if (code === "ENOTEMPTY") sftp.status(reqId, STATUS.FAILURE);
      else sftp.status(reqId, STATUS.FAILURE);
    }
  });

  sftp.on("RENAME", async (reqId, oldPath, newPath) => {
    let from: string;
    let to: string;
    try {
      from = await resolveExisting(state, oldPath);
      // Write-safe for the destination: a symlinked parent would let the
      // rename move a real file *out* of the data directory.
      to = await resolveWritable(state, newPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    if (from === serverDataPath(state.serverId) || to === serverDataPath(state.serverId)) {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    // Moving into self/descendant, same guard as files.ts.
    if (to === from || to.startsWith(from + "/")) {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    try {
      const created = await mkdir(dirname(to), { recursive: true });
      if (created) await alignOwnership(docker, created, { recursive: true });
      await rename(from, to);
      sftp.status(reqId, STATUS.OK);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") sftp.status(reqId, STATUS.NO_SUCH_FILE);
      else sftp.status(reqId, STATUS.FAILURE);
    }
  });

  sftp.on("SETSTAT", async (reqId, clientPath, attrs) => {
    let hostPath: string;
    try {
      hostPath = await resolveExisting(state, clientPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    try {
      if (typeof attrs.mode === "number" && attrs.mode !== 0) {
        await chmod(hostPath, attrs.mode & 0o777);
      }
      if (attrs.atime && attrs.mtime) {
        await utimes(hostPath, attrs.atime, attrs.mtime);
      }
      sftp.status(reqId, STATUS.OK);
    } catch {
      sftp.status(reqId, STATUS.FAILURE);
    }
  });

  sftp.on("READLINK", async (reqId, clientPath) => {
    let hostPath: string;
    try {
      hostPath = await resolveExisting(state, clientPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    try {
      const target = await readlink(hostPath);
      sftp.name(reqId, [{ filename: target.toString(), longname: "", attrs: ZERO_ATTRS }]);
    } catch {
      sftp.status(reqId, STATUS.FAILURE);
    }
  });

  sftp.on("SYMLINK", async (reqId, targetPath, linkPath) => {
    // linkPath is the symlink to create; targetPath is what it points at.
    // Both must resolve inside the data dir. A symlink pointing outside would
    // be caught on read by resolveExistingServerPath, but we block at create
    // time too so a hostile client can't even plant one. The link itself goes
    // through the write-safe resolver so it cannot be *created through* a
    // symlinked parent either.
    let target: string;
    let link: string;
    try {
      target = resolveSafe(state, targetPath);
      link = await resolveWritable(state, linkPath);
    } catch {
      sftp.status(reqId, STATUS.PERMISSION_DENIED);
      return;
    }
    try {
      await symlink(target, link);
      sftp.status(reqId, STATUS.OK);
    } catch {
      sftp.status(reqId, STATUS.FAILURE);
    }
  });
}

/** `lstat` that doesn't throw on missing path. Returns null instead. */
async function lstatSafe(path: string): Promise<Stats | null> {
  return lstat(path).catch(() => null);
}
