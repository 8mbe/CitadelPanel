/**
 * Moving one server's data directory off this node, or onto it.
 *
 * The panel orchestrates a migration (see the panel's
 * `services/serverMigration.ts` and `docs/server-migration.md`); this module is
 * the two halves of the copy that the two nodes each perform. Neither half
 * knows there is a migration going on. The source streams a tar of a data
 * directory it still owns, and the destination writes a tar into a data
 * directory it does not have yet. Nothing here deletes anything.
 *
 * **The bytes go through the panel, not node to node.** The obvious design is
 * for the destination to fetch from the source directly, which is what
 * `files.ts#pullFromUrl` does for a remote URL and would halve the network
 * hops. It is not what happens, for one reason: two nodes are not required to
 * be able to reach each other. A node is registered by the *panel's* view of
 * it, an agent URL that only the panel is promised to be able to open, and
 * plenty of real deployments put each node behind its own NAT with no route
 * between them. A transfer that worked on a flat LAN and failed everywhere
 * else would be worse than one that is uniformly a hop slower. It also keeps
 * the trust model exactly as it is: the panel authenticates to each agent with
 * that agent's own bearer token, and no node is ever handed a credential for
 * another node.
 *
 * **The stream is uncompressed tar.** A game server's disk is mostly already
 * compressed (Minecraft region files, plugin jars, mod archives), so gzip
 * spends real CPU on both nodes to shave very little, and it is CPU on
 * machines whose whole job is running other people's games. The panel can ask
 * for compression per transfer (`compress=1`) for the case that argues for it,
 * a transfer over a metered or slow link.
 *
 * `tar` itself is the alpine busybox one in the agent image. Shelling out to it
 * rather than implementing the format is the same call `backup/` makes with
 * restic: the archiver is not the interesting part, and a bug in a hand-rolled
 * one loses somebody's world.
 */

import { readdir, stat, statfs } from "node:fs/promises";
import { config } from "./config";
import { docker } from "./docker/client";
import { ensureServerDataDir } from "./dataRoot";
import { alignOwnership } from "./docker/userns";
import { resolveExistingServerPath, serverDataPath } from "./paths";
import { badRequest, HttpError, notFound, serviceUnavailable } from "./http";

/**
 * How long the archiver may run.
 *
 * A world of tens of gigabytes across a slow link is the case this has to
 * survive, and the failure mode of setting it too low is a migration that dies
 * three quarters of the way through a copy that was working. Six hours is well
 * past any transfer a single game server can justify, and the panel imposes
 * its own, shorter budget on top.
 */
const TRANSFER_TIMEOUT_MS = 6 * 60 * 60_000;

/** How much of a failed archiver's stderr is worth quoting back to the panel. */
const STDERR_LIMIT = 2000;

/**
 * Free and total bytes on the filesystem holding the server data root.
 *
 * This is the number the panel's preflight actually needs, and it is not the
 * one `nodes.disk_total_mb` holds: that is a figure an admin typed at
 * registration to size the scheduler's bookkeeping, and it can be wrong in
 * either direction. Whether a 40 GB world fits is a question only the
 * destination's filesystem can answer, so it is asked here and asked fresh.
 *
 * A filesystem that cannot be statted reports nulls rather than throwing. The
 * agent has other things to say about its health, and a node whose data root
 * has gone missing is already reported by `probeDataRoot`.
 */
export async function dataRootSpace(): Promise<{
  totalBytes: number | null;
  freeBytes: number | null;
}> {
  try {
    const fs = await statfs(config.serverDataRoot);
    return {
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      // `bavail`, not `bfree`: the reserved blocks a full disk keeps for root
      // are not space this agent can write a world into.
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
    };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}

/**
 * The server's data directory, resolved through containment and required to
 * actually be there.
 *
 * `resolveExistingServerPath` answers with the path it *would* be at when the
 * directory is missing, which is right for the file manager (a write creates
 * it) and wrong here. A migration that read a missing source as an empty one
 * would report a successful transfer of nothing, and then delete the original.
 * So absence is a 404, loudly.
 */
async function requireDataDir(serverId: string): Promise<string> {
  const path = await resolveExistingServerPath(serverId, "/");
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) {
    throw notFound(`No data directory exists on this node for server ${serverId}.`);
  }
  return path;
}

