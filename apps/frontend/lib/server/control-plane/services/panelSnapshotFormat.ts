import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export const SNAPSHOT_TABLES = [
  "user", "account", "twoFactor", "apikey", "panel_settings", "blueprints",
  "nodes", "node_port_pools", "servers", "server_ports", "server_env",
  "server_subusers", "server_databases", "sftp_credentials", "server_links",
  "server_plugins", "server_backup_repos", "node_backup_repos", "backup_runs",
  "backup_run_logs", "server_schedules", "server_schedule_tasks",
  "server_schedule_runs", "server_migrations", "server_migration_logs",
  "suspicious_activity", "audit_logs",
] as const;

export const SNAPSHOT_TRANSIENT_TABLES = ["session", "verification", "console_sessions"] as const;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 47 * 1024 * 1024;
export const MAX_SNAPSHOT_ROWS = 500_000;

export type SnapshotTable = typeof SNAPSHOT_TABLES[number];
export type SnapshotRow = Record<string, unknown>;
export interface SnapshotColumn {
  name: string;
  type: string;
  nullable: boolean;
}
export interface SnapshotTableData {
  columns: SnapshotColumn[];
  rows: SnapshotRow[];
}
export interface PanelSnapshot {
  format: "citadel-panel-snapshot";
  version: 1;
  createdAt: string;
  tables: Record<SnapshotTable, SnapshotTableData>;
}
export interface EncryptedPanelSnapshot {
  format: "citadel-panel-export";
  version: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt-N32768-r8-p1";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
export interface SnapshotCounts {
  users: number;
  nodes: number;
  servers: number;
  blueprints: number;
  settings: number;
  databases: number;
  schedules: number;
  apiKeys: number;
}
export interface PanelSnapshotPreview {
  createdAt: string;
  counts: SnapshotCounts;
  administratorEmails: string[];
  requiresSignIn: true;
}

export class SnapshotError extends Error {}

const AAD = Buffer.from("citadel-panel-export:1");

export function validateSnapshotPassphrase(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 1024) {
    throw new SnapshotError("Use an export passphrase between 12 and 1024 characters.");
  }
}

function deriveArchiveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || value.length > MAX_ARCHIVE_BYTES) {
    throw new SnapshotError("The export file is malformed or too large.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (length !== undefined && decoded.length !== length)) {
    throw new SnapshotError("The export file contains invalid encryption data.");
  }
  return decoded;
}

export async function sealPanelSnapshot(snapshot: PanelSnapshot, passphrase: string): Promise<EncryptedPanelSnapshot> {
  validateSnapshotPassphrase(passphrase);
  const data = Buffer.from(JSON.stringify(snapshot));
  if (data.length > MAX_SNAPSHOT_BYTES) throw new SnapshotError("Panel metadata exceeds the 47 MB export limit. Use a PostgreSQL backup for this panel.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveArchiveKey(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return {
      format: "citadel-panel-export", version: 1, cipher: "aes-256-gcm", kdf: "scrypt-N32768-r8-p1",
      salt: salt.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    key.fill(0);
    data.fill(0);
  }
}

export async function openPanelSnapshot(archive: unknown, passphrase: string): Promise<PanelSnapshot> {
  validateSnapshotPassphrase(passphrase);
  if (!object(archive) || archive.format !== "citadel-panel-export" || archive.version !== 1 ||
      archive.cipher !== "aes-256-gcm" || archive.kdf !== "scrypt-N32768-r8-p1") {
    throw new SnapshotError("This is not a supported CitadelPanel export file.");
  }
  if (Buffer.byteLength(JSON.stringify(archive)) > MAX_ARCHIVE_BYTES) throw new SnapshotError("Export files cannot exceed 64 MB.");
  const salt = decodeBase64(archive.salt, 16);
  const iv = decodeBase64(archive.iv, 12);
  const tag = decodeBase64(archive.tag, 16);
  const ciphertext = decodeBase64(archive.ciphertext);
  if (ciphertext.length > MAX_SNAPSHOT_BYTES) throw new SnapshotError("The export file is too large.");
  const key = await deriveArchiveKey(passphrase, salt);
  let data: Buffer | undefined;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    cipher.setAuthTag(tag);
    data = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
  } catch {
    throw new SnapshotError("The passphrase is incorrect or the export file has been damaged.");
  } finally {
    key.fill(0);
  }
  try {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    return validatePanelSnapshot(parsed);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("The export file contains invalid panel metadata.");
  } finally {
    data.fill(0);
  }
}

