/**
 * AI console helper — the user-facing half of the AI assistant.
 *
 * `POST /api/servers/:id/ai-helper` takes only the user's free-text question
 * and assembles the full prompt server-side: recent console logs, the game
 * (blueprint name + key), the game version, and the non-secret environment. The
 * browser never supplies context and never sees the API key — the same
 * "panel-composed, never browser-supplied" posture the database explorer takes
 * with SQL. A hostile client cannot redirect the model with injected context or
 * exfiltrate the key: there is nothing to exfiltrate, and the only client input
 * is the question itself.
 *
 * The route gates on the `console` permission (a subuser with console access
 * can use it; one without cannot). The call is audited with only the lengths of
 * the question and the gathered logs — never their contents, which may include
 * server output the operator would rather not store in the audit trail.
 */

import { requireServerPermission } from "../auth/middleware";
import { getBlueprintById } from "../blueprints/registry";
import { sql } from "../db/client";
import {
  badRequest,
  json,
  parseJsonBody,
  requireString,
  requireUuidParam,
} from "../lib/http";
import { getServerLogs } from "../nodes/nodeServerApi";
import { recordAuditFromRequest } from "../services/auditLog";
import { chatCompletion } from "../services/aiClient";
import { getAiApiKey, getAiSettings, isAiUsable } from "../services/settings";

/** The user's question is bounded so a prompt cannot be made arbitrarily long. */
const MAX_MESSAGE = 2000;
/** How many recent console lines to inject. Capped to keep the prompt bounded. */
const LOG_TAIL = 200;

/**
 * Gather the server-side context the model needs: the blueprint's human name
 * and key, the game version (if it is a non-secret env var), the non-secret
 * environment, and the recent console output. Logs are best-effort — a node
 * being unreachable yields an empty tail rather than a failed helper call,
 * because the user is often asking about exactly that (a server that won't
 * start) and the env/blueprint context is still useful without live output.
 */
async function gatherContext(serverId: string): Promise<{
  serverName: string;
  blueprintKey: string | null;
  blueprintName: string | null;
  env: { key: string; value: string }[];
  logs: string;
  logLines: number;
}> {
  const serverRows = (await sql`
    SELECT name, blueprint_id, node_id, container_id
    FROM servers WHERE id = ${serverId}
  `) as {
    name: string;
    blueprint_id: string;
    node_id: string;
    container_id: string | null;
  }[];
  const server = serverRows[0];
  if (!server) throw badRequest("Server not found.");

  const blueprint = server.blueprint_id
    ? await getBlueprintById(server.blueprint_id)
    : null;

  const envRows = (await sql`
    SELECT key, value FROM server_env
    WHERE server_id = ${serverId} AND is_secret = false
    ORDER BY key ASC
  `) as { key: string; value: string }[];

  let logs = "";
  if (server.container_id) {
    try {
      logs = await getServerLogs(server.node_id, serverId, LOG_TAIL);
    } catch {
      // Node unreachable — proceed without logs. The user is often asking
      // about a server that won't start, so env + blueprint context alone is
      // still useful, and the assistant can say it couldn't read live output.
    }
  }

  return {
    serverName: server.name,
    blueprintKey: blueprint?.key ?? null,
    blueprintName: blueprint?.name ?? null,
    env: envRows,
    logs,
    logLines: logs ? logs.split("\n").length : 0,
  };
}

/** Build the system prompt from the gathered context. */
function buildSystemPrompt(ctx: Awaited<ReturnType<typeof gatherContext>>): string {
  const versionKey = ctx.env.find((e) => e.key.toUpperCase() === "VERSION");
  const version = versionKey ? versionKey.value : null;

  const envBlock = ctx.env.length
    ? ctx.env.map((e) => `${e.key}=${e.value}`).join("\n")
    : "(none)";

  const logsBlock = ctx.logs
    ? ctx.logs
    : "(no recent console output — the server may be offline, or the node is unreachable)";

  return [
    "You are a game-server operations assistant inside CitadelPanel, a game-server control panel.",
    "The user runs a game server and is looking at its console output. They will describe what they want fixed or what is going wrong.",
    "",
    "Use the context below to diagnose the problem and give concrete, actionable steps to fix it.",
    "Prefer specific commands or config changes the user can run from the in-panel console or file manager.",
    "If the logs show a known error pattern, name it and quote the relevant log line.",
    "Be concise and practical. If you cannot diagnose from the logs, say what additional information would help.",
    "Do not invent commands or files that do not exist for this game.",
    "",
    "Context:",
    `- Server name: ${ctx.serverName}`,
    `- Game (blueprint): ${ctx.blueprintKey ?? "unknown"}${ctx.blueprintName ? ` (${ctx.blueprintName})` : ""}`,
    `- Game version: ${version ?? "not set"}`,
    `- Non-secret environment:`,
    envBlock,
    "",
    `Recent console output (last ${ctx.logLines || LOG_TAIL} lines):`,
    logsBlock,
  ].join("\n");
}

/**
 * POST /api/servers/:id/ai-helper — ask the assistant about this server.
 *
 * Body: `{ message: string }`. Returns `{ reply: string }`.
 */
export async function handleServerAiHelper(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "console");

  const body = await parseJsonBody(request);
  const message = requireString(body, "message", {
    min: 1,
    max: MAX_MESSAGE,
  }).trim();
  if (!message) throw badRequest('"message" must not be empty.');

  const ai = await getAiSettings();
  if (!isAiUsable(ai) || !ai.apiUrl || !ai.model) {
    throw badRequest(
      "The AI assistant is not configured. Ask the panel administrator to enable it.",
    );
  }
  const apiKey = await getAiApiKey();
  if (!apiKey) {
    throw badRequest("The AI assistant is not configured.");
  }

  const ctx = await gatherContext(id);
  const systemPrompt = buildSystemPrompt(ctx);

  const reply = await chatCompletion(
    { apiUrl: ai.apiUrl, apiKey, model: ai.model },
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
  );

  // Audit only the lengths — the question and logs may contain output the
  // operator would rather not persist in the audit trail. Fire-and-forget.
  void recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.ai.helper",
    targetType: "server",
    targetId: id,
    metadata: {
      messageLength: message.length,
      logLines: ctx.logLines,
      model: ai.model,
    },
  });

  return json({ reply });
}
