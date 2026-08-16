/**
 * Capacity-aware node scheduler (plan.md section 7).
 *
 * Strategy: most-free-capacity-first bin packing. Simple and predictable — it
 * spreads load rather than tightly packing, which suits game servers where a
 * noisy neighbour hurts perceived quality more than node count does.
 *
 * The selection maths is kept as a pure function (`selectNode`) so it can be
 * unit-tested without a database or Docker daemon.
 */

import { sql } from "../db/client";
import { conflict } from "../lib/http";
import { listActiveNodesWithSecrets, type NodeWithSecrets } from "./nodeRegistry";
import { checkPortsFree, type PortProtocol } from "./nodePortsApi";
import { expandNodePortPool } from "./portPool";

/** Resources a prospective server is asking for. */
export interface ResourceRequest {
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
}

/** A node plus what is already committed on it. */
export interface NodeCapacity {
  nodeId: string;
  nodeName: string;
  cpuTotal: number;
  memoryTotalMb: number;
  diskTotalMb: number;
  /** Share of CPU (0-95) the scheduler must leave free. */
  cpuReservePct: number;
  /** Share of memory (0-95) the scheduler must leave free. */
  memoryReservePct: number;
  /** Share of disk (0-95) the scheduler must leave free. */
  diskReservePct: number;
  /** When true, ignore the reserves and allocate against the full totals. */
  allowOvercommit: boolean;
  cpuAllocated: number;
  memoryAllocatedMb: number;
  diskAllocatedMb: number;
}

export interface NodeFreeCapacity extends NodeCapacity {
  cpuFree: number;
  memoryFreeMb: number;
  diskFreeMb: number;
}

/**
 * The allocable amount of a resource after applying the node's reservation.
 *
 * A reservation is a percentage that must stay FREE for the host: with a 20%
 * reserve only 80% of the total is allocable. `allowOvercommit` bypasses the
 * reserve, restoring the full total — for nodes that intentionally
 * oversubscribe where limits are ceilings rather than reservations.
 *
 * Exported so the capacity UI can show the effective allocable total without
 * duplicating the formula.
 */
export function allocable(
  total: number,
  reservePct: number,
  allowOvercommit: boolean,
): number {
  if (allowOvercommit) return total;
  const usableFraction = Math.max(0, 1 - reservePct / 100);
  return total * usableFraction;
}

export function withFreeCapacity(capacity: NodeCapacity): NodeFreeCapacity {
  const cpuAllocable = allocable(
    capacity.cpuTotal,
    capacity.cpuReservePct,
    capacity.allowOvercommit,
  );
  const memoryAllocable = allocable(
    capacity.memoryTotalMb,
    capacity.memoryReservePct,
    capacity.allowOvercommit,
  );
  const diskAllocable = allocable(
    capacity.diskTotalMb,
    capacity.diskReservePct,
    capacity.allowOvercommit,
  );
  return {
    ...capacity,
    // Free headroom floored at 0: a node already over its allocable ceiling
    // (e.g. reserve raised after servers were placed) reports no free space,
    // so the scheduler won't add to it — but existing servers keep running.
    cpuFree: Math.max(0, cpuAllocable - capacity.cpuAllocated),
    memoryFreeMb: Math.max(0, memoryAllocable - capacity.memoryAllocatedMb),
    diskFreeMb: Math.max(0, diskAllocable - capacity.diskAllocatedMb),
  };
}

/** Whether a node can accommodate the request across all three dimensions. */
export function nodeCanFit(
  capacity: NodeFreeCapacity,
  request: ResourceRequest,
): boolean {
  return (
    capacity.cpuFree >= request.cpuLimit &&
    capacity.memoryFreeMb >= request.memoryLimitMb &&
    capacity.diskFreeMb >= request.diskLimitMb
  );
}

/**
 * Score a candidate node: higher is a better placement.
 *
 * Memory is the dimension that most often binds for game servers (a Minecraft
 * server is memory-hungry and only moderately CPU-hungry), so free memory is
 * weighted most heavily. The score is a fraction-free-capacity blend rather
 * than raw units, so heterogeneous nodes compare fairly.
 */
