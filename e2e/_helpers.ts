/**
 * E2E helpers for the API-key surface (see docs/api-keys.md).
 *
 * These tests drive a running panel over HTTP and authenticate with two real
 * API keys supplied via `.env.e2e` (see `.env.e2e.example`):
 *
 *   E2E_PANEL_URL   panel base URL        (default http://localhost:3000)
 *   E2E_USER_API_KEY  a non-admin owner's key  (tests the user side)
 *   E2E_ADMIN_API_KEY an admin's key            (tests the admin side)
 *   E2E_USER_EMAIL / E2E_ADMIN_EMAIL  optional; asserted when set
 *
 * Run via `bun run test:e2e`. The helper loads `.env.e2e` itself (resolved
 * relative to this file), so the suite also works under a bare `bun test e2e/`.
 * When the two keys are absent the authenticated tests are skipped (not failed)
 * via `test.skipIf`, so the suite is safe to run before `.env.e2e` is filled in.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

loadDotEnv(fileURLToPath(new URL("../.env.e2e", import.meta.url)));

export interface E2EConfig {
  panelUrl: string;
  userKey: string;
  adminKey: string;
  userEmail: string;
  adminEmail: string;
}

export const config: E2EConfig = {
  panelUrl: (process.env.E2E_PANEL_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  userKey: process.env.E2E_USER_API_KEY ?? "",
  adminKey: process.env.E2E_ADMIN_API_KEY ?? "",
  userEmail: process.env.E2E_USER_EMAIL ?? "",
  adminEmail: process.env.E2E_ADMIN_EMAIL ?? "",
};

/** True when both keys are present. Gates the authenticated tests. */
export const configured = Boolean(config.userKey && config.adminKey);

/** A test that only runs when both E2E keys are configured. */
export const e2e = (name: string, fn: () => Promise<unknown> | unknown) =>
  test.skipIf(!configured)(name, fn);

/**
 * Assert a status code and return the result for chaining. Centralised so a
 * mismatch surfaces one clear failure instead of a chain of follow-on errors.
 */
export function expectStatus(res: ApiResult, expected: number): ApiResult {
  expect(res.status).toBe(expected);
  return res;
}

/** A UUID known to not exist on the panel, used for "not found" assertions. */
export const UNKNOWN_UUID = "00000000-0000-0000-0000-000000000000";

export type HeaderMode = "bearer" | "x-api-key";

export interface ApiResult {
  status: number;
  body: unknown;
  headers: Headers;
}

/**
 * Issue a request against the panel. `key` selects a credential; `header`
 * chooses which convention to present it under (the panel aliases
 * `Authorization: Bearer` onto `x-api-key`, see auth/middleware.ts).
 */
export async function api(
  path: string,
  opts: {
    method?: string;
    key?: string | null;
    header?: HeaderMode;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult> {
  const { method = "GET", key = null, header = "bearer", body, headers = {} } =
    opts;
  const h: Record<string, string> = { ...headers };
  if (key) {
    if (header === "x-api-key") h["x-api-key"] = key;
    else h["Authorization"] = `Bearer ${key}`;
  }
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h["content-type"] = h["content-type"] ?? "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const url = path.startsWith("http")
    ? path
    : `${config.panelUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json") && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/**
 * Minimal KEY=VALUE loader for `.env.e2e`. Only fills env vars that are not
 * already set, so an explicit `bun --env-file` or shell export wins over the
 * file. Quotes and comments are handled; interpolation is not.
 */
function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val[0] === '"' && val[val.length - 1] === '"') ||
        (val[0] === "'" && val[val.length - 1] === "'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// --- Live fixtures ------------------------------------------------------------
//
// The suite resolves real row ids (server, node, blueprint, users) from the
// panel at start-up so it never hardcodes UUIDs that drift when the dev DB is
// reset. All the happy-path read tests run against the admin's own server and
// node. The user key, which has no relationship to that server, is used to
// assert the 404 "no access" path that the auth middleware returns to prevent
// information leakage (see auth/middleware.ts).

export interface Fixtures {
  /** A real server the admin owns. The admin key reaches every route on it. */
  serverId: string;
  /** The node that server lives on. */
  serverNodeId: string;
  /** The server's blueprint key (e.g. "minecraft-java"). */
  serverBlueprintKey: string;
  /** A real registered node id. */
  nodeId: string;
  /** An admin-surface blueprint id (UUID). */
  blueprintId: string;
  /** The admin account's user id. */
  adminUserId: string;
  /** The non-admin account's user id. */
  userUserId: string;
}

let _fixtures: Fixtures | null = null;

/**
 * Pull live ids from the panel so the suite doesn't hardcode UUIDs that drift
 * when the dev DB is reset. Cached after the first call. Throws if the panel
 * lacks a node/server/blueprint/non-admin user, i.e. the dev environment was
 * never seeded.
 */
export async function loadFixtures(): Promise<Fixtures> {
  if (_fixtures) return _fixtures;

  const [me, servers, nodes, blueprints, users] = await Promise.all([
    api("/api/me", { key: config.adminKey }),
    api("/api/admin/servers", { key: config.adminKey }),
    api("/api/admin/nodes", { key: config.adminKey }),
    api("/api/admin/blueprints", { key: config.adminKey }),
    api("/api/admin/users", { key: config.adminKey }),
  ]);

  if (me.status !== 200) {
    throw new Error(`loadFixtures: admin /api/me failed (${me.status}). Is the panel running with RATE_LIMIT_ENABLED=false?`);
  }

  const adminId = (me.body as { user?: { id?: string } }).user?.id;
  const srv = (servers.body as { servers?: Array<{ id?: string; nodeId?: string; blueprintKey?: string }> }).servers?.[0];
  const node = (nodes.body as { nodes?: Array<{ id?: string }> }).nodes?.[0];
  const bp = (blueprints.body as { blueprints?: Array<{ id?: string }> }).blueprints?.[0];
  const nonAdmin = (users.body as { users?: Array<{ id?: string; role?: string }> }).users?.find(
    (u) => u.role === "user",
  );

  if (!adminId || !srv?.id || !node?.id || !bp?.id || !nonAdmin?.id) {
    throw new Error(
      "loadFixtures: the dev panel needs at least one node, one server, one blueprint, and a non-admin user to run the suite.",
    );
  }

  _fixtures = {
    serverId: srv.id,
    serverNodeId: srv.nodeId ?? node.id,
    serverBlueprintKey: srv.blueprintKey ?? "",
    nodeId: node.id,
    blueprintId: bp.id,
    adminUserId: adminId,
    userUserId: nonAdmin.id,
  };
  return _fixtures;
}
