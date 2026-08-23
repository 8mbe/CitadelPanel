/**
 * Typed wrappers over the node agent's port-availability endpoint.
 *
 * The agent owns the host's sockets, so "is this port actually free on the
 * node?" is a question only it can answer — the panel's `server_ports` table
 * knows what CitadelPanel has bound, but not what some other process or
 * container holds. Call sites talk to this module rather than building the
 * request path by hand, mirroring {@link ./nodeServerApi.ts}.
 */

import { nodeRequest } from "./nodeApi";

export type PortProtocol = "tcp" | "udp";

/** A host port the panel wants the agent to probe. */
export interface PortProbeRequest {
  hostPort: number;
  protocol: PortProtocol;
}

/** The agent's verdict on one host port. */
export interface PortFreeResult {
  hostPort: number;
  protocol: PortProtocol;
  free: boolean;
  /** Present when the port is not free (e.g. "in use"). */
  reason?: string;
}

/**
 * Ask a node's agent which of the given host ports are bindable right now.
 *
 * Never throws for a taken port — that is a result with `free: false`. Throws
 * `HttpError` only for transport/permission failures: an unreachable node
 * becomes a 502, which callers must treat as "cannot verify" (and refuse to
 * reserve or allocate the port rather than proceed unverified).
 *
 * @param timeoutMs Short by default — a probe is instant when free; the panel's
 *   pool reservation and allocation flows should not hang on a slow node.
 */
export async function checkPortsFree(
  nodeId: string,
  ports: PortProbeRequest[],
  timeoutMs = 8000,
): Promise<PortFreeResult[]> {
  const result = await nodeRequest<{ results: PortFreeResult[] }>(
    nodeId,
    "/v1/ports/free",
    { method: "POST", body: { ports }, timeoutMs },
  );
  return result.results;
}

/**
 * Port numbers per probe request. 256 numbers = 512 socket binds on the node,
 * which is a comfortable single round trip; a wide pool spec becomes several
 * requests rather than one that cannot answer in time.
 */
const PROBE_CHUNK = 256;

/** The verdict on one port *number*, across both protocols. */
export interface PortNumberFreeResult {
  hostPort: number;
  free: boolean;
  /** Present when the number is not free, naming the protocol that blocked it. */
  reason?: string;
}

/**
 * Ask a node whether the given port *numbers* are free — on TCP and UDP both.
 *
 * A published port is claimed on both protocols, so a number is only usable
 * when both halves are bindable. This is where the panel's one-number-per-port
 * model meets the agent's protocol-carrying probe API: each number expands into
 * two probes in a single round trip, and a number is free only if both answers
 * are.
 *
 * The agent contract is deliberately left protocol-aware. Collapsing it there
 * would mean every node had to be upgraded in lockstep with the panel for
 * allocation to work at all.
 */
export async function checkPortNumbersFree(
  nodeId: string,
  numbers: number[],
  timeoutMs = 8000,
): Promise<PortNumberFreeResult[]> {
  if (numbers.length === 0) return [];

  // Index by number so a blocked half is attributable: "25565 (udp: in use)"
  // tells an admin which listener to go look for.
  const blocked = new Map<number, string>();

  // Chunked because each number costs the agent two real socket binds, run in
  // parallel: an admin reserving a wide range ("20000-30000") would otherwise
  // ask one node to open twenty thousand sockets in one request and answer
  // inside the timeout. Chunks keep each round trip bounded instead.
  for (let i = 0; i < numbers.length; i += PROBE_CHUNK) {
    const chunk = numbers.slice(i, i + PROBE_CHUNK);
    const probes: PortProbeRequest[] = chunk.flatMap((hostPort) => [
      { hostPort, protocol: "tcp" as const },
      { hostPort, protocol: "udp" as const },
    ]);
    const results = await checkPortsFree(nodeId, probes, timeoutMs);

    for (const result of results) {
      if (result.free) continue;
      if (blocked.has(result.hostPort)) continue;
      blocked.set(
        result.hostPort,
        `${result.protocol}: ${result.reason ?? "in use"}`,
      );
    }
  }

  return numbers.map((hostPort) => {
    const reason = blocked.get(hostPort);
    return reason === undefined
      ? { hostPort, free: true }
      : { hostPort, free: false, reason };
  });
}
