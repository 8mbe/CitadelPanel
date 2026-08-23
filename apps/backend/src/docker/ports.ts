/**
 * Host port availability probing (per-node port pools).
 *
 * The panel asks the agent whether a set of host ports are actually bindable
 * before reserving them into a pool or allocating them to a new server. A port
 * that is free in the panel's `server_ports` table can still be held on the host
 * by a non-CitadelPanel process or container, and binding it would fail at
 * container-create time, so the check happens here, on the node, where the
 * sockets live.
 *
 * Method: attempt to bind a socket on `0.0.0.0:<port>`, then close it
 * immediately. This matches `hardening.ts`, which publishes container ports on
 * all interfaces (no `HostIp`), so a port bound only on loopback by another
 * process correctly fails the all-interface probe, which is the real
 * allocation semantic. A Docker-bound port holds a host socket and fails the
 * probe just like any other process, so no separate `docker.listContainers`
 * call is needed.
 *
 * TOCTOU: the check-then-bind window is unavoidable; the panel's
 * `UNIQUE(node_id, host_port, protocol)` constraint is the final safety net for
 * panel-side races. This probe is a best-effort prefilter.
 */

import { createServer } from "node:net";
import { createSocket } from "node:dgram";

export type PortProtocol = "tcp" | "udp";

export interface PortProbeRequest {
  hostPort: number;
  protocol: PortProtocol;
}

export interface PortProbeResult {
  hostPort: number;
  protocol: PortProtocol;
  free: boolean;
  /** Present only when the port is not free. */
  reason?: string;
}

/** Per-port probe timeout: binding is instant when free, so this is generous. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Probe one host port by binding it briefly on 0.0.0.0.
 *
 * Never throws for a taken port. That is a result (`free: false`), not an
 * error. Only truly unexpected failures are reported as not-free with a reason.
 */
function probePort(hostPort: number, protocol: PortProtocol): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const settle = (result: PortProbeResult) => resolve(result);

    if (protocol === "tcp") {
      const server = createServer();
      server.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        settle({
          hostPort,
          protocol,
          free: false,
          reason: code === "EADDRINUSE" ? "in use" : error.message,
        });
      });
      server.listen(hostPort, "0.0.0.0", () => {
        // Bound successfully, so the port is free. Close immediately.
        server.close(() =>
          settle({ hostPort, protocol, free: true }),
        );
      });
      // Guard against a misbehaving stack hanging the probe.
      const timer = setTimeout(() => {
        server.close();
        settle({ hostPort, protocol, free: false, reason: "probe timed out" });
      }, PROBE_TIMEOUT_MS);
      server.once("close", () => clearTimeout(timer));
      return;
    }

    // UDP: bind a dgram socket, then close. reuseAddr stays false (the default)
    // so an in-use port reports EADDRINUSE rather than sharing the binding.
    const socket = createSocket({ type: "udp4", reuseAddr: false });
    socket.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      socket.close();
      settle({
        hostPort,
        protocol,
        free: false,
        reason: code === "EADDRINUSE" ? "in use" : error.message,
      });
    });
    socket.bind(hostPort, "0.0.0.0", () => {
      socket.close(() => settle({ hostPort, protocol, free: true }));
    });
    const timer = setTimeout(() => {
      socket.close();
      settle({ hostPort, protocol, free: false, reason: "probe timed out" });
    }, PROBE_TIMEOUT_MS);
    socket.once("close", () => clearTimeout(timer));
  });
}

/**
 * Probe many host ports in parallel.
 *
 * Each port is probed independently, so one slow/taken port cannot delay the
 * others. Results are returned in the same order as the request.
 */
export async function probePorts(
  requests: PortProbeRequest[],
): Promise<PortProbeResult[]> {
  const results = await Promise.all(
    requests.map((request) => probePort(request.hostPort, request.protocol)),
  );
  return results;
}
