/**
 * Tests for the DB identifier validation in `docker/database.ts`.
 *
 * The agent interpolates `dbName`/`dbUser` directly into SQL (backticked for
 * identifiers, single-quoted for the user host), so they must be vetted before
 * use. The panel generates them, but the agent is root-equivalent on this
 * MariaDB and defends itself: anything that doesn't match the strict identifier
 * shape is rejected with a 400 before any SQL runs.
 *
 * These tests pin that shape so a regression (loosening the regex, or dropping
 * the check) is caught.
 */

import { expect, test } from "bun:test";

import { assertValidDbIdentifier } from "./database";

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
