import { sql } from "../db/client";
import { nodeRequest } from "../nodes/nodeApi";
import { getNodeServerStates } from "../nodes/nodeServerApi";
import { getNode, setNodeActive } from "../nodes/nodeRegistry";
import { cancelStartWatch } from "./startWatchdog";
import { NodeMaintenanceControl } from "./nodeMaintenanceControl";
import { recordAudit } from "./auditLog";

const MAINTENANCE_TIMEOUT_MS = 10 * 60_000;

/** Stop game, install, DB, and tool containers while keeping the agent reachable. */
async function enterNodeMaintenance(nodeId: string): Promise<void> {
  const servers = await sql`SELECT id FROM servers WHERE node_id = ${nodeId}` as { id: string }[];
  for (const server of servers) cancelStartWatch(server.id);
  await nodeRequest(nodeId, "/v1/maintenance", {
    method: "POST", body: { enabled: true }, timeoutMs: MAINTENANCE_TIMEOUT_MS,
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
async function leaveNodeMaintenance(nodeId: string): Promise<void> {
  await nodeRequest(nodeId, "/v1/maintenance", {
    method: "POST", body: { enabled: false }, timeoutMs: MAINTENANCE_TIMEOUT_MS,
  });
}

const control = new NodeMaintenanceControl({
  getNode,
  setActive: setNodeActive,
  enter: enterNodeMaintenance,
  leave: leaveNodeMaintenance,
  isMaintained: async (nodeId) => {
    const health = await nodeRequest<{ maintenance?: boolean }>(nodeId, "/v1/health", {
      timeoutMs: 5_000,
    });
    return health.maintenance === true;
  },
});

export async function reconcileNodeMaintenance(nodeId: string): Promise<void> {
  if (await control.reconcile(nodeId)) {
    console.warn(`[status-sweeper] cleared stale agent maintenance on active node ${nodeId}`);
    void recordAudit({
      action: "node.update", targetType: "node", targetId: nodeId,
      metadata: { isActive: true, maintenance: false, trigger: "maintenance-reconciliation" },
    });
  }
}

export function setNodeActiveWithMaintenance(
  nodeId: string,
  active: boolean,
  onUpdated: () => Promise<void>,
) {
  return control.setActive(nodeId, active, onUpdated);
}
