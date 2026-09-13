/**
 * Unit tests for the API-key scope vocabulary (see docs/api-keys.md).
 *
 * Every claim here is security-relevant, because this module is the only thing
 * standing between a stored grant and a decision to allow a request:
 *
 *   - an unknown resource or action can never become a stored grant
 *   - a damaged grant denies rather than degrading to full access
 *   - `null` (unrestricted) and `{}` (nothing) stay distinguishable end to end
 *   - attenuation is a real subset check, in both directions
 */

import { describe, expect, test } from "bun:test";

import {
  API_KEY_RESOURCES,
  countScopedResources,
  describeScopes,
  isScopeSubset,
  parseApiKeyScopes,
  sanitizeApiKeyScopes,
  scopesAllow,
  type ApiKeyScopes,
} from "./api-key-scopes";

describe("sanitizeApiKeyScopes", () => {
  test("keeps known resources and actions", () => {
    expect(
      sanitizeApiKeyScopes({ servers: ["read", "write"], files: ["read"] }),
    ).toEqual({ servers: ["read", "write"], files: ["read"] });
  });

  test("drops resources the enforcer has never heard of", () => {
    expect(sanitizeApiKeyScopes({ nodes_secret: ["read"], files: ["read"] })).toEqual({
      files: ["read"],
    });
  });

  test("drops actions that are not read or write", () => {
    expect(sanitizeApiKeyScopes({ files: ["read", "delete", "*"] })).toEqual({
      files: ["read"],
    });
  });

  test("drops a resource whose actions all fell away", () => {
    expect(sanitizeApiKeyScopes({ files: ["admin"] })).toEqual({});
  });

  test("normalises action order so equal grants serialise identically", () => {
    expect(JSON.stringify(sanitizeApiKeyScopes({ files: ["write", "read"] }))).toBe(
      JSON.stringify(sanitizeApiKeyScopes({ files: ["read", "write"] })),
    );
  });

  test("rejects non-objects and arrays outright", () => {
    expect(sanitizeApiKeyScopes(null)).toEqual({});
    expect(sanitizeApiKeyScopes("files")).toEqual({});
    expect(sanitizeApiKeyScopes([["files", ["read"]]])).toEqual({});
  });

  test("a non-array action list is not a grant", () => {
    expect(sanitizeApiKeyScopes({ files: "read" })).toEqual({});
  });
});

describe("parseApiKeyScopes", () => {
  test("an absent column is unrestricted", () => {
    expect(parseApiKeyScopes(null)).toBeNull();
    expect(parseApiKeyScopes(undefined)).toBeNull();
    expect(parseApiKeyScopes("  ")).toBeNull();
  });

  test("reads the stored JSON string the plugin writes", () => {
    expect(parseApiKeyScopes('{"files":["read"]}')).toEqual({ files: ["read"] });
  });

  test("accepts an already-parsed object", () => {
    expect(parseApiKeyScopes({ files: ["write"] })).toEqual({ files: ["write"] });
  });

  test("corrupt JSON denies rather than granting everything", () => {
    // The dangerous failure mode: a damaged restriction must not read as "no
    // restriction". An empty grant is a key that can reach nothing.
    expect(parseApiKeyScopes("{not json")).toEqual({});
  });

  test("a grant of only unknown resources denies, it does not go unrestricted", () => {
    expect(parseApiKeyScopes('{"made_up":["read"]}')).toEqual({});
  });

  test("an explicit empty grant stays empty, not unrestricted", () => {
    expect(parseApiKeyScopes("{}")).toEqual({});
  });
});

describe("scopesAllow", () => {
  const scopes: ApiKeyScopes = { files: ["read"], console: ["read", "write"] };

  test("an unrestricted key allows anything", () => {
    expect(scopesAllow(null, "admin_users", "write")).toBe(true);
  });

  test("a granted action is allowed", () => {
    expect(scopesAllow(scopes, "console", "write")).toBe(true);
    expect(scopesAllow(scopes, "files", "read")).toBe(true);
  });

  test("write does not imply read, and read does not imply write", () => {
    expect(scopesAllow(scopes, "files", "write")).toBe(false);
    expect(scopesAllow({ files: ["write"] }, "files", "read")).toBe(false);
  });

  test("an ungranted resource is denied", () => {
    expect(scopesAllow(scopes, "backups", "read")).toBe(false);
  });

  test("the empty grant denies everything", () => {
    expect(scopesAllow({}, "servers", "read")).toBe(false);
  });
});

describe("isScopeSubset", () => {
  const parent: ApiKeyScopes = { files: ["read", "write"], console: ["read"] };

  test("an unrestricted parent permits any child", () => {
    expect(isScopeSubset({ admin_users: ["write"] }, null)).toBe(true);
    expect(isScopeSubset(null, null)).toBe(true);
  });

  test("a scoped parent may not mint an unrestricted child", () => {
    // This is the escalation the whole attenuation rule exists to stop.
    expect(isScopeSubset(null, parent)).toBe(false);
  });

  test("a narrower child is permitted", () => {
    expect(isScopeSubset({ files: ["read"] }, parent)).toBe(true);
    expect(isScopeSubset({}, parent)).toBe(true);
  });

  test("an equal child is permitted", () => {
    expect(isScopeSubset({ ...parent }, parent)).toBe(true);
  });

  test("a child reaching a resource the parent lacks is refused", () => {
    expect(isScopeSubset({ backups: ["read"] }, parent)).toBe(false);
  });

  test("a child reaching an action the parent lacks is refused", () => {
    expect(isScopeSubset({ console: ["write"] }, parent)).toBe(false);
  });
});

describe("presentation", () => {
  test("counts every resource for an unrestricted key", () => {
    expect(countScopedResources(null)).toBe(API_KEY_RESOURCES.length);
    expect(countScopedResources({ files: ["read"] })).toBe(1);
  });

  test("describes the three shapes a grant can take", () => {
    expect(describeScopes(null)).toBe("Full access");
    expect(describeScopes({})).toBe("No access");
    expect(describeScopes({ files: ["read", "write"] })).toBe("Files (read/write)");
  });

  test("resource ids are unique", () => {
    const ids = API_KEY_RESOURCES.map((resource) => resource.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