/**
 * The on-disk size of a server's data directory, in bytes.
 *
 * Measured with `du` rather than a recursive walk in Bun, because a world
 * directory is hundreds of thousands of small files and the walk is the slow
 * part, not the syscall. `du -sb` counts apparent size, which is what a tar
 * stream will actually carry; block usage would over-report a sparse file and
 * under-report the tar's own headers.
 *
 * The panel uses this twice: to decide whether the destination has room before
 * anything is stopped, and as the denominator of the transfer's progress bar.
 */
export async function measureServerData(serverId: string): Promise<number> {
  const path = await requireDataDir(serverId);

  const proc = Bun.spawn(["du", "-sb", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw serviceUnavailable(
      `Could not measure the server's data directory: ${err.trim().slice(0, STDERR_LIMIT)}`,
    );
  }

  const bytes = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(bytes)) {
    throw serviceUnavailable(
      "Could not measure the server's data directory: unreadable `du` output.",
    );
  }
  return bytes;
}

/**
 * Stream a server's data directory as a tar archive.
 *
 * Archived as `-C <dataDir> .` rather than from the parent, so the archive's
 * members are relative to the data directory itself and carry no server id.
 * That is what lets the destination extract into its own root without the two
 * nodes having to agree on any path, and it is the same reason the panel never
 * sends a host path.
 *
 * The returned body is the archiver's stdout, live. Nothing is buffered: a
 * fifty-gigabyte world must not become a fifty-gigabyte allocation on a node
 * whose memory is committed to running games. If the reader goes away, the
 * `cancel` below kills the archiver rather than leaving it writing into a pipe
 * nobody is draining.
 *
 * A `tar` that exits non-zero after the response has already started streaming
 * cannot be turned into an HTTP error; the stream is aborted instead, which is
 * what makes the panel's side fail rather than quietly accept a truncated
 * archive. See the panel's transfer step for the size check that catches the
 * remaining case of a truncation nobody noticed.
 */
export async function exportServerData(
  serverId: string,
  options: { compress?: boolean } = {},
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  const path = await requireDataDir(serverId);

  const args = ["tar", "-c"];
  if (options.compress) args.push("-z");
  // `--warning=no-file-changed` is a GNU flag busybox tar does not have, so a
  // file the game rewrote mid-archive is handled the same way it is for a
  // backup: the server is stopped before the copy starts, so it should not
  // happen, and the destination's extract is what would report it if it did.
  args.push("-f", "-", "-C", path, ".");

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  // Drained concurrently: a `tar` that writes more than a pipe buffer of
  // warnings to stderr blocks forever if nobody reads it, and it would block
  // holding the archive half-written.
  const stderr = new Response(proc.stderr).text();

  const source = proc.stdout;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }

        const code = await proc.exited;
        if (code !== 0) {
          const message = (await stderr).trim().slice(0, STDERR_LIMIT);
          // The response headers are long gone by now, so the only way to tell
          // the panel this archive is not whole is to break the stream.
          controller.error(
            new Error(`tar exited ${code} while archiving ${serverId}: ${message}`),
          );
          return;
        }
        controller.close();
      } catch (error) {
        proc.kill();
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel() {
      // The panel gave up (a cancelled migration, a dropped connection). Kill
      // the archiver rather than leaving it reading a world into a dead pipe.
      proc.kill();
    },
  });

  return {
    body,
    contentType: options.compress ? "application/gzip" : "application/x-tar",
  };
}

