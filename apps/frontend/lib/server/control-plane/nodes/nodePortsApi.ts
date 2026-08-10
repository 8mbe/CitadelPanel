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
