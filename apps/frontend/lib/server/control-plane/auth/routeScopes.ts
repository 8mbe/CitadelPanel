/**
 * The route → (resource, action) map that scoped API keys are enforced against
 * (see docs/api-keys.md).
 *
 * ## Why the map lives here and not on each guard
 *
 * The panel has one dispatcher (`app/api/[...path]/route.ts`) and roughly a
 * hundred handlers behind it, each already carrying its own authorization
 * (`requireAdmin`, `requireServerPermission`, …). Threading a second
 * permission argument through all of them would mean a hundred places where a
 * scope could be forgotten, and the only symptom would be a key quietly
 * reaching something it was not scoped to.
 *
 * So the scope check is a *gate in front of* the dispatcher, keyed on the same
 * two things the dispatcher itself routes on: the path and the method. It
 * narrows what a key may reach; it never widens anything, because the handler's
 * own guards still run afterwards. A key can only ever do the intersection of
 * "what its owner can do" and "what it is scoped to".
 *
 * ## Fail closed
 *
 * A path this module does not recognise resolves to `null`, and the gate turns
 * `null` into a denial for scoped keys. Adding a route without adding it here
 * therefore makes it unreachable *by scoped keys only* — cookie sessions and
 * unrestricted keys are unaffected. That is the safe direction to fail in: a
 * new endpoint is never silently in scope for a key that predates it.
 *
 * ## Reading the table
 *
 * Rules are ordered and the first match wins, mirroring the dispatcher's own
 * "exact before pattern, literal segment before `:id`" discipline. `action` is
 * derived from the method (GET/HEAD → read, everything else → write) unless a
 * rule pins it, which is needed wherever the panel uses POST for something that
 * reads: batched stats, probes, previews and preflights.
 */

import type { ApiKeyResource, ScopeAction } from "@/lib/api-key-scopes";

export interface RouteScope {
  resource: ApiKeyResource;
  action: ScopeAction;
}

interface ScopeRule {
  pattern: RegExp;
  resource: ApiKeyResource;
  /** Pins the action regardless of method. Omitted ⇒ derive from the method. */
  action?: ScopeAction;
}

/**
 * Paths that carry no scope requirement at all.
 *
 * Only two kinds qualify: liveness/branding endpoints that are unauthenticated
 * anyway (so gating them would protect nothing), and the setup wizard's status
 * probe, which the login page reads before anyone has an account. Everything
 * else in `setup/` mutates panel settings and is mapped to `admin_settings`
 * below.
 */
const UNSCOPED_PATHS: ReadonlySet<string> = new Set([
  "health",
  "settings/public",
  "setup/status",
]);

/** GET and HEAD read; everything else is treated as a write. */
export function actionForMethod(method: string): ScopeAction {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD" ? "read" : "write";
}

/**
 * Rules for the panel's own `/api/*` surface (the dispatcher's `path`, i.e.
 * without the `/api/` prefix).
 */
