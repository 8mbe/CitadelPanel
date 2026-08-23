/**
 * Filesystem path resolution and containment.
 *
 * This module is the entire security boundary for the file manager and for the
 * bind mount handed to Docker. The invariant it enforces:
 *
 *   Every path the agent touches resolves to somewhere inside
 *   `<serverDataRoot>/<serverId>`.
 *
 * The panel never sends a host path. It sends a server id and a relative path,
 * and both are re-derived here. That is deliberate: the agent's token is
 * root-equivalent for this host, so a caller who can name an arbitrary
 * `hostDataPath` could bind-mount `/` into a container and own the machine.
 *
 * Two distinct checks are needed, because they catch different attacks:
 *   - lexical containment (`resolve` + prefix) stops `../` traversal;
 *   - `realpath` containment stops symlinks planted *inside* the data directory
 *     by the game server itself, which lexical checks cannot see.
 */

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { config } from "./config";
import { badRequest, forbidden } from "./http";

/**
 * Absolute path to a server's data directory.
 *
 * `resolve` plus a UUID-validated id segment (see `requireServerId`) means the
 * result is always a direct child of the root.
 */
export function serverDataPath(serverId: string): string {
  return join(config.serverDataRoot, serverId);
}

/** True when `candidate` is `base` itself or lies beneath it. */
export function isInside(base: string, candidate: string): boolean {
  if (candidate === base) return true;
  return candidate.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Resolve a panel-supplied relative path against a server's data directory.
 *
 * Lexical only. This runs before the target is known to exist, so it is what
 * guards writes and creates. Absolute paths are rejected outright rather than
 * silently reinterpreted, because a caller sending `/etc/passwd` is either
 * confused or hostile and both deserve an error.
 */
export function resolveServerPath(serverId: string, userPath = "/"): string {
  if (userPath.includes("\0")) {
    throw badRequest("Path must not contain null bytes.");
  }

  const base = serverDataPath(serverId);

  // Treat the supplied path as rooted at the data directory: "/plugins" and
  // "plugins" both mean the same place, and neither escapes.
  const relative = isAbsolute(userPath) ? userPath.slice(1) : userPath;
  const target = resolve(base, relative);

  if (!isInside(base, target)) {
    throw forbidden("Path escapes the server's data directory.");
  }
  return target;
}

/**
 * Resolve a path and additionally verify it after symlink expansion.
 *
 * Use for reads, deletes and directory listings, where the target already
 * exists and could be a symlink the game server created pointing outside its
 * own directory.
 *
 * A missing target is not an error here: the lexically-checked path is
 * returned so callers can produce their own 404, and creating a new file at a
 * safe path must not be blocked just because it does not exist yet.
 */
export async function resolveExistingServerPath(
  serverId: string,
  userPath = "/",
): Promise<string> {
  const target = resolveServerPath(serverId, userPath);
  const base = serverDataPath(serverId);

  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return target;
  }

  // The base itself may legitimately sit behind a symlink (a mounted volume),
  // so compare against its resolved form rather than the configured string.
  let realBase: string;
  try {
    realBase = await realpath(base);
  } catch {
    realBase = base;
  }

  if (!isInside(realBase, real)) {
    throw forbidden("Path resolves outside the server's data directory.");
  }
  return real;
}

/**
 * Resolve a path for **writing**, where the target may not exist yet but any
 * existing directory along the way could be a symlink.
 *
 * The lexical check alone is not enough for writes: a game server can plant a
 * symlink inside its own data directory (`ln -s /etc plugins/x`), and a later
 * `mkdir -p`/write to `plugins/x/foo` would follow it and land outside the
 * containment boundary. That write runs as the agent, which is root-equivalent
 * on this host. `resolveServerPath`'s lexical `resolve` never expands that
 * symlink, so it cannot see the escape.
 *
 * The target itself is allowed to be missing (that is the whole point of a
 * write), so instead of realpath-ing the target we walk up to the *deepest
 * existing ancestor* and verify its real path is inside the data root. Any
 * symlink in the existing portion of the path shows up there; the components
 * that do not exist yet cannot be symlinks, and `mkdir` will create them as
 * real directories.
 *
 * A residual TOCTOU remains (the container could plant a symlink between this
 * check and the write), the same window `resolveExistingServerPath` has for
 * reads and deletes. Closing it entirely needs per-component `O_NOFOLLOW`
 * openat, which Bun does not expose; this closes the practical vector (a
 * symlink planted ahead of an owner-triggered write).
 */
export async function resolveWritableServerPath(
  serverId: string,
  userPath = "/",
): Promise<string> {
  const target = resolveServerPath(serverId, userPath);
  const base = serverDataPath(serverId);

  let realBase: string;
  try {
    realBase = await realpath(base);
  } catch {
    realBase = base;
  }

  let ancestor = target;
  for (;;) {
    let real: string | null = null;
    try {
      real = await realpath(ancestor);
    } catch {
      // This component does not exist yet, so keep walking up.
    }

    if (real !== null) {
      if (!isInside(realBase, real)) {
        throw forbidden("Path resolves outside the server's data directory.");
      }
      break;
    }

    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached the filesystem root
    ancestor = parent;
  }

  return target;
}
