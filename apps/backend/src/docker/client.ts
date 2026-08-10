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
