/**
 * Container lifecycle operations against this node's local Docker daemon
 * (plan.md sections 8 and 11).
 *
 * Every create call goes through `buildHardenedContainerConfig`, so there is no
 * code path that can produce an unhardened container.
 *
 * The client stays an explicit parameter rather than a module-level import, so
 * these remain pure functions over an injected daemon and can be tested without
 * a running Docker.
 */

import type Docker from "dockerode";
import {
  buildHardenedContainerConfig,
  buildIsolatedNetworkConfig,
  type HardenedContainerSpec,
} from "./hardening";

/** Docker returns 404 for "no such container/network/image". */
function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 404;
}

/** Docker returns 409 for "already started/stopped" style conflicts. */
function isConflict(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 409;
}

/**
 * Ensure a managed network exists.
 *
 * Idempotent: a pre-existing network is reused. Creation races (two requests
 * for the same server) surface as a 409, which we treat as success.
 *
 * `config` defaults to the per-server isolated network; pass
 * `buildLinkNetworkConfig` for pairwise link networks, which need ICC on.
 */
export async function ensureNetwork(
  client: Docker,
  networkName: string,
  config: Docker.NetworkCreateOptions = buildIsolatedNetworkConfig(networkName),
): Promise<void> {
  try {
    await client.getNetwork(networkName).inspect();
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  try {
    await client.createNetwork(config);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

/**
 * Pull an image if it is not already present on the node.
 *
 * The pull stream must be fully drained, otherwise the daemon may abort the
 * transfer partway and leave a partial image behind.
 */
export async function ensureImage(client: Docker, image: string): Promise<void> {
  try {
    await client.getImage(image).inspect();
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const stream = await client.pull(image);
  await new Promise<void>((resolve, reject) => {
    client.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Create a hardened container for a server.
 *
 * Prepares the network and image first so the create call does not fail
 * halfway through provisioning.
 */
export async function createContainer(
  client: Docker,
  spec: HardenedContainerSpec,
): Promise<string> {
  await ensureNetwork(client, spec.networkName);
  await ensureImage(client, spec.image);

  const container = await client.createContainer(
    buildHardenedContainerConfig(spec),
  );

  // Attach any extra networks (e.g. node_db_net) after creation. The primary
  // network is set via NetworkMode in the container config; extras need a
  // separate connect call. Idempotent: an already-attached network is a no-op.
  if (spec.extraNetworks) {
    for (const networkName of spec.extraNetworks) {
      await attachToNetwork(client, networkName, container.id);
    }
  }

  return container.id;
}

/**
 * Run a hardened container to completion and return its exit code and logs.
 *
 * Used for one-time provisioning (a blueprint's install step): the container is
 * created, started, waited on, its logs captured, then removed regardless of
 * outcome — nothing is left behind on the node. The caller decides whether a
 * non-zero exit code is a failure.
 *
 * `wait()` blocks until the process exits, so the panel-side HTTP timeout must
 * be generous enough for a slow download.
 */
export async function runContainerToCompletion(
  client: Docker,
  spec: HardenedContainerSpec,
): Promise<{ exitCode: number; logs: string }> {
  await ensureNetwork(client, spec.networkName);
  await ensureImage(client, spec.image);

  const container = await client.createContainer(
    buildHardenedContainerConfig(spec),
  );

  // Attach extra networks for the install container too, in case the install
  // script needs DB access (rare, but consistent with the runtime container).
  if (spec.extraNetworks) {
    for (const networkName of spec.extraNetworks) {
      await attachToNetwork(client, networkName, container.id);
    }
  }

  try {
    await container.start();
    // dockerode resolves this once the container's main process exits.
    const result = (await container.wait()) as { StatusCode?: number };
    const logs = await getContainerLogs(client, container.id, 500);
    return { exitCode: result.StatusCode ?? 0, logs };
  } finally {
    // Always clean up: a leftover install container would collide with the next
    // attempt and hold the data volume open.
    await removeContainer(client, container.id).catch(() => undefined);
  }
}

/** Start a container. Already-running is treated as success (idempotent). */
export async function startContainer(
  client: Docker,
  containerId: string,
): Promise<void> {
  try {
    await client.getContainer(containerId).start();
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

/**
 * Stop a container, giving the game a grace period to save and shut down
 * cleanly before Docker sends SIGKILL.
 */
export async function stopContainer(
  client: Docker,
  containerId: string,
  timeoutSeconds = 30,
): Promise<void> {
  try {
    await client.getContainer(containerId).stop({ t: timeoutSeconds });
  } catch (error) {
    // 304/409 mean it was already stopped; 404 means it is already gone.
    if (!isConflict(error) && !isNotFound(error)) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 304) throw error;
    }
  }
}

export async function restartContainer(
  client: Docker,
  containerId: string,
  timeoutSeconds = 30,
): Promise<void> {
  await client.getContainer(containerId).restart({ t: timeoutSeconds });
}

/**
 * Force-stop a container with SIGKILL, bypassing the graceful shutdown.
 *
 * Used as the escape hatch when a container is wedged and the graceful `stop`
 * (SIGTERM + grace period) is not completing. SIGKILL is immediate, so there is
 * no timeout — the game gets no chance to save. Idempotent: an already-stopped
 * or already-gone container is treated as success.
 */
export async function killContainer(
  client: Docker,
  containerId: string,
): Promise<void> {
  try {
    await client.getContainer(containerId).kill();
  } catch (error) {
    // 304/409 = already stopped; 404 = already gone. None are errors here.
    if (!isConflict(error) && !isNotFound(error)) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 304) throw error;
    }
  }
}

/**
 * Remove a container. Missing containers are treated as already-removed so
 * cleanup and delete flows are safely retryable.
 */
export async function removeContainer(
  client: Docker,
  containerId: string,
  force = true,
): Promise<void> {
  try {
    await client.getContainer(containerId).remove({ force, v: false });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Remove a per-server network. Ignores missing networks. */
export async function removeNetwork(
  client: Docker,
  networkName: string,
): Promise<void> {
  try {
    await client.getNetwork(networkName).remove();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Remove a network only once it has no endpoints left.
 *
 * Returns whether the network was actually removed. A 403 ("network has
 * active endpoints") is not an error — the caller asked "remove if empty",
 * not "remove". Used by link teardown, where a container recreated mid-unlink
 * may legitimately still be attached; the empty network is harmless until the
 * next unlink (or link) tidies it up.
 */
export async function removeNetworkIfEmpty(
  client: Docker,
  networkName: string,
): Promise<boolean> {
  try {
    await client.getNetwork(networkName).remove();
    return true;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404 || status === 403) return false;
    throw error;
  }
}

export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead"
  | "missing";

/** Read a container's current state, or "missing" if it no longer exists. */
export async function inspectContainerState(
  client: Docker,
  containerId: string,
): Promise<ContainerState> {
  try {
    const info = await client.getContainer(containerId).inspect();
    return (info.State?.Status as ContainerState) ?? "dead";
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
}

/** Attach a container to an additional network (used for `node_db_net`). */
export async function attachToNetwork(
  client: Docker,
  networkName: string,
  containerId: string,
): Promise<void> {
  try {
    await client.getNetwork(networkName).connect({ Container: containerId });
  } catch (error) {
    // Already-connected surfaces as a 403/409 depending on daemon version.
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 403 && status !== 409) throw error;
  }
}

/** Detach a container from a network. Ignores "not connected". */
export async function detachFromNetwork(
  client: Docker,
  networkName: string,
  containerId: string,
): Promise<void> {
  try {
    await client.getNetwork(networkName).disconnect({ Container: containerId });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 403 && status !== 404 && status !== 409) throw error;
  }
}

/** Fetch the tail of a container's logs, for the console view's backlog. */
export async function getContainerLogs(
  client: Docker,
  containerId: string,
  tail = 200,
): Promise<string> {
  const buffer = (await client.getContainer(containerId).logs({
    stdout: true,
    stderr: true,
    tail,
    follow: false,
  })) as unknown as Buffer;

  // A TTY container's logs are a raw byte stream with no 8-byte multiplexing
  // headers, so the header-stripper must be skipped or it would misparse
  // payload bytes as frame headers.
  if (await containerIsTty(client, containerId)) return buffer.toString("utf8");
  return stripDockerLogHeaders(buffer);
}

/**
 * Demultiplex Docker's 8-byte-framed log stream into a stream of payload bytes.
 *
 * The follow-mode (`logs({follow:true})`) stream uses the same framing as a
 * one-shot read — [stream(1), 0,0,0, size(4 BE)] + payload per frame — but
 * arrives incrementally: a single `data` event may hold several frames or only
 * part of one, and a frame header can be split across two reads. So, like the
 * raw-socket attach in `docker/attach.ts`, bytes are buffered and complete
 * frames are emitted as they arrive.
 *
 * Unlike `stripDockerLogHeaders` (which works on a whole buffer), this is
 * stateful and streaming, so it is what powers the live console's SSE feed.
 *
 * When `tty` is true the container was created with `Tty: true`, so Docker
 * merges stdout/stderr into a single raw byte stream with no framing — the
 * stream is forwarded verbatim instead of demuxed.
 */
export function demuxDockerLogStream(
  input: NodeJS.ReadableStream,
  tty = false,
): ReadableStream<Uint8Array> {
  // A partial frame waiting for more bytes: either the 8-byte header is
  // incomplete, or the header is read and `remaining` payload bytes are owed.
  let buffer = Buffer.alloc(0);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | string) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

        // TTY mode: raw byte stream, no 8-byte multiplexing headers. Forward
        // each chunk as it arrives.
        if (tty) {
          controller.enqueue(buffer);
          buffer = Buffer.alloc(0);
          return;
        }

        // Peel every complete frame off the front of the buffer.
        while (buffer.length >= 8) {
          const size = buffer.readUInt32BE(4);
          if (buffer.length < 8 + size) return; // payload still arriving

          // Stream id (byte 0) is 1=stdout or 2=stderr; both are forwarded, so
          // the console shows errors rather than hiding them.
          const payload = buffer.subarray(8, 8 + size);
          controller.enqueue(Buffer.from(payload));
          buffer = buffer.subarray(8 + size);
        }
      };

      const cleanup = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
      };

      const onEnd = () => {
        cleanup();
        controller.close();
      };

      const onError = (error: unknown) => {
        cleanup();
        controller.error(
          error instanceof Error ? error : new Error(String(error)),
        );
      };

      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
    },
  });
}

/**
 * Whether a container was created with a pseudo-TTY (`Tty: true`).
 *
 * A TTY container's stdout/stderr are merged into one raw byte stream with no
 * Docker multiplexing headers, so the attach and log layers must read it
 * differently from a non-TTY container's 8-byte-framed stream.
 */
export async function containerIsTty(
  client: Docker,
  containerId: string,
): Promise<boolean> {
  const info = await client.getContainer(containerId).inspect();
  return info.Config.Tty === true;
}

/**
 * Strip Docker's 8-byte multiplexed stream headers from a non-TTY log buffer.
 *
 * Each frame is [stream(1), 0,0,0, size(4 BE)] followed by `size` payload
 * bytes. Without this the console shows binary garbage between lines.
 */
export function stripDockerLogHeaders(buffer: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + length, buffer.length);

    chunks.push(buffer.subarray(start, end).toString("utf8"));
    offset = end;
  }

  // Not a multiplexed stream (TTY mode): return as-is.
  if (chunks.length === 0) return buffer.toString("utf8");
  return chunks.join("");
}