const RULES: readonly ScopeRule[] = [
  // --- Setup wizard ---------------------------------------------------------
  // `setup/status` is unscoped above; the rest write panel settings.
  { pattern: /^setup\//, resource: "admin_settings" },

  // --- The caller's own account --------------------------------------------
  { pattern: /^me$/, resource: "account" },
  { pattern: /^account\//, resource: "account" },

  // --- Server-scoped sections ----------------------------------------------
  // Each section comes before the catch-all `servers/...` rule at the end of
  // this block, so a section is never swallowed by the generic server scope.
  { pattern: /^servers\/[^/]+\/files(\/|$)/, resource: "files" },

  // Console: reading output is `read`, obtaining a session or sending a command
  // is `write` — a console session is a bidirectional terminal, not a log tail.
  { pattern: /^servers\/[^/]+\/logs$/, resource: "console", action: "read" },
  { pattern: /^servers\/[^/]+\/console\/stream$/, resource: "console", action: "read" },
  { pattern: /^servers\/[^/]+\/console\//, resource: "console", action: "write" },
  { pattern: /^servers\/[^/]+\/command$/, resource: "console", action: "write" },
  // The AI helper reads the server's own logs and asks a question about them;
  // it changes nothing on the server, so it is a console read.
  { pattern: /^servers\/[^/]+\/ai-helper$/, resource: "console", action: "read" },
  // Provisioning output. Admin-only in the handler, but it is still this
  // server's console output, so it is scoped with the rest of it.
  { pattern: /^servers\/[^/]+\/install-log$/, resource: "console", action: "read" },

  { pattern: /^servers\/[^/]+\/backups\/settings$/, resource: "backups" },
  { pattern: /^servers\/[^/]+\/backups(\/|$)/, resource: "backups" },
  // The explorer lives under a database, so it is matched by the same rule.
  { pattern: /^servers\/[^/]+\/databases(\/|$)/, resource: "databases" },
  { pattern: /^servers\/[^/]+\/schedules\/preview$/, resource: "schedules", action: "read" },
  { pattern: /^servers\/[^/]+\/schedules(\/|$)/, resource: "schedules" },
  { pattern: /^servers\/[^/]+\/subusers(\/|$)/, resource: "subusers" },
  { pattern: /^servers\/[^/]+\/sftp(\/|$)/, resource: "sftp" },
  { pattern: /^servers\/[^/]+\/plugins(\/|$)/, resource: "plugins" },

  // Batched live samples for the dashboard. POST only because the id list does
  // not fit a query string; it reads.
  { pattern: /^servers\/stats-batch$/, resource: "servers", action: "read" },
  // Everything else about a server: detail, power, env, ports, links, activity,
  // stats, reinstall, delete.
  { pattern: /^servers(\/|$)/, resource: "servers" },
  // The catalogue the create-server form reads.
  { pattern: /^blueprints(\/|$)/, resource: "servers", action: "read" },

  // --- API keys -------------------------------------------------------------
  // Both the admin oversight surface and (below) the plugin's self-service one.
  { pattern: /^admin\/api-keys(\/|$)/, resource: "api_keys" },

  // --- Admin: settings ------------------------------------------------------
  // The two provider probes POST because they carry a candidate config, but
  // neither changes panel state. `test-email` does send a message, so it is a
  // write.
  { pattern: /^admin\/settings\/ai\/(models|test)$/, resource: "admin_settings", action: "read" },
  { pattern: /^admin\/settings(\/|$)/, resource: "admin_settings" },
  { pattern: /^admin\/legal(\/|$)/, resource: "admin_settings" },

  // --- Admin: backups -------------------------------------------------------
  { pattern: /^admin\/backups\/(test|preview-schedule)$/, resource: "admin_backups", action: "read" },
  { pattern: /^admin\/backups(\/|$)/, resource: "admin_backups" },

  // --- Admin: nodes ---------------------------------------------------------
  // `probe` and `database/status` inspect a machine the operator is about to
  // register; they create nothing.
  { pattern: /^admin\/nodes\/probe$/, resource: "admin_nodes", action: "read" },
  { pattern: /^admin\/nodes\/database\/status$/, resource: "admin_nodes", action: "read" },
  { pattern: /^admin\/nodes(\/|$)/, resource: "admin_nodes" },

  // --- Admin: audit ---------------------------------------------------------
  { pattern: /^admin\/audit-logs(\/|$)/, resource: "admin_audit" },
  { pattern: /^admin\/suspicious-activity(\/|$)/, resource: "admin_audit" },
  { pattern: /^admin\/scan$/, resource: "admin_audit", action: "write" },

  // --- Admin: servers -------------------------------------------------------
  { pattern: /^admin\/servers\/[^/]+\/migrations\/preflight$/, resource: "admin_servers", action: "read" },
  { pattern: /^admin\/servers(\/|$)/, resource: "admin_servers" },

  // --- Admin: blueprints, users --------------------------------------------
  { pattern: /^admin\/blueprints(\/|$)/, resource: "admin_blueprints" },
  { pattern: /^admin\/users(\/|$)/, resource: "admin_users" },
];

/**
 * Rules for Better Auth's own surface, matched against the path *after*
 * `auth/`.
 *
 * These endpoints are reachable at `/api/auth/*`, which the dispatcher hands
 * straight to `auth.handler`, so they need mapping too — and two of them are
 * the reason scopes are worth anything at all. `api-key/*` is how a key could
 * mint an unrestricted successor, and `admin/*` is the auth plugin's own
 * ban/role surface, which would otherwise be an unscoped route to the very
 * actions `admin_users` gates.
 */
const AUTH_RULES: readonly ScopeRule[] = [
  { pattern: /^api-key(\/|$)/, resource: "api_keys" },
  // Read-shaped admin-plugin endpoints; everything else under it writes.
  { pattern: /^admin\/(list-users|has-permission)$/, resource: "admin_users", action: "read" },
  { pattern: /^admin(\/|$)/, resource: "admin_users" },
  // Sign-in/out, session listing and revocation, password, email, 2FA: all
  // operations on the key owner's own account.
  { pattern: /^/, resource: "account" },
];

/**
 * Resolve the scope a request needs, or `null` when the path is unknown.
 *
 * `undefined` is returned for the paths that require no scope at all, which the
 * gate must not confuse with `null` — one means "everyone may", the other means
 * "no scoped key may".
 */
export function resolveRouteScope(
  path: string,
  method: string,
): RouteScope | null | undefined {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (UNSCOPED_PATHS.has(normalized)) return undefined;

  const rules = normalized.startsWith("auth/") || normalized === "auth" ? AUTH_RULES : RULES;
  const subject =
    rules === AUTH_RULES ? normalized.replace(/^auth\/?/, "") : normalized;

  for (const rule of rules) {
    if (!rule.pattern.test(subject)) continue;
    return { resource: rule.resource, action: rule.action ?? actionForMethod(method) };
  }

  return null;
}
