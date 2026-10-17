/** Run alone against a migrated disposable SERVER_DELETION_TEST_DATABASE_URL. */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const databaseUrl = process.env.SERVER_DELETION_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("SERVER_DELETION_TEST_DATABASE_URL must name a disposable test database.");
}
const actorId = "offline-test-admin";
const serverId = "11111111-1111-4111-8111-111111111119";
const peerId = "11111111-1111-4111-8111-111111111118";
const nodeId = "22222222-2222-4222-8222-222222222229";
const healthyNodeId = "22222222-2222-4222-8222-222222222228";
const admin = { id: actorId, email: "offline-admin@example.test", role: "admin" as const };
let viewer = { ...admin, role: "admin" as "admin" | "user" };
let client: typeof import("../db/client");
let manager: typeof import("./serverManager");
let routes: typeof import("../routes/servers");
let nodeRoutes: typeof import("../routes/nodes");
let adminRoutes: typeof import("../routes/admin");
let registry: typeof import("../nodes/nodeRegistry");
let nodeApi: typeof import("../nodes/nodeApi");
let maintenance: typeof import("./nodeMaintenance");
let serverView: typeof import("../../server-view");
let crypto: typeof import("../lib/crypto");
let fetchMode: "stalled" | "ok" | "forbidden" | "unhealthy" | "mixed" | "unavailable";
let requests: string[];
let sampledServerIds: string[][];
const originalFetch = globalThis.fetch;

if (databaseUrl) {
  mock.module("server-only", () => ({}));
  mock.module("../config/env", () => ({ env: {
    databaseUrl, encryptionKey: "offline-test-encryption-key-00000000000000",
    authSecret: "offline-test-auth-secret-00000000000000000", frontendUrl: "http://localhost:3000",
    authBaseUrl: "http://localhost:3000", nodeEnv: "test", isProduction: false,
    nodeApiTimeoutMs: 1000, uploadMaxBytes: 1024,
    security: { watcherIntervalSeconds: 60 },
  } }));
  mock.module("next/headers", () => ({ headers: async () => new Headers() }));
  mock.module("../auth/middleware", () => ({
    getAuthenticatedUser: async () => viewer,
    requireAuth: async () => viewer,
    requireAdmin: async () => admin,
    requireServerOwner: async () => ({ user: viewer, access: { kind: "owner", permissions: {} } }),
    requireServerPermission: async () => ({ user: viewer, access: { kind: "admin", permissions: {} } }),
  }));
}