/** Only this closed table list can ever become SQL identifiers during restore. */
export function validatePanelSnapshot(value: unknown): PanelSnapshot {
  if (!object(value) || value.format !== "citadel-panel-snapshot" || value.version !== 1 ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !object(value.tables)) {
    throw new SnapshotError("The export file contains invalid panel metadata.");
  }
  const names = Object.keys(value.tables);
  if (names.length !== SNAPSHOT_TABLES.length || names.some(name => !(SNAPSHOT_TABLES as readonly string[]).includes(name))) {
    throw new SnapshotError("The export file has missing or unsupported database tables.");
  }
  let totalRows = 0;
  for (const name of SNAPSHOT_TABLES) {
    const table = value.tables[name];
    if (!object(table) || !Array.isArray(table.columns) || table.columns.length === 0 || table.columns.length > 100 || !Array.isArray(table.rows)) {
      throw new SnapshotError(`The export file has invalid ${name} data.`);
    }
    const columns = new Set<string>();
    for (const column of table.columns) {
      if (!object(column) || typeof column.name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column.name) ||
          typeof column.type !== "string" || typeof column.nullable !== "boolean" || columns.has(column.name)) {
        throw new SnapshotError(`The export file has invalid ${name} columns.`);
      }
      columns.add(column.name);
    }
    totalRows += table.rows.length;
    if (totalRows > MAX_SNAPSHOT_ROWS) throw new SnapshotError("The export file exceeds the 500,000 row limit.");
    for (const row of table.rows) {
      if (!object(row) || Object.keys(row).length !== columns.size || Object.keys(row).some(key => !columns.has(key))) {
        throw new SnapshotError(`The export file has invalid ${name} rows.`);
      }
    }
  }
  const snapshot = value as unknown as PanelSnapshot;
  assertSettledSnapshot(snapshot);
  if (snapshotAdministratorEmails(snapshot).length === 0) {
    throw new SnapshotError("The export must contain an active administrator with a password login.");
  }
  return snapshot;
}

export function assertSettledSnapshot(snapshot: PanelSnapshot): void {
  const settled = new Set(["stopped", "running", "suspended", "error", "archived"]);
  if (snapshot.tables.servers.rows.some(row => !settled.has(String(row.status))) ||
      snapshot.tables.backup_runs.rows.some(row => row.status === "pending" || row.status === "running") ||
      snapshot.tables.server_migrations.rows.some(row => ["pending", "running", "cancelling"].includes(String(row.status))) ||
      snapshot.tables.server_schedule_runs.rows.some(row => row.status === "running")) {
    throw new SnapshotError("Wait for server builds, power actions, backups, migrations, archives and scheduled tasks to finish before exporting or importing.");
  }
}

export function snapshotAdministratorEmails(snapshot: PanelSnapshot): string[] {
  const passwordUsers = new Set(snapshot.tables.account.rows.filter(row => row.providerId === "credential" && typeof row.password === "string" && row.password.length > 0).map(row => row.userId));
  return snapshot.tables.user.rows.filter(row => row.role === "admin" && typeof row.email === "string" &&
    (row.banned !== true || (typeof row.banExpires === "string" && Date.parse(row.banExpires) <= Date.now())) && passwordUsers.has(row.id))
    .map(row => row.email as string).sort();
}

export function previewPanelSnapshot(snapshot: PanelSnapshot): PanelSnapshotPreview {
  return {
    createdAt: snapshot.createdAt, requiresSignIn: true,
    administratorEmails: snapshotAdministratorEmails(snapshot),
    counts: {
      users: snapshot.tables.user.rows.length, nodes: snapshot.tables.nodes.rows.length,
      servers: snapshot.tables.servers.rows.length, blueprints: snapshot.tables.blueprints.rows.length,
      settings: snapshot.tables.panel_settings.rows.length, databases: snapshot.tables.server_databases.rows.length,
      schedules: snapshot.tables.server_schedules.rows.length, apiKeys: snapshot.tables.apikey.rows.length,
    },
  };
}

/** Transform only designated secret fields, never hashes or ordinary strings. */
export async function transformSnapshotSecrets(
  snapshot: PanelSnapshot,
  panelTransform: (value: string) => string | Promise<string>,
  authTransform: (value: string) => string | Promise<string>,
): Promise<void> {
  const columns: Partial<Record<SnapshotTable, string[]>> = {
    nodes: ["api_token_encrypted", "db_admin_password_encrypted"],
    server_databases: ["db_password_encrypted"],
    server_backup_repos: ["repo_password_encrypted"], node_backup_repos: ["repo_password_encrypted"],
  };
  const transform = async (row: SnapshotRow, key: string, fn: (value: string) => string | Promise<string>) => {
    if (row[key] !== null && row[key] !== undefined) {
      if (typeof row[key] !== "string") throw new SnapshotError("The export contains an invalid secret field.");
      row[key] = await fn(row[key]);
    }
  };
  for (const [name, keys] of Object.entries(columns)) {
    for (const row of snapshot.tables[name as SnapshotTable].rows) {
      for (const key of keys) await transform(row, key, panelTransform);
    }
  }
  for (const row of snapshot.tables.server_env.rows) if (row.is_secret === true) await transform(row, "value", panelTransform);
  for (const row of snapshot.tables.panel_settings.rows) {
    let stored = row.value;
    if (typeof stored === "string" && stored.startsWith("{")) {
      try { stored = JSON.parse(stored); } catch { /* Ordinary scalar settings stay intact. */ }
    }
    if (!object(stored)) continue;
    const settingKeys: Record<string, string[]> = {
      captcha: ["secretKeyEncrypted"], mail: ["smtpPasswordEncrypted", "resendApiKeyEncrypted"],
      ai: ["apiKeyEncrypted"], backups: ["secretAccessKeyEncrypted"],
    };
    for (const key of settingKeys[String(row.key)] ?? []) await transform(stored, key, panelTransform);
    row.value = stored;
  }
  for (const row of snapshot.tables.twoFactor.rows) {
    await transform(row, "secret", authTransform);
    await transform(row, "backupCodes", authTransform);
  }
}
