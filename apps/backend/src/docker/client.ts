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

export interface DaemonInfo {
  serverVersion: string | undefined;
  containersRunning: number;
  ncpu: number;
  memTotalMb: number;
}

/** Read daemon version and host capacity, used for health and capacity auto-fill. */
export async function readDaemonInfo(): Promise<DaemonInfo> {
  const info = (await docker.info()) as {
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
 * of a create-time error on every provision. Never throws — the same "log the
 * fix, keep serving" posture as the data-root and socket reports.
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