describe.skipIf(!databaseUrl)("server management with a stalled node", () => {
  beforeAll(async () => {
    client = await import("../db/client");
    crypto = await import("../lib/crypto");
    manager = await import("./serverManager");
    routes = await import("../routes/servers");
    nodeRoutes = await import("../routes/nodes");
    adminRoutes = await import("../routes/admin");
    registry = await import("../nodes/nodeRegistry");
    nodeApi = await import("../nodes/nodeApi");
    maintenance = await import("./nodeMaintenance");
    serverView = await import("../../server-view");
    await client.sql`INSERT INTO "user" (id,name,email) VALUES (${actorId},'Offline test',${admin.email})`;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname;
      requests.push(path);
      if (fetchMode === "stalled" || (fetchMode === "mixed" && url.hostname === "stalled-node.test")) {
        return new Promise<Response>(() => {});
      }
      if (fetchMode === "unavailable") return Response.json({ error: "Agent unavailable" }, { status: 503 });
      if (fetchMode === "forbidden" && path.endsWith("/container")) {
        return Response.json({ error: "Agent token rejected" }, { status: 403 });
      }
      if (fetchMode === "unhealthy" && path === "/v1/health") {
        return Response.json({ error: "Agent unavailable" }, { status: 503 });
      }
      if (path.endsWith("/state")) return Response.json({ state: "exited" });
      if (path === "/v1/stats") {
        const { serverIds } = JSON.parse(String(init?.body)) as { serverIds: string[] };
        sampledServerIds.push(serverIds);
        return Response.json({ samples: serverIds.map((id) => ({
          serverId: id, cpuPercent: 40, memoryUsageMb: 256, diskUsageMb: 512,
        })) });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });

  beforeEach(async () => {
    requests = [];
    sampledServerIds = [];
    fetchMode = "stalled";
    viewer = { ...admin };
    await client.sql`DELETE FROM servers WHERE id IN (${serverId}, ${peerId})`;
    await client.sql`DELETE FROM audit_logs WHERE target_id IN (${serverId}, ${nodeId})`;
    await client.sql`
      INSERT INTO nodes (id,name,hostname,api_url,db_admin_host,db_admin_user,db_admin_password_encrypted)
      VALUES (${nodeId},'offline-deletion-test-node','node.test','http://stalled-node.test',
        'node_db','node-admin',${crypto.encryptSecret("test-database-password")})
      ON CONFLICT (id) DO UPDATE SET is_active = true
    `;
    nodeApi.invalidateNodeConnection(nodeId);
    const [blueprint] = await client.sql`SELECT id FROM blueprints WHERE key = 'minecraft-java'`;
    for (const id of [serverId, peerId]) {
      await client.sql`
        INSERT INTO servers (id,name,owner_id,node_id,blueprint_id,container_id,status,cpu_limit,memory_limit_mb,disk_limit_mb)
        VALUES (${id},${id === serverId ? "Offline server" : "Peer"},${actorId},${nodeId},${blueprint!.id},
          ${`container-${id}`},'running',1,2048,4096)
      `;
    }
    await client.sql`INSERT INTO server_ports (server_id,node_id,host_port,container_port,is_primary)
      VALUES (${serverId},${nodeId},25565,25565,true)`;
    await client.sql`INSERT INTO server_links (server_id,target_id,created_by) VALUES (${serverId},${peerId},${actorId})`;
    await client.sql`
      INSERT INTO server_databases (server_id,node_id,db_name,db_user,db_password_encrypted,host,port)
      VALUES (${serverId},${nodeId},'offline_world','offline_user',${crypto.encryptSecret("test-password")},'node_db',3306)
    `;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await client.sql`DELETE FROM servers WHERE id IN (${serverId}, ${peerId})`;
    await client.sql`DELETE FROM nodes WHERE id IN (${nodeId}, ${healthyNodeId})`;
    await client.sql`DELETE FROM audit_logs WHERE user_id = ${actorId}`;
    await client.sql`DELETE FROM "user" WHERE id = ${actorId}`;
    await client.sql.end();
    await client.authPool.end();
  });

  test("saved server detail loads without asking the stalled agent", async () => {
    const server = await manager.getServer(serverId);
    expect(server).toMatchObject({ id: serverId, name: "Offline server", status: "running" });
    expect(server.ports[0]?.port).toBe(25565);
    expect(requests).toEqual([]);
  });

  test("the detail API returns saved metadata before live status is requested", async () => {
    const response = await routes.handleGetServer(new Request(`http://panel.test/api/servers/${serverId}`), serverId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ server: { id: serverId, status: "running" } });
    expect(requests).toEqual([]);

    fetchMode = "ok";
    const live = await routes.handleGetServer(new Request(`http://panel.test/api/servers/${serverId}?reconcile=true`), serverId);
    expect(await live.json()).toMatchObject({ server: { id: serverId, status: "stopped" } });
    expect(requests).toEqual([`/v1/servers/${serverId}/state`]);
  });

  test("the server page seed renders from panel metadata with a stalled agent", async () => {
    const view = await serverView.resolveServerView(serverId);
    expect(view).toMatchObject({ id: serverId, name: "Offline server", status: "running" });
    expect(requests).toEqual([]);
  });

  test("the admin fleet returns stored rows and management context without contacting a stalled node", async () => {
    const response = await adminRoutes.handleListAdminServers(new Request("http://panel.test/api/admin/servers"));
    expect(response.status).toBe(200);
    const { servers } = await response.json();
    expect(servers.find((server: { id: string }) => server.id === serverId)).toMatchObject({
      id: serverId, status: "running", ownerEmail: admin.email, cpuPercent: null, memoryUsageMb: null,
    });
    expect(requests).toEqual([]);
  });

  test("node detail returns saved capacity, ports and server rows without a live sample", async () => {
    const response = await nodeRoutes.handleGetNode(new Request(`http://panel.test/api/admin/nodes/${nodeId}`), nodeId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.node.id).toBe(nodeId);
    expect(body.allocation).toMatchObject({ cpuAllocated: 2, memoryAllocatedMb: 4096 });
    expect(body.servers.find((server: { id: string }) => server.id === serverId)).toMatchObject({
      ownerEmail: admin.email, cpuPercent: null, memoryUsageMb: null, diskUsageMb: null,
      ports: [{ port: 25565, isPrimary: true }],
    });
    expect(body.abuse).toBeDefined();
    expect(body.portPool).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a healthy node's fleet usage loads independently of a stalled node and retains owner search", async () => {
    await client.sql`
      INSERT INTO nodes (id,name,hostname,api_url)
      VALUES (${healthyNodeId},'healthy-usage-test-node','healthy.test','http://healthy-node.test')
      ON CONFLICT (id) DO NOTHING
    `;
    await client.sql`UPDATE servers SET node_id = ${healthyNodeId} WHERE id = ${peerId}`;
    nodeApi.invalidateNodeConnection(healthyNodeId);
    fetchMode = "mixed";
    const response = await adminRoutes.handleListAdminServers(new Request(
      `http://panel.test/api/admin/servers?includeUsage=true&nodeId=${healthyNodeId}&q=${encodeURIComponent(admin.email)}`,
    ));
    expect(await response.json()).toMatchObject({ servers: [{ id: peerId, cpuPercent: 40, memoryUsageMb: 256 }] });
    expect(requests).toEqual(["/v1/stats"]);
    expect(sampledServerIds).toEqual([[peerId]]);

    const unmatched = await adminRoutes.handleListAdminServers(new Request(
      `http://panel.test/api/admin/servers?includeUsage=true&nodeId=${healthyNodeId}&q=Offline%20server`,
    ));
    expect(await unmatched.json()).toEqual({ servers: [] });
    expect(requests).toEqual(["/v1/stats"]);
  });

  test("node usage is explicitly requested after saved detail and enriches only the live fields", async () => {
    fetchMode = "ok";
    const response = await nodeRoutes.handleGetNode(new Request(`http://panel.test/api/admin/nodes/${nodeId}?includeUsage=true`), nodeId);
    const body = await response.json();
    expect(body.servers.find((server: { id: string }) => server.id === serverId)).toMatchObject({
      id: serverId, status: "running", cpuPercent: 40, memoryUsageMb: 256, diskUsageMb: 512,
    });
    expect(requests).toEqual(["/v1/stats"]);
  });

  test("failed live usage preserves saved fleet and node detail", async () => {
    fetchMode = "unavailable";
    const fleet = await adminRoutes.handleListAdminServers(new Request(`http://panel.test/api/admin/servers?includeUsage=true&nodeId=${nodeId}`));
    const node = await nodeRoutes.handleGetNode(new Request(`http://panel.test/api/admin/nodes/${nodeId}?includeUsage=true`), nodeId);
    expect(fleet.status).toBe(200);
    expect(node.status).toBe(200);
    for (const response of [fleet, node]) {
      const { servers } = await response.json();
      expect(servers.find((server: { id: string }) => server.id === serverId)).toMatchObject({
        id: serverId, status: "running", ownerEmail: admin.email, cpuPercent: null, memoryUsageMb: null,
      });
    }
    expect(requests).toEqual(["/v1/stats", "/v1/stats"]);
  });

  test("force deletion skips every node call and retains an accurate cleanup receipt", async () => {
    await manager.deleteServer(serverId, actorId, true, true);
    expect(requests).toEqual([]);
    expect(await client.sql`SELECT id FROM servers WHERE id = ${serverId}`).toHaveLength(0);
    expect(await client.sql`SELECT server_id FROM server_ports WHERE server_id = ${serverId}`).toHaveLength(0);
    expect(await client.sql`SELECT id FROM server_databases WHERE server_id = ${serverId}`).toHaveLength(0);
    expect(await client.sql`SELECT id FROM server_links WHERE server_id = ${serverId} OR target_id = ${serverId}`).toHaveLength(0);
    expect(await client.sql`SELECT id FROM servers WHERE id = ${peerId}`).toHaveLength(1);
    const [audit] = await client.sql`SELECT metadata FROM audit_logs WHERE target_id = ${serverId} AND action = 'server.delete'`;
    expect(audit!.metadata).toMatchObject({
      forced: true, nodeCleanupSkipped: true, nodeId, dataDeleted: false, dataDeleteRequested: true,
      orphaned: { container: `container-${serverId}`, dataDirectory: serverId, databases: ["offline_world"],
        links: [{ serverId, targetId: peerId }] },
    });
  });

  test("owners cannot select force deletion", async () => {
    viewer = { ...admin, role: "user" };
    await expect(routes.handleDeleteServer(new Request(`http://panel.test/api/servers/${serverId}?force=true`, { method: "DELETE" }), serverId))
      .rejects.toMatchObject({ status: 403 });
    expect(await client.sql`SELECT id FROM servers WHERE id = ${serverId}`).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  test("normal deletion retains the row and restores status when the agent rejects cleanup", async () => {
    fetchMode = "forbidden";
    await expect(manager.deleteServer(serverId, actorId, true)).rejects.toMatchObject({ status: 403 });
    const [server] = await client.sql`SELECT status FROM servers WHERE id = ${serverId}`;
    expect(server!.status).toBe("running");
    expect(await client.sql`SELECT id FROM server_databases WHERE server_id = ${serverId}`).toHaveLength(1);
    expect(requests).toEqual([`/v1/servers/${serverId}/links/${peerId}`, `/v1/servers/${serverId}/container`]);
  });

  test("normal deletion still removes node resources before deleting metadata", async () => {
    fetchMode = "ok";
    await manager.deleteServer(serverId, actorId, true);
    expect(requests).toEqual([`/v1/servers/${serverId}/links/${peerId}`, `/v1/servers/${serverId}/container`, `/v1/servers/${serverId}/database`]);
    expect(await client.sql`SELECT id FROM servers WHERE id = ${serverId}`).toHaveLength(0);
    const [audit] = await client.sql`SELECT metadata FROM audit_logs WHERE target_id = ${serverId} AND action = 'server.delete'`;
    expect(audit!.metadata).toEqual({ dataDeleted: true });
  });

  test("force deletion cannot interrupt a server migration", async () => {
    await client.sql`UPDATE servers SET status = 'migrating' WHERE id = ${serverId}`;
    await expect(manager.deleteServer(serverId, actorId, true, true)).rejects.toMatchObject({ status: 409 });
    expect(await client.sql`SELECT id FROM servers WHERE id = ${serverId}`).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  test("failed drain persists inactive intent so a dead node can be removed after its last server", async () => {
    await client.sql`DELETE FROM servers WHERE id = ${peerId}`;
    fetchMode = "unhealthy";
    await expect(maintenance.setNodeActiveWithMaintenance(nodeId, false, async () => {})).rejects.toThrow("Agent unavailable");
    expect((await registry.getNode(nodeId))?.isActive).toBe(false);
    expect(requests).toEqual(["/v1/health"]);

    fetchMode = "stalled";
    await manager.deleteServer(serverId, actorId, false, true);
    const response = await nodeRoutes.handleDeleteNode(new Request(`http://panel.test/api/admin/nodes/${nodeId}`, { method: "DELETE" }), nodeId);
    expect(response.status).toBe(204);
    expect(await registry.getNode(nodeId)).toBeNull();
    expect(requests).toEqual(["/v1/health"]);
  });
});
