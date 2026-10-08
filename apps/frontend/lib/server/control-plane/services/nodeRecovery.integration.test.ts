/** Run alone against a migrated disposable NODE_RECOVERY_TEST_DATABASE_URL. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiscoveredServer, ServerRecoveryMetadata } from "../nodes/nodeRecoveryApi";
import type { Blueprint } from "../blueprints/types";
import { SNAPSHOT_TABLES, SNAPSHOT_TRANSIENT_TABLES } from "./panelSnapshotFormat";

const testDatabaseUrl = process.env.NODE_RECOVERY_TEST_DATABASE_URL;
if (testDatabaseUrl && !new URL(testDatabaseUrl).pathname.toLowerCase().includes("test") && !new URL(testDatabaseUrl).pathname.toLowerCase().includes("recovery")) {
  throw new Error("NODE_RECOVERY_TEST_DATABASE_URL must name a disposable test database.");
}
const token = "test-only-node-agent-token-000000000000000";
const admin = { id: "recovery-admin", email: "admin@example.test", role: "admin" as const };
if (testDatabaseUrl) {
  mock.module("server-only", () => ({}));
  mock.module("../config/env", () => ({ env: {
    databaseUrl: testDatabaseUrl, encryptionKey: "recovery-panel-test-key-000000000000000000", authSecret: "recovery-auth-test-key-0000000000000000000",
    frontendUrl: "http://localhost:3000", authBaseUrl: "http://localhost:3000", nodeEnv: "test", isProduction: false,
    nodeApiTimeoutMs: 1000, uploadMaxBytes: 1024, rateLimitEnabled: false,
  } }));
  mock.module("../auth/middleware", () => ({ requireAdmin: async () => admin }));
}

let client: typeof import("../db/client");
let crypto: typeof import("../lib/crypto");
let recovery: typeof import("./nodeRecovery");
let registry: typeof import("../nodes/nodeRegistry");
let blueprintRegistry: typeof import("../blueprints/registry");
let nodeApi: typeof import("../nodes/nodeApi");
let routes: typeof import("../routes/nodes");
let agent: ReturnType<typeof Bun.serve>;
let discovered: DiscoveredServer[] = [];
let discoveryStatus = 200;
let healthStatus = 200;
let forbiddenCalls: string[] = [];
let remembered: { serverId: string; recovery: ServerRecoveryMetadata }[] = [];
const tableNames = [...SNAPSHOT_TABLES, ...SNAPSHOT_TRANSIENT_TABLES].map(name => `"public"."${name}"`).join(", ");
const serverId = (number: number) => `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;

function fixture(number = 1, port = 25565): DiscoveredServer {
  const blueprint: Blueprint = {
    key: `remembered-game-${number}`, name: "Remembered game", dockerImage: "game:original", dataPath: "/game",
    defaultPorts: [{ container: port, primary: true }], envSchema: { PASSWORD: { required: false, secret: true } },
    primaryPortEnv: "SERVER_PORT", startupCommand: "./game --port {{SERVER_PORT}}", stopCommand: "quit",
    install: { image: "installer:original", script: "printf setup", entrypoint: ["/bin/sh", "-c"] },
    minimums: { cpuLimit: 1, memoryLimitMb: 512, diskLimitMb: 1024 }, expectedResourceProfile: "bursty", user: "1000:1000", tty: true,
  };
  return {
    serverId: serverId(number), containerId: `existing-container-${number}`, state: "running", dataPresent: true, source: "manifest",
    spec: { image: blueprint.dockerImage, containerDataPath: blueprint.dataPath, env: { PASSWORD: "remembered-private", SERVER_PORT: String(port) },
      cpuLimit: 1.5, memoryLimitMb: 2048, command: ["./game", "--port", String(port)], user: "1000:1000", tty: true,
      ports: [{ hostPort: port, containerPort: port, protocol: "tcp" }, { hostPort: port, containerPort: port, protocol: "udp" }] },
    recovery: { name: `Remembered server ${number}`, ownerId: "former-owner", ownerEmail: "owner@example.test", blueprint,
      diskLimitMb: 8192, status: "running", secretEnvKeys: ["PASSWORD"], ports: [{ hostPort: port, isPrimary: true, isAdditional: false }] },
  };
}

async function user(id: string, email: string, verified: boolean): Promise<void> {
  await client.sql`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
    VALUES (${id},${id},${email},${verified},now(),now(),${id === admin.id ? "admin" : "user"},false)`;
}

async function node(name = "test-node"): Promise<string> {
  const result = await registry.createNode({ name, hostname: "node.test", apiUrl: agent.url.toString(), apiToken: token,
    cpuTotal: 8, memoryTotalMb: 16384, diskTotalMb: 65536 });
  return result.id;
}

describe.skipIf(!testDatabaseUrl)("node recovery PostgreSQL integration", () => {
  beforeAll(async () => {
    client = await import("../db/client");
    crypto = await import("../lib/crypto");
    registry = await import("../nodes/nodeRegistry");
    blueprintRegistry = await import("../blueprints/registry");
    nodeApi = await import("../nodes/nodeApi");
    recovery = await import("./nodeRecovery");
    routes = await import("../routes/nodes");
    agent = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "Wrong test token" }, { status: 401 });
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/health") return Response.json({ status: "ok", capacity: { ncpu: 8, memTotalMb: 16384 } }, { status: healthStatus });
      if (request.method === "GET" && path === "/v1/servers/discovery") return Response.json({ servers: discovered, warnings: [] }, { status: discoveryStatus });
      const metadata = path.match(/^\/v1\/servers\/([^/]+)\/recovery$/);
      if (request.method === "PUT" && metadata) {
        const body = await request.json() as { recovery: ServerRecoveryMetadata };
        remembered.push({ serverId: metadata[1]!, recovery: body.recovery });
        return Response.json({ ok: true });
      }
      forbiddenCalls.push(`${request.method} ${path}`);
      return Response.json({ error: "Recovery must never modify the container" }, { status: 500 });
    } });
  });

  beforeEach(async () => {
    for (const row of await client.sql`SELECT id FROM nodes`) nodeApi.invalidateNodeConnection(String(row.id));
    await client.sql.unsafe(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY`);
    blueprintRegistry.invalidateBlueprintCache();
    discovered = [];
    discoveryStatus = 200;
    healthStatus = 200;
    forbiddenCalls = [];
    remembered = [];
    await user(admin.id, admin.email, true);
  });
  afterEach(() => expect(forbiddenCalls).toEqual([]));
  afterAll(async () => {
    if (!client) return;
    agent.stop(true);
    await client.sql.unsafe(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY`);
    await client.authPool.end();
    await client.sql.end();
  });

  test("registering a reachable node automatically restores its inventory without recreating or powering containers", async () => {
    discovered = [fixture()];
    const response = await routes.handleCreateNode(new Request("http://localhost:3000/api/admin/nodes", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "registered", hostname: "node.test", apiUrl: agent.url.toString(), token, diskTotalMb: 65536 }) }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.recovery).toMatchObject({ discovered: 1, restored: 1, existing: 0, skipped: [] });
    const [restored] = await client.sql`SELECT owner_id,node_id,container_id,status FROM servers WHERE id=${serverId(1)}`;
    expect(restored).toEqual({ owner_id: admin.id, node_id: body.node.id, container_id: "existing-container-1", status: "running" });
    expect(remembered[0]!.recovery.ownerId).toBe(admin.id);
    expect(JSON.stringify(body)).not.toContain("remembered-private");
  });

  test("rescanning the same server id is idempotent and does not overwrite panel settings", async () => {
    const nodeId = await node();
    discovered = [fixture()];
    expect((await recovery.recoverNodeServers(nodeId, admin.id)).restored).toBe(1);
    discovered[0]!.recovery!.name = "Unexpected replacement name";
    discovered[0]!.spec.env.PASSWORD = "unexpected replacement secret";
    expect(await recovery.recoverNodeServers(nodeId, admin.id)).toMatchObject({ restored: 0, existing: 1, skipped: [] });
    expect((await client.sql`SELECT COUNT(*)::int AS count FROM servers`)[0]!.count).toBe(1);
    expect((await client.sql`SELECT name FROM servers WHERE id=${serverId(1)}`)[0]!.name).toBe("Remembered server 1");
    expect(crypto.decryptSecret(String((await client.sql`SELECT value FROM server_env WHERE key='PASSWORD'`)[0]!.value))).toBe("remembered-private");
  });

  test("verified email ownership can reconnect while an unverified email match falls back to the registering admin", async () => {
    const nodeId = await node();
    await user("replacement-owner", "owner@example.test", true);
    discovered = [fixture()];
    expect((await recovery.recoverNodeServers(nodeId, admin.id)).restored).toBe(1);
    expect((await client.sql`SELECT owner_id FROM servers WHERE id=${serverId(1)}`)[0]!.owner_id).toBe("replacement-owner");
    await user("unverified-owner", "unverified@example.test", false);
    const unmatched = fixture(2, 25566);
    unmatched.recovery!.ownerEmail = "unverified@example.test";
    discovered = [unmatched];
    const result = await recovery.recoverNodeServers(nodeId, admin.id);
    expect(result.restored).toBe(1);
    expect(result.warning).toContain("assigned to you");
    expect((await client.sql`SELECT owner_id FROM servers WHERE id=${serverId(2)}`)[0]!.owner_id).toBe(admin.id);
  });

  test("an original owner id and email can reconnect without a new email verification grant", async () => {
    const nodeId = await node();
    await user("former-owner", "owner@example.test", false);
    discovered = [fixture()];
    expect((await recovery.recoverNodeServers(nodeId, admin.id)).restored).toBe(1);
    expect((await client.sql`SELECT owner_id FROM servers WHERE id=${serverId(1)}`)[0]!.owner_id).toBe("former-owner");
  });

  test("legacy containers get a runtime-only blueprint and every unknown env value is encrypted", async () => {
    const nodeId = await node();
    const legacy = fixture();
    delete legacy.recovery;
    legacy.source = "container";
    discovered = [legacy];
    const result = await recovery.recoverNodeServers(nodeId, admin.id);
    expect(result.restored).toBe(1);
    expect(result.warning).toContain("runtime-only blueprint");
    const [blueprint] = await client.sql`SELECT b.* FROM blueprints b JOIN servers s ON s.blueprint_id=b.id WHERE s.id=${serverId(1)}`;
    expect(blueprint!.install_script).toBeNull();
    expect(blueprint!.docker_image).toBe("game:original");
    expect(blueprint!.startup_command).toContain("'./game'");
    const environment = await client.sql`SELECT key,value,is_secret FROM server_env ORDER BY key`;
    expect(environment.every(row => row.is_secret === true)).toBe(true);
    expect(environment.map(row => crypto.decryptSecret(String(row.value)))).toEqual(["remembered-private", "25565"]);
  });

  test("a port conflict rolls back that server and its newly inserted blueprint", async () => {
    const nodeId = await node();
    discovered = [fixture()];
    await recovery.recoverNodeServers(nodeId, admin.id);
    discovered = [fixture(2)];
    const result = await recovery.recoverNodeServers(nodeId, admin.id);
    expect(result).toMatchObject({ restored: 0, existing: 0, skipped: [{ serverId: serverId(2) }] });
    expect(result.skipped[0]!.reason).toContain("published port");
    expect((await client.sql`SELECT COUNT(*)::int AS count FROM servers WHERE id=${serverId(2)}`)[0]!.count).toBe(0);
    expect((await client.sql`SELECT COUNT(*)::int AS count FROM blueprints WHERE key='remembered-game-2'`)[0]!.count).toBe(0);
    expect((await client.sql`SELECT COUNT(*)::int AS count FROM server_env WHERE server_id=${serverId(2)}`)[0]!.count).toBe(0);
  });

  test("an identity already assigned to another node is skipped without moving its records", async () => {
    const firstNode = await node("first-node");
    discovered = [fixture()];
    await recovery.recoverNodeServers(firstNode, admin.id);
    const otherNode = await node("other-node");
    const result = await recovery.recoverNodeServers(otherNode, admin.id);
    expect(result.restored).toBe(0);
    expect(result.skipped[0]!.reason).toContain("another node");
    expect((await client.sql`SELECT node_id FROM servers WHERE id=${serverId(1)}`)[0]!.node_id).toBe(firstNode);
  });

  test("a changed same-key blueprint keeps the original install and runtime definition under a distinct key", async () => {
    const nodeId = await node();
    discovered = [fixture()];
    await recovery.recoverNodeServers(nodeId, admin.id);
    await client.sql`UPDATE blueprints SET install_script='printf replacement',docker_image='game:replacement' WHERE key='remembered-game-1'`;
    blueprintRegistry.invalidateBlueprintCache();
    const original = fixture(2, 25566);
    original.recovery!.blueprint = fixture().recovery!.blueprint;
    discovered = [original];
    const result = await recovery.recoverNodeServers(nodeId, admin.id);
    expect(result.restored).toBe(1);
    const [blueprint] = await client.sql`SELECT b.key,b.install_script,b.install_image,b.startup_command,b.docker_image FROM blueprints b
      JOIN servers s ON s.blueprint_id=b.id WHERE s.id=${serverId(2)}`;
    expect(blueprint!.key).toContain(`recovered-${serverId(2)}-`);
    expect(blueprint).toMatchObject({ install_script: "printf setup", install_image: "installer:original", docker_image: "game:original", startup_command: "./game --port {{SERVER_PORT}}" });
    expect((await client.sql`SELECT docker_image FROM blueprints WHERE key='remembered-game-1'`)[0]!.docker_image).toBe("game:replacement");
  });

  test("an unavailable discovery endpoint returns a warning and leaves registration usable", async () => {
    const nodeId = await node();
    discoveryStatus = 503;
    expect(await recovery.recoverNodeServers(nodeId, admin.id)).toMatchObject({ discovered: 0, restored: 0, existing: 0, skipped: [], warning: expect.stringContaining("unavailable") });
    healthStatus = 503;
    const response = await routes.handleCreateNode(new Request("http://localhost:3000/api/admin/nodes", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "temporarily-offline", hostname: "node.test", apiUrl: agent.url.toString(), token, diskTotalMb: 65536 }) }));
    expect(response.status).toBe(201);
    expect((await response.json()).recovery.warning).toContain("Connect the agent");
  });
});
