/**
 * Node management routes (plan.md section 7). Admin-only, without exception:
 * a node's agent token is root-equivalent access to that machine.
 *
 * No endpoint here ever returns the agent token or DB passwords — responses go
 * through `toPublicNode`, which strips every secret. The one exception is the
 * create response, which echoes a *generated* token once so the operator can
 * configure the agent with it; it is never readable again.
 */

import { requireAdmin } from "../auth/middleware";
import { sql } from "../db/client";
import {
  badRequest,
  conflict,
  json,
  noContent,
  notFound,
  optionalString,
  parseJsonBody,
  requireNumber,
  requireString,
  requireUuidParam,
} from "../lib/http";
import { generateStrongPassword } from "../lib/crypto";
import {
  checkNodeHealth,
  invalidateNodeConnection,
  normalizeApiUrl,
  probeAgent,
} from "../nodes/nodeApi";
import {
  createNode,
  deleteNode,
  getNode,
  getNodeWithSecrets,
  listActiveNodesWithSecrets,
  listNodes,
  recordHeartbeat,
  setNodeActive,
  updateNode,
} from "../nodes/nodeRegistry";
import { sampleNodeServers } from "../nodes/nodeServerApi";
import {
  addPortPoolEntry,
  listNodePortPool,
  removePortPoolEntry,
} from "../nodes/portPool";
import { loadNodeCapacity, loadNodeCapacities } from "../nodes/scheduler";
import { getNodeAbuseSummary } from "../security/suspiciousList";
import { recordAuditFromRequest } from "../services/auditLog";
import { countServersOnNode, listServersForNode } from "../services/serverManager";

/**
 * Validate an agent base URL.
 *
 * Only http/https: the agent speaks plain HTTP, and anything else is a
 * leftover Docker endpoint from the pre-agent design.
 */
function assertValidApiUrl(apiUrl: string): void {
  try {
    normalizeApiUrl(apiUrl);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : "Invalid apiUrl");
  }
}

/** GET /api/admin/nodes — nodes with capacity and health. */
export async function handleListNodes(request: Request): Promise<Response> {
  await requireAdmin(request);

  const [nodes, capacities] = await Promise.all([
    listNodes(),
    loadNodeCapacities(),
  ]);

  const capacityByNode = new Map(
    capacities.map((capacity) => [capacity.nodeId, capacity]),
  );

  return json({
    nodes: nodes.map((node) => ({
      ...node,
      allocation: capacityByNode.get(node.id) ?? null,
    })),
  });
}

/**
 * GET /api/admin/nodes/:id — one node's full detail for the admin page.
 *
 * Aggregates the node row, its committed allocation, the servers on it (with
 * owner emails and a live usage sample), and an abuse summary, in a single
 * response so the page renders in one round-trip.
 *
 * Pure read: it does not probe the agent or record a heartbeat. Live
 * reachability (and the heartbeat that comes with it) is the client's job on
 * mount, via the existing `GET /api/admin/nodes/:id/health` — that keeps this
 * endpoint cacheable and free of side effects.
 *
 * Sampling uses a short timeout so a dead node cannot hang the page; the
 * servers/ports/abuse data still renders without the agent being reachable.
 */
export async function handleGetNode(
  request: Request,
  nodeId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const node = await getNode(id);
  if (!node) throw notFound("Node not found");

  const [allocation, servers, abuse, portPool] = await Promise.all([
    loadNodeCapacity(id),
    listServersForNode(id),
    getNodeAbuseSummary(id),
    listNodePortPool(id),
  ]);

  // Owner emails: mirror handleListAdminServers's lookup-per-owner pattern.
  const ownerIds = [...new Set(servers.map((server) => server.ownerId))];
  const ownersById = new Map<string, string>();
  for (const ownerId of ownerIds) {
    const rows = (await sql`
      SELECT id, email FROM "user" WHERE id = ${ownerId}
    `) as { id: string; email: string }[];
    if (rows[0]) ownersById.set(rows[0].id, rows[0].email);
  }

  // One sample request to the node's agent, regardless of how many servers.
  // A node that does not answer just reports null usage per server.
  const usageByServer = new Map<
    string,
    { cpuPercent: number; memoryUsageMb: number; diskUsageMb: number }
  >();

  if (servers.length > 0) {
    try {
      for (const sample of await sampleNodeServers(
        id,
        servers.map((server) => server.id),
        10_000,
      )) {
        usageByServer.set(sample.serverId, {
          cpuPercent: sample.cpuPercent,
          memoryUsageMb: sample.memoryUsageMb,
          diskUsageMb: sample.diskUsageMb,
        });
      }
    } catch {
      // Node unreachable — its servers report null usage below.
    }
  }

  const enriched = servers.map((server) => {
    const usage = usageByServer.get(server.id);
    return {
      ...server,
      ownerEmail: ownersById.get(server.ownerId) ?? "unknown",
      cpuPercent: usage?.cpuPercent ?? null,
      memoryUsageMb: usage?.memoryUsageMb ?? null,
      diskUsageMb: usage?.diskUsageMb ?? null,
    };
  });

  return json({ node, allocation, servers: enriched, abuse, portPool });
}

