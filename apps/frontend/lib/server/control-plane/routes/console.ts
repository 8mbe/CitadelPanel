/**
 * Direct-console WebSocket capability-token routes.
 *
 * The live console is a browser → agent WebSocket (no panel-held connection).
 * Because a browser cannot set headers on a WS handshake, the panel can't hand
 * the browser the long-lived agent bearer, so it mints a short-lived,
 * single-use capability token instead. Three endpoints cooperate:
 *
 *   1. `POST /api/servers/:id/console/session`. The browser asks for a console.
 *      The panel checks the `console` permission, mints a UUID token, stores a
 *      `console_sessions` row, and returns `{token, url}`. The browser opens the
 *      WS at that URL; the agent validates the token against endpoint #2.
 *   2. `POST /api/internal/console/sessions/validate`. The agent calls back at
 *      WS open. The panel authenticates the agent by its long-lived token
 *      (`findNodeByAgentToken`), atomically marks the session upgraded (so a
 *      replayed token can't open a second console), and returns the serverId/
 *      userId the socket needs.
 *   3. `POST /api/internal/console/audit`. The agent calls back on each command
 *      typed, so the panel can write the `server.console.command` audit row
 *      attributed to the token's user. The agent never learns the userId; it
 *      sends only the token, which the panel resolves, so a compromised agent
 *      cannot spoof attribution.
 *
 * The agent stays stateless (it pulls validation per-connection); this table is
 * the source of truth, giving instant revocation and surviving agent restarts.
 */

import { randomUUID } from "node:crypto";

import { requireServerPermission } from "@/lib/server/control-plane/auth/middleware";
import { sql } from "@/lib/server/control-plane/db/client";
import {
  badRequest,
  clientIp,
  json,
  noContent,
  parseJsonBody,
  requireString,
  requireUuidParam,
  unauthorized,
} from "@/lib/server/control-plane/lib/http";
import {
  normalizeApiUrl,
  nodeRequestRaw,
} from "@/lib/server/control-plane/nodes/nodeApi";
import {
  findNodeByAgentToken,
  getNodeWithSecrets,
} from "@/lib/server/control-plane/nodes/nodeRegistry";
import { recordAudit } from "@/lib/server/control-plane/services/auditLog";

/** How long a minted token may sit unused before its WS open is rejected. */
const SESSION_TTL_SECONDS = 60;

/**
 * Response headers for the proxied console stream.
 *
 * Every one of these exists to stop something in the path from holding bytes
 * back. A console that arrives in one-kilobyte batches is not a live console,
 * and the panel sits behind at least one reverse proxy in every real install:
 *
 *   - `no-transform` forbids a proxy from gzipping the stream, which would
 *     otherwise buffer until the compressor's window fills.
 *   - `x-accel-buffering: no` is nginx's opt-out (Caddy and Traefik honour it
 *     too); without it nginx buffers proxied responses by default.
 *   - `connection: keep-alive` keeps the hop open for the life of the stream.
 *
 * The agent sets the same set on its own SSE response; they are repeated here
 * because the panel→browser hop is a *different* connection through different
 * proxies than the agent→panel one.
 */
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * Pull the agent's long-lived bearer from a request and resolve it to a node,
 * or throw 401. Shared by the two agent-callback endpoints.
 */
async function requireCallingAgent(request: Request) {
  const header = request.headers.get("authorization");
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) throw unauthorized("A valid agent bearer token is required.");
  const node = await findNodeByAgentToken(match[1]!);
  if (!node) throw unauthorized("Unknown agent token.");
  return node;
}

/**
 * Build the browser WebSocket URL for a node: prefer an explicit `console_url`,
 * otherwise derive ws/wss from `api_url`'s scheme.
 *
 * Returns the scheme separately so the caller can run the mixed-content check.
 */
function deriveWsUrl(
  apiUrl: string,
  consoleUrl: string | null,
): { url: URL; scheme: "ws" | "wss" } {
  const base = consoleUrl ?? apiUrl;
  const normalized = normalizeApiUrl(base);
  const parsed = new URL(normalized);
  const scheme: "ws" | "wss" = parsed.protocol === "https:" ? "wss" : "ws";
  parsed.protocol = scheme;
  parsed.pathname = "";
  return { url: parsed, scheme };
}

/**
 * `POST /api/servers/:id/console/session` mints a console capability token.
 *
 * Authorized like the SSE stream and command routes before it: the caller needs
 * the `console` permission. The returned URL points the browser straight at the
 * agent; the panel is then out of the data path.
 */
