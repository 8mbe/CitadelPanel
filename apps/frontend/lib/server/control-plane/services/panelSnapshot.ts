import "server-only";

import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { TransactionSql } from "postgres";

import { invalidateSessionCache } from "../auth/sessionCache";
import { invalidateBlueprintCache } from "../blueprints/registry";
import { env } from "../config/env";
import { sql } from "../db/client";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { badRequest, conflict, HttpError } from "../lib/http";
import { invalidateNode } from "../nodes/nodeRegistry";
import { invalidateNodeConnection } from "../nodes/nodeApi";
import { invalidateSettingsCache } from "./settings";
import {
  openPanelSnapshot, previewPanelSnapshot, sealPanelSnapshot, SnapshotError,
  SNAPSHOT_TABLES, SNAPSHOT_TRANSIENT_TABLES, validatePanelSnapshot,
  transformSnapshotSecrets,
  type EncryptedPanelSnapshot, type PanelSnapshot, type PanelSnapshotPreview,
  type SnapshotColumn, type SnapshotRow, type SnapshotTable,
} from "./panelSnapshotFormat";

const RESTORE_TABLES = [...SNAPSHOT_TABLES, ...SNAPSHOT_TRANSIENT_TABLES];
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tableIdentifier = (name: string) => `"public".${quoteIdentifier(name)}`;
const qualifiedTables = RESTORE_TABLES.map(tableIdentifier).join(", ");

interface CatalogColumn {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
}

async function snapshotSchema(transaction: TransactionSql): Promise<Record<SnapshotTable, SnapshotColumn[]>> {
  const rows = await transaction<CatalogColumn[]>`
    SELECT table_name, column_name, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ${transaction([...SNAPSHOT_TABLES])}
    ORDER BY table_name, ordinal_position
  `;
  const result = {} as Record<SnapshotTable, SnapshotColumn[]>;
  for (const table of SNAPSHOT_TABLES) result[table] = [];
  for (const row of rows) {
    result[row.table_name as SnapshotTable].push({ name: row.column_name, type: row.udt_name, nullable: row.is_nullable === "YES" });
  }
  if (SNAPSHOT_TABLES.some(table => result[table].length === 0)) {
    throw conflict("The panel database schema is incomplete. Run the panel and auth migrations before exporting or importing.");
  }
  return result;
}

async function validateRestoreSchema(transaction: TransactionSql, snapshot: PanelSnapshot): Promise<void> {
  const current = await snapshotSchema(transaction);
  for (const table of SNAPSHOT_TABLES) {
    if (JSON.stringify(current[table]) !== JSON.stringify(snapshot.tables[table].columns)) {
      throw conflict("The export and destination use different database schemas. Restore using the same CitadelPanel version with all migrations applied.");
    }
  }
  // TRUNCATE has no CASCADE. Extensions that depend on these tables must never
  // disappear merely because an administrator imported a panel export.
  const references = await transaction<{ table_name: string }[]>`
    SELECT child.relname AS table_name
    FROM pg_constraint fk
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace parent_schema ON parent_schema.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
    WHERE fk.contype = 'f' AND parent_schema.nspname = 'public'
      AND parent.relname IN ${transaction(RESTORE_TABLES)}
      AND (child_schema.nspname <> 'public' OR child.relname NOT IN ${transaction(RESTORE_TABLES)})
  `;
  if (references.length > 0) throw conflict("Additional database tables depend on panel data. Use a PostgreSQL restore for this installation.");
}