// --- Port pool ---------------------------------------------------------------

/**
 * GET /api/admin/nodes/:id/ports — the node's reserved port-pool entries.
 *
 * Folded into {@link handleGetNode} for the detail page's initial load, but kept
 * as its own endpoint so the page can refresh just the pool after an add/delete
 * without re-fetching the whole node.
 */
export async function handleListNodePortPool(
  request: Request,
  nodeId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");
  return json({ entries: await listNodePortPool(id) });
}

/**
 * POST /api/admin/nodes/:id/ports — reserve a port-pool entry.
 *
 * Parses the spec, rejects overlaps with existing entries, and verifies every
 * port is free on the host through the agent before persisting. A 409 names the
 * offending ports; a 502 means the node could not be reached to verify.
 */
export async function handleAddNodePortPoolEntry(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const body = await parseJsonBody(request);
  const spec = requireString(body, "spec", { max: 1024 });
  const protocolRaw = optionalString(body, "protocol");
  const protocol = (protocolRaw ?? "tcp") as "tcp" | "udp";
  if (protocol !== "tcp" && protocol !== "udp") {
    throw badRequest('"protocol" must be "tcp" or "udp".');
  }

  const entry = await addPortPoolEntry({ nodeId: id, spec, protocol });

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "node.portpool.add",
    targetType: "node",
    targetId: id,
    metadata: { spec, protocol, ports: entry.ports },
  });

  return json({ entry }, 201);
}

/**
 * DELETE /api/admin/nodes/ports/:entryId — remove a pool entry.
 *
 * Existing server bindings are grandfathered (no FK); only future allocations
 * are affected. A missing entry 404s.
 */
export async function handleDeleteNodePortPoolEntry(
  request: Request,
  entryId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(entryId, "entryId");

  const deleted = await removePortPoolEntry(id);
  if (!deleted) throw notFound("Port pool entry not found");

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "node.portpool.delete",
    targetType: "node",
    targetId: id,
    metadata: {},
  });

  return noContent();
}

/**
 * POST /api/admin/nodes/probe — reachability check before registering.
 *
 * Takes raw connection details (no node row exists yet) and pings the agent
 * without persisting anything. The register dialog uses this for its "Test
 * connection" button, so a wrong URL or token is caught at entry rather than
 * after the row is written. Never returns an error for an unreachable agent —
 * that is the answer the caller asked for.
 */
export async function handleProbeNode(request: Request): Promise<Response> {
  await requireAdmin(request);
  const body = await parseJsonBody(request);

  const apiUrl = requireString(body, "apiUrl", { max: 512 });
  assertValidApiUrl(apiUrl);

  // A probe is only meaningful with a token: an empty one would 401 against a
  // correctly-configured agent and read as "wrong token". The register flow
  // generates a token when none is supplied, but that token cannot be tested
  // until the operator has set it on the agent — so require one here.
  const token = requireString(body, "token", { min: 1, max: 512 });

  const health = await probeAgent(apiUrl, token);

  // The raw token never leaves the panel; only the probe result does.
  return json({ health });
}

/**
 * POST /api/admin/nodes — register a node.
 *
 * The node must already be running the CitadelPanel agent. When no token is
 * supplied one is generated and returned **once** in the response: that is the
 * only time it is ever readable, and the operator configures the agent with it.
 *
 * Capacity is probed from the agent when reachable, because hand-typed CPU/RAM
 * totals are what the scheduler bin-packs against and a wrong number there
 * causes overcommit that only shows up under load.
 */
