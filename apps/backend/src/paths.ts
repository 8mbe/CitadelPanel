/**
 * Filesystem path resolution and containment.
 *
 * This module is the entire security boundary for the file manager and for the
 * bind mount handed to Docker. The invariant it enforces:
 *
 *   Every path the agent touches resolves to somewhere inside
 *   `<serverDataRoot>/<serverId>`.
 *
 * The panel never sends a host path — it sends a server id and a relative path,
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
import { isAbsolute, join, resolve, sep } from "node:path";
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
 * Lexical only — this runs before the target is known to exist, so it is what
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