export interface ImportResult {
  /** Where the data landed, for the agent's own logs. Never sent to a browser. */
  path: string;
  /** Bytes on disk after extraction, so the panel can verify the transfer. */
  sizeBytes: number;
}

/**
 * Extract a tar stream into a server's data directory on this node.
 *
 * The directory is created the same way a provision creates one
 * (`ensureServerDataDir`), so a migrated server lands on the destination with
 * exactly the ownership a server built here would have had, userns offset
 * included. That matters more here than anywhere else: the archive carries the
 * *source* node's numeric uids, and a node that remaps users has a different
 * idea of which uid owns a world. Extracting with `--no-same-owner` and then
 * re-aligning is what makes a world written by node A's containers readable by
 * node B's.
 *
 * Refuses to extract onto a directory that already has contents. A migration's
 * destination is by definition a server that is not here yet, so anything in
 * that path is either a previous failed attempt nobody cleaned up or a server
 * id collision, and both want a human rather than a silent merge.
 */
export async function importServerData(
  serverId: string,
  body: ReadableStream<Uint8Array>,
  options: { compressed?: boolean } = {},
): Promise<ImportResult> {
  const target = serverDataPath(serverId);

  // ENOENT is the expected case (the server has never been here), so a missing
  // directory is an empty one rather than an error.
  const entries = await readdir(target).catch(() => [] as string[]);
  if (entries.length > 0) {
    throw new HttpError(
      409,
      `This node already holds data for server ${serverId}. Remove it before ` +
        `transferring, or the transfer would merge two servers' files.`,
    );
  }

  await ensureServerDataDir(serverId);

  const args = ["tar", "-x"];
  if (options.compressed) args.push("-z");
  // `--no-same-owner`: the archive's uids are the *source* node's, and this
  // node's are re-applied below. Without it a remapped node ends up with a
  // world its own containers cannot read.
  args.push("--no-same-owner", "-f", "-", "-C", target);

  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();

  const timeout = setTimeout(() => proc.kill(), TRANSFER_TIMEOUT_MS);

  try {
    const reader = body.getReader();
    const writer = proc.stdin;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
        // Backpressure: without this the whole archive is buffered in the
        // agent's memory while `tar` works through it at disk speed.
        await writer.flush();
      }
    } finally {
      reader.releaseLock();
      await writer.end();
    }

    const code = await proc.exited;
    if (code !== 0) {
      throw serviceUnavailable(
        `Extracting the transferred data failed (tar exited ${code}): ` +
          (await stderr).trim().slice(0, STDERR_LIMIT),
      );
    }
  } catch (error) {
    proc.kill();
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  // The bytes are this node's now, so the ownership must be too. Recursive,
  // unlike the steady-state alignment in `ensureServerDataDir`: every file in
  // the tree has just arrived carrying another machine's uid.
  await alignOwnership(docker, target, { recursive: true });

  return { path: target, sizeBytes: await measureServerData(serverId) };
}

/**
 * Whether `tar` and `du` are actually on this node.
 *
 * Reported by `/v1/health` so the panel's preflight can refuse a migration for
 * a reason an operator can fix, rather than discovering it as a failed spawn
 * after the server has already been stopped. Both are in the agent's alpine
 * base image; a node running the agent outside a container is where this can
 * be false.
 */
export async function transferToolsAvailable(): Promise<boolean> {
  try {
    const results = await Promise.all(
      ["tar", "du"].map(async (tool) => {
        const proc = Bun.spawn([tool, "--help"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        // busybox applets answer `--help` with a non-zero exit, so the question
        // is only whether the binary could be spawned at all.
        await proc.exited;
        return true;
      }),
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}

/** Reject a compression flag that is neither absent nor a recognised boolean. */
export function parseCompress(value: string | null): boolean {
  if (value === null || value === "" || value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") return true;
  throw badRequest('"compress" must be 0 or 1.');
}
