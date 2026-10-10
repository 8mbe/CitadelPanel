/** Run alone against a migrated disposable SERVER_ENV_TEST_DATABASE_URL. */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { containerEnvFingerprint } from "./containerEnv";
import type { CreateContainerRequest } from "../nodes/nodeServerApi";

const databaseUrl = process.env.SERVER_ENV_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("SERVER_ENV_TEST_DATABASE_URL must name a disposable test database.");
}
const key = "test-only-panel-encryption-key-000000000000";
const id = "11111111-1111-4111-8111-111111111111";
const nodeId = "22222222-2222-4222-8222-222222222222";
const agent = "-javaagent:plugins/Nova-0.24.0+MC-26.2.jar";
const initialEnv = { SERVER_PORT: "25565", JVM_OPTS: "", PASSWORD: "old-secret" };
let client: typeof import("../db/client");
let manager: typeof import("./serverManager");
let crypto: typeof import("../lib/crypto");
let registry: typeof import("../blueprints/registry");
let HttpError: typeof import("../lib/http").HttpError;
let calls: string[];
let createdEnv: Record<string, string> | undefined;
let createdSpec: CreateContainerRequest | undefined;
let failCreate: boolean;
let missing: boolean;
let duringCreate: (() => Promise<void>) | undefined;

if (databaseUrl) {
  mock.module("server-only", () => ({}));
  mock.module("../config/env", () => ({ env: {
    databaseUrl, encryptionKey: key, authSecret: "test-only-auth-secret-000000000000000000",
    frontendUrl: "http://localhost:3000", authBaseUrl: "http://localhost:3000",
    nodeEnv: "test", isProduction: false, nodeApiTimeoutMs: 1000, uploadMaxBytes: 1024,
  } }));
  mock.module("./pluginManager", () => ({
    autoUpdateServerPlugins: async () => { calls.push("plugins"); },
    getServerPluginSupportSummary: async () => null,
  }));
  mock.module("./startWatchdog", () => ({
    beginStartWatch: () => { calls.push("watch"); },
    cancelStartWatch: () => { calls.push("cancel-watch"); },
  }));
  mock.module("./serverLinks", () => ({
    listServerLinkNetworks: async () => ["citadel-link-test"], detachAllServerLinks: async () => {},
  }));
  mock.module("./auditLog", () => ({ recordAudit: async (entry: { action: string }) => { calls.push(entry.action); } }));
}