export function placementScore(capacity: NodeFreeCapacity): number {
  const memoryFraction =
    capacity.memoryTotalMb > 0 ? capacity.memoryFreeMb / capacity.memoryTotalMb : 0;
  const cpuFraction =
    capacity.cpuTotal > 0 ? capacity.cpuFree / capacity.cpuTotal : 0;
  const diskFraction =
    capacity.diskTotalMb > 0 ? capacity.diskFreeMb / capacity.diskTotalMb : 0;

  return memoryFraction * 0.5 + cpuFraction * 0.3 + diskFraction * 0.2;
}

/**
 * Pick the best node for a request, or null when none can fit.
 *
 * Pure: takes capacities in, returns a choice. Ties break on node name so
 * placement is deterministic for a given input set.
 */
export function selectNode(
  capacities: NodeCapacity[],
  request: ResourceRequest,
): NodeFreeCapacity | null {
  const viable = capacities.map(withFreeCapacity).filter((c) => nodeCanFit(c, request));

  if (viable.length === 0) return null;

  return viable.reduce((best, candidate) => {
    const bestScore = placementScore(best);
    const candidateScore = placementScore(candidate);

    if (candidateScore > bestScore) return candidate;
    if (candidateScore < bestScore) return best;
    return candidate.nodeName < best.nodeName ? candidate : best;
  });
}

/**
 * Read current allocation per active node.
 *
 * Allocation is the SUM OF CONFIGURED LIMITS of non-deleted servers, not live
 * usage. Scheduling on commitments rather than momentary usage is what prevents
 * overcommitting a node that merely happens to be idle right now.
 */
export async function loadNodeCapacities(): Promise<NodeCapacity[]> {
  const rows = (await sql`
    SELECT
      n.id                                            AS node_id,
      n.name                                          AS node_name,
      n.cpu_total,
      n.memory_total_mb,
      n.disk_total_mb,
      n.cpu_reserve_pct,
      n.memory_reserve_pct,
      n.disk_reserve_pct,
      n.allow_overcommit,
      COALESCE(SUM(s.cpu_limit), 0)                    AS cpu_allocated,
      COALESCE(SUM(s.memory_limit_mb), 0)              AS memory_allocated_mb,
      COALESCE(SUM(s.disk_limit_mb), 0)                AS disk_allocated_mb
    FROM nodes n
    LEFT JOIN servers s
      ON s.node_id = n.id
     AND s.status <> 'deleting'
    WHERE n.is_active = TRUE
    GROUP BY n.id, n.name, n.cpu_total, n.memory_total_mb, n.disk_total_mb,
      n.cpu_reserve_pct, n.memory_reserve_pct, n.disk_reserve_pct, n.allow_overcommit
    ORDER BY n.name ASC
  `) as Record<string, unknown>[];

  return rows.map((row) => ({
    nodeId: String(row.node_id),
    nodeName: String(row.node_name),
    cpuTotal: Number(row.cpu_total),
    memoryTotalMb: Number(row.memory_total_mb),
    diskTotalMb: Number(row.disk_total_mb),
    cpuReservePct: Number(row.cpu_reserve_pct),
    memoryReservePct: Number(row.memory_reserve_pct),
    diskReservePct: Number(row.disk_reserve_pct),
    allowOvercommit: Boolean(row.allow_overcommit),
    cpuAllocated: Number(row.cpu_allocated),
    memoryAllocatedMb: Number(row.memory_allocated_mb),
    diskAllocatedMb: Number(row.disk_allocated_mb),
  }));
}

/**
 * Read current allocation for a single node.
 *
 * Same committed-load sum as {@link loadNodeCapacities}, but scoped to one node
 * and **without** the `is_active` filter: a drained node still hosts the servers
 * it was carrying, and the node detail page needs to show that committed load,
 * not pretend the node is empty because it is out of rotation.
 *
 * Returns null only when the node row itself is missing — the route layer 404s
 * before that, so callers can treat the result as non-null after that check.
 */
