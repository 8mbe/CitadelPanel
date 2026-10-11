import { sql } from "../db/client";
import { nodeRequest } from "../nodes/nodeApi";
import { getNodeServerStates } from "../nodes/nodeServerApi";
import { cancelStartWatch } from "./startWatchdog";

/** Stop game, install, DB, and tool containers while keeping the agent reachable. */
export async function enforceNodeMaintenance(nodeId: string): Promise<void> {
  const servers = await sql`SELECT id FROM servers WHERE node_id = ${nodeId}` as { id: string }[];
  for (const server of servers) cancelStartWatch(server.id);
  await nodeRequest(nodeId, "/v1/maintenance", {
    method: "POST", body: { enabled: true }, timeoutMs: 10 * 60_000,
  });
  if (!servers.length) return;
  // Use observations, preserving statuses owned by another task or an admin.
  const states = await getNodeServerStates(nodeId, servers.map((server) => server.id));
  const stopped = Object.entries(states).filter(([, state]) => ["exited", "created", "dead"].includes(state)).map(([id]) => id);
  if (stopped.length) await sql`
    UPDATE servers SET status = 'stopped', updated_at = now()
    WHERE node_id = ${nodeId} AND id IN ${sql(stopped)}
      AND status IN ('running', 'starting', 'stopping')
  `;
}

/** Clear the agent latch before advertising the node as active. */
export async function leaveNodeMaintenance(nodeId: string): Promise<void> {
  await nodeRequest(nodeId, "/v1/maintenance", { method: "POST", body: { enabled: false } });
}