describe.skipIf(!databaseUrl)("saved environment on power actions", () => {
  beforeAll(async () => {
    client = await import("../db/client");
    ({ HttpError } = await import("../lib/http"));
    crypto = await import("../lib/crypto");
    registry = await import("../blueprints/registry");
    const nodeApi = await import("../nodes/nodeServerApi");
    mock.module("../nodes/nodeServerApi", () => ({
      ...nodeApi,
      stopServerContainer: async () => { calls.push("stop"); },
      deleteServerContainer: async (_node: string, _server: string, deleteData: boolean) => {
        expect(deleteData).toBe(false);
        calls.push("remove");
      },
      createServerContainer: async (_node: string, _server: string, spec: CreateContainerRequest) => {
        calls.push("create");
        createdSpec = spec;
        createdEnv = { ...spec.env };
        if (duringCreate) await duringCreate();
        if (failCreate) throw new Error("node create failed");
        missing = false;
        return { containerId: "new-container" };
      },
      startServerContainer: async () => {
        calls.push("start");
        if (missing) throw new HttpError(404, "No container exists");
      },
      restartServerContainer: async () => { calls.push("restart"); },
      getServerState: async () => missing ? "missing" : "running",
    }));
    manager = await import("./serverManager");
    await client.sql`INSERT INTO "user" (id,name,email) VALUES ('env-test-owner','Test','env@example.test')`;
    await client.sql`INSERT INTO nodes (id,name,hostname,api_url) VALUES (${nodeId},'env-test-node','node.test','http://node.test')`;
  });

  beforeEach(async () => {
    calls = [];
    createdEnv = undefined;
    createdSpec = undefined;
    failCreate = false;
    missing = false;
    duringCreate = undefined;
    await client.sql`DELETE FROM servers WHERE id = ${id}`;
    const [blueprint] = await client.sql`SELECT id FROM blueprints WHERE key = 'minecraft-java'`;
    await client.sql`INSERT INTO servers (id,name,owner_id,node_id,blueprint_id,container_id,status,cpu_limit,memory_limit_mb,disk_limit_mb,container_env_fingerprint)
      VALUES (${id},'Env test','env-test-owner',${nodeId},${blueprint!.id},'old-container','stopped',1,2048,4096,${containerEnvFingerprint(initialEnv, key)})`;
    await client.sql`INSERT INTO server_ports (server_id,node_id,host_port,container_port,is_primary)
      VALUES (${id},${nodeId},25565,25565,true)`;
    await manager.writeEnvValues(id, Object.entries(initialEnv).map(([key, value]) => ({ key, value, isSecret: key === "PASSWORD" })));
    registry.invalidateBlueprintCache();
  });

  afterAll(async () => {
    await client.sql`DELETE FROM servers WHERE id = ${id}`;
    await client.sql`DELETE FROM nodes WHERE id = ${nodeId}`;
    await client.sql`DELETE FROM "user" WHERE id = 'env-test-owner'`;
    await client.sql.end();
    await client.authPool.end();
  });

  for (const action of ["startServer", "restartServer"] as const) {
    test(`${action} applies saved flags and decrypted secrets before boot`, async () => {
      await client.sql`UPDATE servers SET status = 'running' WHERE id = ${id}`;
      await manager.writeEnvValues(id, [
        { key: "JVM_OPTS", value: agent, isSecret: false },
        { key: "PASSWORD", value: "new-secret", isSecret: true },
      ]);
      await manager[action](id, null);
      expect(createdEnv).toEqual({ ...initialEnv, JVM_OPTS: agent, PASSWORD: "new-secret" });
      expect(createdSpec).toMatchObject({
        containerDataPath: "/data", cpuLimit: 1, memoryLimitMb: 2048,
        extraNetworks: ["citadel-link-test"],
        ports: [
          { hostPort: 25565, containerPort: 25565, protocol: "tcp" },
          { hostPort: 25565, containerPort: 25565, protocol: "udp" },
        ],
      });
      expect(calls).toEqual(["cancel-watch", "stop", "remove", "create", "plugins", "start", "watch", action === "startServer" ? "server.start" : "server.restart"]);
      const [row] = await client.sql`SELECT container_env_fingerprint,status FROM servers WHERE id = ${id}`;
      expect(row!.container_env_fingerprint).toBe(containerEnvFingerprint(createdEnv!, key));
      expect(row!.status).toBe("running");
      const [stored] = await client.sql`SELECT value FROM server_env WHERE server_id = ${id} AND key = 'PASSWORD'`;
      expect(stored!.value).not.toBe("new-secret");
      expect(crypto.decryptSecret(stored!.value)).toBe("new-secret");
    });

    test(`${action} reuses the container when settings have not changed`, async () => {
      await manager[action](id, null);
      expect(calls).toEqual(["plugins", action === "startServer" ? "start" : "restart", "watch", action === "startServer" ? "server.start" : "server.restart"]);
      expect(createdEnv).toBeUndefined();
    });
  }

  test("existing containers with unknown env refresh once", async () => {
    await client.sql`UPDATE servers SET container_env_fingerprint = NULL WHERE id = ${id}`;
    await manager.startServer(id, null);
    calls = [];
    await manager.restartServer(id, null);
    expect(calls).not.toContain("create");
    expect(calls).toContain("restart");
  });

  test("deleted settings disappear from the recreated env", async () => {
    await client.sql`DELETE FROM server_env WHERE server_id = ${id} AND key = 'JVM_OPTS'`;
    await manager.startServer(id, null);
    expect(createdEnv).not.toHaveProperty("JVM_OPTS");
  });

  test("failed recreation does not record an edit as applied or start the game", async () => {
    await manager.writeEnvValues(id, [{ key: "JVM_OPTS", value: agent, isSecret: false }]);
    failCreate = true;
    await expect(manager.restartServer(id, null)).rejects.toThrow("node create failed");
    const [row] = await client.sql`SELECT container_id,container_env_fingerprint,status FROM servers WHERE id = ${id}`;
    expect(row!.container_env_fingerprint).toBe(containerEnvFingerprint(initialEnv, key));
    expect(row!.container_id).toBeNull();
    expect(row!.status).toBe("error");
    expect(calls).not.toContain("start");
  });

  test("an edit saved during creation remains pending for the next restart", async () => {
    await manager.writeEnvValues(id, [{ key: "JVM_OPTS", value: agent, isSecret: false }]);
    duringCreate = async () => manager.writeEnvValues(id, [{ key: "JVM_OPTS", value: "-Dnew=value", isSecret: false }]);
    await manager.restartServer(id, null);
    expect(createdEnv!.JVM_OPTS).toBe(agent);
    duringCreate = undefined;
    await manager.restartServer(id, null);
    expect(createdEnv!.JVM_OPTS).toBe("-Dnew=value");
  });

  test("missing-container recovery still rebuilds and retries the start", async () => {
    missing = true;
    await manager.startServer(id, null);
    expect(calls).toEqual(["plugins", "start", "create", "start", "watch", "server.start"]);
    const [row] = await client.sql`SELECT container_env_fingerprint FROM servers WHERE id = ${id}`;
    expect(row!.container_env_fingerprint).toBe(containerEnvFingerprint(initialEnv, key));
  });

  test("a destination build fingerprints port overrides without marking the source applied", async () => {
    const built = await manager.buildServerContainerOn(id, nodeId, [{ port: 25566, isPrimary: true }], { SERVER_PORT: "25566" });
    expect(createdEnv).toEqual({ ...initialEnv, SERVER_PORT: "25566" });
    expect(built.envFingerprint).toBe(containerEnvFingerprint(createdEnv!, key));
    const [row] = await client.sql`SELECT container_env_fingerprint FROM servers WHERE id = ${id}`;
    expect(row!.container_env_fingerprint).toBe(containerEnvFingerprint(initialEnv, key));
  });

  test("environment refresh cannot start suspended or archived servers", async () => {
    for (const status of ["suspended", "archived", "migrating", "restoring", "archiving"]) {
      await client.sql`UPDATE servers SET status = ${status},container_env_fingerprint = NULL WHERE id = ${id}`;
      await expect(manager.startServer(id, null)).rejects.toBeInstanceOf(HttpError);
      await expect(manager.restartServer(id, null)).rejects.toBeInstanceOf(HttpError);
    }
    expect(calls).toEqual([]);
  });
});
