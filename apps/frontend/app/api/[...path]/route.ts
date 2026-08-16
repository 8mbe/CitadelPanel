import type { NextRequest } from "next/server";

import { auth } from "@/lib/server/control-plane/auth/betterAuth";
import { requireServerPermission } from "@/lib/server/control-plane/auth/middleware";
import { checkDatabaseConnection, sql } from "@/lib/server/control-plane/db/client";
import { json, parseJsonBody, requireString, toErrorResponse } from "@/lib/server/control-plane/lib/http";
import { sendServerCommand } from "@/lib/server/control-plane/nodes/nodeServerApi";
import {
  handleAdminCreateServer,
  handleBanUser,
  handleGetSuspicious,
  handleListAdminServers,
  handleListAuditLogs,
  handleListSuspicious,
  handleListUsers,
  handleReviewSuspicious,
  handleSuspendServer,
  handleTriggerScan,
  handleUnbanUser,
  handleUnsuspendServer,
  handleUpdateServerResources,
  handleUpdateUserRole,
} from "@/lib/server/control-plane/routes/admin";
import {
  handleAdminCreateBlueprint,
  handleAdminDeleteBlueprint,
  handleAdminGetBlueprint,
  handleAdminImportBlueprintUrl,
  handleAdminListBlueprints,
  handleAdminUpdateBlueprint,
} from "@/lib/server/control-plane/routes/blueprints";
import {
  handleCreateDirectory,
  handleDeleteFiles,
  handleDownloadFile,
  handleListFiles,
  handlePullFromUrl,
  handleReadFile,
  handleRenameFile,
  handleUploadFile,
  handleWriteFile,
} from "@/lib/server/control-plane/routes/files";
import {
import {
  handleAllNodesHealth,
  handleCreateNode,
  handleDeleteNode,
  handleDeleteNodePortPoolEntry,
  handleGetNode,
  handleAddNodePortPoolEntry,
  handleListNodePortPool,
  handleListNodes,
  handleNodeHealth,
  handleProbeNode,
  handleUpdateNode,
} from "@/lib/server/control-plane/routes/nodes";
import {
  handleDeleteServer,
  handleGetServer,
  handleGetServerEnv,
  handleGetServerLogs,
  handleGetServerStats,
  handleKillServer,
  handleListBlueprints,
  handleListServers,
  handleRestartServer,
  handleStartServer,
  handleStopServer,
  handleUpdateServerEnv,
} from "@/lib/server/control-plane/routes/servers";
import {
  handleGetSettings,
  handlePublicSettings,
  handleSetupComplete,
  handleSetupCreateAdmin,
  handleSetupStatus,
  handleTestEmail,
  handleUpdateSettings,
} from "@/lib/server/control-plane/routes/setup";
import {
  handleInviteSubuser,
  handleListSubusers,
  handleRemoveSubuser,
  handleUpdateSubuser,
} from "@/lib/server/control-plane/routes/subusers";
import { handleDeleteAccount, handleGetMe } from "@/lib/server/control-plane/routes/users";
import { recordAuditFromRequest } from "@/lib/server/control-plane/services/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Handler = (request: Request, ...params: string[]) => Promise<Response>;

const exact = new Map<string, Partial<Record<string, Handler>>>([
  ["health", { GET: async () => {
    const database = await checkDatabaseConnection();
    return json({ status: database ? "ok" : "degraded", database }, database ? 200 : 503);
  }}],
  ["setup/status", { GET: handleSetupStatus }],
  ["setup/admin", { POST: handleSetupCreateAdmin }],
  ["setup/settings", { PATCH: handleUpdateSettings }],
  ["setup/complete", { POST: handleSetupComplete }],
  ["settings/public", { GET: handlePublicSettings }],
  ["admin/settings", { GET: handleGetSettings, PATCH: handleUpdateSettings }],
  ["admin/settings/test-email", { POST: handleTestEmail }],
  ["me", { GET: handleGetMe }],
  ["account/delete", { POST: handleDeleteAccount }],
  ["blueprints", { GET: handleListBlueprints }],
  ["servers", { GET: handleListServers }],
  ["admin/nodes", { GET: handleListNodes, POST: handleCreateNode }],
  ["admin/nodes/health", { GET: handleAllNodesHealth }],
  ["admin/nodes/probe", { POST: handleProbeNode }],
  ["admin/suspicious-activity", { GET: handleListSuspicious }],
  ["admin/scan", { POST: handleTriggerScan }],
  ["admin/servers", { GET: handleListAdminServers, POST: handleAdminCreateServer }],
  ["admin/blueprints", { GET: handleAdminListBlueprints, POST: handleAdminCreateBlueprint }],
  ["admin/blueprints/import-url", { POST: handleAdminImportBlueprintUrl }],
  ["admin/users", { GET: handleListUsers }],
  ["admin/audit-logs", { GET: handleListAuditLogs }],
]);

const patterns: Array<{
  pattern: RegExp;
  methods: Partial<Record<string, Handler>>;
}> = [
  { pattern: /^servers\/([^/]+)$/, methods: { GET: handleGetServer, DELETE: handleDeleteServer } },
  { pattern: /^servers\/([^/]+)\/start$/, methods: { POST: handleStartServer } },
  { pattern: /^servers\/([^/]+)\/stop$/, methods: { POST: handleStopServer } },
  { pattern: /^servers\/([^/]+)\/restart$/, methods: { POST: handleRestartServer } },
  { pattern: /^servers\/([^/]+)\/kill$/, methods: { POST: handleKillServer } },
  { pattern: /^servers\/([^/]+)\/logs$/, methods: { GET: handleGetServerLogs } },
  { pattern: /^servers\/([^/]+)\/stats$/, methods: { GET: handleGetServerStats } },
  { pattern: /^servers\/([^/]+)\/env$/, methods: { GET: handleGetServerEnv, PATCH: handleUpdateServerEnv } },
  { pattern: /^servers\/([^/]+)\/command$/, methods: { POST: handleConsoleCommand } },
  { pattern: /^servers\/([^/]+)\/console\/session$/, methods: { POST: handleConsoleSession } },
  { pattern: /^servers\/([^/]+)\/console\/revoke$/, methods: { POST: handleConsoleRevoke } },
  { pattern: /^servers\/([^/]+)\/files$/, methods: { GET: handleListFiles } },
  { pattern: /^servers\/([^/]+)\/files\/delete$/, methods: { POST: handleDeleteFiles } },
  { pattern: /^servers\/([^/]+)\/files\/content$/, methods: { GET: handleReadFile, PUT: handleWriteFile } },
  { pattern: /^servers\/([^/]+)\/files\/directory$/, methods: { POST: handleCreateDirectory } },
  { pattern: /^servers\/([^/]+)\/files\/rename$/, methods: { POST: handleRenameFile } },
  { pattern: /^servers\/([^/]+)\/files\/copy$/, methods: { POST: handleCopyFile } },
  { pattern: /^servers\/([^/]+)\/files\/download$/, methods: { GET: handleDownloadFile } },
  { pattern: /^servers\/([^/]+)\/files\/upload$/, methods: { POST: handleUploadFile } },
  { pattern: /^servers\/([^/]+)\/files\/pull$/, methods: { POST: handlePullFromUrl } },
  { pattern: /^servers\/([^/]+)\/subusers$/, methods: { GET: handleListSubusers, POST: handleInviteSubuser } },
  { pattern: /^servers\/([^/]+)\/subusers\/([^/]+)$/, methods: { PATCH: handleUpdateSubuser, DELETE: handleRemoveSubuser } },
  { pattern: /^admin\/nodes\/([^/]+)$/, methods: { GET: handleGetNode, PATCH: handleUpdateNode, DELETE: handleDeleteNode } },
  { pattern: /^admin\/nodes\/([^/]+)\/health$/, methods: { GET: handleNodeHealth } },
  { pattern: /^admin\/nodes\/([^/]+)\/ports$/, methods: { GET: handleListNodePortPool, POST: handleAddNodePortPoolEntry } },
  { pattern: /^admin\/nodes\/ports\/([^/]+)$/, methods: { DELETE: handleDeleteNodePortPoolEntry } },
  { pattern: /^admin\/suspicious-activity\/([^/]+)$/, methods: { GET: handleGetSuspicious } },
  { pattern: /^admin\/suspicious-activity\/([^/]+)\/review$/, methods: { POST: handleReviewSuspicious } },
  { pattern: /^admin\/servers\/([^/]+)$/, methods: { PATCH: handleUpdateServerResources } },
  { pattern: /^admin\/blueprints\/([^/]+)$/, methods: { GET: handleAdminGetBlueprint, PATCH: handleAdminUpdateBlueprint, DELETE: handleAdminDeleteBlueprint } },
  { pattern: /^admin\/servers\/([^/]+)\/suspend$/, methods: { POST: handleSuspendServer } },
  { pattern: /^admin\/servers\/([^/]+)\/unsuspend$/, methods: { POST: handleUnsuspendServer } },
  { pattern: /^admin\/users\/([^/]+)\/role$/, methods: { PATCH: handleUpdateUserRole } },
  { pattern: /^admin\/users\/([^/]+)\/ban$/, methods: { POST: handleBanUser } },
  { pattern: /^admin\/users\/([^/]+)\/unban$/, methods: { POST: handleUnbanUser } },
];

async function handleConsoleCommand(request: Request, serverId: string): Promise<Response> {
  const { user } = await requireServerPermission(request, serverId, "console");
  const body = await parseJsonBody(request);
  const command = requireString(body, "command", { max: 4096 });
  const rows = await sql<{ node_id: string }[]>`
    SELECT node_id FROM servers WHERE id = ${serverId}
  `;
  const server = rows[0];
  if (!server) return json({ error: "Server not found" }, 404);

  await sendServerCommand(server.node_id, serverId, command);
  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.console.command",
    targetType: "server",
    targetId: serverId,
    metadata: { command: command.slice(0, 500) },
  });
  return new Response(null, { status: 204 });
}

async function dispatch(request: NextRequest): Promise<Response> {
  const path = request.nextUrl.pathname.replace(/^\/api\/?/, "");

  if (path === "auth" || path.startsWith("auth/")) {
    return auth.handler(request);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const direct = exact.get(path)?.[request.method];
  if (direct) return direct(request);

  for (const route of patterns) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const handler = route.methods[request.method];
    if (!handler) return json({ error: "Method not allowed" }, 405);
    return handler(request, ...match.slice(1));
  }

  return json({ error: "Not found" }, 404);
}

async function route(request: NextRequest): Promise<Response> {
  try {
    return await dispatch(request);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export const GET = route;
export const POST = route;
export const PUT = route;
export const PATCH = route;
export const DELETE = route;
export const OPTIONS = route;
