/**
 * The panel's half of a node-to-node data transfer.
 *
 * Three calls, two nodes: measure the source, open the source's archive
 * stream, and pipe that stream into the destination's extract. The panel is
 * the pipe. See the agent's `transfer.ts` for why the bytes go through here
 * rather than directly between the two agents (two nodes are not required to
 * be able to reach each other, and no node is ever handed another node's
 * credential), and `docs/server-migration.md` for the migration that drives it.
 *
 * Everything here is streaming. A world is tens of gigabytes; buffering one in
 * the panel's process would take the panel down, and taking the panel down is
 * how a migration turns into a server that exists on neither node.
 */

import { nodeRequest, nodeRequestRaw } from "./nodeApi";
import { HttpError } from "../lib/http";
import { countTransferStream } from "./transferStream";

/**
 * How long a single transfer leg may run.
 *
 * The archive is produced and consumed at disk-and-network speed, so the only
 * honest bound is a generous one: this is a timeout against a *wedged* copy,
 * not against a slow one. Six hours matches the agent's own ceiling, so
 * whichever side gives up first, both sides give up.
 */
const TRANSFER_TIMEOUT_MS = 6 * 60 * 60_000;

/** Refuse occupied destinations before the migration owns anything there. */
export async function prepareMigrationDestination(nodeId: string, serverId: string): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/transfer/prepare`, { method: "POST" });
}

/** The size of a server's data directory on the node that currently holds it. */
export async function measureServerData(
  nodeId: string,
  serverId: string,
): Promise<number> {
  const result = await nodeRequest<{ sizeBytes: number }>(
    nodeId,
    `/v1/servers/${serverId}/transfer/size`,
    // A `du` over a large world is a real walk of the filesystem, so this needs
    // more than the default per-call budget without needing the transfer's.
    { timeoutMs: 5 * 60_000 },
  );
  return result.sizeBytes;
}

export interface TransferResult {
  /** Bytes the panel forwarded, counted as they passed through. */
  bytesTransferred: number;
  /** What the destination measured on disk afterwards. */
  destinationSizeBytes: number;
}

/**
 * Copy a server's data directory from one node to another.
 *
 * The source's response body becomes the destination's request body directly,
 * so the archive is never held anywhere: bytes arrive from one agent and leave
 * for the other in the same pass. `onProgress` is called as they go, which is
 * the only place the panel can count them, since neither agent knows what the
 * other is doing.
 *
 * Returns the size the *destination* measured after extracting. The caller
 * compares that against the source's measurement, and that comparison is what
 * catches the one failure mode a streaming copy has that a buffered one does
 * not: an archive truncated cleanly enough for `tar` to accept it.
 *
 * Nothing is deleted on either side. A failed transfer leaves a partial tree on
 * the destination for the migration's rollback to remove; the source is not
 * touched at all, by construction, because the only call made against it is a
 * read.
 */
export async function transferServerData(options: {
  sourceNodeId: string;
  destinationNodeId: string;
  serverId: string;
  /** gzip the stream. Off by default; see the agent's `transfer.ts`. */
  compress?: boolean;
  /** Called with the running byte total as the archive passes through. */
  onProgress?: (bytesTransferred: number) => void;
  /** Aborts both legs: a cancelled migration, or the caller's own deadline. */
  signal?: AbortSignal;
}): Promise<TransferResult> {
  const compress = options.compress === true;
  const query = compress ? { compress: 1 } : undefined;

  let bytesTransferred = 0;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  let counted: ReadableStream<Uint8Array> | undefined;
  try {
    const source = await nodeRequestRaw(
      options.sourceNodeId,
      `/v1/servers/${options.serverId}/transfer/export`,
      { query, timeoutMs: TRANSFER_TIMEOUT_MS, signal },
    );
    if (!source.body) {
      throw new HttpError(502, "The source node returned no data to transfer.");
    }

    // No tee and no eager read loop: the destination controls consumption.
    counted = countTransferStream(source.body, (bytes) => {
      bytesTransferred += bytes;
      options.onProgress?.(bytesTransferred);
    }, signal);

    const response = await nodeRequestRaw(
      options.destinationNodeId,
      `/v1/servers/${options.serverId}/transfer/import`,
      {
        method: "POST",
        query,
        rawBody: counted,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        signal,
      },
    );

    const result = (await response.json()) as { sizeBytes: number };
    return { bytesTransferred, destinationSizeBytes: result.sizeBytes };
  } finally {
    // Abort the destination upload even when it rejected the body before
    // reading it. Its cancellation propagates to the source's tar stream.
    cancellation.abort();
    await counted?.cancel().catch(() => undefined);
  }
}