export async function handleCreateNode(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const body = await parseJsonBody(request);

  const name = requireString(body, "name", { max: 64 });
  const hostname = requireString(body, "hostname", { max: 255 });
  const apiUrl = requireString(body, "apiUrl", { max: 512 });
  assertValidApiUrl(apiUrl);

  // A supplied token must be strong enough to be worth having; the agent
  // enforces the same floor at boot.
  const suppliedToken = optionalString(body, "token", { max: 512 });
  if (suppliedToken && suppliedToken.length < 32) {
    throw badRequest("token must be at least 32 characters.");
  }

  const token = suppliedToken ?? generateStrongPassword(48);
  const generatedToken = suppliedToken ? null : token;

  // Probe before persisting: a node that fails now is a quick fix, whereas one
  // that fails at first server-create is a confusing bug report.
  const health = await probeAgent(apiUrl, token);

  const cpuTotal =
    body.cpuTotal === undefined && health.capacity
      ? health.capacity.ncpu
      : body.cpuTotal === undefined
        ? 4 // Unreachable agent: nothing to probe, so fall back to a sane default
        : requireNumber(body, "cpuTotal", { min: 0.5, max: 1024 });

  const memoryTotalMb =
    body.memoryTotalMb === undefined && health.capacity
      ? health.capacity.memTotalMb
      : body.memoryTotalMb === undefined
        ? 8192
        : requireNumber(body, "memoryTotalMb", { min: 512, max: 8_388_608 });

  const diskTotalMb = requireNumber(body, "diskTotalMb", {
    min: 1024,
    max: 1_000_000_000,
  });

  const dbAdminHost = optionalString(body, "dbAdminHost", { max: 255 });
  const dbAdminUser = optionalString(body, "dbAdminUser", { max: 128 });
  const dbAdminPassword = optionalString(body, "dbAdminPassword", { max: 512 });
  const dbAdminPort =
    body.dbAdminPort === undefined
      ? undefined
      : requireNumber(body, "dbAdminPort", { min: 1, max: 65535 });

  // Partial DB config would fail confusingly at provisioning time.
  const dbFields = [dbAdminHost, dbAdminUser, dbAdminPassword];
  if (dbFields.some(Boolean) && !dbFields.every(Boolean)) {
    throw badRequest(
      "To enable the shared node database, provide dbAdminHost, dbAdminUser and dbAdminPassword together.",
    );
  }

  // Resource reservations: each is an optional percentage (0-95) the scheduler
  // must leave free. Default 0 = today's behaviour (full total allocable).
  const cpuReservePct =
    body.cpuReservePct === undefined
      ? undefined
      : requireNumber(body, "cpuReservePct", { min: 0, max: 95 });
  const memoryReservePct =
    body.memoryReservePct === undefined
      ? undefined
      : requireNumber(body, "memoryReservePct", { min: 0, max: 95 });
  const diskReservePct =
    body.diskReservePct === undefined
      ? undefined
      : requireNumber(body, "diskReservePct", { min: 0, max: 95 });
  const allowOvercommit =
    body.allowOvercommit === undefined ? undefined : body.allowOvercommit === true;

  // Optional public browser URL for the direct console WebSocket. When omitted,
  // the panel derives it from apiUrl (ws/wss from its scheme) — the zero-config
  // homelab case. Only validated for shape when supplied.
  const consoleUrl = optionalString(body, "consoleUrl", { max: 512 });
  if (consoleUrl) assertValidApiUrl(consoleUrl);

  let node;
  try {
    node = await createNode({
      name,
      hostname,
      apiUrl,
      apiToken: token,
      consoleUrl,
      cpuTotal,
      memoryTotalMb,
      diskTotalMb,
      cpuReservePct,
      memoryReservePct,
      diskReservePct,
      allowOvercommit,
      dbAdminHost,
      dbAdminPort: dbAdminPort ?? (dbAdminHost ? 3306 : undefined),
      dbAdminUser,
      dbAdminPassword,
    });
  } catch (error) {
    // Postgres 23505 = unique_violation, here on nodes.name
    if ((error as { code?: string }).code === "23505") {
      throw conflict(`A node named "${name}" already exists`);
    }
    throw error;
  }

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "node.create",
    targetType: "node",
    targetId: node.id,
    // Endpoint but never credentials.
    metadata: {
      name,
      apiUrl,
      cpuTotal,
      memoryTotalMb,
      ...(cpuReservePct !== undefined ? { cpuReservePct } : {}),
      ...(memoryReservePct !== undefined ? { memoryReservePct } : {}),
      ...(diskReservePct !== undefined ? { diskReservePct } : {}),
      ...(allowOvercommit !== undefined ? { allowOvercommit } : {}),
    },
  });

  return json(
    {
      node,
      health,
      // Shown once, then unrecoverable — the operator must copy it now.
      ...(generatedToken
        ? {
            token: generatedToken,
            warning:
              "Copy this token now: it is stored encrypted and cannot be shown again. Set it as AGENT_TOKEN on the node.",
          }
        : {}),
      ...(health.reachable
        ? {}
        : {
            warning:
              `The agent at ${apiUrl} could not be reached (${health.error}). ` +
              "The node is registered but will fail to provision until it responds.",
          }),
    },
    201,
  );
}

