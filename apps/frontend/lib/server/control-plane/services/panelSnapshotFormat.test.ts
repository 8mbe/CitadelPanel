import { describe, expect, test } from "bun:test";

import {
  openPanelSnapshot, previewPanelSnapshot, sealPanelSnapshot, SNAPSHOT_TABLES,
  transformSnapshotSecrets, validatePanelSnapshot, validateSnapshotPassphrase,
  type PanelSnapshot, type SnapshotRow, type SnapshotTable,
} from "./panelSnapshotFormat";

function fixture(): PanelSnapshot {
  const tables = {} as PanelSnapshot["tables"];
  for (const name of SNAPSHOT_TABLES) tables[name] = { columns: [{ name: "id", type: "text", nullable: false }], rows: [] };
  const snapshot: PanelSnapshot = { format: "citadel-panel-snapshot", version: 1, createdAt: "2026-10-08T12:00:00.000Z", tables };
  put(snapshot, "user", [{ id: "admin", role: "admin", email: "admin@example.test", banned: false, banExpires: null }]);
  put(snapshot, "account", [{ id: "account", userId: "admin", providerId: "credential", password: "a-password-hash" }]);
  return snapshot;
}

function put(snapshot: PanelSnapshot, name: SnapshotTable, rows: SnapshotRow[]): void {
  snapshot.tables[name] = {
    columns: Object.keys(rows[0]!).map(key => ({ name: key, type: "text", nullable: true })), rows,
  };
}

const passphrase = "an export password with spaces";

