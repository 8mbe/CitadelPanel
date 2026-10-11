/** Run alone against a migrated disposable SERVER_MIGRATION_TEST_DATABASE_URL. */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const databaseUrl = process.env.SERVER_MIGRATION_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.includes("test")) {
  throw new Error("SERVER_MIGRATION_TEST_DATABASE_URL must name a disposable test database.");
}
const serverId = "11111111-2222-4333-8444-555555555555";
const actorId = "migration-admin";
const token = "migration-test-agent-token-000000000000000000";
let client: typeof import("../db/client");
let registry: typeof import("../nodes/nodeRegistry");
let settings: typeof import("./settings");
let migrations: typeof import("./serverMigration");
let backups: typeof import("./serverBackups");
let sourceAgent: ReturnType<typeof Bun.serve>;
let destinationAgent: ReturnType<typeof Bun.serve>;
let sourceId: string;
let destinationId: string;
let mode: "success" | "incomplete_snapshot" | "restore_unsettled" | "restore_pending" | "occupied" | "s3_unreachable" = "success";
let events: string[] = [];
let backupRequests: { exclude: string[]; requireComplete?: boolean; repo: unknown }[] = [];
let restoreSnapshot: string | undefined;
let sourceDeleted = false;
let destinationDeleted = false;
let built = false;
let capabilities = true;
let jobs = new Map<string, { kind: string; status: string; snapshotId?: string; error?: string }>();

if (databaseUrl) {
  mock.module("server-only", () => ({}));
  mock.module("../config/env", () => ({ env: {
    databaseUrl, encryptionKey: "migration-test-encryption-key-000000000000000", authSecret: "migration-test-auth-secret-000000000000000",
    frontendUrl: "http://localhost:3000", authBaseUrl: "http://localhost:3000", nodeEnv: "test", isProduction: false,
    nodeApiTimeoutMs: 1000, uploadMaxBytes: 1024, rateLimitEnabled: false,
  } }));
  mock.module("./serverManager", () => ({
    setStatus: async (id: string, status: string) => { await client.sql`UPDATE servers SET status = ${status}, updated_at = now() WHERE id = ${id}`; },
    storeEnv: async () => {},
    buildServerContainerOn: async () => { events.push("build"); built = true; return { containerId: "destination-container", envFingerprint: "test-fingerprint" }; },
  }));
  mock.module("./serverLinks", () => ({ rewireServerLinks: async () => [] }));
}

function agent(destination: boolean) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({}, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/v1/health") return Response.json({ status: "ok", snapshotMigration: capabilities, maintenance: false,
      dockerSocket: { reachable: true }, dataRoot: { writable: true }, disk: { freeBytes: 100_000_000_000 }, transferTools: true });
    if (path === "/v1/ports/free") {
      const body = await request.json() as { ports: object[] };
      return Response.json({ results: body.ports.map(port => ({ ...port, free: true })) });
    }
    if (path.endsWith("/transfer/size")) return Response.json({ sizeBytes: 100_000 });
    if (path === "/v1/backups/check") return Response.json({ reachable: mode !== "s3_unreachable", initialised: true, detail: mode === "s3_unreachable" ? "S3 unreachable" : "S3 reachable" });
    if (path.endsWith("/state")) return Response.json({ state: destination ? (built ? "created" : "missing") : "exited" });
    if (path.endsWith("/transfer/prepare")) {
      events.push("prepare");
      return mode === "occupied" ? Response.json({ error: "destination occupied" }, { status: 409 }) : Response.json({ prepared: true }, { status: 201 });
    }
    if (path.endsWith("/transfer/restore")) {
      const body = await request.json() as { snapshotId: string };
      restoreSnapshot = body.snapshotId;
      events.push("restore");
      const [row] = await client.sql`SELECT node_id, status FROM servers WHERE id = ${serverId}`;
      expect(row!.node_id).toBe(sourceId);
      expect(row!.status).toBe("migrating");
      jobs.set("restore", { kind: "restore", status: mode === "restore_unsettled" || mode === "restore_pending" ? "running" : "succeeded", snapshotId: body.snapshotId });
      return Response.json({ jobId: "restore" }, { status: 202 });
    }
    if (path.startsWith("/v1/backups/servers/")) {
      const body = await request.json() as typeof backupRequests[number];
      backupRequests.push(body);
      const id = `backup-${backupRequests.length}`;
      events.push(id);
      const incomplete = mode === "incomplete_snapshot" && body.requireComplete;
      jobs.set(id, { kind: "backup", status: incomplete ? "failed" : "succeeded", snapshotId: String(backupRequests.length).repeat(64), error: incomplete ? "snapshot skipped unreadable files" : undefined });
      return Response.json({ jobId: id }, { status: 202 });
    }
    if (path.startsWith("/v1/backups/jobs/")) {
      const id = path.split("/").at(-1)!;
      const job = jobs.get(id)!;
      if (id === "restore" && mode === "restore_unsettled") {
        // The reconciler can lose a run while its agent is still writing.
        await client.sql`UPDATE backup_runs SET status = 'failed', error = 'lost restore observation' WHERE job_id = ${id}`;
      }
      return Response.json({ id, subject: `server:${serverId}`, ...job, phase: "finished", percent: 100,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: job.error ?? null,
        result: { snapshotId: job.snapshotId, bytesProcessed: 100_000, bytesAdded: 100, repoSizeBytes: 100 }, logs: [], latestSeq: 0, droppedLines: 0 });
    }
    if (request.method === "DELETE" && path.endsWith("/container")) {
      events.push(destination ? "delete-destination" : "delete-source");
      if (destination) destinationDeleted = true;
      else {
        const [row] = await client.sql`SELECT node_id FROM servers WHERE id = ${serverId}`;
        expect(row!.node_id).toBe(destinationId);
        sourceDeleted = true;
      }
      return Response.json({ ok: true });
    }
    if (path.endsWith("/transfer/export")) {
      events.push("export");
      return new Response("tar bytes");
    }
    if (path.endsWith("/transfer/import")) {
      events.push("import");
      expect(await request.text()).toBe("tar bytes");
      return Response.json({ sizeBytes: 100_000 }, { status: 201 });
    }
    return Response.json({ error: `Unexpected test route ${request.method} ${path}` }, { status: 500 });
  } });
}

