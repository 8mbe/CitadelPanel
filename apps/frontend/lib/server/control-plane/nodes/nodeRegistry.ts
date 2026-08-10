/**
 * Node registry (plan.md section 7).
 *
 * A "node" is a machine running the CitadelPanel agent, which owns that
 * machine's Docker daemon and server data. The panel is the control-plane;
 * agents do the work. Even a single-machine install is just one row here, so
 * there is no special-cased single-node code path.
 *
 * The agent token and the DB admin password are encrypted at rest; this module
 * is the only place that decrypts them, and only when handing them to a caller
 * that is about to authenticate with them.
 */

import { sql } from "../db/client";
import {
  decryptOptionalSecret,
  encryptOptionalSecret,
} from "../lib/crypto";

/** A node row as stored, with secrets still encrypted. */
interface NodeRow {
  id: string;
  name: string;
  hostname: string;
  api_url: string;
  api_token_encrypted: string | null;
  cpu_total: string | number;
  memory_total_mb: number;
  disk_total_mb: number;
  cpu_reserve_pct: number;
  memory_reserve_pct: number;
  disk_reserve_pct: number;
  allow_overcommit: boolean;
  db_admin_host: string | null;
  db_admin_port: number | null;
  db_admin_user: string | null;
  db_admin_password_encrypted: string | null;
  is_active: boolean;
  last_heartbeat_at: Date | null;
  created_at: Date;
}

/** A node with secrets decrypted. Never serialise this to an API response. */
export interface NodeWithSecrets {
  id: string;
  name: string;
  hostname: string;
  /** Base URL of the node's agent, e.g. "https://node1.internal:8081". */
  apiUrl: string;
  /** Bearer token the panel presents to that agent. */
  apiToken: string | null;
  cpuTotal: number;
  memoryTotalMb: number;
  diskTotalMb: number;
  cpuReservePct: number;
  memoryReservePct: number;
  diskReservePct: number;
  allowOvercommit: boolean;
  db: {
    host: string | null;
    port: number | null;
    user: string | null;
    password: string | null;
  };
  isActive: boolean;
  lastHeartbeatAt: Date | null;
}

/** Safe node shape for API responses — no credentials of any kind. */
export interface PublicNode {
  id: string;
  name: string;
  hostname: string;
  apiUrl: string;
  cpuTotal: number;
  memoryTotalMb: number;
  diskTotalMb: number;
  cpuReservePct: number;
  memoryReservePct: number;
  diskReservePct: number;
  allowOvercommit: boolean;
  hasDatabaseServer: boolean;
  isActive: boolean;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
}

function toNodeWithSecrets(row: NodeRow): NodeWithSecrets {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    apiUrl: row.api_url,
    apiToken: decryptOptionalSecret(row.api_token_encrypted),
    cpuTotal: Number(row.cpu_total),
    memoryTotalMb: row.memory_total_mb,
    diskTotalMb: row.disk_total_mb,
    cpuReservePct: row.cpu_reserve_pct,
    memoryReservePct: row.memory_reserve_pct,
    diskReservePct: row.disk_reserve_pct,
    allowOvercommit: row.allow_overcommit,
    db: {
      host: row.db_admin_host,
      port: row.db_admin_port,
      user: row.db_admin_user,
      password: decryptOptionalSecret(row.db_admin_password_encrypted),
    },
    isActive: row.is_active,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

/** Strip every secret before a node leaves the backend. */
export function toPublicNode(row: NodeRow): PublicNode {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    apiUrl: row.api_url,
    cpuTotal: Number(row.cpu_total),
    memoryTotalMb: row.memory_total_mb,
    diskTotalMb: row.disk_total_mb,
    cpuReservePct: row.cpu_reserve_pct,
    memoryReservePct: row.memory_reserve_pct,
    diskReservePct: row.disk_reserve_pct,
    allowOvercommit: row.allow_overcommit,
    hasDatabaseServer: Boolean(row.db_admin_host && row.db_admin_user),
    isActive: row.is_active,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
  };
}

export interface CreateNodeInput {
  name: string;
  hostname: string;
  apiUrl: string;
  apiToken: string;
  cpuTotal: number;
  memoryTotalMb: number;
  diskTotalMb: number;
  /** Share of CPU (0-95) the scheduler must leave free. Defaults to 0. */
  cpuReservePct?: number;
  /** Share of memory (0-95) the scheduler must leave free. Defaults to 0. */
  memoryReservePct?: number;
  /** Share of disk (0-95) the scheduler must leave free. Defaults to 0. */
  diskReservePct?: number;
  /** When true, ignore the reserves and allocate against the full totals. */
  allowOvercommit?: boolean;
  dbAdminHost?: string;
  dbAdminPort?: number;
  dbAdminUser?: string;
  dbAdminPassword?: string;
}

export async function createNode(input: CreateNodeInput): Promise<PublicNode> {
  const rows = (await sql`
    INSERT INTO nodes (
      name, hostname, api_url, api_token_encrypted,
      cpu_total, memory_total_mb, disk_total_mb,
      cpu_reserve_pct, memory_reserve_pct, disk_reserve_pct, allow_overcommit,
      db_admin_host, db_admin_port, db_admin_user, db_admin_password_encrypted
    ) VALUES (
      ${input.name}, ${input.hostname}, ${input.apiUrl},
      ${encryptOptionalSecret(input.apiToken)},
      ${input.cpuTotal}, ${input.memoryTotalMb}, ${input.diskTotalMb},
      ${input.cpuReservePct ?? 0}, ${input.memoryReservePct ?? 0},
      ${input.diskReservePct ?? 0}, ${input.allowOvercommit ?? false},
      ${input.dbAdminHost ?? null}, ${input.dbAdminPort ?? null},
      ${input.dbAdminUser ?? null},
      ${encryptOptionalSecret(input.dbAdminPassword)}
    )
    RETURNING *
  `) as NodeRow[];

  return toPublicNode(rows[0]!);
}