async function assertEmptyDestination(transaction: TransactionSql): Promise<void> {
  const rows = await transaction<{ occupied: boolean; busy: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM servers) AS occupied,
      (EXISTS(SELECT 1 FROM backup_runs WHERE status IN ('pending', 'running'))
       OR EXISTS(SELECT 1 FROM server_migrations WHERE status IN ('pending', 'running', 'cancelling'))
       OR EXISTS(SELECT 1 FROM server_schedule_runs WHERE status = 'running')) AS busy
  `;
  if (rows[0]?.occupied) throw conflict("Import is only available on a panel with no registered servers. Restore into a fresh panel to keep existing server files safe.");
  if (rows[0]?.busy) throw conflict("Wait for this panel's active tasks to finish before importing.");
}

/** postgres.js preserves bigint/numeric as strings; normalize dates to JSON. */
export async function exportPanelSnapshot(passphrase: string): Promise<EncryptedPanelSnapshot> {
  const snapshot = await sql.begin("ISOLATION LEVEL REPEATABLE READ", async transaction => {
    await transaction`SET LOCAL lock_timeout = '5s'`;
    await transaction.unsafe(`LOCK TABLE ${qualifiedTables} IN SHARE MODE`);
    const columns = await snapshotSchema(transaction);
    const tables = {} as PanelSnapshot["tables"];
    for (const table of SNAPSHOT_TABLES) {
      const rows = await transaction.unsafe<SnapshotRow[]>(`SELECT * FROM ${tableIdentifier(table)}`);
      tables[table] = { columns: columns[table], rows: JSON.parse(JSON.stringify(rows)) as SnapshotRow[] };
    }
    return validatePanelSnapshot({ format: "citadel-panel-snapshot", version: 1, createdAt: new Date().toISOString(), tables });
  });
  try {
    // Plaintext exists only inside the passphrase-encrypted archive and memory.
    // Neither machine's boot secrets are included, so they can differ on restore.
    await transformSnapshotSecrets(snapshot, decryptSecret,
      data => symmetricDecrypt({ key: env.authSecret, data }));
    return await sealPanelSnapshot(snapshot, passphrase);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw conflict("Stored panel secrets could not be decrypted. Check the panel encryption keys before exporting.");
  }
}

export async function previewPanelImport(archive: unknown, passphrase: string): Promise<PanelSnapshotPreview> {
  const snapshot = await openPanelSnapshot(archive, passphrase);
  await sql.begin(async transaction => {
    await validateRestoreSchema(transaction, snapshot);
    await assertEmptyDestination(transaction);
  });
  return previewPanelSnapshot(snapshot);
}

async function insertTable(transaction: TransactionSql, table: SnapshotTable, columns: SnapshotColumn[], rows: SnapshotRow[]): Promise<void> {
  const names = columns.map(column => quoteIdentifier(column.name)).join(", ");
  const identifier = tableIdentifier(table);
  for (let offset = 0; offset < rows.length; offset += 250) {
    await transaction.unsafe(
      `INSERT INTO ${identifier} (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::${identifier}, $1::jsonb)`,
      [transaction.json(rows.slice(offset, offset + 250) as never)],
    );
  }
}

export async function importPanelSnapshot(archive: unknown, passphrase: string): Promise<PanelSnapshotPreview> {
  const snapshot = await openPanelSnapshot(archive, passphrase);
  const preview = previewPanelSnapshot(snapshot);
  await transformSnapshotSecrets(snapshot, encryptSecret,
    data => symmetricEncrypt({ key: env.authSecret, data }));
  const previousNodeIds: string[] = [];
  try {
    await sql.begin(async transaction => {
      await transaction`SET LOCAL lock_timeout = '5s'`;
      await transaction.unsafe(`LOCK TABLE ${qualifiedTables} IN ACCESS EXCLUSIVE MODE`);
      await validateRestoreSchema(transaction, snapshot);
      await assertEmptyDestination(transaction);
      const nodes = await transaction<{ id: string }[]>`SELECT id FROM nodes`;
      previousNodeIds.push(...nodes.map(node => node.id));
      await transaction.unsafe(`TRUNCATE TABLE ${qualifiedTables} RESTART IDENTITY`);
      for (const table of SNAPSHOT_TABLES) {
        // servers -> archive_run_id -> backup_runs -> servers is a real cycle.
        // Keep the snapshot pointer and reconnect the history once runs exist.
        const rows = table === "servers"
          ? snapshot.tables.servers.rows.map(row => ({ ...row, archive_run_id: null }))
          : snapshot.tables[table].rows;
        await insertTable(transaction, table, snapshot.tables[table].columns, rows);
      }
      for (const row of snapshot.tables.servers.rows) {
        if (row.archive_run_id !== null && row.archive_run_id !== undefined) {
          await transaction`UPDATE servers SET archive_run_id = ${String(row.archive_run_id)} WHERE id = ${String(row.id)}`;
        }
      }
      // Imported log ids must not make the next serial allocation collide.
      for (const table of ["backup_run_logs", "server_migration_logs"] as const) {
        await transaction.unsafe(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${tableIdentifier(table)}`,
          [`public.${table}`],
        );
      }
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "55P03" || code === "40P01") throw conflict("The panel is busy. Wait for current requests to finish and retry the import.");
    // Database exceptions can contain imported values. Do not log them or put
    // their SQL detail into a response, even when the whole transaction rolls back.
    throw badRequest("The export failed database validation. No panel data changed. Use an unmodified export from the same CitadelPanel version.");
  }
  for (const id of [...previousNodeIds, ...snapshot.tables.nodes.rows.map(row => String(row.id))]) {
    invalidateNode(id);
    invalidateNodeConnection(id);
  }
  invalidateSettingsCache();
  invalidateBlueprintCache();
  invalidateSessionCache();
  return preview;
}