export async function loadNodeCapacity(
  nodeId: string,
): Promise<NodeCapacity | null> {
  const rows = (await sql`
    SELECT
      n.id                                            AS node_id,
      n.name                                          AS node_name,
      n.cpu_total,
      n.memory_total_mb,
      n.disk_total_mb,
      n.cpu_reserve_pct,
      n.memory_reserve_pct,
      n.disk_reserve_pct,
      n.allow_overcommit,
      COALESCE(SUM(s.cpu_limit), 0)                    AS cpu_allocated,
      COALESCE(SUM(s.memory_limit_mb), 0)              AS memory_allocated_mb,
      COALESCE(SUM(s.disk_limit_mb), 0)                AS disk_allocated_mb
    FROM nodes n
    LEFT JOIN servers s
      ON s.node_id = n.id
     AND s.status <> 'deleting'
    WHERE n.id = ${nodeId}
    GROUP BY n.id, n.name, n.cpu_total, n.memory_total_mb, n.disk_total_mb,
      n.cpu_reserve_pct, n.memory_reserve_pct, n.disk_reserve_pct, n.allow_overcommit
  `) as Record<string, unknown>[];

  const row = rows[0];
  if (!row) return null;

  return {
    nodeId: String(row.node_id),
    nodeName: String(row.node_name),
    cpuTotal: Number(row.cpu_total),
    memoryTotalMb: Number(row.memory_total_mb),
    diskTotalMb: Number(row.disk_total_mb),
    cpuReservePct: Number(row.cpu_reserve_pct),
    memoryReservePct: Number(row.memory_reserve_pct),
    diskReservePct: Number(row.disk_reserve_pct),
    allowOvercommit: Boolean(row.allow_overcommit),
    cpuAllocated: Number(row.cpu_allocated),
    memoryAllocatedMb: Number(row.memory_allocated_mb),
    diskAllocatedMb: Number(row.disk_allocated_mb),
  };
}

/**
 * Choose a node for a new server, throwing a 409 when the cluster is full.
 *
 * A capacity failure is a legitimate client-visible outcome ("no room right
 * now"), not an internal error, hence 409 rather than 500.
 */
export async function scheduleServer(
  request: ResourceRequest,
): Promise<NodeFreeCapacity> {
  const capacities = await loadNodeCapacities();

  if (capacities.length === 0) {
    throw conflict(
      "No active nodes are registered. An admin must add a node before servers can be created.",
    );
  }

  const chosen = selectNode(capacities, request);
  if (!chosen) {
    throw conflict(
      "No active node has enough free capacity for the requested resources.",
    );
  }

  return chosen;
}

/**
 * Validate that a specific node can accommodate a request.
 *
 * Used when an admin explicitly targets a node during provisioning: instead of
 * picking the best node, this fails with a clear 409 when that exact node
 * cannot fit the request.
 */
export async function scheduleServerOnNode(
  nodeId: string,
  request: ResourceRequest,
): Promise<NodeFreeCapacity> {
  const capacities = await loadNodeCapacities();
  const target = capacities
    .map(withFreeCapacity)
    .find((capacity) => capacity.nodeId === nodeId);

  if (!target) {
    throw conflict("The requested node is not registered or not active.");
  }
  if (!nodeCanFit(target, request)) {
    throw conflict(
      "The requested node does not have enough free capacity for the requested resources.",
    );
  }

  return target;
}

/**
 * Allocate a free host port on a node.
 *
 * Candidate source: the node's reserved port pool for this protocol
 * (admin-managed). There is no default port range — every published host port
 * is drawn from a pool an admin explicitly reserved, so a node with no pool
 * configured cannot host servers until one is added.
 *
 * A preferred port is honored only if it is a valid candidate (a member of the
 * pool) and free.
 *
 * Two freeness checks, layered:
 *   - `server_ports` (the panel's own bindings) filters out what CitadelPanel
 *     has already allocated. The UNIQUE(node_id, host_port, protocol) constraint
 *     is the real concurrency safety net — this scan is an optimisation.
 *   - The node agent confirms the port is actually bindable on the host right
 *     now, so a port held by another process or container is caught before the
 *     Docker bind at container-create fails.
 *
 * The agent is asked once per call, with a small candidate batch (the preferred
 * port plus a few fallbacks), to keep allocation to one round-trip per port.
 *
 * TOCTOU: there is a window between the agent's "free" answer and the container
 * actually binding. The DB constraint catches panel-side races (one INSERT wins
 * on 23505); a non-panel process grabbing the port in the window surfaces as a
 * container-create failure, which the create flow already records as `error`.
 */
