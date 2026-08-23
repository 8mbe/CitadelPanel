/**
 * SQL composition for the database explorer. Pure, no I/O, heavily tested.
 *
 * The explorer never lets the browser send SQL. The UI posts structured
 * operations (create this table, update this row, …) and *this module* compiles
 * them to MariaDB statements under three rules that make injection impossible:
 *
 *   1. Every identifier (table/column name) must match a strict backtick-safe
 *      shape before it is ever interpolated. `assertSqlIdentifier` is the gate.
 *   2. Every data value is encoded as a hex literal wrapped in CAST
 *      (`CAST(x'…' AS CHAR)`), which contains no characters MySQL parses, so
 *      quoting/sql_mode cannot be subverted. MariaDB coerces the resulting
 *      string against the column's real type on INSERT/UPDATE.
 *   3. Column types come from a fixed allowlist the UI's dropdown is built
 *      from, optionally parameterized with a digits-only length. The form never
 *      sends free-form SQL type syntax.
 *
 * One place needs a quoted literal: DDL `DEFAULT` and `COMMENT`, where MySQL
 * requires a literal rather than an expression. That path uses
 * `quoteStringLiteral`, which escapes both `'` and `\`.
 *
 * Even if all of this failed, the statements run as the database's scoped
 * user, whose grants cover exactly that one database, but the panel still
 * validates everything itself rather than leaning on that backstop.
 */

/**
 * A validation failure in composed SQL. The module stays dependency-free so it
 * can be unit-tested directly (`bun test`, no Next.js runtime); the service
 * layer maps this to a 400 `HttpError` at its boundary.
 */
export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlValidationError";
  }
}

/**
 * A backtick-safe MariaDB identifier: starts with a letter or underscore, then
 * letters/digits/`$`/`_`, at most 64 chars (MariaDB's limit).
 */
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;

/** Reject any identifier that is not backtick-safe, with a readable error. */
export function assertSqlIdentifier(value: string, what: string): string {
  if (!SQL_IDENTIFIER_RE.test(value)) {
    throw new SqlValidationError(
      `Invalid ${what} "${value.slice(0, 64)}". Must start with a letter or ` +
        "underscore and contain only letters, digits, underscores, and $.",
    );
  }
  return value;
}

/** Backtick-quote an identifier, after vetting its shape. */
export function quoteIdent(value: string): string {
  return "`" + assertSqlIdentifier(value, "identifier") + "`";
}

/**
 * Encode a value as a hex literal cast to CHAR, safe in every expression
 * context (WHERE, INSERT VALUES, SET). Round-trips any UTF-8 including quotes,
 * backslashes, and newlines, without caring about sql_mode.
 */
export function sqlValueLiteral(value: string): string {
  const hex = Buffer.from(value, "utf8").toString("hex");
  return `CAST(x'${hex}' AS CHAR)`;
}

/**
 * Quote a value for the DDL contexts (DEFAULT, COMMENT) where MySQL demands a
 * literal, not an expression. Doubles `'` and doubles `\` (portable under the
 * default backslash-escapes mode).
 */
export function quoteStringLiteral(value: string): string {
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/** Column kinds the create/edit forms may choose from, wired to the UI select. */
export const COLUMN_BASE_TYPES = [
  "TINYINT",
  "SMALLINT",
  "INT",
  "BIGINT",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "CHAR",
  "VARCHAR",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "BLOB",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "YEAR",
  "JSON",
  "BOOLEAN",
] as const;

export type ColumnBaseType = (typeof COLUMN_BASE_TYPES)[number];

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "TINYINT",
  "SMALLINT",
  "INT",
  "BIGINT",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "YEAR",
]);

/** Types that take a `(n)` / `(m,d)` parameter; VARCHAR/CHAR require one. */
const PARAMETERIZED_TYPES: ReadonlySet<string> = new Set([
  "CHAR",
  "VARCHAR",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
]);

const DEFAULT_KINDS = ["none", "null", "literal", "currentTimestamp"] as const;
export type ColumnDefaultKind = (typeof DEFAULT_KINDS)[number];

export function isColumnDefaultKind(value: unknown): value is ColumnDefaultKind {
  return (
    typeof value === "string" &&
    (DEFAULT_KINDS as readonly string[]).includes(value)
  );
}

