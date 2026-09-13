/**
 * Unit tests for the route → scope map (see docs/api-keys.md).
 *
 * This module decides what a scoped key may reach, so the tests are written as
 * claims about the API surface rather than about the regexes:
 *
 *   - every path the dispatcher routes resolves to a scope (nothing is
 *     accidentally unreachable, which fail-closed would otherwise hide)
 *   - the sections of a server map to their own resource and not to `servers`
 *   - the POSTs that read are classified as reads
 *   - the two escalation surfaces (`auth/api-key/*`, `auth/admin/*`) are mapped
 *   - an unknown path fails closed
 */

import { describe, expect, test } from "bun:test";

import { resolveRouteScope } from "./routeScopes";

const scopeOf = (path: string, method = "GET") => {
  const scope = resolveRouteScope(path, method);
  if (!scope) return scope;
  return `${scope.resource}:${scope.action}`;
};

describe("unscoped paths", () => {
  test("liveness and public branding need no scope", () => {
    expect(resolveRouteScope("health", "GET")).toBeUndefined();
    expect(resolveRouteScope("settings/public", "GET")).toBeUndefined();
    expect(resolveRouteScope("setup/status", "GET")).toBeUndefined();
  });

  test("the rest of the setup wizard is admin settings", () => {
    expect(scopeOf("setup/settings", "PATCH")).toBe("admin_settings:write");
    expect(scopeOf("setup/complete", "POST")).toBe("admin_settings:write");
  });
});

describe("failing closed", () => {
  test("an unknown path resolves to null, which the gate denies", () => {
    expect(resolveRouteScope("something/new", "GET")).toBeNull();
  });

  test("the agent callback surface is not reachable by any scope", () => {
    expect(resolveRouteScope("internal/console/audit", "POST")).toBeNull();
    expect(resolveRouteScope("internal/sftp/authenticate", "POST")).toBeNull();
  });
});

describe("method → action", () => {
  test("GET reads, everything else writes", () => {
    expect(scopeOf("servers", "GET")).toBe("servers:read");
    expect(scopeOf("servers/abc", "DELETE")).toBe("servers:write");
    expect(scopeOf("servers/abc/start", "POST")).toBe("servers:write");
    expect(scopeOf("servers/abc/env", "PATCH")).toBe("servers:write");
  });

  test("the POSTs that only read are classified as reads", () => {
    expect(scopeOf("servers/stats-batch", "POST")).toBe("servers:read");
    expect(scopeOf("admin/nodes/probe", "POST")).toBe("admin_nodes:read");
    expect(scopeOf("admin/nodes/database/status", "POST")).toBe("admin_nodes:read");
    expect(scopeOf("admin/backups/preview-schedule", "POST")).toBe("admin_backups:read");
    expect(scopeOf("admin/backups/test", "POST")).toBe("admin_backups:read");
    expect(scopeOf("admin/settings/ai/models", "POST")).toBe("admin_settings:read");
    expect(scopeOf("servers/abc/schedules/preview", "POST")).toBe("schedules:read");
    expect(scopeOf("admin/servers/abc/migrations/preflight", "POST")).toBe(
      "admin_servers:read",
    );
  });

  test("test-email writes, because it sends something", () => {
    expect(scopeOf("admin/settings/test-email", "POST")).toBe("admin_settings:write");
  });
});

describe("a server's sections keep their own resource", () => {
  const cases: Array<[string, string, string]> = [
    ["servers/abc/files", "GET", "files:read"],
    ["servers/abc/files/content", "PUT", "files:write"],
    ["servers/abc/files/download", "GET", "files:read"],
    ["servers/abc/files/delete", "POST", "files:write"],
    ["servers/abc/logs", "GET", "console:read"],
    ["servers/abc/console/stream", "GET", "console:read"],
    ["servers/abc/install-log", "GET", "console:read"],
    ["servers/abc/ai-helper", "POST", "console:read"],
    ["servers/abc/command", "POST", "console:write"],
    ["servers/abc/console/session", "POST", "console:write"],
    ["servers/abc/console/revoke", "POST", "console:write"],
    ["servers/abc/backups", "GET", "backups:read"],
    ["servers/abc/backups/settings", "PATCH", "backups:write"],
    ["servers/abc/backups/snap1/restore", "POST", "backups:write"],
    ["servers/abc/databases", "GET", "databases:read"],
    ["servers/abc/databases/d1/explorer/tables", "POST", "databases:write"],
    ["servers/abc/databases/d1/explorer/tables/t/rows", "GET", "databases:read"],
    ["servers/abc/schedules", "POST", "schedules:write"],
    ["servers/abc/schedules/s1/runs", "GET", "schedules:read"],
    ["servers/abc/subusers", "POST", "subusers:write"],
    ["servers/abc/sftp/credentials", "GET", "sftp:read"],
    ["servers/abc/plugins", "GET", "plugins:read"],
    ["servers/abc/plugins/install", "POST", "plugins:write"],
    ["servers/abc/plugins/search", "GET", "plugins:read"],
  ];

  for (const [path, method, expected] of cases) {
    test(`${method} ${path} → ${expected}`, () => {
      expect(scopeOf(path, method)).toBe(expected);
    });
  }

  test("a console session is a write even though obtaining one 'reads'", () => {
    // It hands back a capability token for a bidirectional terminal, so it is
    // the same authority as sending a command, not the same as tailing a log.
    expect(scopeOf("servers/abc/console/session", "POST")).toBe("console:write");
  });
});

