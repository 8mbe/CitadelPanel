/**
 * Outbound console-session callbacks to the panel.
 *
 * The browser-direct console WebSocket (see `server.ts`) authenticates with a
 * short-lived capability token minted by the panel, not the agent's long-lived
 * bearer. The agent has no user model, no session table, and no audit log of its
 * own. The panel owns all three. So when a browser opens a console socket, and
 * on every command it types, the agent calls back here so the panel can:
 *
 *   1. validate the token and atomically mark it consumed (`validateConsoleSession`),
 *   2. record the `server.console.command` audit row attributed to the token's
 *      user (`recordConsoleCommand`).
 *
 * Both calls carry the agent's own bearer (`config.token`) so the panel can
 * reverse-identify which node is calling. The token itself identifies the user
 * via the panel's `console_sessions` row; the agent never learns or sends the
 * userId, which keeps a compromised agent from spoofing attribution.
 *
 * This module is stateless: no maps, no caches, no retry queues, matching the
 * agent's deliberate "no users, sessions or permissions here" posture. A dropped
 * audit callback means an unaudited command (see the plan's Known limitations);
 * that is preferable to buffering state in the agent or blocking console input.
 */

import { config } from "./config";

interface PanelError extends Error {
  status?: number;
}

/** A non-2xx response from the panel, thrown so the WS handshake can 401 it. */
class PanelRejectedError extends Error implements PanelError {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PanelRejectedError";
    this.status = status;
  }
}

/**
 * The panel base URL for callbacks.
 *
 * Read from the environment at call time rather than from the import-time
 * `config` object: the agent's other config (token, data root) is security- or
 * path-critical and correctly frozen at boot, but the callback URL is an
 * operational detail an operator may re-point without restarting the agent.
 * Reading it lazily also keeps the direct-console tests from being coupled to
 * module-load order (`config` is shared across Bun's test files).
 */
function panelUrl(): string {
  return process.env.PANEL_URL ?? config.panelUrl;
}

/** Build the authenticated JSON POST to a panel console endpoint. */
function panelPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  return fetch(`${panelUrl()}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Validate a capability token with the panel and mark it consumed.
 *
 * Called (and awaited) at WebSocket open. Single-use is enforced atomically on
 * the panel side, so two simultaneous handshakes for the same token see only one
 * 200. Throws on any non-2xx or network failure, and the caller turns that into
 * a 401 handshake rejection.
 */
export async function validateConsoleSession(
  token: string,
): Promise<{ serverId: string; userId: string }> {
  let response: Response;
  try {
    response = await panelPost(
      "/api/internal/console/sessions/validate",
      { token },
      3_000,
    );
  } catch (error) {
    throw new PanelRejectedError(
      `panel validate callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new PanelRejectedError(
      `panel rejected console session (status ${response.status})`,
      response.status,
    );
  }

  const parsed = (await response.json()) as { serverId?: unknown; userId?: unknown };
  if (typeof parsed.serverId !== "string" || typeof parsed.userId !== "string") {
    throw new PanelRejectedError("panel validate response was malformed");
  }
  return { serverId: parsed.serverId, userId: parsed.userId };
}

/**
 * Record a console command's audit entry via the panel.
 *
 * Fire-and-forget at the call site (`void recordConsoleCommand(...)`): a console
 * command must never block on, or fail because of, the audit trail, the same
 * posture the panel's own `recordAudit` takes (log-and-swallow). A dropped call
 * leaves the command unaudited; that gap is monitored at the panel-reachability
 * layer, not papered over with a retry queue here.
 */
export async function recordConsoleCommand(
  token: string,
  serverId: string,
  command: string,
): Promise<void> {
  try {
    await panelPost(
      "/api/internal/console/audit",
      { token, serverId, command },
      2_000,
    );
  } catch (error) {
    // Swallowed, never rethrown. See the module docstring. Logged so a
    // panel-reachability problem is visible without a separate monitor.
    console.error(
      `[agent] console audit callback failed for ${serverId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
