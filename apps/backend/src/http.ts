/**
 * Minimal HTTP helpers, mirroring the panel backend's `lib/http.ts` so error
 * shapes are consistent across both services and the panel can surface an
 * agent's message verbatim.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Machine-readable tag for the failures a caller reacts to rather than just
     * displays (`no_container` so far). The message stays the human's version;
     * this is what the panel and the browser branch on, so their handling does
     * not depend on matching an English sentence.
     */
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = "Authentication required") =>
  new HttpError(401, message);
export const forbidden = (message = "Forbidden") => new HttpError(403, message);
export const notFound = (message = "Not found", code?: string) =>
  new HttpError(404, message, code);
export const conflict = (message: string) => new HttpError(409, message);
export const payloadTooLarge = (message: string) => new HttpError(413, message);
/**
 * The node is correctly refusing work it cannot currently do, say because the
 * data root is unwritable. Distinct from 500: nothing here is a bug, and the message is
 * written for the admin who will fix the node.
 */
export const serviceUnavailable = (message: string) => new HttpError(503, message);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Headers for a Server-Sent Events stream. `no-transform` stops proxies from
 * buffering the response, which would defeat the point of streaming.
 */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx (and compatible proxies) buffer responses by default, which would
  // defeat streaming. This opts the console feed out of buffering.
  "x-accel-buffering": "no",
};

/**
 * Encode a complete log payload as one or more Server-Sent Events `data:`
 * chunks. Each newline-delimited line becomes its own event (`data: <line>\n\n`),
 * so a Docker frame carrying several log lines is split cleanly for the client
 * to append line-by-line. Trailing empty lines produce no event.
 */
function sseData(payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const lines = payload.split("\n");
  let out = "";
  for (const line of lines) {
    // An empty trailing token (from a payload ending in "\n") is not a line.
    if (line.length === 0) continue;
    out += `data: ${line}\n\n`;
  }
  return encoder.encode(out);
}

/**
 * Wrap a stream of raw payload bytes as a Server-Sent Events body.
 *
 * Bytes are decoded to text and split on newlines: each completed line becomes
 * a `data:` event. A trailing partial line (no newline yet) is buffered until
 * the next chunk completes it, so a log line split across two Docker frames is
 * emitted as one event, not two.
 *
 * Push-driven (reads the upstream in a loop inside `start`) rather than
 * `pull`-driven: a chunk that holds only a partial line enqueues nothing, and a
 * demand-driven `pull` would then stall waiting for the next read with no new
 * demand to trigger it. The loop keeps reading until the upstream ends.
 *
 * A `: ping` SSE comment is emitted every few seconds of silence. Game servers
 * go quiet between events, and Bun's HTTP server closes idle connections after
 * ~10s. Without the keepalive the stream dies and the browser's EventSource
 * reconnect-storms. A comment line is valid SSE that EventSource ignores, so it
 * keeps the connection alive without polluting the console.
 */
export function sseWrap(
  body: ReadableStream<Uint8Array>,
  options: { keepaliveMs?: number } = {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const ping = new TextEncoder().encode(": ping\n\n");
  const keepaliveMs = options.keepaliveMs ?? 5_000;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (pingTimer) clearInterval(pingTimer);
      };

      // Re-armed each time data flows, so pings only appear during genuine
      // silence, never interleaved with a burst of log lines.
      pingTimer = setInterval(() => {
        if (!stopped) controller.enqueue(ping);
      }, keepaliveMs);

      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (pending.length > 0) controller.enqueue(sseData(pending));
              break;
            }

            pending += decoder.decode(value, { stream: true });
            const lastNewline = pending.lastIndexOf("\n");
            if (lastNewline !== -1) {
              const complete = pending.slice(0, lastNewline + 1);
              pending = pending.slice(lastNewline + 1);
              controller.enqueue(sseData(complete));
            }
          }
        } catch (error) {
          stop();
          controller.error(error);
          return;
        }
        stop();
        controller.close();
      })();
    },
    cancel() {
      // The downstream client disconnected: release the upstream reader so the
      // agent's log stream (and its dockerode handle) is torn down.
      clearInterval(pingTimer);
      reader.cancel().catch(() => undefined);
      reader.releaseLock();
    },
  });
}

/**
 * Build a one-shot SSE body from a list of typed events, then end the stream.
 *
 * Used to deliver a terminal error (e.g. "no container") as an SSE event the
 * browser can surface, rather than a bare HTTP error that EventSource hides.
 *
 * The event type is named `console` rather than `error`: EventSource reserves
 * the `error` event name for transport failures (which fire `onerror` and
 * carry no payload), so a named event lets the client read the message.
 */
export function sseFromEvents(
  events: Array<{ type: string; [key: string]: unknown }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Convert a thrown value into a response.
 *
 * Unexpected errors are logged in full but reported generically: the panel is
 * trusted, but an agent stack trace still has no business crossing the network.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      error.code ? { error: error.message, code: error.code } : { error: error.message },
      error.status,
    );
  }

  console.error("[agent] unhandled error:", error);
  return json({ error: "Internal agent error" }, 500);
}

/** Parse a JSON body, rejecting anything that is not a plain object. */
export async function parseJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a server id.
 *
 * Server ids come from the panel's `uuid` primary key and are used to build
 * filesystem paths and container names, so anything non-UUID is rejected before
 * it can reach either.
 */
export function requireServerId(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw badRequest("serverId must be a UUID.");
  }
  return value;
}