export async function handleConsoleSession(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "console");

  const rows = (await sql`
    SELECT s.node_id, n.console_url, n.api_url, COALESCE(b.tty, false) AS tty
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    LEFT JOIN blueprints b ON b.id = s.blueprint_id
    WHERE s.id = ${id}
  `) as {
    node_id: string;
    console_url: string | null;
    api_url: string;
    tty: boolean;
  }[];

  const server = rows[0];
  if (!server) return json({ error: "Server not found" }, 404);

  const node = await getNodeWithSecrets(server.node_id);
  if (!node) return json({ error: "Server not found" }, 404);

  const { url, scheme } = deriveWsUrl(server.api_url, server.console_url);

  // Mixed-content guard: an https page cannot open ws:// (the browser blocks it
  // silently). Rather than hand the browser a URL that will fail opaquely,
  // refuse the mint with an actionable message. Page protocol comes from the
  // standard proxy header, falling back to the request URL, the same approach
  // as clientIp().
  const pageProto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    new URL(request.url).protocol.replace(":", "");
  if (pageProto === "https" && scheme === "ws") {
    throw badRequest(
      "This node's console URL must use wss:// (TLS) because the panel is " +
        "served over HTTPS. Configure the node with a TLS-terminated agent URL " +
        "or a console_url using wss://.",
    );
  }

  const token = randomUUID();
  // Cast the interval parameter so Postgres can type the bound `$n`. Without
  // it, `interval '...' seconds` leaves the parameter's type ambiguous (42P18).
  // The `::int` pins the multiplier, and `make_interval` builds the value.
  await sql`
    INSERT INTO console_sessions (token, server_id, user_id, node_id, expires_at)
    VALUES (
      ${token}, ${id}, ${user.id}, ${server.node_id},
      now() + make_interval(secs => ${SESSION_TTL_SECONDS}::int)
    )
  `;

  url.pathname = `/v1/sessions/${token}/console`;
  return json({ token, url: url.toString(), tty: server.tty });
}

/**
 * `POST /api/internal/console/sessions/validate` is the agent callback at WS
 * open.
 *
 * Atomically marks the token consumed so a replayed token (two browser tabs, a
 * leaked URL) cannot open a second console. Binds the session to the calling
 * node: a token minted for node X is rejected if node Y presents it.
 */
export async function handleConsoleSessionValidate(
  request: Request,
): Promise<Response> {
  const node = await requireCallingAgent(request);
  const body = await parseJsonBody(request);
  const token = requireString(body, "token", { max: 64 });

  const rows = (await sql`
    UPDATE console_sessions
    SET upgraded_at = now()
    WHERE token = ${token}
      AND upgraded_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    RETURNING server_id, user_id, node_id
  `) as {
    server_id: string;
    user_id: string;
    node_id: string;
  }[];

  const session = rows[0];
  if (!session) throw unauthorized("Console session is invalid or expired.");
  if (session.node_id !== node.id) {
    // A token leaked from one node cannot be consumed by another.
    throw unauthorized("Console session does not belong to this node.");
  }

  return json({ serverId: session.server_id, userId: session.user_id });
}

/**
 * `POST /api/servers/:id/console/revoke` gives up a console session.
 *
 * Called by the browser when the user genuinely leaves the page (unmount on
 * client-side navigation, or `pagehide` on tab close / reload / back-button),
 * as opposed to a transient WebSocket drop which just reconnects. Revoking
 * means a subsequent reconnect attempt mints a fresh token, but the dropped
 * token can no longer upgrade (open a WS) or feed audit callbacks, so a token
 * leaked from the URL bar can't be replayed once the user has navigated away.
 *
 * It does NOT sever an already-open socket: the agent is stateless and holds no
 * handle back to the panel. A live session stays live until the socket's own
 * close; revoke only takes effect on the next upgrade attempt.
 *
 * Scoped to the caller: a user can only revoke their own sessions, and
 * idempotent (revoking an already-revoked or unknown token is a no-op 204) so
 * the unmount + pagehide double-fire from a single leave is harmless.
 */
export async function handleConsoleRevoke(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "console");
  const body = await parseJsonBody(request);
  const token = requireString(body, "token", { max: 64 });

  // Scope by user_id so one user can't revoke another's session, and only touch
  // rows that are still active. No row affected (already revoked, never
  // existed, belonged to someone else) is a no-op. The caller's intent ("this
  // token is done") is already satisfied.
  await sql`
    UPDATE console_sessions
    SET revoked_at = now()
    WHERE token = ${token}
      AND user_id = ${user.id}
      AND revoked_at IS NULL
  `;

  return noContent();
}

/**
 * `POST /api/internal/console/audit` is the agent callback on each typed
 * command.
 *
 * The agent sends the token + the command; the panel resolves the user from the
 * session row (never trusting an agent-supplied userId) and writes the audit
 * entry. A valid, upgraded, non-revoked session bound to the calling node is
 * required, so a stale or replayed token can't keep minting audit rows.
 */
