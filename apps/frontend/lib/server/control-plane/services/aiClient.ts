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

  const data = (await response.json().catch(() => null)) as
    | { data?: Array<{ id?: string }> }
    | null;
  if (!data) {
    throw new HttpError(502, "The AI provider returned a malformed model list.");
  }
  return (data.data ?? [])
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
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
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HttpError(502, "Could not reach the AI provider. Check the API URL and network.");
  }

  if (!response.ok) await throwProviderError(response);

  const data = (await response.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null;
  if (!data) {
    throw new HttpError(502, "The AI provider returned a malformed response.");
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new HttpError(502, "The AI returned an empty response.");
  }
  return content.trim();
}
