import type { NodeHealthResult } from "@/lib/api";

/**
 * The one thing worth telling an admin about a *reachable* agent.
 *
 * A node can answer its health check and still be unable to host anything: no
 * Docker socket, or no writable data root. Both used to be discovered as a
 * failed server creation, so both are folded into one string the connection
 * test can show, worst first, since an agent that cannot reach Docker will not
 * get as far as needing the data root.
 */
export function agentProblem(health: NodeHealthResult): string | undefined {
  if (health.dockerSocket && !health.dockerSocket.reachable) {
    return (
      "This node's agent cannot reach Docker, so every container action will fail. " +
      (health.dockerSocket.error ??
        `The socket at ${health.dockerSocket.path} is unreachable.`)
    );
  }

  if (health.dataRoot && !health.dataRoot.writable) {
    return (
      "This node cannot store server data yet, so provisioning will fail. " +
      (health.dataRoot.error ??
        `Its data root ${health.dataRoot.path} is not writable by the agent.`)
    );
  }

  return undefined;
}
