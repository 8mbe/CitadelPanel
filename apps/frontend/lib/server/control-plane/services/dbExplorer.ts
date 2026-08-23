/**
 * Database explorer service: the panel-side half of the per-server DB browser.
 *
 * Every operation is *structured*. The browser posts "create this table with
 * these columns" or "update this row", and this service turns it into SQL via
 * the pure builders in `dbExplorerSql.ts`, sends it to the node agent's
 * `/v1/servers/:id/database/query` endpoint, and parses the results. The
 * browser never sends SQL, and the statements run as the database's scoped
 * user (never the node's DB admin), so the blast radius of any bug here is one
 * database.
 *
 * Reads are not audited (matching files/console listing); every mutation is.
 */

import { sql } from "../db/client";
import { decryptSecret } from "../lib/crypto";
import { badRequest, notFound } from "../lib/http";
import { queryServerDatabase, type DbQueryResult } from "../nodes/nodeServerApi";
import { recordAudit } from "./auditLog";
import {
  SqlValidationError,
  assertSqlIdentifier,
  buildAddColumnSql,
  buildChangeColumnSql,
  buildCreateTableSql,
  buildDeleteRowSql,
  buildInsertRowSql,
  buildUpdateRowSql,
  isColumnDefaultKind,
  quoteIdent,
  validateColumnSpec,
  type ColumnSpecInput,
} from "./dbExplorerSql";

/** The row-level view of one provisioned database the explorer needs. */
interface ExplorerDatabaseRow {
  node_id: string;
  db_name: string;
  db_user: string;
  db_password_encrypted: string;
}

/**
 * Load the (server, database) pair and decrypt the scoped user's password.
 *
 * The database must belong to the server. The composite check is the
 * authorization boundary that stops one server's owner from querying another
 * server's database by id.
 */
async function loadExplorerDatabase(
  serverId: string,
  databaseId: string,
): Promise<ExplorerDatabaseRow> {
  const rows = (await sql`
    SELECT node_id, db_name, db_user, db_password_encrypted
    FROM server_databases
    WHERE id = ${databaseId} AND server_id = ${serverId}
  `) as ExplorerDatabaseRow[];
  const row = rows[0];
  if (!row) throw notFound("Database not found");

  return { ...row, db_password_encrypted: decryptSecret(row.db_password_encrypted) };
}

/**
 * Run one batch of composed SQL as the database's scoped user.
 *
 * SQL arrives as a thunk so builder validation (identifier shape, type rules)
 * happens inside this function. A `SqlValidationError` becomes a clean 400
 * here, the single place where the pure module's error type meets the HTTP
 * layer.
 */
async function runExplorerSql(
  serverId: string,
  databaseId: string,
  compose: () => string,
): Promise<DbQueryResult[]> {
  let statements: string;
  try {
    statements = compose();
  } catch (error) {
    if (error instanceof SqlValidationError) throw badRequest(error.message);
    throw error;
  }
  const db = await loadExplorerDatabase(serverId, databaseId);
  const { results } = await queryServerDatabase(
    db.node_id,
    serverId,
    db.db_name,
    db.db_user,
    db.db_password_encrypted,
    statements,
  );
  return results;
}

/** The first result of a read, which must exist (SHOW/SELECT always emit one). */
function firstResult(results: DbQueryResult[], what: string): DbQueryResult {
  const result = results[0];
  if (!result) throw badRequest(`The database returned no result for ${what}.`);
  return result;
}

/** A cell as a number, or null when the estimate is unavailable. */
function cellAsNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// --- Reads --------------------------------------------------------------------

/** One table in the database, as the sidebar lists it. */
export interface DbTableSummary {
  name: string;
  /** InnoDB's estimate from information_schema, exact enough for a browser. */
  rowsEstimate: number | null;
  sizeBytes: number | null;
  engine: string | null;
  comment: string | null;
}

/**
 * List the database's tables. `DATABASE()` resolves to the one database the
 * scoped user can see (the agent preselects it), so no schema name is ever
 * interpolated here.
 */