async function finish(existingId?: string) {
  const runId = existingId ?? (await migrations.startServerMigration({ serverId, destinationNodeId: destinationId, actorId, acknowledgeNoBackup: true })).id;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const current = await migrations.getServerMigration(serverId, runId);
    if (["succeeded", "failed", "cancelled"].includes(current.status)) return current;
    await Bun.sleep(10);
  }
  throw new Error("Test migration did not finish");
}

describe.skipIf(!databaseUrl)("S3 server migration PostgreSQL integration", () => {
  beforeAll(async () => {
    client = await import("../db/client");
    registry = await import("../nodes/nodeRegistry");
    settings = await import("./settings");
    migrations = await import("./serverMigration");
    backups = await import("./serverBackups");
    sourceAgent = agent(false);
    destinationAgent = agent(true);
  });
  beforeEach(async () => {
    for (const node of await registry.listNodes()) registry.invalidateNode(node.id);
    await client.sql.begin(async tx => {
      await tx.unsafe("SET LOCAL client_min_messages = warning");
      await tx.unsafe('TRUNCATE servers, nodes, "user" CASCADE');
    });
    settings.invalidateSettingsCache();
    (await import("../blueprints/registry")).invalidateBlueprintCache();
    events = []; backupRequests = []; restoreSnapshot = undefined; jobs = new Map();
    sourceDeleted = false; destinationDeleted = false; built = false; mode = "success"; capabilities = true;
    await client.sql`INSERT INTO "user" (id, name, email, role) VALUES (${actorId}, 'Admin', 'admin@example.test', 'admin')`;
    const source = await registry.createNode({ name: "Source", hostname: "source.test", apiUrl: sourceAgent.url.toString(), apiToken: token, cpuTotal: 8, memoryTotalMb: 16384, diskTotalMb: 65536 });
    const destination = await registry.createNode({ name: "Destination", hostname: "destination.test", apiUrl: destinationAgent.url.toString(), apiToken: token, cpuTotal: 8, memoryTotalMb: 16384, diskTotalMb: 65536 });
    sourceId = source.id; destinationId = destination.id;
    const [blueprint] = await client.sql`INSERT INTO blueprints (key, name, docker_image) VALUES ('migration-test', 'Game', 'game:test') ON CONFLICT (key) DO UPDATE SET name = 'Game' RETURNING id`;
    await client.sql`INSERT INTO servers (id, name, owner_id, node_id, blueprint_id, container_id, status, cpu_limit, memory_limit_mb, disk_limit_mb)
      VALUES (${serverId}, 'Survival', ${actorId}, ${sourceId}, ${blueprint!.id}, 'source-container', 'stopped', 1, 1024, 1024)`;
    await client.sql`INSERT INTO server_ports (server_id,node_id,host_port,container_port,is_primary) VALUES (${serverId},${sourceId},25565,25565,true)`;
    await client.sql`INSERT INTO node_port_pools (node_id,spec,ports) VALUES (${destinationId},'25565',${[25565]})`;
    await settings.setBackupSettings({ enabled: true, endpoint: "s3.test", bucket: "backups", accessKeyId: "test", secretAccessKey: "test-only", servers: { exclude: ["logs/**"], maxPerServer: 5 } }, actorId);
  });
  afterAll(async () => {
    await sourceAgent?.stop(true); await destinationAgent?.stop(true);
    await client?.sql.end(); await client?.authPool.end();
  });

  test("uses a complete stopped-source snapshot, restores on the destination, then cuts over", async () => {
    const result = await finish();
    expect(result.status).toBe("succeeded");
    expect(backupRequests[0]!.exclude).toEqual(["logs/**"]);
    expect(backupRequests[1]!.exclude).toEqual([]);
    expect(backupRequests[1]!.requireComplete).toBe(true);
    expect(restoreSnapshot).toBe("2".repeat(64));
    expect(sourceDeleted).toBe(true);
    expect(destinationDeleted).toBe(false);
    expect(events).toEqual(["backup-1", "backup-2", "prepare", "restore", "build", "delete-source"]);
    const [row] = await client.sql`SELECT node_id, status FROM servers WHERE id = ${serverId}`;
    expect(row!.node_id).toBe(destinationId);
    expect(row!.status).toBe("stopped");
  }, 15000);

  test("a snapshot with skipped files never starts a destination restore or loses the source", async () => {
    mode = "incomplete_snapshot";
    const result = await finish();
    expect(result.status).toBe("failed");
    expect(events).toEqual(["backup-1", "backup-2"]);
    expect(sourceDeleted).toBe(false);
    expect(destinationDeleted).toBe(false);
  }, 15000);

  test("rollback retains destination files while restic is still writing", async () => {
    mode = "restore_unsettled";
    const result = await finish();
    expect(result.status).toBe("failed");
    expect(result.rollback).toBe("partial");
    expect(sourceDeleted).toBe(false);
    expect(destinationDeleted).toBe(false);
    expect(events).not.toContain("build");
    const [row] = await client.sql`SELECT node_id, status FROM servers WHERE id = ${serverId}`;
    expect(row!.node_id).toBe(sourceId);
    expect(row!.status).toBe("stopped");
  }, 15000);

  test("an occupied destination is refused without deleting its existing files", async () => {
    mode = "occupied";
    expect((await finish()).status).toBe("failed");
    expect(sourceDeleted).toBe(false);
    expect(destinationDeleted).toBe(false);
    expect(events).not.toContain("restore");
  }, 15000);

  test("outdated agents are refused before stopping or snapshotting", async () => {
    capabilities = false;
    const preflight = await migrations.preflightMigration(serverId, destinationId);
    expect(preflight.canMigrate).toBe(false);
    expect(preflight.checks.find(check => check.id === "snapshot_transport")?.status).toBe("fail");
    expect(events).toEqual([]);
  });

  test("a destination that cannot reach S3 is refused before the source stops", async () => {
    mode = "s3_unreachable";
    const preflight = await migrations.preflightMigration(serverId, destinationId);
    expect(preflight.canMigrate).toBe(false);
    expect(preflight.checks.find(check => check.id === "s3_destination")?.status).toBe("fail");
    expect(events).toEqual([]);
  });

  test("ordinary backups, restores, and deletion cannot interfere with a migration", async () => {
    await client.sql`UPDATE servers SET status = 'migrating' WHERE id = ${serverId}`;
    await expect(backups.startServerBackup({ serverId, actorId, trigger: "manual" })).rejects.toThrow("being migrated");
    await expect(backups.startServerRestore({ serverId, actorId, runId: serverId })).rejects.toThrow("being migrated");
    await expect(backups.deleteServerBackup(serverId, serverId, actorId)).rejects.toThrow("being migrated");
    expect(await backups.listServersDueForBackup()).toEqual([]);
  });

  test("cancellation waits for the destination restore before removing its files", async () => {
    mode = "restore_pending";
    const run = await migrations.startServerMigration({ serverId, destinationNodeId: destinationId, actorId });
    for (let i = 0; i < 500 && !jobs.has("restore"); i++) await Bun.sleep(10);
    expect(jobs.has("restore")).toBe(true);
    await migrations.cancelServerMigration(serverId, run.id, actorId);
    await Bun.sleep(100);
    expect((await migrations.getServerMigration(serverId, run.id)).status).toBe("cancelling");
    expect(destinationDeleted).toBe(false);
    expect(sourceDeleted).toBe(false);
    const [waiting] = await client.sql`SELECT status FROM servers WHERE id = ${serverId}`;
    expect(waiting!.status).toBe("migrating");
    jobs.get("restore")!.status = "succeeded";
    const result = await finish(run.id);
    expect(result.status).toBe("cancelled");
    expect(result.rollback).toBe("restored");
    expect(destinationDeleted).toBe(true);
    expect(sourceDeleted).toBe(false);
    expect(events).not.toContain("build");
  }, 15000);

  test("without configured S3, acknowledgement enables direct streaming", async () => {
    await settings.setBackupSettings({ enabled: false }, actorId);
    const result = await finish();
    expect(result.status).toBe("succeeded");
    expect(backupRequests).toEqual([]);
    expect(restoreSnapshot).toBeUndefined();
    expect(events).toEqual(["prepare", "export", "import", "build", "delete-source"]);
  }, 15000);
});
