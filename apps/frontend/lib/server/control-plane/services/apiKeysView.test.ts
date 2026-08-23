/**
 * Unit tests for the admin API-key view mapping.
 *
 * The mapping is the boundary between raw `apikey`-table rows and what the
 * admin endpoint returns, so the claims tested here are security-adjacent:
 * key material (the `key` column) has no path into the view shape, expiry is
 * computed against an injected clock, and degraded inputs (missing owner,
 * unparseable dates, null counters) render rather than throw.
 */

import { describe, expect, test } from "bun:test";

import { toApiKeyAdminView, type ApiKeyRow } from "./apiKeysView";

const NOW = new Date("2026-08-17T12:00:00.000Z");

const row = (overrides: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: "0b2a1c58-92d1-4d5e-a3f2-7a9d1b0c4e11",
  name: "CI deploy",
  prefix: "cpl_x9Kd",
  start: "cpl_x9",
  enabled: true,
  request_count: 41,
  last_request: new Date("2026-08-17T11:00:00.000Z"),
  expires_at: null,
  created_at: new Date("2026-01-02T03:04:05.000Z"),
  owner_id: "1d2c3b4a-1111-2222-3333-444455556666",
  owner_email: "owner@example.com",
  owner_name: "Owner",
  owner_role: "admin",
  ...overrides,
});

describe("toApiKeyAdminView", () => {
  test("maps a healthy row into camelCase", () => {
    const view = toApiKeyAdminView(row(), NOW);
    expect(view.id).toBe("0b2a1c58-92d1-4d5e-a3f2-7a9d1b0c4e11");
    expect(view.name).toBe("CI deploy");
    expect(view.prefix).toBe("cpl_x9Kd");
    expect(view.enabled).toBe(true);
    expect(view.status).toBe("active");
    expect(view.requestCount).toBe(41);
    expect(view.lastUsedAt).toBe("2026-08-17T11:00:00.000Z");
    expect(view.expiresAt).toBeNull();
    expect(view.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(view.ownerEmail).toBe("owner@example.com");
    expect(view.ownerRole).toBe("admin");
  });

  test("the view shape carries no field for key material", () => {
    // `key` (the hash) and `metadata` exist on the real table but are not part
    // of ApiKeyRow, so they cannot be selected-and-leaked by this mapping.
    const view = toApiKeyAdminView(row(), NOW) as Record<string, unknown>;
    expect(view.key).toBeUndefined();
    expect(view.hash).toBeUndefined();
    expect(view.token).toBeUndefined();
  });

  test("disabled and expired keys report the right status", () => {
    expect(toApiKeyAdminView(row({ enabled: false }), NOW).status).toBe("disabled");
    expect(
      toApiKeyAdminView(row({ expires_at: new Date("2026-08-17T11:59:59.999Z") }), NOW)
        .status,
    ).toBe("expired");
  });

  test("expiry at the exact instant of `now` counts as expired", () => {
    expect(
      toApiKeyAdminView(row({ expires_at: NOW }), NOW).status,
    ).toBe("expired");
  });

  test("an expired-but-disabled key reads as expired (dead either way)", () => {
    expect(
      toApiKeyAdminView(
        row({ enabled: false, expires_at: new Date("2026-01-01T00:00:00.000Z") }),
        NOW,
      ).status,
    ).toBe("expired");
  });

  test("accepts ISO strings where a driver may serialize dates as strings", () => {
    const view = toApiKeyAdminView(
      row({
        last_request: "2026-08-16T10:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-01-02T03:04:05.000Z",
      }),
      NOW,
    );
    expect(view.lastUsedAt).toBe("2026-08-16T10:00:00.000Z");
    expect(view.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(view.status).toBe("active");
  });

  test("unparseable dates degrade to null instead of throwing", () => {
    const view = toApiKeyAdminView(row({ expires_at: "not-a-date", last_request: "nope" }), NOW);
    expect(view.expiresAt).toBeNull();
    expect(view.lastUsedAt).toBeNull();
    // An unparseable expiry must not read as expired, because that would invite
    // an admin to "clean up" keys that are actually fine.
    expect(view.status).toBe("active");
  });

  test("null counters default to zero and enabled defaults to true", () => {
    const view = toApiKeyAdminView(row({ request_count: null, enabled: null }), NOW);
    expect(view.requestCount).toBe(0);
    expect(view.enabled).toBe(true);
  });

  test("a missing owner (deleted account) still maps, with empty owner fields", () => {
    const view = toApiKeyAdminView(
      row({ owner_id: null, owner_email: null, owner_name: null, owner_role: null }),
      NOW,
    );
    expect(view.ownerId).toBe("");
    expect(view.ownerEmail).toBeNull();
    expect(view.ownerRole).toBe("user");
  });

  test("an unexpected role string degrades to plain user", () => {
    expect(toApiKeyAdminView(row({ owner_role: "superuser" }), NOW).ownerRole).toBe("user");
  });

  test("prefix falls back to `start` for plugin-minted keys", () => {
    // The plugin stores `prefix` only when one was configured; its own
    // created keys carry `start` (first ~6 chars) instead.
    const view = toApiKeyAdminView(row({ prefix: null, start: "slpgDd" }), NOW);
    expect(view.prefix).toBe("slpgDd");
    expect(toApiKeyAdminView(row({ prefix: null, start: null }), NOW).prefix).toBeNull();
  });
});