export async function listExplorerTables(
  serverId: string,
  databaseId: string,
): Promise<DbTableSummary[]> {
  const results = await runExplorerSql(
    serverId,
    databaseId,
    () =>
      "SELECT TABLE_NAME AS name, TABLE_ROWS AS rows_estimate, " +
      "(DATA_LENGTH + INDEX_LENGTH) AS size_bytes, ENGINE AS engine, TABLE_COMMENT AS comment " +
      "FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' " +
      "ORDER BY TABLE_NAME",
  );
  const rows = firstResult(results, "table list").rows;
  return rows.map((row) => ({
    name: row[0] ?? "",
    rowsEstimate: cellAsNumber(row[1]),
    sizeBytes: cellAsNumber(row[2]),
    engine: row[3],
    comment: row[4] === "" ? null : row[4],
  }));
}

/** One column of a table, as `SHOW FULL COLUMNS` reports it. */
export interface DbColumnSchema {
  name: string;
  /** The full type text, e.g. "varchar(255)" or "int unsigned". */
  type: string;
  nullable: boolean;
  /** "PRI", "UNI", "MUL" or null when the column is unkeyed. */
  keyType: string | null;
  defaultValue: string | null;
  /** e.g. "auto_increment", "on update CURRENT_TIMESTAMP". */
  extra: string | null;
  comment: string | null;
}

/** A table's columns plus its primary key column names (in index order). */
export interface DbTableSchema {
  columns: DbColumnSchema[];
  primaryKey: string[];
}

/**
 * A table's structure. The primary key drives row identity for edit/delete and
 * the deterministic pagination order. `SHOW FULL COLUMNS` reports key
 * membership per column, and its row order matches the index column order.
 */
export async function getExplorerTableSchema(
  serverId: string,
  databaseId: string,
  table: string,
): Promise<DbTableSchema> {
  const results = await runExplorerSql(
    serverId,
    databaseId,
    () => `SHOW FULL COLUMNS FROM ${quoteIdent(table)}`,
  );
  // SHOW FULL COLUMNS: Field, Type, Collation, Null, Key, Default, Extra,
  // Privileges, Comment.
  const columns = firstResult(results, "table schema").rows.map((row) => ({
    name: row[0] ?? "",
    type: row[1] ?? "",
    nullable: row[3] === "YES",
    keyType: row[4] === "" || row[4] === null ? null : row[4],
    defaultValue: row[5],
    extra: row[6] === "" || row[6] === null ? null : row[6],
    comment: row[8] === "" || row[8] === null ? null : row[8],
  }));
  return {
    columns,
    primaryKey: columns.filter((c) => c.keyType === "PRI").map((c) => c.name),
  };
}

/** Page bounds the explorer will serve; narrow enough to stay responsive. */
export const EXPLORER_MAX_PAGE = 200;

export interface ExplorerRowsPageInput {
  offset: number;
  limit: number;
}

