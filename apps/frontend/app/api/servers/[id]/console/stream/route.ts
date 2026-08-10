/**
 * Live console log stream (Server-Sent Events).
 *
 * The browser opens an `EventSource` here to receive a server's console output
 * in real time. This handler is a thin authenticated proxy: it checks the
 * caller can access the server, looks up the node, then streams the agent's
 * `/v1/servers/:id/logs/stream` SSE feed straight through. The browser never
 * sees the agent's address or its bearer token.
 *
 * Transport is SSE rather than a WebSocket because Next.js Route Handlers
 * cannot hold a WebSocket open — the response is generated and the connection
 * closes. SSE streams fine from a Route Handler, and command input already has
 * its own audited endpoint (`POST /api/servers/:id/command`), so the stream is
 * output-only.
 *
 * Disconnect handling is the load-bearing part: the browser closing the
 * `EventSource` aborts `request.signal`, which aborts the `fetch` to the agent,
 * which aborts the agent's dockerode log stream — one unbroken chain, so no
 * daemon log stream is leaked when a user navigates away.
 */

import type { NextRequest } from "next/server";

import { requireServerPermission } from "@/lib/server/control-plane/auth/middleware";
import { sql } from "@/lib/server/control-plane/db/client";
import { requireUuidParam, toErrorResponse } from "@/lib/server/control-plane/lib/http";
import { normalizeApiUrl } from "@/lib/server/control-plane/nodes/nodeApi";
import { getNodeWithSecrets } from "@/lib/server/control-plane/nodes/nodeRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx (and compatible proxies) buffer responses by default, which would
  // defeat streaming. This opts the console feed out of buffering.
  "x-accel-buffering": "no",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const serverId = requireUuidParam(id, "serverId");

    // Authorize before any bytes are sent: owner, a subuser with the `console`
    // permission, or an admin. Throws 401/403/404 (the latter for "no access",
    // to avoid revealing that a server exists).
    await requireServerPermission(request, serverId, "console");

    const rows = (await sql`
      SELECT container_id, node_id FROM servers WHERE id = ${serverId}
    `) as { container_id: string | null; node_id: string }[];

    const server = rows[0];

    // The server exists (auth would have 404'd otherwise) but has no container
    // yet. Mirror the logs endpoint, which returns an empty body in this case:
    // stream nothing and close, so the console shows "Waiting for output…".
    if (!server?.container_id) {
      return emptyStream();
    }

    const node = await getNodeWithSecrets(server.node_id);
    if (!node?.apiToken) {
      return emptyStream("[panel] this server's node is not configured");
    }

    const baseUrl = normalizeApiUrl(node.apiUrl);
    const tail = request.nextUrl.searchParams.get("tail") ?? "200";
    const url = `${baseUrl}/v1/servers/${serverId}/logs/stream?tail=${encodeURIComponent(tail)}`;

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        headers: { authorization: `Bearer ${node.apiToken}` },
        // The browser disconnecting aborts this signal, which tears down the
        // fetch and the agent's dockerode stream behind it. Deliberately NOT a
        // timeout — a console stream lasts as long as the container runs.
        signal: request.signal,
      });
    } catch {
      // Node unreachable: surface it inline rather than as a bare connection
      // error that EventSource would swallow.
      return emptyStream("[panel] the node could not be reached");
    }

    if (!upstream.ok || !upstream.body) {
      return emptyStream("[panel] the console stream could not be opened");
    }

    // The agent already emits well-formed SSE; pass its body straight through.
    return new Response(upstream.body, { headers: SSE_HEADERS });
  } catch (error) {
    // Pre-stream failures (auth, bad UUID, DB) become normal JSON responses,
    // matching the catch-all's contract. Once the streaming Response above is
    // returned this is unreachable, so an SSE stream is never interrupted by a
    // late JSON body.
    return toErrorResponse(error);
  }
}

/**
 * A minimal SSE body that emits one optional `console` event, then closes.
 *
 * Used for every non-streaming outcome (no container, node unreachable, auth
 * aside). Emitted as a `console` event rather than `error` because EventSource
 * reserves `error` for transport failures and delivers no payload for them — a
 * named event lets the browser show the message.
 */
function emptyStream(message?: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (message) {
        controller.enqueue(
          encoder.encode(
            `event: console\ndata: ${JSON.stringify({ type: "console", message })}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
