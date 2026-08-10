/**
 * Per-node port pool registry (plan.md: admin-managed, host-verified pools).
 *
 * An admin reserves a set of host ports per node per protocol; new servers draw
 * their published ports exclusively from that pool
 * (see {@link ./scheduler.ts allocateHostPort}). Each entry keeps the raw spec
 * the admin typed alongside the expanded port array.
 *
 * Adding an entry verifies, through the node's agent, that every port is
 * actually free on the host — not just free in the panel's `server_ports`
 * table — so a port held by another process is caught before it is reserved.
 * Overlaps between entries are rejected at add time so the pool stays a clean
 * disjoint set per protocol.
 */

import { sql } from "../db/client";
import { conflict } from "../lib/http";
import { checkPortsFree, type PortProtocol } from "./nodePortsApi";
import { parsePortSpec, PortSpecError } from "./portSpec";

/** A reserved port-pool entry, as the admin manages it. */
export interface PortPoolEntry {
  id: string;
  nodeId: string;
  /** Raw entry as the admin typed it, e.g. "25565-25570". */
  spec: string;
  protocol: PortProtocol;
  /** Expanded individual ports the spec resolves to. */
  ports: number[];
  createdAt: string;
}

interface PortPoolRow {
  id: string;
  node_id: string;
  spec: string;
  protocol: PortProtocol;
  ports: number[];
  created_at: Date;
}

function toEntry(row: PortPoolRow): PortPoolEntry {
  return {
    id: row.id,
    nodeId: row.node_id,
    spec: row.spec,
    protocol: row.protocol,
    ports: row.ports,
    createdAt: row.created_at.toISOString(),
  };
}

/** Every pool entry for a node, oldest first. */
export async function listNodePortPool(nodeId: string): Promise<PortPoolEntry[]> {
  const rows = (await sql`
    SELECT id, node_id, spec, protocol, ports, created_at
    FROM node_port_pools
    WHERE node_id = ${nodeId}
    ORDER BY created_at ASC
  `) as PortPoolRow[];
  return rows.map(toEntry);
}

/**
 * All ports reserved on a node for a protocol, flattened and sorted ascending.
 *
 * What {@link allocateHostPort} consumes to draw a candidate set from.
 */
export async function expandNodePortPool(
  nodeId: string,
  protocol: PortProtocol,
): Promise<number[]> {
  const rows = (await sql`
    SELECT ports FROM node_port_pools
    WHERE node_id = ${nodeId} AND protocol = ${protocol}
  `) as { ports: number[] }[];

  const all = new Set<number>();
  for (const row of rows) {
    for (const port of row.ports) all.add(port);
  }
  return [...all].sort((a, b) => a - b);
}

export interface AddPortPoolInput {
  nodeId: string;
  spec: string;
  protocol: PortProtocol;
}

/**
 * Reserve a port-pool entry.
 *
 * Steps, in order: parse the spec; reject ports that already belong to another
 * entry for this node+protocol (a clean disjoint set); ask the agent to confirm
 * every port is actually free on the host; then persist. A taken or overlapping
 * port is a 409 with the offending ports named in the message so the admin can
 * act on it without inspecting a structured `details` blob.
 *
 * The host check makes this call depend on the agent being reachable; an
 * unreachable node returns a 502, which is correct — unverifiable ports are not
 * reserved.
 */
export async function addPortPoolEntry(
  input: AddPortPoolInput,
): Promise<PortPoolEntry> {
  let ports: number[];
  try {
    ports = parsePortSpec(input.spec);
  } catch (error) {
    // PortSpecError is safe to surface verbatim.
    throw conflict(
      error instanceof PortSpecError
        ? error.message
        : "Invalid port spec.",
    );
  }

  // Reject overlaps with existing entries so the pool is a disjoint set.
  const existing = await expandNodePortPool(input.nodeId, input.protocol);
  const existingSet = new Set(existing);
  const overlaps = ports.filter((port) => existingSet.has(port));
  if (overlaps.length > 0) {
    throw conflict(
      `These ports are already in the pool for this node: ${overlaps.join(", ")}.`,
    );
  }

  // Verify every port is actually free on the host through the agent.
  const results = await checkPortsFree(
    input.nodeId,
    ports.map((port) => ({ hostPort: port, protocol: input.protocol })),
  );
  const taken = results
    .filter((result) => !result.free)
    .map((result) => result.hostPort);
  if (taken.length > 0) {
    throw conflict(
      `These ports are already in use on the host: ${taken.join(", ")}.`,
    );
  }

  const rows = (await sql`
    INSERT INTO node_port_pools (node_id, spec, protocol, ports)
    VALUES (${input.nodeId}, ${input.spec}, ${input.protocol}, ${sql.array(ports, 23)})
    RETURNING id, node_id, spec, protocol, ports, created_at
  `) as PortPoolRow[];

  return toEntry(rows[0]!);
}

/**
 * Remove a pool entry.
 *
 * Existing servers keep their bindings: `server_ports` has no FK to
 * `node_port_pools` (ports are copied in at allocation), so removing an entry
 * only changes the allowed set for *future* allocations. Callers may warn the
 * admin before deleting an entry whose ports are currently allocated.
 */
export async function removePortPoolEntry(entryId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM node_port_pools WHERE id = ${entryId} RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}