export async function listNodes(): Promise<PublicNode[]> {
  const rows = (await sql`
    SELECT * FROM nodes ORDER BY created_at ASC
  `) as NodeRow[];
  return rows.map(toPublicNode);
}

export async function getNode(nodeId: string): Promise<PublicNode | null> {
  const rows = (await sql`SELECT * FROM nodes WHERE id = ${nodeId}`) as NodeRow[];
  return rows[0] ? toPublicNode(rows[0]) : null;
}

/**
 * Load a node including decrypted credentials, for internal use only
 * (building a Docker client or connecting to the node's database server).
 */
export async function getNodeWithSecrets(
  nodeId: string,
): Promise<NodeWithSecrets | null> {
  const rows = (await sql`SELECT * FROM nodes WHERE id = ${nodeId}`) as NodeRow[];
  return rows[0] ? toNodeWithSecrets(rows[0]) : null;
}

/** Active nodes only, for scheduling and the abuse watcher's sweep. */
export async function listActiveNodesWithSecrets(): Promise<NodeWithSecrets[]> {
  const rows = (await sql`
    SELECT * FROM nodes WHERE is_active = TRUE ORDER BY created_at ASC
  `) as NodeRow[];
  return rows.map(toNodeWithSecrets);
}

/**
 * Activate or drain a node.
 *
 * Draining (`isActive = false`) only stops NEW servers being scheduled onto it;
 * existing containers keep running so this is a safe, reversible operation.
 */
export async function setNodeActive(
  nodeId: string,
  isActive: boolean,
): Promise<PublicNode | null> {
  const rows = (await sql`
    UPDATE nodes SET is_active = ${isActive} WHERE id = ${nodeId} RETURNING *
  `) as NodeRow[];
  return rows[0] ? toPublicNode(rows[0]) : null;
}

/**
 * Editable fields for {@link updateNode}. Every field is optional: only the
 * ones supplied are changed, so a caller correcting one mistyped value does not
 * have to re-supply the rest (and cannot blank one out by omitting it).
 *
 * `apiToken`, when supplied, is re-encrypted; omit it to keep the stored token.
 */
export interface UpdateNodeInput {
  name?: string;
  hostname?: string;
  apiUrl?: string;
  apiToken?: string;
  /** Share of CPU (0-95) the scheduler must leave free. Omit to keep current. */
  cpuReservePct?: number;
  /** Share of memory (0-95) the scheduler must leave free. Omit to keep current. */
  memoryReservePct?: number;
  /** Share of disk (0-95) the scheduler must leave free. Omit to keep current. */
  diskReservePct?: number;
  /** When true, ignore the reserves. Omit to keep current. */
  allowOvercommit?: boolean;
}

/**
 * Update a node's connection details and resource reservations.
 *
 * Lets an admin correct a mistyped hostname, agent URL or token, or adjust the
 * reservation policy, without deleting and re-registering the node (which is
 * blocked while servers reference it anyway). Only provided fields are written.
 */
export async function updateNode(
  nodeId: string,
  input: UpdateNodeInput,
): Promise<PublicNode | null> {
  // Build the SET clause from only the supplied fields. COALESCE keeps the
  // stored value for any field that is omitted (null). The token is encrypted
  // here (or null when omitted), so COALESCE preserves the existing ciphertext.
  // The boolean allowOvercommit uses the same COALESCE trick: null (omitted)
  // preserves the stored value, while an explicit true/false is written.
  const rows = (await sql`
    UPDATE nodes SET
      name                 = COALESCE(${input.name ?? null}, name),
      hostname             = COALESCE(${input.hostname ?? null}, hostname),
      api_url              = COALESCE(${input.apiUrl ?? null}, api_url),
      api_token_encrypted  = COALESCE(${encryptOptionalSecret(input.apiToken)}, api_token_encrypted),
      cpu_reserve_pct      = COALESCE(${input.cpuReservePct ?? null}, cpu_reserve_pct),
      memory_reserve_pct   = COALESCE(${input.memoryReservePct ?? null}, memory_reserve_pct),
      disk_reserve_pct     = COALESCE(${input.diskReservePct ?? null}, disk_reserve_pct),
      allow_overcommit     = COALESCE(${input.allowOvercommit ?? null}, allow_overcommit)
    WHERE id = ${nodeId}
    RETURNING *
  `) as NodeRow[];
  return rows[0] ? toPublicNode(rows[0]) : null;
}

export async function recordHeartbeat(nodeId: string): Promise<void> {
  await sql`UPDATE nodes SET last_heartbeat_at = now() WHERE id = ${nodeId}`;
}

/**
 * Delete a node.
 *
 * `servers.node_id` is ON DELETE RESTRICT, so Postgres refuses while any server
 * still references it. That is intentional: silently orphaning running
 * containers would be worse than a failed request.
 */
export async function deleteNode(nodeId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM nodes WHERE id = ${nodeId} RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}