describe("the admin surface", () => {
  const cases: Array<[string, string, string]> = [
    ["admin/users", "GET", "admin_users:read"],
    ["admin/users/u1/ban", "POST", "admin_users:write"],
    ["admin/servers", "GET", "admin_servers:read"],
    ["admin/servers/s1/suspend", "POST", "admin_servers:write"],
    ["admin/servers/s1/migrations", "POST", "admin_servers:write"],
    ["admin/nodes", "POST", "admin_nodes:write"],
    ["admin/nodes/n1/database/setup", "POST", "admin_nodes:write"],
    ["admin/nodes/n1/ports", "GET", "admin_nodes:read"],
    ["admin/blueprints", "GET", "admin_blueprints:read"],
    ["admin/blueprints/import-url", "POST", "admin_blueprints:write"],
    ["admin/settings", "PATCH", "admin_settings:write"],
    ["admin/legal/terms", "PUT", "admin_settings:write"],
    ["admin/audit-logs", "GET", "admin_audit:read"],
    ["admin/suspicious-activity/x/review", "POST", "admin_audit:write"],
    ["admin/scan", "POST", "admin_audit:write"],
    ["admin/backups/databases/n1", "POST", "admin_backups:write"],
    ["admin/backups/storage", "GET", "admin_backups:read"],
    ["admin/api-keys", "GET", "api_keys:read"],
    ["admin/api-keys/k1", "DELETE", "api_keys:write"],
  ];

  for (const [path, method, expected] of cases) {
    test(`${method} ${path} → ${expected}`, () => {
      expect(scopeOf(path, method)).toBe(expected);
    });
  }
});

describe("Better Auth's own surface", () => {
  test("the key-management endpoints are gated on api_keys", () => {
    // Otherwise `api_keys` would be decorative: any key could mint an
    // unrestricted successor here and step straight out of its scope.
    expect(scopeOf("auth/api-key/create", "POST")).toBe("api_keys:write");
    expect(scopeOf("auth/api-key/delete", "POST")).toBe("api_keys:write");
    expect(scopeOf("auth/api-key/list", "GET")).toBe("api_keys:read");
  });

  test("the admin plugin's ban/role endpoints are gated on admin_users", () => {
    expect(scopeOf("auth/admin/ban-user", "POST")).toBe("admin_users:write");
    expect(scopeOf("auth/admin/set-role", "POST")).toBe("admin_users:write");
    expect(scopeOf("auth/admin/list-users", "GET")).toBe("admin_users:read");
  });

  test("everything else on the auth surface is the owner's own account", () => {
    expect(scopeOf("auth/get-session", "GET")).toBe("account:read");
    expect(scopeOf("auth/sign-out", "POST")).toBe("account:write");
    expect(scopeOf("auth/change-password", "POST")).toBe("account:write");
    expect(scopeOf("auth/two-factor/enable", "POST")).toBe("account:write");
    expect(scopeOf("auth", "GET")).toBe("account:read");
  });
});

describe("the caller's own account and the catalogue", () => {
  test("me and account actions", () => {
    expect(scopeOf("me", "GET")).toBe("account:read");
    expect(scopeOf("account/delete", "POST")).toBe("account:write");
  });

  test("the blueprint catalogue reads as part of servers", () => {
    expect(scopeOf("blueprints", "GET")).toBe("servers:read");
  });
});

describe("normalisation", () => {
  test("leading and trailing slashes do not change the answer", () => {
    expect(scopeOf("/servers/", "GET")).toBe("servers:read");
    expect(resolveRouteScope("/health", "GET")).toBeUndefined();
  });

  test("the method is matched case-insensitively", () => {
    expect(scopeOf("servers", "get")).toBe("servers:read");
  });
});
