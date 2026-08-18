/**
 * OpenAI-compatible chat client.
 *
 * The panel calls the AI provider server-side only: the browser never receives
 * the API key and never composes the prompt (it sends only the free-text
 * question). This matches the "panel-composed, never browser-supplied" posture
 * the database explorer takes with SQL — the prompt is assembled here from
 * server-side context (logs, game, version), not from client input.
 *
 * The base URL is whatever the admin configured (`apiUrl`), with `/models` and
 * `/chat/completions` appended. OpenAI, OpenRouter, Together, local llama.cpp,
 * Ollama, and any other server that speaks the OpenAI HTTP shape all work
 * against the same two endpoints.
 */
import "server-only";

import { HttpError } from "../lib/http";

/** The chat message shape the OpenAI completions endpoint expects. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Resolve the admin-supplied base URL into a full endpoint URL. */
function joinUrl(base: string, path: string): string {
  // Trim trailing slashes so "https://x/v1/" and "https://x/v1" behave the same.
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** Convert a non-2xx provider response into a thrown HttpError with its body. */
async function throwProviderError(response: Response): Promise<never> {
  const text = await response.text().catch(() => "");
  const trimmed = text.slice(0, 500);
  throw new HttpError(
    response.status,
    response.status === 401 || response.status === 403
      ? `The AI provider rejected the API key (${response.status}).`
      : `The AI provider returned an error (${response.status})${trimmed ? `: ${trimmed}` : "."}`,
  );
}

export interface AiProviderConfig {
  apiUrl: string;
  apiKey: string;
}

/**
 * Fetch the list of model ids the provider offers, for the admin settings
 * "fetch models" button. Returns ids only — enough to populate a select.
 */
export async function fetchAiModels(
  config: AiProviderConfig,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(joinUrl(config.apiUrl, "/models"), {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "Could not reach the AI provider. Check the API URL and network.");
  }

  if (!response.ok) await throwProviderError(response);

  const text = await response.text().catch(() => "");
  const trimmed = text.trim();
  if (!trimmed) {
    throw new HttpError(502, "The AI provider returned an empty model list.");
  }
  // The standard shape is `{ data: [{ id }] }`. Some compatible providers
  // return a bare top-level array; both are handled here.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(502, "The AI provider returned a malformed model list.");
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { data?: unknown })?.data;
  if (!Array.isArray(list)) {
    throw new HttpError(502, "The AI provider returned a malformed model list.");
  }
  return list
    .map((m) => (m as Record<string, unknown> | null)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Extract the assistant's reply text from a parsed OpenAI chat-completion
 * object. Handles three shapes the ecosystem actually sends:
 *   - `choices[0].message.content` as a string (the standard).
 *   - `choices[0].message.content` as an array of `{ text }` parts (some
 *     proxies / newer OpenAI responses).
 *   - `choices[0].text` (the legacy completions shape some compatible servers
 *     still return).
 */
function extractContent(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as Record<string, unknown> | undefined;
  if (!choice) return null;

  const message = choice.message as Record<string, unknown> | undefined;
  if (message) {
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const joined = content
        .map((p) => (p as Record<string, unknown> | null)?.text)
        .filter((t): t is string => typeof t === "string")
        .join("");
      if (joined) return joined;
    }
  }
  if (typeof choice.text === "string") return choice.text;
  return null;
}

/**
 * Parse a Server-Sent-Events stream body into the concatenated reply.
 *
 * Some OpenAI-compatible providers stream by default even when `stream:false`
 * is requested (or ignore it). The body is then `data: {json}\n\ndata:
 * {json}\n\ndata: [DONE]` — not valid JSON as a whole, so `response.json()`
 * throws. Each chunk carries `choices[0].delta.content`; concatenating them
 * reconstructs the full reply.
 */
function parseSseStream(text: string): string | null {
  let result = "";
  for (const line of text.split("\n")) {
    const d = line.trim();
    if (!d.startsWith("data:")) continue;
    const payload = d.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as unknown;
      const delta = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> })
        ?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") result += delta;
    } catch {
      // Skip an unparseable chunk — partial SSE is still salvageable.
    }
  }
  return result || null;
}

/**
 * Parse the raw response body of a chat-completion call into the reply text,
 * tolerating the three ways OpenAI-compatible providers actually respond:
 * standard JSON, an unexpected SSE stream, or plain text. HTML (an error page
 * served with a 2xx) is rejected rather than echoed back as a reply.
 */
function parseChatResponse(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Standard OpenAI JSON shape (or a non-standard one — extractContent
  // handles the variants).
  try {
    const content = extractContent(JSON.parse(trimmed));
    if (content) return content;
  } catch {
    // Not JSON — fall through to the SSE / plain-text cases.
  }

  // An unexpected stream: the provider streamed despite stream:false.
  if (trimmed.startsWith("data:")) {
    const sse = parseSseStream(trimmed);
    if (sse) return sse;
  }

  // Plain text — some minimal providers return the reply directly. Reject
  // HTML (likely a misrouted error page) rather than presenting it as a reply.
  if (trimmed.startsWith("<")) return null;
  return trimmed;
}

export interface AiChatConfig extends AiProviderConfig {
  model: string;
}

/**
 * Send a chat completion request and return the assistant's reply text.
 *
 * Used by both the admin "test" button (a trivial ping) and the console helper
 * (a full context-bearing prompt). The timeout is generous because model
 * inference can take tens of seconds on a cold provider.
 *
 * The request explicitly sends `stream: false`; some providers stream by
 * default and would otherwise return an SSE body that is not valid JSON. The
 * response parser tolerates an SSE body anyway, for providers that ignore the
 * hint — matching how every OpenAI-compatible server in the wild actually
 * behaves.
 */
export async function chatCompletion(
  config: AiChatConfig,
  messages: ChatMessage[],
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(joinUrl(config.apiUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HttpError(502, "Could not reach the AI provider. Check the API URL and network.");
  }

  if (!response.ok) await throwProviderError(response);

  const text = await response.text().catch(() => "");
  const content = parseChatResponse(text);
  if (!content || !content.trim()) {
    // Log a truncated body so an operator can see what the provider actually
    // returned when the shape is one the parser does not recognize.
    console.error(
      `[ai] unparseable chat response from ${config.apiUrl} (model ${config.model}):`,
      text.slice(0, 200),
    );
    throw new HttpError(
      502,
      text.trim().startsWith("<")
        ? "The AI provider returned an HTML page instead of a completion — the API URL may point at a web UI rather than the API endpoint."
        : "The AI provider returned an empty response. Check the model and API URL.",
    );
  }
  return content.trim();
}