/** One column as the create/edit form submits it. */
export interface ColumnSpecInput {
  name: string;
  baseType: string;
  /** `(n)` or `(m,d)` parameter, e.g. "255" or "10,2". Digits and one comma. */
  length?: string;
  /** `UNSIGNED`: numeric types only. */
  unsigned?: boolean;
  nullable: boolean;
  /** AUTO_INCREMENT. Only valid on a keyed column; enforced where used. */
  autoIncrement?: boolean;
  /** Include in the table's PRIMARY KEY (create-table only). */
  primaryKey?: boolean;
  defaultKind: ColumnDefaultKind;
  /** The literal for `defaultKind: "literal"`. */
  defaultValue?: string;
  comment?: string;
}

/** Upper bound for a DDL string parameter or comment. */
const MAX_TEXT_FIELD = 255;

/**
 * Validate and normalize one column spec, returning an error list instead of
 * throwing so the create-table form can surface every problem at once.
 */
export function validateColumnSpec(col: ColumnSpecInput): string[] {
  const errors: string[] = [];
  const base = col.baseType?.toUpperCase() ?? "";

  if (!SQL_IDENTIFIER_RE.test(col.name ?? "")) {
    errors.push(
      `Column name "${(col.name ?? "").slice(0, 64)}" is invalid (letters, digits, underscore, $; must start with a letter or underscore).`,
    );
  }
  if (!(COLUMN_BASE_TYPES as readonly string[]).includes(base)) {
    errors.push(`Column "${col.name}": unsupported type "${base}".`);
    return errors;
  }

  const length = (col.length ?? "").trim();
  if (length.length > 0) {
    if (!PARAMETERIZED_TYPES.has(base)) {
      errors.push(`Column "${col.name}": ${base} does not take a length.`);
    } else if (!/^\d{1,4}(,\d{1,2})?$/.test(length)) {
      errors.push(
        `Column "${col.name}": length must look like "255" or "10,2".`,
      );
    }
  } else if (base === "VARCHAR" || base === "CHAR") {
    errors.push(`Column "${col.name}": ${base} requires a length.`);
  }

  if (col.unsigned && !NUMERIC_TYPES.has(base)) {
    errors.push(`Column "${col.name}": only numeric types can be unsigned.`);
  }
  if (col.autoIncrement && !NUMERIC_TYPES.has(base)) {
    errors.push(
      `Column "${col.name}": AUTO_INCREMENT requires an integer/decimal type.`,
    );
  }
  if (col.defaultKind === "currentTimestamp" && base !== "TIMESTAMP" && base !== "DATETIME") {
    errors.push(
      `Column "${col.name}": CURRENT_TIMESTAMP defaults need TIMESTAMP or DATETIME.`,
    );
  }
  if ((col.defaultValue ?? "").length > MAX_TEXT_FIELD) {
    errors.push(`Column "${col.name}": default is too long.`);
  }
  if ((col.comment ?? "").length > MAX_TEXT_FIELD) {
    errors.push(`Column "${col.name}": comment is too long.`);
  }

  return errors;
}

/** The `DEFAULT …` clause for a spec, or "" for "none". */
function defaultClauseSql(col: ColumnSpecInput): string {
  switch (col.defaultKind) {
    case "none":
      return "";
    case "null":
      return " DEFAULT NULL";
    case "currentTimestamp":
      return " DEFAULT CURRENT_TIMESTAMP";
    case "literal": {
      const value = col.defaultValue ?? "";
      // A bare number stays numeric; CURRENT_TIMESTAMP snuck into the literal
      // field would otherwise be quoted into a string default.
      if (/^-?\d+(\.\d+)?$/.test(value.trim())) return ` DEFAULT ${value.trim()}`;
      if (/^CURRENT_TIMESTAMP$/i.test(value.trim())) return " DEFAULT CURRENT_TIMESTAMP";
      return ` DEFAULT ${quoteStringLiteral(value)}`;
    }
  }
}