describe("encrypted panel export", () => {
  test("round trip preserves metadata while secrets do not appear in the download", async () => {
    const snapshot = fixture();
    put(snapshot, "nodes", [{ id: "node", api_token_encrypted: "root-equivalent-node-token" }]);
    const sealed = await sealPanelSnapshot(snapshot, passphrase);
    expect(JSON.stringify(sealed)).not.toContain("root-equivalent-node-token");
    expect(JSON.stringify(sealed)).not.toContain("admin@example.test");
    expect(await openPanelSnapshot(sealed, passphrase)).toEqual(snapshot);
  });

  test("wrong passphrase and altered ciphertext fail authentication", async () => {
    const sealed = await sealPanelSnapshot(fixture(), passphrase);
    await expect(openPanelSnapshot(sealed, "a different export password")).rejects.toThrow("incorrect or");
    const changed = Buffer.from(sealed.ciphertext, "base64");
    changed[0] = changed[0]! ^ 1;
    await expect(openPanelSnapshot({ ...sealed, ciphertext: changed.toString("base64") }, passphrase)).rejects.toThrow("incorrect or");
  });

  test("fresh salt and nonce make two exports different", async () => {
    const first = await sealPanelSnapshot(fixture(), passphrase);
    const second = await sealPanelSnapshot(fixture(), passphrase);
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  test("rejects unsupported encryption and malformed base64 before deriving a key", async () => {
    const sealed = await sealPanelSnapshot(fixture(), passphrase);
    await expect(openPanelSnapshot({ ...sealed, kdf: "an-unbounded-kdf" }, passphrase)).rejects.toThrow("supported");
    await expect(openPanelSnapshot({ ...sealed, salt: "!!!!" }, passphrase)).rejects.toThrow("invalid encryption");
    await expect(openPanelSnapshot({ ...sealed, tag: "" }, passphrase)).rejects.toThrow("invalid encryption");
  });

  test("passphrases have a minimum and retain intentional spaces", async () => {
    expect(() => validateSnapshotPassphrase("too-short")).toThrow("12");
    const sealed = await sealPanelSnapshot(fixture(), ` ${passphrase} `);
    await expect(openPanelSnapshot(sealed, passphrase)).rejects.toThrow("incorrect or");
    expect(await openPanelSnapshot(sealed, ` ${passphrase} `)).toEqual(fixture());
  });
});

describe("snapshot restore validation", () => {
  test("rejects arbitrary table names, missing tables and row columns", () => {
    const extra = fixture();
    (extra.tables as Record<string, unknown>)["user; DROP TABLE user"] = { columns: [], rows: [] };
    expect(() => validatePanelSnapshot(extra)).toThrow("unsupported database tables");
    const missing = fixture();
    delete (missing.tables as Partial<PanelSnapshot["tables"]>).servers;
    expect(() => validatePanelSnapshot(missing)).toThrow("missing");
    const column = fixture();
    column.tables.user.rows[0]!.unexpected = true;
    expect(() => validatePanelSnapshot(column)).toThrow("invalid user rows");
  });

  test("requires a usable imported admin login and previews its account", () => {
    expect(previewPanelSnapshot(validatePanelSnapshot(fixture())).administratorEmails).toEqual(["admin@example.test"]);
    const snapshot = fixture();
    snapshot.tables.user.rows[0]!.banned = true;
    expect(() => validatePanelSnapshot(snapshot)).toThrow("active administrator");
    snapshot.tables.user.rows[0]!.banned = false;
    snapshot.tables.account.rows[0]!.password = null;
    expect(() => validatePanelSnapshot(snapshot)).toThrow("password login");
  });

  test("refuses unfinished lifecycle work while preserving archived servers", () => {
    const snapshot = fixture();
    put(snapshot, "servers", [{ id: "server", status: "archived", archive_snapshot_id: "the-only-copy", archive_run_id: "run" }]);
    expect(validatePanelSnapshot(snapshot).tables.servers.rows[0]!.archive_snapshot_id).toBe("the-only-copy");
    snapshot.tables.servers.rows[0]!.status = "migrating";
    expect(() => validatePanelSnapshot(snapshot)).toThrow("finish");
    snapshot.tables.servers.rows[0]!.status = "running";
    put(snapshot, "backup_runs", [{ id: "run", status: "running" }]);
    expect(() => validatePanelSnapshot(snapshot)).toThrow("finish");
  });
});

describe("portable secret conversion", () => {
  test("reencrypts all designated credentials and leaves password hashes and public values intact", async () => {
    const snapshot = fixture();
    put(snapshot, "nodes", [{ id: "node", api_token_encrypted: "source(node-token)", db_admin_password_encrypted: "source(db-admin)" }]);
    put(snapshot, "server_env", [{ server_id: "server", key: "PASSWORD", value: "source(game-secret)", is_secret: true }, { server_id: "server", key: "PLAIN", value: "public", is_secret: false }]);
    put(snapshot, "server_databases", [{ id: "db", db_password_encrypted: "source(db-password)" }]);
    put(snapshot, "server_backup_repos", [{ server_id: "server", repo_password_encrypted: "source(restic-server)" }]);
    put(snapshot, "node_backup_repos", [{ node_id: "node", repo_password_encrypted: "source(restic-node)" }]);
    put(snapshot, "twoFactor", [{ id: "2fa", secret: "source(totp)", backupCodes: "source(codes)", userId: "admin" }]);
    put(snapshot, "panel_settings", [
      { key: "captcha", value: { secretKeyEncrypted: "source(captcha)", siteKey: "public-site-key" } },
      { key: "mail", value: { smtpPasswordEncrypted: "source(smtp)", resendApiKeyEncrypted: null } },
      { key: "ai", value: { apiKeyEncrypted: "source(ai)" } },
      { key: "backups", value: { secretAccessKeyEncrypted: "source(s3)" } },
      { key: "timezone", value: "UTC" },
    ]);
    const decrypt = (value: string) => value.slice(7, -1);
    await transformSnapshotSecrets(snapshot, decrypt, decrypt);
    const encrypt = (value: string) => `target(${value})`;
    await transformSnapshotSecrets(snapshot, encrypt, encrypt);
    expect(snapshot.tables.nodes.rows[0]!.api_token_encrypted).toBe("target(node-token)");
    expect(snapshot.tables.nodes.rows[0]!.db_admin_password_encrypted).toBe("target(db-admin)");
    expect(snapshot.tables.server_env.rows.map(row => row.value)).toEqual(["target(game-secret)", "public"]);
    expect(snapshot.tables.twoFactor.rows[0]!.secret).toBe("target(totp)");
    expect(snapshot.tables.twoFactor.rows[0]!.backupCodes).toBe("target(codes)");
    expect(snapshot.tables.account.rows[0]!.password).toBe("a-password-hash");
    expect(snapshot.tables.panel_settings.rows[0]!.value).toEqual({ secretKeyEncrypted: "target(captcha)", siteKey: "public-site-key" });
    expect(snapshot.tables.panel_settings.rows[1]!.value).toEqual({ smtpPasswordEncrypted: "target(smtp)", resendApiKeyEncrypted: null });
    expect(snapshot.tables.panel_settings.rows[4]!.value).toBe("UTC");
    expect(snapshot.tables.server_databases.rows[0]!.db_password_encrypted).toBe("target(db-password)");
    expect(snapshot.tables.server_backup_repos.rows[0]!.repo_password_encrypted).toBe("target(restic-server)");
    expect(snapshot.tables.node_backup_repos.rows[0]!.repo_password_encrypted).toBe("target(restic-node)");
  });

  test("empty secret values are encrypted again and double-encoded settings are normalized", async () => {
    const snapshot = fixture();
    put(snapshot, "server_env", [{ server_id: "server", key: "EMPTY", value: "", is_secret: true }]);
    put(snapshot, "panel_settings", [{ key: "ai", value: JSON.stringify({ apiKeyEncrypted: "key" }) }]);
    await transformSnapshotSecrets(snapshot, value => `encrypted(${value})`, value => value);
    expect(snapshot.tables.server_env.rows[0]!.value).toBe("encrypted()");
    expect(snapshot.tables.panel_settings.rows[0]!.value).toEqual({ apiKeyEncrypted: "encrypted(key)" });
  });
});
