/**
 * Unit tests for the SFTP username builder.
 *
 * The auth-callback and CRUD routes require a running Postgres + Better Auth,
 * so they are exercised via the panel's integration suite rather than here.
 * The username format is pure string logic and the most likely thing to
 * regress, so it gets its own fast test.
 */

import { test, expect } from "bun:test";
import { buildSftpUsername } from "./sftpUsername";

test("builds a username from email local-part + first 8 of server UUID", () => {
  const u = buildSftpUsername("alice@example.com", "11111111-2222-3333-4444-555555555555");
  expect(u).toBe("alice-11111111");
});

test("lowercases the email local-part", () => {
  const u = buildSftpUsername("Alice@Example.com", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  expect(u).toBe("alice-aaaaaaaa");
});

test("strips non-alphanumeric characters from the local-part", () => {
  const u = buildSftpUsername("alice.bob+tag@example.com", "12345678-abcd-ef01-2345-6789012345");
  expect(u).toBe("alicebobtag-12345678");
});

test("falls back to 'user' when local-part is empty or all symbols", () => {
  expect(buildSftpUsername("@example.com", "12345678-1234-1234-1234-123456789012")).toBe(
    "user-12345678",
  );
  expect(buildSftpUsername("..--@@example.com", "12345678-1234-1234-1234-123456789012")).toBe(
    "user-12345678",
  );
});

test("truncates a long local-part to 24 chars", () => {
  const u = buildSftpUsername(
    "a-very-long-username-that-exceeds-the-limit@example.com",
    "abcdef01-1234-1234-1234-123456789012",
  );
  // "averylongusernamethatexceedst" stripped → 29 chars → truncated to 24
  expect(u).toBe("averylongusernamethatexc-abcdef01");
  expect(u.split("-")[0]!.length).toBeLessThanOrEqual(24);
});

test("uses the first 8 hex chars of the server UUID (no dashes)", () => {
  const u = buildSftpUsername("bob@example.com", "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  expect(u).toBe("bob-a1b2c3d4");
});