/** The full column definition used by CREATE TABLE / ADD / CHANGE. */
export function columnDefinitionSql(col: ColumnSpecInput): string {
  const base = assertSqlIdentifier(col.name, "column name");
  const type = col.baseType.toUpperCase() as ColumnBaseType;
  const length = (col.length ?? "").trim();
  const parameter = PARAMETERIZED_TYPES.has(type) && length ? `(${length})` : "";

  const parts = [
    quoteIdent(base),
    `${type}${parameter}${col.unsigned && NUMERIC_TYPES.has(type) ? " UNSIGNED" : ""}`,
    col.nullable ? "NULL" : "NOT NULL",
  ];
  if (col.autoIncrement && NUMERIC_TYPES.has(type)) parts.push("AUTO_INCREMENT");
  parts.push(defaultClauseSql(col).trimStart());
  if (col.comment && col.comment.length > 0) {
    parts.push(`COMMENT ${quoteStringLiteral(col.comment)}`);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * CREATE TABLE for the explorer: validated name, validated columns, one
 * optional AUTO_INCREMENT, InnoDB + utf8mb4 to match what the game servers
 * themselves create.
 */
export function buildCreateTableSql(
  table: string,
  columns: ColumnSpecInput[],
): string {
  assertSqlIdentifier(table, "table name");
  if (columns.length === 0) {
    throw new SqlValidationError("A table needs at least one column.");
  }

  const autoColumns = columns.filter((c) => c.autoIncrement);
  if (autoColumns.length > 1) {
    throw new SqlValidationError("Only one column can be AUTO_INCREMENT.");
  }
  if (autoColumns.length === 1 && !autoColumns[0]!.primaryKey) {
    throw new SqlValidationError("An AUTO_INCREMENT column must be part of the primary key.");
  }

  const pk = columns.filter((c) => c.primaryKey).map((c) => c.name);
  const defs = columns.map((c) => `  ${columnDefinitionSql(c)}`);
  if (pk.length > 0) {
    defs.push(`  PRIMARY KEY (${pk.map(quoteIdent).join(", ")})`);
  }

  return (
    `CREATE TABLE ${quoteIdent(table)} (\n${defs.join(",\n")}\n)` +
    " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
  );
}

/** ALTER TABLE … ADD COLUMN for one validated spec. */
export function buildAddColumnSql(table: string, col: ColumnSpecInput): string {
  return `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnDefinitionSql(col)}`;
}

/**
 * ALTER TABLE … CHANGE COLUMN for an edit. CHANGE restates the whole column
 * definition, so the form must prefill type/nullability/auto-increment from
 * information_schema or an edit would silently drop them.
 */
export function buildChangeColumnSql(
  table: string,
  fromName: string,
  col: ColumnSpecInput,
): string {
  return (
    `ALTER TABLE ${quoteIdent(table)} CHANGE COLUMN ` +
    `${quoteIdent(fromName)} ${columnDefinitionSql(col)}`
  );
}

/** The WHERE clause matching one row by its primary key (or a unique index). */
export function buildPrimaryKeyWhere(pk: Record<string, string | null>): string {
  const entries = Object.entries(pk);
  if (entries.length === 0) {
    throw new SqlValidationError("A primary key is required to identify the row.");
  }
  return entries
    .map(([column, value]) => {
      const ident = quoteIdent(column);
      return value === null ? `${ident} IS NULL` : `${ident} = ${sqlValueLiteral(value)}`;
    })
    .join(" AND ");
}

/**
 * INSERT one row. Column names are the validated keys; values are hex-encoded
 * strings or NULL.
 */
export function buildInsertRowSql(
  table: string,
  values: Record<string, string | null>,
): string {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new SqlValidationError("No values given for the new row.");
  const cols = entries.map(([c]) => quoteIdent(c)).join(", ");
  const vals = entries.map(([, v]) => (v === null ? "NULL" : sqlValueLiteral(v))).join(", ");
  return `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${vals})`;
}

/**
 * UPDATE one row, matched by primary key. Only the submitted columns are SET,
 * so an edit that cannot round-trip a column (a binary value) simply omits it.
 */
export function buildUpdateRowSql(
  table: string,
  pk: Record<string, string | null>,
  values: Record<string, string | null>,
): string {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new SqlValidationError("No changes given for the row.");
  const sets = entries
    .map(([c, v]) => `${quoteIdent(c)} = ${v === null ? "NULL" : sqlValueLiteral(v)}`)
    .join(", ");
  return `UPDATE ${quoteIdent(table)} SET ${sets} WHERE ${buildPrimaryKeyWhere(pk)} LIMIT 1`;
}

/** DELETE one row, matched by primary key. */
export function buildDeleteRowSql(
  table: string,
  pk: Record<string, string | null>,
): string {
  return `DELETE FROM ${quoteIdent(table)} WHERE ${buildPrimaryKeyWhere(pk)} LIMIT 1`;
}