export async function handleConsoleAudit(request: Request): Promise<Response> {
  const node = await requireCallingAgent(request);
  const body = await parseJsonBody(request);
  const token = requireString(body, "token", { max: 64 });
  const serverId = requireString(body, "serverId", { max: 64 });
  const command = requireString(body, "command", { max: 4096 });

  const rows = (await sql`
    SELECT user_id, node_id, server_id, upgraded_at, revoked_at, created_at
    FROM console_sessions
    WHERE token = ${token}
  `) as {
    user_id: string;
    node_id: string;
    server_id: string;
    upgraded_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
  }[];

  const session = rows[0];
  if (!session) throw unauthorized("Console session not found.");
  if (session.revoked_at || !session.upgraded_at) {
    throw unauthorized("Console session is not active.");
  }
  if (session.node_id !== node.id) {
    throw unauthorized("Console session does not belong to this node.");
  }
  if (session.server_id !== serverId) {
    throw unauthorized("Console session does not match this server.");
  }
  // Bound how long a live session's audit callbacks are honored after upgrade.
  if (Date.now() - session.created_at.getTime() > 60 * 60 * 1000) {
    throw unauthorized("Console session has expired.");
  }

  await recordAudit({
    userId: session.user_id,
    action: "server.console.command",
    targetType: "server",
    targetId: serverId,
    // The agent's IP, not the user's, but still useful for forensics (which
    // node relayed the command). The user is identified by userId above.
    ip: clientIp(request),
    metadata: { command: command.slice(0, 500) },
  });

  return noContent();
}

/**
 * `GET /api/servers/:id/console/stream` is the panel-proxied console feed.
 *
 * The fallback for every deployment where the direct WebSocket cannot work.
 * The direct console needs an agent the *browser* can reach over `wss://`, and
 * two common setups have no such address at all: an agent published only on the
 * panel's private Docker network (`api_url: http://backend:8081`, the bundled
 * compose), and an agent with no TLS certificate behind an HTTPS panel (the
 * mixed-content refusal in {@link handleConsoleSession}). In both the mint is
 * the wrong thing to hand a browser, so the console falls back to here and the
 * panel carries the bytes instead.
 *
 * The trade the direct socket exists to avoid (see docs/direct-console.md) is
 * real and is accepted knowingly: the panel now holds one upstream connection
 * per viewer. That is the price of a console that works without exposing the
 * agent publicly, and it is paid only by deployments that cannot do better.
 *
 * Output only. SSE is one-directional, so input keeps going through the
 * existing `POST /api/servers/:id/command`, which already checks the same
 * `console` permission and writes the same `server.console.command` audit row.
 * Attribution is therefore *better* on this path than on the direct socket:
 * the command transits the panel, so nothing has to be resolved from a
 * capability token handed to an agent.
 *
 * The agent's own stream is passed through untouched rather than re-parsed. It
 * already emits the same `output`/`console` event shapes the WebSocket sends,
 * so the browser runs one frame handler for both transports. Only a leading
 * `ready` event is prepended, carrying the blueprint's `tty` flag — the one
 * piece of state the WS path gets from the session mint, and which the console
 * needs before the first frame to decide whether to echo typed commands.
 *
 * `request.signal` is forwarded through the node client to the agent, which
 * forwards it to dockerode: closing the console tab releases the Docker log
 * stream, with no leaked attach anywhere along the chain.
 */
export async function handleConsoleStream(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "console");

  const rows = (await sql`
    SELECT s.node_id, COALESCE(b.tty, false) AS tty
    FROM servers s
    LEFT JOIN blueprints b ON b.id = s.blueprint_id
    WHERE s.id = ${id}
  `) as { node_id: string; tty: boolean }[];

  const server = rows[0];
  if (!server) return json({ error: "Server not found" }, 404);

  const raw = Number(new URL(request.url).searchParams.get("tail"));
  const tail = Math.min(Math.max(Number.isFinite(raw) ? raw : 200, 1), 2000);

  const upstream = await nodeRequestRaw(
    server.node_id,
    `/v1/servers/${id}/logs/stream`,
    { query: { tail }, signal: request.signal },
  );

  // The `tty` flag the WS path gets from the session mint. The console needs it
  // before the first output frame (it decides whether typed commands are echoed
  // locally), so it leads the stream as a `ready` event in the same shape the
  // WebSocket sends.
  // A *named* event, like the agent's own error frames. An unnamed `data:`
  // event is how the agent sends a plain log line, so a nameless ready frame
  // would be appended to the console as literal JSON text.
  const ready = new TextEncoder().encode(
    `event: ready\ndata: ${JSON.stringify({ type: "ready", tty: server.tty })}\n\n`,
  );

  const stream = upstream.body;
  if (!stream) return new Response(ready, { headers: SSE_HEADERS });

  // Prepend the ready frame, then forward the agent's bytes as they arrive.
  // Chunks are passed straight through, never accumulated: a log line must
  // reach the browser as the container writes it, not when some buffer fills.
  const merged = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(ready);
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // Upstream dropped (agent restart, container gone, client abort). The
        // browser's EventSource reconnects on its own, so end the stream
        // quietly rather than surfacing a transport error as console text.
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
    cancel() {
      // The browser went away. Drop the upstream so the agent's dockerode
      // attach is released instead of lingering until its own timeout.
      void stream.cancel().catch(() => undefined);
    },
  });

  return new Response(merged, { headers: SSE_HEADERS });
}