export async function allocateHostPort(
  nodeId: string,
  protocol: PortProtocol,
  preferredPort?: number,
): Promise<number> {
  // The pool is the only candidate source — no default range fallback.
  const candidates = await expandNodePortPool(nodeId, protocol);
  if (candidates.length === 0) {
    throw conflict(
      `No ${protocol} port pool is configured on this node. ` +
        "An admin must reserve ports before servers can be created.",
    );
  }

  const rows = (await sql`
    SELECT host_port
    FROM server_ports
    WHERE node_id = ${nodeId} AND protocol = ${protocol}
  `) as { host_port: number }[];

  const taken = new Set(rows.map((row) => row.host_port));
  const freeInDb = candidates.filter((port) => !taken.has(port));

  if (freeInDb.length === 0) {
    throw conflict(
      `No free ${protocol} ports remain in this node's port pool (all are allocated).`,
    );
  }

  // Verify a small candidate batch against the host. Preferred port first (if
  // it is a valid, DB-free candidate), then the next few fallbacks so a handful
  // of host-occupied ports do not exhaust the batch.
  const toVerify: number[] = [];
  if (
    preferredPort !== undefined &&
    candidates.includes(preferredPort) &&
    !taken.has(preferredPort)
  ) {
    toVerify.push(preferredPort);
  }
  for (const port of freeInDb) {
    if (port === preferredPort) continue;
    if (toVerify.length >= 8) break;
    toVerify.push(port);
  }

  const results = await checkPortsFree(
    nodeId,
    toVerify.map((port) => ({ hostPort: port, protocol })),
  );
  // Preserve verification order when picking the first free port.
  const freeByAgent = new Set(
    results.filter((r) => r.free).map((r) => r.hostPort),
  );
  const chosen = toVerify.find((port) => freeByAgent.has(port));
  if (chosen !== undefined) return chosen;

  throw conflict(
    `No free ${protocol} ports could be confirmed on the node's host. ` +
      "Checked ports were in use; widen the port pool or free host ports.",
  );
}

/**
 * Allocate one specific host port, or fail with the reason it is unavailable.
 *
 * Owner-added additional ports are identity mappings the owner chose by number
 * (a plugin config references that exact port), so silently substituting a
 * fallback — what {@link allocateHostPort} does — would be wrong. Every failure
 * mode gets its own readable 409: not in the node's pool, already allocated to
 * another server, or held on the host by another process.
 */
export async function allocateSpecificHostPort(
  nodeId: string,
  protocol: PortProtocol,
  port: number,
): Promise<number> {
  const pool = await expandNodePortPool(nodeId, protocol);
  if (!pool.includes(port)) {
    throw conflict(
      `Port ${port}/${protocol} is not in this node's reserved port pool. ` +
        "An admin must add it to the pool before it can be published.",
    );
  }

  const rows = (await sql`
    SELECT 1 FROM server_ports
    WHERE node_id = ${nodeId} AND host_port = ${port} AND protocol = ${protocol}
  `) as { 1: number }[];
  if (rows.length > 0) {
    throw conflict(
      `Port ${port}/${protocol} is already allocated to a server on this node.`,
    );
  }

  const [probe] = await checkPortsFree(nodeId, [{ hostPort: port, protocol }]);
  if (!probe?.free) {
    throw conflict(
      `Port ${port}/${protocol} is in use on the node's host by another process.`,
    );
  }

  return port;
}

/** Resolve the chosen node into a full node record with credentials. */
export async function resolveScheduledNode(
  nodeId: string,
): Promise<NodeWithSecrets> {
  const nodes = await listActiveNodesWithSecrets();
  const node = nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    throw conflict(`Node ${nodeId} is no longer active.`);
  }
  return node;
}