/** One page of a table's rows plus the full-table count for pagination. */
export interface DbRowsPage {
  columns: string[];
  rows: (string | null)[][];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Read one page of rows, ordered by the primary key when the table has one
 * (keyless tables get the engine's natural order, and no row edit/delete in
 * the UI, since there is no stable row identity).
 *
 * The count and the page go out as two statements in one agent exec; the
 * mariadb client emits one resultset per statement.
 */
export async function readExplorerTableRows(
  serverId: string,
  databaseId: string,
  table: string,
  input: ExplorerRowsPageInput,
): Promise<DbRowsPage> {
  const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const limit =
    Number.isInteger(input.limit) && input.limit >= 1
      ? Math.min(input.limit, EXPLORER_MAX_PAGE)
      : 50;

  const schema = await getExplorerTableSchema(serverId, databaseId, table);
  const order = schema.primaryKey.length > 0
    ? ` ORDER BY ${schema.primaryKey.map(quoteIdent).join(", ")}`
    : "";

  const results = await runExplorerSql(
    serverId,
    databaseId,
    () =>
      `SELECT COUNT(*) AS total FROM ${quoteIdent(table)};` +
      `SELECT * FROM ${quoteIdent(table)}${order} LIMIT ${limit} OFFSET ${offset}`,
  );
  if (results.length < 2) {
    throw badRequest("The database returned no rows for the table page.");
  }
  const total = cellAsNumber(results[0]!.rows[0]?.[0] ?? null) ?? 0;
  return {
    columns: results[1]!.columns,
    rows: results[1]!.rows,
    total,
    offset,
    limit,
  };
}

// --- Mutations ----------------------------------------------------------------

export interface ExplorerActor {
  serverId: string;
  databaseId: string;
  actorId: string;
}

/** Audit an explorer mutation. Fire-and-forget inside `recordAudit` itself. */
function audit(
  actor: ExplorerActor,
  action: Parameters<typeof recordAudit>[0]["action"],
  metadata: Record<string, unknown>,
): Promise<void> {
  return recordAudit({
    userId: actor.actorId,
    action,
    targetType: "server",
    targetId: actor.serverId,
    // Row/column values are bounded to identifiers and pk snapshots; the
    // builder guarantees names are ≤64 chars.
    metadata: { databaseId: actor.databaseId, ...metadata },
  });
}

/**
 * Collect every column-spec problem before touching the database, so a bad
 * form submit is one 400 with all the reasons, not a partial DDL run.
 */
function assertValidColumns(columns: ColumnSpecInput[]): void {
  const errors = columns.flatMap((col) => validateColumnSpec(col));
  if (errors.length > 0) {
    throw badRequest(errors.join(" "), { errors });
  }
}

/** Parse one column spec from a JSON body (see routes/dbExplorer.ts). */
export function parseColumnSpecInput(value: unknown, what: string): ColumnSpecInput {
  if (typeof value !== "object" || value === null) {
    throw badRequest(`"${what}" must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.baseType !== "string") {
    throw badRequest(`"${what}" needs a name and a type.`);
  }
  const defaultKind = typeof raw.defaultKind === "string" ? raw.defaultKind : "none";
  if (!isColumnDefaultKind(defaultKind)) {
    throw badRequest(`"${what}" has an invalid defaultKind.`);
  }
  const spec: ColumnSpecInput = {
    name: raw.name.trim(),
    baseType: raw.baseType,
    length: typeof raw.length === "string" ? raw.length : undefined,
    unsigned: raw.unsigned === true,
    nullable: raw.nullable === true,
    autoIncrement: raw.autoIncrement === true,
    primaryKey: raw.primaryKey === true,
    defaultKind,
    defaultValue: typeof raw.defaultValue === "string" ? raw.defaultValue : undefined,
    comment: typeof raw.comment === "string" ? raw.comment : undefined,
  };
  if (spec.defaultKind === "literal" && spec.defaultValue === undefined) {
    spec.defaultValue = "";
  }
  const errors = validateColumnSpec(spec);
  if (errors.length > 0) {
    throw badRequest(`Invalid ${what}: ${errors.join(" ")}`, { errors });
  }
  return spec;
}

/**
 * Parse a row-values object: column name → string or null. Names are vetted
 * identifiers; values are hex-encoded by the builders, so any string content
 * is safe. This only shapes the JSON.
 */
export function parseRowValues(value: unknown, what: string): Record<string, string | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`"${what}" must be an object.`);
  }
  const out: Record<string, string | null> = {};
  for (const [column, cell] of Object.entries(value as Record<string, unknown>)) {
    assertSqlIdentifier(column, "column name");
    if (cell === null) {
      out[column] = null;
    } else if (typeof cell === "string") {
      out[column] = cell;
    } else {
      throw badRequest(`Value for column "${column}" must be a string or null.`);
    }
  }
  if (Object.keys(out).length === 0) {
    throw badRequest(`"${what}" must not be empty.`);
  }
  return out;
}

/** Create a table from validated column specs. */
export async function createExplorerTable(
  actor: ExplorerActor,
  table: string,
  columns: ColumnSpecInput[],
): Promise<void> {
  assertValidColumns(columns);
  await runExplorerSql(actor.serverId, actor.databaseId, () =>
    buildCreateTableSql(table, columns),
  );
  await audit(actor, "server.database.explorer.create_table", {
    table,
    columns: columns.map((c) => c.name),
  });
}

/** Drop a table (destructive; the UI confirms, the audit records it). */
export async function dropExplorerTable(
  actor: ExplorerActor,
  table: string,
): Promise<void> {
  await runExplorerSql(actor.serverId, actor.databaseId, () => `DROP TABLE ${quoteIdent(table)}`);
  await audit(actor, "server.database.explorer.drop_table", { table });
}

/** Add a column to a table. */
export async function addExplorerColumn(
  actor: ExplorerActor,
  table: string,
  column: ColumnSpecInput,
): Promise<void> {
  assertValidColumns([column]);
  await runExplorerSql(actor.serverId, actor.databaseId, () =>
    buildAddColumnSql(table, column),
  );
  await audit(actor, "server.database.explorer.add_column", { table, column: column.name });
}

/**
 * Edit a column. `CHANGE COLUMN` restates the whole definition (type,
 * nullability, default, auto-increment), so the form must prefill everything.
 * See the SQL builder for why an underfilled edit would silently strip attrs.
 */
export async function changeExplorerColumn(
  actor: ExplorerActor,
  table: string,
  fromName: string,
  column: ColumnSpecInput,
): Promise<void> {
  assertValidColumns([column]);
  await runExplorerSql(actor.serverId, actor.databaseId, () =>
    buildChangeColumnSql(table, fromName, column),
  );
  await audit(actor, "server.database.explorer.change_column", {
    table,
    from: fromName,
    to: column.name,
  });
}

/** Drop a column (destructive; the UI confirms). */
export async function dropExplorerColumn(
  actor: ExplorerActor,
  table: string,
  column: string,
): Promise<void> {
  await runExplorerSql(actor.serverId, actor.databaseId, () =>
    `ALTER TABLE ${quoteIdent(table)} DROP COLUMN ${quoteIdent(column)}`,
  );
  await audit(actor, "server.database.explorer.drop_column", { table, column });
}

/** Insert one row; values are hex-encoded strings or NULLs. */
export async function insertExplorerRow(
  actor: ExplorerActor,
  table: string,
  values: Record<string, string | null>,
): Promise<void> {
  await runExplorerSql(actor.serverId, actor.databaseId, () =>
    buildInsertRowSql(table, values),
  );
  await audit(actor, "server.database.explorer.insert_row", {
    table,
    columns: Object.keys(values),
  });
}

/** Update one row matched by its primary key. */
export async function updateExplorerRow(
  actor: ExplorerActor,
  table: string,
  pk: Record<string, string | null>,
  values: Record<string, string | null>,
): Promise<void> {
  await runExplorerSql(actor.serverId, actor.databaseId, () =>
    buildUpdateRowSql(table, pk, values),
  );
  await audit(actor, "server.database.explorer.update_row", {
    table,
    pk: truncatePk(pk),
    columns: Object.keys(values),
  });
}

/** Delete one row matched by its primary key (destructive; the UI confirms). */
export async function deleteExplorerRow(
  actor: ExplorerActor,
  table: string,
  pk: Record<string, string | null>,
): Promise<void> {
  await runExplorerSql(actor.serverId, actor.databaseId, () =>
    buildDeleteRowSql(table, pk),
  );
  await audit(actor, "server.database.explorer.delete_row", { table, pk: truncatePk(pk) });
}

/** Keep pk snapshots small in audit metadata. They identify, not replicate. */
function truncatePk(pk: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(pk).map(([column, value]) => [
      column,
      value === null ? null : value.slice(0, 100),
    ]),
  );
}
