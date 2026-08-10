/**
 * Bearer-token comparison tests.
 *
 * The agent has exactly one credential and it grants root-equivalent control of
 * the node, so header parsing must not be sloppy about what it accepts.
 */

import { describe, expect, test } from "bun:test";

process.env.AGENT_TOKEN ??= "test-agent-token-that-is-long-enough-0123456789";

const { extractBearer, isAuthorized } = await import("./auth");

const TOKEN = process.env.AGENT_TOKEN!;

function requestWith(authorization?: string): Request {
  return new Request("http://agent/v1/health", {
    headers: authorization ? { authorization } : {},
  });
}

describe("extractBearer", () => {
  test("reads the token from a well-formed header", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
  });

  test("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer abc123")).toBe("abc123");
  });

  test("returns null for a missing or non-bearer header", () => {
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("Basic abc123")).toBeNull();
    expect(extractBearer("abc123")).toBeNull();
  });
});

describe("isAuthorized", () => {
  test("accepts the configured token", () => {
    expect(isAuthorized(requestWith(`Bearer ${TOKEN}`))).toBe(true);
  });

  test("rejects a wrong, absent, or truncated token", () => {
    expect(isAuthorized(requestWith(`Bearer ${TOKEN}x`))).toBe(false);
    expect(isAuthorized(requestWith(`Bearer ${TOKEN.slice(0, -1)}`))).toBe(false);
    expect(isAuthorized(requestWith())).toBe(false);
    expect(isAuthorized(requestWith("Bearer "))).toBe(false);
  });
});
