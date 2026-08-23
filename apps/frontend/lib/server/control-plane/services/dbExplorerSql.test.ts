/**
 * Unit tests for the explorer's SQL builders.
 *
 * These functions are the injection boundary between the browser's structured
 * operations and the SQL the agent execs, so every test here is a security
 * claim: identifiers that don't match the safe shape must throw, values must
 * appear only as hex literals, and DDL strings must be escaped.
 */

import { describe, expect, test } from "bun:test";
import {
  assertSqlIdentifier,
  buildAddColumnSql,
  buildChangeColumnSql,
  buildCreateTableSql,
  buildDeleteRowSql,
  buildInsertRowSql,
  buildPrimaryKeyWhere,
  buildUpdateRowSql,
  quoteIdent,
  quoteStringLiteral,
  sqlValueLiteral,
  SqlValidationError,
  validateColumnSpec,
  type ColumnSpecInput,
} from "./dbExplorerSql";

const column = (over: Partial<ColumnSpecInput> = {}): ColumnSpecInput => ({
  name: "name",
  baseType: "VARCHAR",
  length: "255",
  nullable: false,
  defaultKind: "none",
  ...over,
});

// --- identifiers ------------------------------------------------------------

test("assertSqlIdentifier accepts safe names and rejects everything else", () => {
  expect(assertSqlIdentifier("players", "table name")).toBe("players");
  expect(assertSqlIdentifier("_tmp", "table name")).toBe("_tmp");
  expect(assertSqlIdentifier("a$b", "table name")).toBe("a$b");

  for (const bad of [
    "", // empty
    "1abc", // starts with a digit
    "has space",
    "drop;--",
    "`quoted`",
    "players\x00", // control char
    "üñí", // non-ascii
    "a".repeat(65), // over MariaDB's 64-char limit
  ]) {
    expect(() => assertSqlIdentifier(bad, "table name")).toThrow(SqlValidationError);
  }
});

test("quoteIdent wraps a vetted identifier in backticks", () => {
  expect(quoteIdent("players")).toBe("`players`");
});

// --- value encoding -----------------------------------------------------------

test("sqlValueLiteral hex-encodes values so nothing is parseable", () => {
  // The body between the quotes is hex only. Quotes, backslashes, newlines
  // and comment markers from the value cannot appear there.
  expect(sqlValueLiteral("it's")).toBe("CAST(x'69742773' AS CHAR)");
  expect(sqlValueLiteral("a\\b")).toBe("CAST(x'615c62' AS CHAR)");
  const withNewline = sqlValueLiteral("a\nb");
  expect(withNewline).not.toContain("\n");
  expect(withNewline).toMatch(/^CAST\(x'[0-9a-f]*' AS CHAR\)$/);
  expect(sqlValueLiteral("'); DROP TABLE x; --")).toMatch(/^CAST\(x'[0-9a-f]*' AS CHAR\)$/);
});

test("quoteStringLiteral doubles quotes and backslashes", () => {
  expect(quoteStringLiteral("plain")).toBe("'plain'");
  expect(quoteStringLiteral("it's")).toBe("'it''s'");
  expect(quoteStringLiteral("a\\b")).toBe("'a\\\\b'");
});

// --- column validation --------------------------------------------------------

test("validateColumnSpec collects every problem at once", () => {
  const errors = validateColumnSpec({
    name: "9bad",
    baseType: "VARCHAR",
    length: "abc",
    nullable: true,
    defaultKind: "currentTimestamp",
  });
  expect(errors).toHaveLength(3); // bad name, bad length, CURRENT_TIMESTAMP on VARCHAR
});

