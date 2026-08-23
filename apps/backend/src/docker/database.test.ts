/**
 * Tests for `docker/database.ts`: the DB identifier validation the agent's SQL
 * relies on, and the `--xml` output parser behind the database explorer.
 *
 * The agent interpolates `dbName`/`dbUser` directly into SQL (backticked for
 * identifiers, single-quoted for the user host), so they must be vetted before
 * use. The panel generates them, but the agent is root-equivalent on this
 * MariaDB and defends itself: anything that doesn't match the strict identifier
 * shape is rejected with a 400 before any SQL runs.
 *
 * The parser tests pin the mariadb client's `--xml` wire format, including the
 * `xsi:nil` distinction that keeps a literal "NULL" string and a real NULL from
 * being conflated. A silent mis-parse there would feed the explorer (and row
 * edits keyed on mis-read values) wrong data.
 */

import { describe, expect, test } from "bun:test";

import { assertValidDbIdentifier, parseMysqlXmlOutput } from "./database";

test("accepts a well-formed database name", () => {
  expect(() => assertValidDbIdentifier("db_48160ddadc87ab", "name")).not.toThrow();
  expect(() => assertValidDbIdentifier("db_abc123", "name")).not.toThrow();
  expect(() => assertValidDbIdentifier("db_a", "name")).not.toThrow();
});

test("accepts a well-formed database user", () => {
  expect(() => assertValidDbIdentifier("u_48160ddadc87ab", "user")).not.toThrow();
  expect(() => assertValidDbIdentifier("u_abc123", "user")).not.toThrow();
});

test("accepts the full length the panel generates", () => {
  // db_ + 12 hex (server id) + 6 hex (random suffix) = db_ + 18 chars
  expect(() =>
    assertValidDbIdentifier("db_48160ddadc87a1b2c3", "name"),
  ).not.toThrow();
});

test("rejects names without the db_ prefix", () => {
  expect(() => assertValidDbIdentifier("48160ddadc87", "name")).toThrow();
  expect(() => assertValidDbIdentifier("mydb_abc123", "name")).toThrow();
});

test("rejects users without the u_ prefix", () => {
  expect(() => assertValidDbIdentifier("db_abc123", "user")).toThrow();
  expect(() => assertValidDbIdentifier("user_abc123", "user")).toThrow();
});

test("rejects SQL-injection attempts", () => {
  const attacks = [
    "db_; DROP DATABASE mysql",
    "db_' OR '1'='1",
    "db_`; --",
    "db_abc--",
    "db_abc/*",
    "db_ OR 1=1",
  ];
  for (const bad of attacks) {
    expect(() => assertValidDbIdentifier(bad, "name")).toThrow();
  }
});

test("rejects shell/hostile characters", () => {
  const bad = [
    "db_abc-def", // dash
    "db_abc.def", // dot
    "db_abc def", // space
    "db_abc/def", // slash
    "db_\\abc", // backslash
    "db_abc@host", // @
    "db_`abc", // backtick
    'db_"abc', // double quote
    "db_'abc", // single quote
  ];
  for (const name of bad) {
    expect(() => assertValidDbIdentifier(name, "name")).toThrow();
  }
});

test("rejects empty and whitespace-only values", () => {
  expect(() => assertValidDbIdentifier("", "name")).toThrow();
  expect(() => assertValidDbIdentifier("   ", "name")).toThrow();
  expect(() => assertValidDbIdentifier("db_", "name")).toThrow();
});

test("rejects values over the 48-char cap", () => {
  const tooLong = "db_" + "a".repeat(46); // 49 chars
  expect(() => assertValidDbIdentifier(tooLong, "name")).toThrow();
});

test("the thrown error is a 400 HttpError", () => {
  try {
    assertValidDbIdentifier("db_; DROP TABLE x", "name");
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("HttpError");
    expect((err as { status: number }).status).toBe(400);
    expect((err as Error).message).toContain("database name");
  }
});

// --- parseMysqlXmlOutput --------------------------------------------------------

/** The exact shape the mariadb client emits with `--xml`. */
const wrap = (statement: string, rows: string) =>
  `<?xml version="1.0"?>\n\n<resultset statement="${statement}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${rows}</resultset>\n`;

const field = (name: string, value: string) =>
  `<field name="${name}">${value}</field>`;
const nilField = (name: string) =>
  `<field name="${name}" xsi:nil="true" />`;

describe("parseMysqlXmlOutput", () => {
  test("returns [] for empty output (DDL / no result set)", () => {
    expect(parseMysqlXmlOutput("")).toEqual([]);
  });

  test("parses columns and values", () => {
    const xml = wrap(
      "select id, name from t",
      `<row>\n${field("id", "1")}\n${field("name", "Steve")}\n</row>\n`,
    );
    expect(parseMysqlXmlOutput(xml)).toEqual([
      { columns: ["id", "name"], rows: [["1", "Steve"]] },
    ]);
  });

  test("maps xsi:nil fields to null, keeping literal NULL strings distinct", () => {
    const xml = wrap(
      "select a, b from t",
      `<row>\n${field("a", "NULL")}\n${nilField("b")}\n</row>\n`,
    );
    expect(parseMysqlXmlOutput(xml)).toEqual([
      { columns: ["a", "b"], rows: [["NULL", null]] },
    ]);
  });

  test("decodes XML entities in values and column names", () => {
    const xml = wrap(
      "select q from t",
      `<row>\n${field("q&amp;uote&quot;", "a &lt;tag&gt; &amp; &apos;\\' &#65;&#x42;")}\n</row>\n`,
    );
    const [result] = parseMysqlXmlOutput(xml);
    expect(result?.columns).toEqual([`q&uote"`]);
    expect(result?.rows[0]).toEqual(["a <tag> & '\\' AB"]);
  });

  test("keeps newlines and tabs inside values", () => {
    const xml = wrap(
      "select body from t",
      `<row>\n${field("body", "line1\nline2\ttabbed")}\n</row>\n`,
    );
    expect(parseMysqlXmlOutput(xml)[0]?.rows[0]).toEqual(["line1\nline2\ttabbed"]);
  });

  test("a resultset with no rows has no column names", () => {
    const xml = wrap("select * from empty_t", "");
    expect(parseMysqlXmlOutput(xml)).toEqual([{ columns: [], rows: [] }]);
  });

  test("separates consecutive statements into separate results", () => {
    const xml =
      wrap("select 1", `<row>\n${field("1", "1")}\n</row>\n`) +
      wrap("select 2", `<row>\n${field("2", "2")}\n</row>\n`);
    expect(parseMysqlXmlOutput(xml)).toEqual([
      { columns: ["1"], rows: [["1"]] },
      { columns: ["2"], rows: [["2"]] },
    ]);
  });

  test("big integer ids survive as exact strings", () => {
    const id = "9007199254740993"; // 2^53 + 1, wrong after Number()
    const xml = wrap("select id", `<row>\n${field("id", id)}\n</row>\n`);
    expect(parseMysqlXmlOutput(xml)[0]?.rows[0]).toEqual([id]);
  });

  test("ignores text outside resultsets (xml declaration, junk)", () => {
    const xml = `junk before<?xml version="1.0"?>\n` +
      wrap("select x", `<row>\n${field("x", "1")}\n</row>\n`) +
      "trailing junk";
    expect(parseMysqlXmlOutput(xml)).toHaveLength(1);
  });
});
