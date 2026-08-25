/**
 * The node's local Docker client.
 *
 * One instance, always over the local unix socket. Unlike the panel's old
 * per-node client factory there is no endpoint or TLS negotiation to do: the
 * agent runs *on* the node it manages, which is the whole point of this
 * service.
 */

import Docker from "dockerode";
import { config } from "../config";

export const docker = new Docker({ socketPath: config.dockerSocket });

/**
 * How long a *read* of the daemon may take before the agent stops waiting.
 *
 * dockerode has no timeout of its own, and neither does the unix socket: a
 * daemon that accepts the connection and then stalls (a busy pull, a wedged
 * snapshotter, a socket that is bound but not being served) leaves the request
 * open indefinitely and the agent's own answer with it. The panel then finds out
 * only by burning its own timeout, which is how one node's hiccup used to cost
 * the whole abuse sweep. A read is milliseconds on a healthy daemon, so this is
 * a generous ceiling rather than a budget anything normal runs close to.
 *
 * Reads only. Power actions pull images and stop game servers with a grace
 * period, and streams (attach, logs, exec) are long-lived by design; bounding
 * those would break them.
 */
export const DAEMON_READ_TIMEOUT_MS = 10_000;

/**
 * Run one bounded daemon read.
 *
 * `what` is named in the failure because "Docker did not answer" is only
 * actionable if it says which call: an operator needs to know whether the daemon
 * is wedged for everything or for one container. The abort is translated into a
 * plain error on purpose, so callers that special-case Docker's own status codes
 * (404 for a container that vanished) do not mistake a stall for one.
 */
export async function daemonRead<T>(
  what: string,
  call: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs = DAEMON_READ_TIMEOUT_MS,
): Promise<T> {
  try {
    return await call(AbortSignal.timeout(timeoutMs));
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    if (aborted) {
      throw new Error(`Docker did not answer ${what} within ${timeoutMs}ms.`);
    }
    throw error;
  }
}

export interface DaemonInfo {
  serverVersion: string | undefined;
  containersRunning: number;
  ncpu: number;
  memTotalMb: number;
}

/** Read daemon version and host capacity, used for health and capacity auto-fill. */
export async function readDaemonInfo(): Promise<DaemonInfo> {
  // `info` accepts an options object at runtime (docker-modem forwards
  // `abortSignal` from it); the shipped types only declare the no-argument
  // overload. Bound, because dockerode reads `this.modem` off the client.
  const readInfo = docker.info.bind(docker) as (options: {
    abortSignal: AbortSignal;
  }) => Promise<unknown>;

  const info = (await daemonRead("info", (abortSignal) =>
    readInfo({ abortSignal }),
  )) as {
    ServerVersion?: string;
    ContainersRunning?: number;
    NCPU?: number;
    MemTotal?: number;
  };

  return {
    serverVersion: info.ServerVersion,
    containersRunning: info.ContainersRunning ?? 0,
    ncpu: info.NCPU ?? 0,
    memTotalMb: info.MemTotal ? Math.floor(info.MemTotal / (1024 * 1024)) : 0,
  };
}

/**
 * Verify at boot that a configured `CONTAINER_RUNTIME` actually exists on this
 * daemon, so a typo ("runsc" vs "gvisor") reads as one clear line here instead
 * of a create-time error on every provision. Never throws, keeping the same
 * "log the fix, keep serving" stance as the data-root and socket reports.
 */
export async function reportContainerRuntimeAtBoot(): Promise<void> {
  if (!config.containerRuntime) return;

  let runtimes: string[];
  try {
    const info = (await docker.info()) as { Runtimes?: Record<string, unknown> };
    runtimes = Object.keys(info.Runtimes ?? {});
  } catch {
    // The socket report already explained an unreachable daemon.
    return;
  }

  if (runtimes.includes(config.containerRuntime)) {
    console.log(`[agent] container runtime: ${config.containerRuntime}`);
    return;
  }

  console.error(
    `[agent] CONTAINER_RUNTIME is "${config.containerRuntime}" but this daemon only ` +
      `has: ${runtimes.join(", ") || "(none reported)"}. Every container create will ` +
      `fail until the runtime is registered in /etc/docker/daemon.json ` +
      `("runtimes") or CONTAINER_RUNTIME is unset. See docs/node-hardening.md.`,
  );
}