/** GET /api/admin/nodes/:id/health — live reachability check. */
export async function handleNodeHealth(
  request: Request,
  nodeId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const node = await getNodeWithSecrets(id);
  if (!node) throw notFound("Node not found");

  const health = await checkNodeHealth(node);

  // A successful check doubles as a heartbeat.
  if (health.reachable) {
    await recordHeartbeat(id);
  }

  return json({ health });
}

/** GET /api/admin/nodes/health — health of every active node. */
export async function handleAllNodesHealth(request: Request): Promise<Response> {
  await requireAdmin(request);

  const nodes = await listActiveNodesWithSecrets();
  const results = await Promise.all(
    nodes.map(async (node) => ({
      nodeId: node.id,
      nodeName: node.name,
      ...(await checkNodeHealth(node)),
    })),
  );

  for (const result of results) {
    if (result.reachable) await recordHeartbeat(result.nodeId);
  }

  return json({ nodes: results });
}

/**
 * PATCH /api/admin/nodes/:id — activate or drain a node.
 *
 * Draining is reversible and does not touch running containers; it only stops
 * new servers being scheduled onto the node.
 */
export async function handleUpdateNode(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const body = await parseJsonBody(request);

  // `isActive` (drain/activate), the connection fields, and the resource
  // reservations are independent: a caller correcting a mistyped hostname should
  // not have to also send isActive, and one tuning the memory reserve should not
  // have to re-send the hostname. At least one must be present.
  const hasActiveToggle = typeof body.isActive === "boolean";
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const hostname =
    typeof body.hostname === "string" ? body.hostname.trim() : undefined;
  const apiUrl =
    typeof body.apiUrl === "string" ? body.apiUrl.trim() : undefined;
  const apiToken =
    typeof body.apiToken === "string" && body.apiToken.length > 0
      ? body.apiToken
      : undefined;
  const consoleUrl =
    typeof body.consoleUrl === "string" ? body.consoleUrl.trim() : undefined;

  // Resource reservations: optional percentages (0-95) that must stay free.
  // `body.allowOvercommit === false` is a real value, so distinguish "absent"
  // from "false" by checking for undefined explicitly.
  const cpuReservePct =
    body.cpuReservePct === undefined
      ? undefined
      : requireNumber(body, "cpuReservePct", { min: 0, max: 95 });
  const memoryReservePct =
    body.memoryReservePct === undefined
      ? undefined
      : requireNumber(body, "memoryReservePct", { min: 0, max: 95 });
  const diskReservePct =
    body.diskReservePct === undefined
      ? undefined
      : requireNumber(body, "diskReservePct", { min: 0, max: 95 });
  const allowOvercommit =
    body.allowOvercommit === undefined ? undefined : body.allowOvercommit === true;

  const hasDetailEdit = Boolean(name || hostname || apiUrl || apiToken || consoleUrl);
  const hasReserveEdit =
    cpuReservePct !== undefined ||
    memoryReservePct !== undefined ||
    diskReservePct !== undefined ||
    allowOvercommit !== undefined;
  if (!hasActiveToggle && !hasDetailEdit && !hasReserveEdit) {
    throw badRequest(
      'Provide "isActive" and/or one of "name", "hostname", "apiUrl", "apiToken", ' +
        '"consoleUrl", "cpuReservePct", "memoryReservePct", "diskReservePct", "allowOvercommit".',
    );
  }

  // Validate any supplied URL before writing it.
  if (apiUrl !== undefined) assertValidApiUrl(apiUrl);
  if (consoleUrl !== undefined && consoleUrl.length > 0) assertValidApiUrl(consoleUrl);

  let node = null;

  if (hasActiveToggle) {
    node = await setNodeActive(id, body.isActive as boolean);
  }

  if (hasDetailEdit || hasReserveEdit) {
    node = await updateNode(id, {
      name,
      hostname,
      apiUrl,
      apiToken,
      consoleUrl,
      cpuReservePct,
      memoryReservePct,
      diskReservePct,
      allowOvercommit,
    });
  }

  if (!node) throw notFound("Node not found");

  // A changed URL or token invalidates the cached connection; safe to call
  // unconditionally since it is a cheap map delete.
  invalidateNodeConnection(id);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: hasActiveToggle
      ? (body.isActive as boolean)
        ? "node.update"
        : "node.drain"
      : "node.update",
    targetType: "node",
    targetId: id,
    metadata: {
      ...(hasActiveToggle ? { isActive: body.isActive as boolean } : {}),
      ...(name ? { name } : {}),
      ...(hostname ? { hostname } : {}),
      ...(apiUrl ? { apiUrl } : {}),
      ...(apiToken ? { apiToken: true } : {}), // present, never the value
      ...(consoleUrl !== undefined ? { consoleUrl } : {}),
      ...(cpuReservePct !== undefined ? { cpuReservePct } : {}),
      ...(memoryReservePct !== undefined ? { memoryReservePct } : {}),
      ...(diskReservePct !== undefined ? { diskReservePct } : {}),
      ...(allowOvercommit !== undefined ? { allowOvercommit } : {}),
    },
  });

  return json({ node });
}

