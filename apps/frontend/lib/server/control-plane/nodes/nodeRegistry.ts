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
  safeEqual,
} from "../lib/crypto";

/** A node row as stored, with secrets still encrypted. */
interface NodeRow {
  id: string;
  name: string;
  hostname: string;
  api_url: string;
  /** Optional public/browser URL for the direct console WS; null ⇒ derive from api_url. */
  console_url: string | null;
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
  /**
   * Public/browser URL for the direct console WebSocket (wss://), or null to
   * derive it from `apiUrl` (homelab zero-config case).
   */
  consoleUrl: string | null;
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

/** Safe node shape for API responses. No credentials of any kind. */
export interface PublicNode {
  id: string;
  name: string;
  hostname: string;
  apiUrl: string;
  /** Public browser URL for the direct console WS, or null to derive from apiUrl. */
  consoleUrl: string | null;
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
    consoleUrl: row.console_url,
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
    consoleUrl: row.console_url,
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
  /** Optional public browser WS URL; null/omitted ⇒ derived from apiUrl. */
  consoleUrl?: string | null;
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
      name, hostname, api_url, api_token_encrypted, console_url,
      cpu_total, memory_total_mb, disk_total_mb,
      cpu_reserve_pct, memory_reserve_pct, disk_reserve_pct, allow_overcommit,
      db_admin_host, db_admin_port, db_admin_user, db_admin_password_encrypted
    ) VALUES (
      ${input.name}, ${input.hostname}, ${input.apiUrl},
      ${encryptOptionalSecret(input.apiToken)},
      ${input.consoleUrl ?? null},
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
 * Short-lived cache of resolved node credentials, keyed by node id.
 *
 * Every call to a node's agent starts here: a console attach, a status
 * reconcile, a stats poll, a file listing. So this SELECT (plus its AES
 * decrypt) sat in front of *every* node round trip. Nodes are edited by an
 * admin, roughly never, while the panel reads them several times per page load,
 * so a few seconds of staleness buys back a database round trip per node call.
 *
 * The TTL is a backstop, not the mechanism: the routes that change a node call
 * {@link invalidateNode} directly, so an edit takes effect immediately rather
 * than whenever the entry happens to expire.
 */
const nodeSecretsCache = new Map<
  string,
  { node: NodeWithSecrets | null; at: number }
>();
const NODE_CACHE_TTL_MS = 5_000;

/** Drop a node's cached credentials, after it is edited or deleted. */
export function invalidateNode(nodeId: string): void {
  nodeSecretsCache.delete(nodeId);
}

/**
 * Load a node including decrypted credentials, for internal use only
 * (building a Docker client or connecting to the node's database server).
 */
export async function getNodeWithSecrets(
  nodeId: string,
): Promise<NodeWithSecrets | null> {
  const now = Date.now();
  const cached = nodeSecretsCache.get(nodeId);
  if (cached && now - cached.at < NODE_CACHE_TTL_MS) return cached.node;

  const rows = (await sql`SELECT * FROM nodes WHERE id = ${nodeId}`) as NodeRow[];
  const node = rows[0] ? toNodeWithSecrets(rows[0]) : null;
  nodeSecretsCache.set(nodeId, { node, at: now });
  return node;
}

/** Active nodes only, for scheduling and the abuse watcher's sweep. */
export async function listActiveNodesWithSecrets(): Promise<NodeWithSecrets[]> {
  const rows = (await sql`
    SELECT * FROM nodes WHERE is_active = TRUE ORDER BY created_at ASC
  `) as NodeRow[];
  return rows.map(toNodeWithSecrets);
}

/**
 * Identify which node owns a given agent bearer token, by decrypting each active
 * node's token and comparing in constant time.
 *
 * Used by the direct-console callback endpoints to authenticate the *agent*
 * calling back (the agent presents its long-lived token; the panel reverses it
 * to a node to attribute the session and enforce that a token minted for node X
 * is not validated/audited by node Y). Fleet sizes are small, so an O(nodes)
 * scan after decrypt is cheap and avoids a stored hash column. Returns null when
 * no active node matches. Callers treat that as a 401.
 */
export async function findNodeByAgentToken(
  token: string,
): Promise<NodeWithSecrets | null> {
  const nodes = await listActiveNodesWithSecrets();
  for (const node of nodes) {
    if (node.apiToken && safeEqual(token, node.apiToken)) {
      return node;
    }
  }
  return null;
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
  /**
   * Public browser WS URL. Omit to keep current; set to a string to change it.
   * (Clearing back to null is not supported via this input. A node that needs
   * that can be re-registered.)
   */
  consoleUrl?: string;
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
      console_url          = COALESCE(${input.consoleUrl ?? null}, console_url),
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

/**
 * Store the credentials for a node's shared database, before the container that
 * uses them exists.
 *
 * Split from {@link setNodeDbEndpoint} on purpose. The panel generates the
 * MariaDB root password, then asks the agent to create a container with it, and
 * that call can take minutes (image pull + first-boot init) and time out. If the
 * password only landed here *after* the agent answered, a timed-out setup would
 * leave a running database whose password nobody knows. Written first, the retry
 * presents the same password and the agent recognises its own container.
 *
 * Leaves the host null until the container is up, so `hasDatabaseServer` (host
 * AND user) stays false and no owner is offered a database that does not exist
 * yet.
 */
export async function stageNodeDbCredentials(
  nodeId: string,
  user: string,
  password: string,
): Promise<void> {
  await sql`
    UPDATE nodes SET
      db_admin_user = ${user},
      db_admin_password_encrypted = ${encryptOptionalSecret(password)}
    WHERE id = ${nodeId}
  `;
  invalidateNode(nodeId);
}

/**
 * Record where a node's database actually answers, which is what switches the
 * feature on for that node's servers.
 *
 * The host is the MariaDB container's IP on `node_db_net`. Docker assigns it at
 * start, so it can change when the container is recreated, and every setup/start
 * writes it again rather than trusting the stored value.
 */
export async function setNodeDbEndpoint(
  nodeId: string,
  host: string,
  port: number,
): Promise<void> {
  await sql`
    UPDATE nodes SET
      db_admin_host = ${host},
      db_admin_port = ${port}
    WHERE id = ${nodeId}
  `;
  invalidateNode(nodeId);
}

export async function recordHeartbeat(nodeId: string): Promise<void> {
  await sql`UPDATE nodes SET last_heartbeat_at = now() WHERE id = ${nodeId}`;
}

/**
 * Delete a node.
 *
 * `servers.node_id` is ON DELETE RESTRICT, so Postgres refuses while any server
 * still references it, throwing SQLSTATE 23001 (`restrict_violation`), not
 * 23503. Callers should pre-check the server count (and the drain flag) for a
 * readable error; this low-level function relies on the constraint as the
 * race-condition backstop. Orphaning running containers would be worse than a
 * failed request.
 */
export async function deleteNode(nodeId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM nodes WHERE id = ${nodeId} RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}
