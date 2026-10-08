/**
 * Destructive only to an explicitly supplied, already-migrated test database.
 * PANEL_SNAPSHOT_TEST_DATABASE_URL=postgres://.../citadel_test bun test <this file>
 * Run this file in its own process: it intentionally changes its mocked boot keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins/two-factor";
import { hashPassword, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

import { openPanelSnapshot, sealPanelSnapshot, SNAPSHOT_TABLES, SNAPSHOT_TRANSIENT_TABLES, type EncryptedPanelSnapshot } from "./panelSnapshotFormat";

const testDatabaseUrl = process.env.PANEL_SNAPSHOT_TEST_DATABASE_URL;
if (testDatabaseUrl && !new URL(testDatabaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("PANEL_SNAPSHOT_TEST_DATABASE_URL must name a disposable test database.");
}
const boot = {
  databaseUrl: testDatabaseUrl ?? "", encryptionKey: "source-panel-test-key-00000000000000000000",
  authSecret: "source-auth-test-key-000000000000000000000", frontendUrl: "http://localhost:3000",
  authBaseUrl: "http://localhost:3000", nodeEnv: "test", isProduction: false,
  nodeApiTimeoutMs: 1000, uploadMaxBytes: 1024, rateLimitEnabled: false,
};
if (testDatabaseUrl) {
  mock.module("server-only", () => ({}));
  mock.module("../config/env", () => ({ env: boot }));
}

const ids = {
  node: "11111111-1111-4111-8111-111111111111", otherNode: "22222222-2222-4222-8222-222222222222",
  server: "33333333-3333-4333-8333-333333333333", archived: "44444444-4444-4444-8444-444444444444",
  backup: "55555555-5555-4555-8555-555555555555", schedule: "66666666-6666-4666-8666-666666666666",
  migration: "77777777-7777-4777-8777-777777777777",
};
const phrase = "portable panel export passphrase";
const accountPassword = "restored account password";
const highSerial = "9007199254740993";
let client: typeof import("../db/client");
let snapshots: typeof import("./panelSnapshot");
let crypto: typeof import("../lib/crypto");
let archive: EncryptedPanelSnapshot;
let targetAuthPool: Pool;

const qualifiedTables = [...SNAPSHOT_TABLES, ...SNAPSHOT_TRANSIENT_TABLES].map(table => `"public"."${table}"`).join(", ");

async function resetDatabase(): Promise<void> {
  await client.sql.unsafe(`TRUNCATE TABLE ${qualifiedTables} RESTART IDENTITY`);
}

async function insertAdmin(id = "temporary-admin", email = "temporary@example.test"): Promise<void> {
  await client.sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned)
    VALUES (${id}, ${id}, ${email}, true, now(), now(), 'admin', false)`;
  const password = await hashPassword(accountPassword);
  await client.sql`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
    VALUES (${`${id}-account`}, ${id}, 'credential', ${id}, ${password}, now(), now())`;
}

async function seedSource(): Promise<void> {
  await insertAdmin("source-admin", "source-admin@example.test");
  await insertAdmin("source-subuser", "source-subuser@example.test");
  await client.sql`UPDATE "user" SET role = 'user' WHERE id = 'source-subuser'`;
  await client.sql`UPDATE "user" SET "twoFactorEnabled" = true WHERE id = 'source-admin'`;
  await client.sql`INSERT INTO "twoFactor" (id, "userId", secret, "backupCodes", verified)
    VALUES ('factor', 'source-admin', ${await symmetricEncrypt({ key: boot.authSecret, data: "a-real-totp-secret-for-the-test" })},
      ${await symmetricEncrypt({ key: boot.authSecret, data: JSON.stringify(["ABCDE-FGHIJ", "KLMNO-PQRST"]) })}, true)`;
  await client.sql`INSERT INTO apikey (id, "configId", "referenceId", key, enabled, "createdAt", "updatedAt")
    VALUES ('api-key', 'default', 'source-admin', 'a-stored-api-key-hash', true, now(), now())`;
  await client.sql`INSERT INTO panel_settings (key, value, updated_by) VALUES
    ('branding', ${client.sql.json({ siteName: "Restored panel" })}, 'source-admin'),
    ('setup', ${client.sql.json({ completedAt: new Date().toISOString() })}, 'source-admin'),
    ('backups', ${client.sql.json({ secretAccessKeyEncrypted: crypto.encryptSecret("s3-secret"), enabled: false })}, 'source-admin')`;
  const blueprints = await client.sql`INSERT INTO blueprints (key,name,docker_image) VALUES ('test-game','Test game','test/game:1') RETURNING id`;
  const blueprint = String(blueprints[0]!.id);
  for (const [nodeId, name] of [[ids.node, "source-node"], [ids.otherNode, "other-node"]]) {
    await client.sql`INSERT INTO nodes (id,name,hostname,api_url,api_token_encrypted,db_admin_password_encrypted,cpu_total,memory_total_mb,disk_total_mb)
      VALUES (${nodeId!},${name!},'node.test','http://127.0.0.1:9',${crypto.encryptSecret("agent-token")},${crypto.encryptSecret("db-admin")},8,8192,65536)`;
  }
  await client.sql`INSERT INTO node_port_pools (node_id,spec,ports) VALUES (${ids.node},'25565-25566',ARRAY[25565,25566])`;
  for (const [serverId, name, status] of [[ids.server, "running-server", "running"], [ids.archived, "archived-server", "archived"]]) {
    await client.sql`INSERT INTO servers (id,name,owner_id,node_id,blueprint_id,status,cpu_limit,memory_limit_mb,disk_limit_mb)
      VALUES (${serverId!},${name!},'source-admin',${ids.node},${blueprint},${status!},1,1024,4096)`;
  }
  await client.sql`INSERT INTO server_ports (server_id,node_id,host_port,container_port,is_primary)
    VALUES (${ids.server},${ids.node},25565,25565,true),(${ids.archived},${ids.node},25566,25566,true)`;
  await client.sql`INSERT INTO server_env (server_id,key,value,is_secret) VALUES
    (${ids.server},'PASSWORD',${crypto.encryptSecret("server-secret")},true),(${ids.server},'SERVER_PORT','25565',false)`;
  await client.sql`INSERT INTO server_subusers (server_id,user_id,permissions,invited_by)
    VALUES (${ids.server},'source-subuser',${client.sql.json({ console: true, files: true })},'source-admin')`;
  await client.sql`INSERT INTO server_databases (server_id,node_id,db_name,db_user,db_password_encrypted,host,port)
    VALUES (${ids.server},${ids.node},'game_db','game_user',${crypto.encryptSecret("tenant-db-password")},'citadel-db',3306)`;
  await client.sql`INSERT INTO sftp_credentials (server_id,user_id,username,password_hash)
    VALUES (${ids.server},'source-admin','source-server','sftp-password-hash')`;
  await client.sql`INSERT INTO server_links (server_id,target_id,created_by) VALUES (${ids.server},${ids.archived},'source-admin')`;
  await client.sql`INSERT INTO server_plugins (server_id,provider,project_id,project_title,version_id,version_number,filename,installed_by)
    VALUES (${ids.server},'modrinth','test-project','Test plugin','version-id','1.0','plugin.jar','source-admin')`;
  await client.sql`INSERT INTO server_backup_repos (server_id,repo_password_encrypted) VALUES (${ids.archived},${crypto.encryptSecret("server-restic-password")})`;
  await client.sql`INSERT INTO node_backup_repos (node_id,repo_password_encrypted) VALUES (${ids.node},${crypto.encryptSecret("node-restic-password")})`;
  await client.sql`INSERT INTO backup_runs (id,scope,server_id,node_id,status,trigger,snapshot_id,requested_by)
    VALUES (${ids.backup},'server',${ids.archived},${ids.node},'succeeded','archive','only-archive-snapshot','source-admin')`;
  await client.sql`UPDATE servers SET archived_at=now(),archive_run_id=${ids.backup},archive_snapshot_id='only-archive-snapshot',archive_trigger='manual'
    WHERE id=${ids.archived}`;
  await client.sql`INSERT INTO backup_run_logs (id,run_id,seq,message) VALUES (${highSerial},${ids.backup},1,'Backup finished')`;
  await client.sql`INSERT INTO server_schedules (id,server_id,name,cron,created_by)
    VALUES (${ids.schedule},${ids.server},'Daily stop','0 4 * * *','source-admin')`;
  await client.sql`INSERT INTO server_schedule_tasks (schedule_id,position,action,payload) VALUES (${ids.schedule},0,'power.stop','{}')`;
  await client.sql`INSERT INTO server_schedule_runs (schedule_id,server_id,status,actor_id,finished_at)
    VALUES (${ids.schedule},${ids.server},'succeeded','source-admin',now())`;
  await client.sql`INSERT INTO server_migrations (id,server_id,source_node_id,destination_node_id,status,phase,backup_run_id,requested_by,finished_at)
    VALUES (${ids.migration},${ids.server},${ids.node},${ids.otherNode},'succeeded','finished',${ids.backup},'source-admin',now())`;
  await client.sql`INSERT INTO server_migration_logs (id,migration_id,seq,message) VALUES (${highSerial},${ids.migration},1,'Migration finished')`;
  await client.sql`INSERT INTO suspicious_activity (server_id,reason,score,reviewed_by) VALUES (${ids.server},'test',1,'source-admin')`;
  await client.sql`INSERT INTO audit_logs (user_id,action,target_type,target_id) VALUES ('source-admin','server.create','server',${ids.server})`;
  await client.sql`INSERT INTO session (id,token,"userId","expiresAt","createdAt","updatedAt")
    VALUES ('source-session','source-session-token','source-admin',now()+interval '1 day',now(),now())`;
  await client.sql`INSERT INTO verification (id,identifier,value,"expiresAt","createdAt","updatedAt")
    VALUES ('source-verification','email-code','must-not-travel',now()+interval '1 hour',now(),now())`;
  await client.sql`INSERT INTO console_sessions (token,server_id,node_id,user_id,expires_at)
    VALUES (${"88888888-8888-4888-8888-888888888888"},${ids.server},${ids.node},'source-admin',now()+interval '1 minute')`;
}

describe.skipIf(!testDatabaseUrl)("panel snapshot PostgreSQL integration", () => {
  beforeAll(async () => {
    client = await import("../db/client");
    crypto = await import("../lib/crypto");
    snapshots = await import("./panelSnapshot");
    targetAuthPool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    await resetDatabase();
    await seedSource();
    const actualTables = await client.sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
    expect(actualTables.map(row => row.table_name).sort()).toEqual([...SNAPSHOT_TABLES, ...SNAPSHOT_TRANSIENT_TABLES, "schema_migrations"].sort());
    archive = await snapshots.exportPanelSnapshot(phrase);
    // The destination is allowed to have different root encryption secrets.
    boot.encryptionKey = "target-panel-test-key-00000000000000000000";
    boot.authSecret = "target-auth-test-key-000000000000000000000";
  }, 15_000);

  beforeEach(async () => {
    await resetDatabase();
    await insertAdmin();
    await client.sql`INSERT INTO panel_settings (key,value) VALUES ('branding',${client.sql.json({ siteName: "Temporary panel" })})`;
    await client.sql`INSERT INTO session (id,token,"userId","expiresAt","createdAt","updatedAt")
      VALUES ('temporary-session','temporary-token','temporary-admin',now()+interval '1 day',now(),now())`;
  });

  afterAll(async () => {
    if (!client) return;
    await resetDatabase();
    await targetAuthPool.end();
    await client.authPool.end();
    await client.sql.end();
  });

  test("restores the full dependency graph with portable secrets, bigint ids, and archived snapshot pointers", async () => {
    const preview = await snapshots.previewPanelImport(archive, phrase);
    expect(preview.administratorEmails).toEqual(["source-admin@example.test"]);
    expect(preview.counts).toMatchObject({ users: 2, nodes: 2, servers: 2, databases: 1, schedules: 1, apiKeys: 1 });
    await snapshots.importPanelSnapshot(archive, phrase);
    const restored = await openPanelSnapshot(await snapshots.exportPanelSnapshot(phrase), phrase);
    const original = await openPanelSnapshot(archive, phrase);
    for (const table of SNAPSHOT_TABLES) {
      const sort = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
      expect(sort(restored.tables[table].rows)).toEqual(sort(original.tables[table].rows));
    }
    const archived = await client.sql`SELECT archive_run_id,archive_snapshot_id,status FROM servers WHERE id=${ids.archived}`;
    expect(archived[0]).toMatchObject({ archive_run_id: ids.backup, archive_snapshot_id: "only-archive-snapshot", status: "archived" });
    const node = await client.sql`SELECT api_token_encrypted FROM nodes WHERE id=${ids.node}`;
    expect(crypto.decryptSecret(String(node[0]!.api_token_encrypted))).toBe("agent-token");
    for (const table of SNAPSHOT_TRANSIENT_TABLES) {
      const count = await client.sql.unsafe(`SELECT COUNT(*)::int AS count FROM "${table}"`);
      expect(count[0]!.count).toBe(0);
    }
    const nextBackup = await client.sql`INSERT INTO backup_run_logs (run_id,seq,message) VALUES (${ids.backup},2,'Another line') RETURNING id`;
    expect(nextBackup[0]!.id).toBe("9007199254740994");
    const nextMigration = await client.sql`INSERT INTO server_migration_logs (migration_id,seq,message) VALUES (${ids.migration},2,'Another line') RETURNING id`;
    expect(nextMigration[0]!.id).toBe("9007199254740994");
  }, 15_000);

  test("the imported administrator signs in using its password and a two-factor backup code with new auth keys", async () => {
    await snapshots.importPanelSnapshot(archive, phrase);
    const factor = await client.sql`SELECT secret,"backupCodes" FROM "twoFactor" WHERE id='factor'`;
    expect(await symmetricDecrypt({ key: boot.authSecret, data: String(factor[0]!.secret) })).toBe("a-real-totp-secret-for-the-test");
    const auth = betterAuth({ database: targetAuthPool, secret: boot.authSecret, baseURL: boot.frontendUrl,
      emailAndPassword: { enabled: true }, plugins: [twoFactor({ issuer: "CitadelPanel" })], rateLimit: { enabled: false } });
    const login = await auth.api.signInEmail({ body: { email: "source-admin@example.test", password: accountPassword }, asResponse: true });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
    const cookies = login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    const complete = await auth.api.verifyBackupCode({ body: { code: "ABCDE-FGHIJ" }, headers: new Headers({ cookie: cookies }), asResponse: true });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ user: { id: "source-admin" } });
  }, 15_000);

  test("wrong passphrase, incompatible columns and invalid foreign keys leave the destination intact", async () => {
    await expect(snapshots.importPanelSnapshot(archive, "a-wrong-archive-passphrase")).rejects.toThrow("incorrect or");
    const incompatible = await openPanelSnapshot(archive, phrase);
    incompatible.tables.nodes.columns[0]!.type = "int4";
    await expect(snapshots.importPanelSnapshot(await sealPanelSnapshot(incompatible, phrase), phrase)).rejects.toThrow("different database schemas");
    const invalid = await openPanelSnapshot(archive, phrase);
    invalid.tables.servers.rows[0]!.owner_id = "missing-user";
    await expect(snapshots.importPanelSnapshot(await sealPanelSnapshot(invalid, phrase), phrase)).rejects.toThrow("No panel data changed");
    const users = await client.sql`SELECT id FROM "user"`;
    expect(users.map(row => row.id)).toEqual(["temporary-admin"]);
    const settings = await client.sql`SELECT value FROM panel_settings WHERE key='branding'`;
    expect(settings[0]!.value).toEqual({ siteName: "Temporary panel" });
    const sessions = await client.sql`SELECT id FROM session`;
    expect(sessions.map(row => row.id)).toEqual(["temporary-session"]);
  }, 15_000);

  test("refuses replacing a destination with servers and does not truncate extension tables", async () => {
    await snapshots.importPanelSnapshot(archive, phrase);
    await expect(snapshots.importPanelSnapshot(archive, phrase)).rejects.toThrow("no registered servers");
    expect((await client.sql`SELECT COUNT(*)::int AS count FROM servers`)[0]!.count).toBe(2);
    await resetDatabase();
    await insertAdmin();
    await client.sql`CREATE TABLE snapshot_test_extension (user_id TEXT REFERENCES "user"(id))`;
    try {
      await expect(snapshots.importPanelSnapshot(archive, phrase)).rejects.toThrow("Additional database tables");
      expect((await client.sql`SELECT id FROM "user"`)[0]!.id).toBe("temporary-admin");
    } finally {
      await client.sql`DROP TABLE snapshot_test_extension`;
    }
  }, 15_000);

  test("snapshot endpoints require a browser admin and explicit replacement confirmation", async () => {
    const handlers = await import("../routes/panelSnapshot");
    const keyRequest = new Request("http://localhost:3000/api/admin/settings/export", {
      method: "POST", headers: { "x-api-key": "an-admin-api-key", "content-type": "application/json" },
      body: JSON.stringify({ passphrase: phrase }),
    });
    await expect(handlers.handlePanelExport(keyRequest)).rejects.toThrow("API keys cannot");
    const auth = betterAuth({ database: targetAuthPool, secret: boot.authSecret, baseURL: boot.frontendUrl,
      emailAndPassword: { enabled: true }, rateLimit: { enabled: false } });
    const login = await auth.api.signInEmail({ body: { email: "temporary@example.test", password: accountPassword }, asResponse: true });
    const cookies = login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    const request = (path: string, body: unknown) => new Request(`http://localhost:3000/api/admin/settings/${path}`, {
      method: "POST", headers: { cookie: cookies, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const download = await handlers.handlePanelExport(request("export", { passphrase: phrase }));
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect((await download.json()).format).toBe("citadel-panel-export");
    const preview = await handlers.handlePanelImportPreview(request("import/preview", { passphrase: phrase, archive }));
    expect((await preview.json()).administratorEmails).toEqual(["source-admin@example.test"]);
    await expect(handlers.handlePanelImport(request("import", { passphrase: phrase, archive, confirmation: "wrong" }))).rejects.toThrow("REPLACE PANEL");
    expect((await client.sql`SELECT id FROM "user"`)[0]!.id).toBe("temporary-admin");
  }, 15_000);

  test("a stale cached cookie cannot authorize after import even when its user id survives", async () => {
    const { getAuthenticatedUser } = await import("../auth/middleware");
    const { sessionCacheKey, writeSessionCache } = await import("../auth/sessionCache");
    await resetDatabase();
    await insertAdmin("source-admin", "source-admin@example.test");
    await client.sql`INSERT INTO session (id,token,"userId","expiresAt","createdAt","updatedAt")
      VALUES ('old-session','old-session-token','source-admin',now()+interval '1 day',now(),now())`;
    const request = new Request("http://localhost:3000/api/me", {
      headers: { cookie: "better-auth.session_token=old-cached-cookie" },
    });
    const cacheKey = sessionCacheKey(request.headers);
    const identity = {
      sessionId: "old-session", id: "source-admin", email: "source-admin@example.test",
      sessionRole: "admin", apiKey: null,
    };
    writeSessionCache(cacheKey, identity);
    expect(await getAuthenticatedUser(request)).toEqual({ id: "source-admin", email: "source-admin@example.test", role: "admin" });
    await snapshots.importPanelSnapshot(archive, phrase);
    expect((await client.sql`SELECT id FROM "user" WHERE id='source-admin'`)[0]!.id).toBe("source-admin");
    expect((await client.sql`SELECT COUNT(*)::int AS count FROM session`)[0]!.count).toBe(0);
    // Another worker, or Better Auth's signed browser cache, can still supply
    // this pre-import identity. The durable database check must reject it.
    writeSessionCache(cacheKey, identity);
    await expect(getAuthenticatedUser(request)).rejects.toMatchObject({ status: 401 });
  }, 15_000);

  test("cached API-key identities lose access immediately when their key is disabled or deleted", async () => {
    const { getAuthenticatedUser } = await import("../auth/middleware");
    const { sessionCacheKey, writeSessionCache } = await import("../auth/sessionCache");
    await client.sql`INSERT INTO apikey (id,"configId","referenceId",key,enabled,"createdAt","updatedAt")
      VALUES ('cached-key','default','temporary-admin','test-only-key-hash',true,now(),now())`;
    const request = new Request("http://localhost:3000/api/me", { headers: { "x-api-key": "test-only-cached-key" } });
    const cacheKey = sessionCacheKey(request.headers);
    const identity = {
      sessionId: "cached-key", id: "temporary-admin", email: "temporary@example.test", sessionRole: "admin",
      apiKey: { id: "cached-key", scopes: null },
    };
    writeSessionCache(cacheKey, identity);
    expect(await getAuthenticatedUser(request)).toMatchObject({ id: "temporary-admin", role: "admin" });
    await client.sql`UPDATE apikey SET enabled=false WHERE id='cached-key'`;
    await expect(getAuthenticatedUser(request)).rejects.toMatchObject({ status: 401 });
    await client.sql`DELETE FROM apikey WHERE id='cached-key'`;
    writeSessionCache(cacheKey, identity);
    await expect(getAuthenticatedUser(request)).rejects.toMatchObject({ status: 401 });
  });
});