/**
 * DELETE /api/admin/nodes/:id
 *
 * Two safety gates, checked before the row is touched:
 *
 * 1. The node must be **drained** (`isActive = false`). Deleting an active node
 *    would pull it out of the scheduler mid-provision and surprise owners whose
 *    next server-create lands on a node that no longer exists.
 * 2. It must host **no servers**. `servers.node_id` is ON DELETE RESTRICT, so
 *    Postgres would refuse the delete anyway — but a pre-check lets the message
 *    name the count, instead of surfacing a raw constraint error. The FK is kept
 *    as the race-condition backstop.
 *
 * Orphaning running containers would be worse than refusing the request, so a
 * node that fails either gate gets a 409, not a silent cleanup.
 */
export async function handleDeleteNode(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const existing = await getNode(id);
  if (!existing) throw notFound("Node not found");

  // Gate 1: drain first. Draining is reversible and stops new servers landing
  // here; an admin removing a node must opt out of scheduling before removal.
  if (existing.isActive) {
    throw conflict(
      "Drain this node before deleting it. Set it to inactive so no new servers are scheduled onto it, then remove its servers.",
    );
  }

  // Gate 2: no servers may remain. A direct COUNT names the number in the
  // error; the FK below is the backstop for a concurrent create.
  const serverCount = await countServersOnNode(id);
  if (serverCount > 0) {
    throw conflict(
      `${serverCount} server${serverCount === 1 ? "" : "s"} still hosted on this node. Delete or migrate them before removing the node.`,
    );
  }

  let deleted: boolean;
  try {
    deleted = await deleteNode(id);
  } catch (error) {
    // ON DELETE RESTRICT throws SQLSTATE 23001 (restrict_violation), not 23503
    // (foreign_key_violation) — a concurrent server create between the pre-check
    // and the delete would land here. Catch both so it surfaces as a 409, not a
    // 500.
    const code = (error as { code?: string }).code;
    if (code === "23001" || code === "23503") {
      throw conflict(
        "This node still hosts servers. Remove them before deleting the node.",
      );
    }
    throw error;
  }

  if (!deleted) throw notFound("Node not found");

  invalidateNodeConnection(id);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "node.delete",
    targetType: "node",
    targetId: id,
    metadata: { name: existing.name },
  });

  return noContent();
}