test("validateColumnSpec enforces type rules", () => {
  expect(validateColumnSpec(column({ baseType: "VARCHAR", length: undefined })))
    .toContain('Column "name": VARCHAR requires a length.');
  expect(validateColumnSpec(column({ baseType: "TEXT", length: "20" })))
    .toContain('Column "name": TEXT does not take a length.');
  expect(validateColumnSpec(column({ baseType: "TEXT", unsigned: true })))
    .toContain('Column "name": only numeric types can be unsigned.');
  expect(validateColumnSpec(column({ baseType: "TEXT", autoIncrement: true })))
    .toContain('Column "name": AUTO_INCREMENT requires an integer/decimal type.');
  expect(validateColumnSpec(column())).toEqual([]);
});

// --- table/column DDL ---------------------------------------------------------

test("buildCreateTableSql composes the full statement with keys", () => {
  const sql = buildCreateTableSql("players", [
    column({ name: "id", baseType: "INT", length: undefined, autoIncrement: true, primaryKey: true }),
    column({ name: "name", baseType: "VARCHAR", length: "64", defaultKind: "literal", defaultValue: "anon" }),
    column({ name: "score", baseType: "INT", length: undefined, unsigned: true, nullable: true, defaultKind: "null" }),
  ]);
  expect(sql).toBe(
    "CREATE TABLE `players` (\n" +
      "  `id` INT NOT NULL AUTO_INCREMENT,\n" +
      "  `name` VARCHAR(64) NOT NULL DEFAULT 'anon',\n" +
      "  `score` INT UNSIGNED NULL DEFAULT NULL,\n" +
      "  PRIMARY KEY (`id`)\n" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  );
});

test("buildCreateTableSql rejects keyless AUTO_INCREMENT and multiples", () => {
  expect(() =>
    buildCreateTableSql("t", [column({ name: "id", baseType: "INT", length: undefined, autoIncrement: true })]),
  ).toThrow(/primary key/);
  expect(() =>
    buildCreateTableSql("t", [
      column({ name: "a", baseType: "INT", length: undefined, autoIncrement: true, primaryKey: true }),
      column({ name: "b", baseType: "INT", length: undefined, autoIncrement: true, primaryKey: true }),
    ]),
  ).toThrow(/Only one column/);
  expect(() => buildCreateTableSql("t", [])).toThrow(/at least one column/);
});

test("buildAddColumnSql and buildChangeColumnSql quote both names", () => {
  expect(buildAddColumnSql("players", column({ name: "coins", baseType: "INT", length: undefined })))
    .toBe("ALTER TABLE `players` ADD COLUMN `coins` INT NOT NULL");
  expect(buildChangeColumnSql("players", "name", column({ name: "display_name" })))
    .toBe("ALTER TABLE `players` CHANGE COLUMN `name` `display_name` VARCHAR(255) NOT NULL");
});

// --- row DML ------------------------------------------------------------------

test("buildInsertRowSql hex-encodes values and keeps NULL", () => {
  const sql = buildInsertRowSql("players", { name: "a'b", score: null });
  expect(sql).toMatch(/^INSERT INTO `players` \(`name`, `score`\) VALUES \(CAST\(x'/);
  expect(sql).toContain(", NULL)");
});

test("buildUpdateRowSql sets only submitted columns and limits to the keyed row", () => {
  const sql = buildUpdateRowSql("players", { id: "7" }, { score: "3" });
  expect(sql).toBe(
    "UPDATE `players` SET `score` = CAST(x'33' AS CHAR) WHERE `id` = CAST(x'37' AS CHAR) LIMIT 1",
  );
});

test("buildPrimaryKeyWhere handles NULL key parts and rejects empty keys", () => {
  expect(buildPrimaryKeyWhere({ a: "1", b: null }))
    .toBe("`a` = CAST(x'31' AS CHAR) AND `b` IS NULL");
  expect(() => buildPrimaryKeyWhere({})).toThrow(SqlValidationError);
});

test("buildDeleteRowSql matches one row by key", () => {
  expect(buildDeleteRowSql("players", { id: "7" }))
    .toBe("DELETE FROM `players` WHERE `id` = CAST(x'37' AS CHAR) LIMIT 1");
});
