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
  handleGetUser,
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
  handleAdminCreateApiKey,
  handleAdminDeleteApiKey,
  handleAdminListApiKeys,
  handleAdminSetApiKeyEnabled,
} from "@/lib/server/control-plane/routes/apiKeys";
import {
  handleCreateNodeDatabaseBackup,
  handleCreateServerBackup,
  handleDeleteNodeDatabaseBackup,
  handleDeleteServerBackup,
  handleGetBackupStorage,
  handleGetNodeDatabaseBackupLogs,
  handleGetServerBackup,
  handleGetServerBackupLogs,
  handleListDatabaseBackupNodes,
  handleListNodeDatabaseBackups,
  handleListNodeRepositorySnapshots,
  handleListRepositorySnapshots,
  handleListServerBackups,
  handlePreviewBackupSchedule,
  handleRestoreNodeDatabaseBackup,
  handleRestoreServerBackup,
  handleStartServerAfterRestore,
  handleTestBackupDestination,
  handleUpdateNodeDatabaseBackupSettings,
  handleUpdateServerBackupSettings,
} from "@/lib/server/control-plane/routes/backups";
import {
  handleAdminCreateBlueprint,
  handleAdminDeleteBlueprint,
  handleAdminGetBlueprint,
  handleAdminImportBlueprintUrl,
  handleAdminListBlueprints,
  handleAdminUpdateBlueprint,
} from "@/lib/server/control-plane/routes/blueprints";
import {
  handleConsoleAudit,
  handleConsoleRevoke,
  handleConsoleSession,
  handleConsoleSessionValidate,
} from "@/lib/server/control-plane/routes/console";
import {
  handleCopyFile,
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
  handleCreateSftpCredential,
  handleDeleteSftpCredential,
  handleGetSftpConnection,
  handleListSftpCredentials,
  handleRegenerateSftpCredential,
  handleSftpAuthenticate,
} from "@/lib/server/control-plane/routes/sftp";
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
  handleGetServerInstallLog,
  handleGetServerLogs,
  handleGetServerStats,
  handleKillServer,
  handleListBlueprints,
  handleListServerActivity,
  handleListServerDatabases,
  handleListServerLinks,
  handleListServerPorts,
  handleListServers,
  handleListServerStatsBatch,
  handleAddServerPort,
  handleRemoveServerPort,
  handleCreateServerLink,
  handleRemoveServerLink,
  handleAddServerDatabase,
  handleRemoveServerDatabase,
  handleResetServerDatabasePassword,
  handleReinstallServer,
  handleRestartServer,
  handleStartServer,
  handleStopServer,
  handleUpdateServerEnv,
} from "@/lib/server/control-plane/routes/servers";
import {
  handleAddExplorerColumn,
  handleChangeExplorerColumn,
  handleCreateExplorerTable,
  handleDeleteExplorerRow,
  handleDropExplorerColumn,
  handleDropExplorerTable,
  handleGetExplorerTableRows,
  handleGetExplorerTableSchema,
  handleInsertExplorerRow,
  handleListExplorerTables,
  handleUpdateExplorerRow,
} from "@/lib/server/control-plane/routes/dbExplorer";
import {
  handleGetLegal,
  handleUpdateLegal,
} from "@/lib/server/control-plane/routes/legal";
import {
  handleGetSettings,
  handlePublicSettings,
  handleSetupComplete,
  handleSetupCreateAdmin,
  handleSetupStatus,
  handleTestEmail,
  handleUpdateSettings,
  handleFetchAiModels,
  handleTestAi,
} from "@/lib/server/control-plane/routes/setup";
import { handleServerAiHelper } from "@/lib/server/control-plane/routes/aiHelper";
import {
  handleInviteSubuser,
  handleListSubusers,
  handleRemoveSubuser,
  handleUpdateSubuser,
} from "@/lib/server/control-plane/routes/subusers";
import { handleDeleteAccount, handleGetMe } from "@/lib/server/control-plane/routes/users";
import {
  handleInstallPlugin,
  handleListPluginVersions,
  handleListServerPlugins,
  handlePluginSettings,
  handleRemovePlugin,
  handleSearchServerPlugins,
  handleTogglePlugin,
} from "@/lib/server/control-plane/routes/plugins";
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
  ["admin/settings/ai/models", { POST: handleFetchAiModels }],
  ["admin/settings/ai/test", { POST: handleTestAi }],
  // Backup destination + schedule tooling (see routes/backups.ts). The S3 config
  // itself is part of admin/settings; these two are the "does it work?" and
  // "when would it run?" helpers the form needs.
  ["admin/backups/test", { POST: handleTestBackupDestination }],
  ["admin/backups/preview-schedule", { POST: handlePreviewBackupSchedule }],
  // Storage accounting for the admin page's used/allowed/total line.
  ["admin/backups/storage", { GET: handleGetBackupStorage }],
  // Node database backups: the admin-owned scope (see routes/backups.ts).
  ["admin/backups/databases", { GET: handleListDatabaseBackupNodes }],
  ["admin/legal", { GET: handleGetLegal }],
  ["me", { GET: handleGetMe }],
  ["account/delete", { POST: handleDeleteAccount }],
  ["blueprints", { GET: handleListBlueprints }],
  ["servers", { GET: handleListServers }],
  // Batched live samples for the dashboard's tiles (see routes/servers.ts).
  // Exact-match, so it is found before the `servers/:id` pattern could ever
  // read "stats-batch" as an id.
  ["servers/stats-batch", { POST: handleListServerStatsBatch }],
  ["admin/nodes", { GET: handleListNodes, POST: handleCreateNode }],
  ["admin/nodes/health", { GET: handleAllNodesHealth }],
  ["admin/nodes/probe", { POST: handleProbeNode }],
  ["admin/suspicious-activity", { GET: handleListSuspicious }],
  ["admin/scan", { POST: handleTriggerScan }],
  ["admin/servers", { GET: handleListAdminServers, POST: handleAdminCreateServer }],
  ["admin/blueprints", { GET: handleAdminListBlueprints, POST: handleAdminCreateBlueprint }],
  ["admin/blueprints/import-url", { POST: handleAdminImportBlueprintUrl }],
  ["admin/users", { GET: handleListUsers }],
  ["admin/api-keys", { GET: handleAdminListApiKeys, POST: handleAdminCreateApiKey }],
  ["admin/audit-logs", { GET: handleListAuditLogs }],
  // Agent callbacks for the direct-console WebSocket (see routes/console.ts).
  ["internal/console/sessions/validate", { POST: handleConsoleSessionValidate }],
  ["internal/console/audit", { POST: handleConsoleAudit }],
  // Agent callback for SFTP auth (see routes/sftp.ts).
  ["internal/sftp/authenticate", { POST: handleSftpAuthenticate }],
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
  // Destructive: wipes the data directory and re-runs the blueprint's install.
  { pattern: /^servers\/([^/]+)\/reinstall$/, methods: { POST: handleReinstallServer } },
  { pattern: /^servers\/([^/]+)\/logs$/, methods: { GET: handleGetServerLogs } },
  // Provisioning output, admin-only (see routes/servers.ts).
  { pattern: /^servers\/([^/]+)\/install-log$/, methods: { GET: handleGetServerInstallLog } },
  { pattern: /^servers\/([^/]+)\/stats$/, methods: { GET: handleGetServerStats } },
  { pattern: /^servers\/([^/]+)\/env$/, methods: { GET: handleGetServerEnv, PATCH: handleUpdateServerEnv } },
  { pattern: /^servers\/([^/]+)\/ports$/, methods: { GET: handleListServerPorts, POST: handleAddServerPort, DELETE: handleRemoveServerPort } },
  { pattern: /^servers\/([^/]+)\/links$/, methods: { GET: handleListServerLinks, POST: handleCreateServerLink } },
  { pattern: /^servers\/([^/]+)\/links\/([^/]+)$/, methods: { DELETE: handleRemoveServerLink } },
  { pattern: /^servers\/([^/]+)\/databases$/, methods: { GET: handleListServerDatabases, POST: handleAddServerDatabase } },
  // `reset-password` must be matched before the `:databaseId` pattern, otherwise
  // POST /databases/<id>/reset-password matches the DELETE-only database route
  // and returns 405.
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)\/reset-password$/, methods: { POST: handleResetServerDatabasePassword } },
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)$/, methods: { DELETE: handleRemoveServerDatabase } },
  // Database explorer (see routes/dbExplorer.ts). Literal segments (`schema`,
  // `rows`, `columns`) come before the bare `:table` DELETE so they are not
  // captured as a table name.
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)\/explorer\/tables$/, methods: { GET: handleListExplorerTables, POST: handleCreateExplorerTable } },
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)\/explorer\/tables\/([^/]+)\/schema$/, methods: { GET: handleGetExplorerTableSchema } },
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)\/explorer\/tables\/([^/]+)\/rows$/, methods: { GET: handleGetExplorerTableRows, POST: handleInsertExplorerRow, PATCH: handleUpdateExplorerRow, DELETE: handleDeleteExplorerRow } },
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)\/explorer\/tables\/([^/]+)\/columns$/, methods: { POST: handleAddExplorerColumn } },
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)\/explorer\/tables\/([^/]+)\/columns\/([^/]+)$/, methods: { PATCH: handleChangeExplorerColumn, DELETE: handleDropExplorerColumn } },
  { pattern: /^servers\/([^/]+)\/databases\/([^/]+)\/explorer\/tables\/([^/]+)$/, methods: { DELETE: handleDropExplorerTable } },
  { pattern: /^servers\/([^/]+)\/activity$/, methods: { GET: handleListServerActivity } },
  { pattern: /^servers\/([^/]+)\/command$/, methods: { POST: handleConsoleCommand } },
  { pattern: /^servers\/([^/]+)\/console\/session$/, methods: { POST: handleConsoleSession } },
  { pattern: /^servers\/([^/]+)\/console\/revoke$/, methods: { POST: handleConsoleRevoke } },
  // AI console helper (see routes/aiHelper.ts). Panel-composed prompt; the
  // browser only supplies the free-text question, never the logs or context.
  { pattern: /^servers\/([^/]+)\/ai-helper$/, methods: { POST: handleServerAiHelper } },
  { pattern: /^servers\/([^/]+)\/files$/, methods: { GET: handleListFiles } },
  { pattern: /^servers\/([^/]+)\/files\/delete$/, methods: { POST: handleDeleteFiles } },
  { pattern: /^servers\/([^/]+)\/files\/content$/, methods: { GET: handleReadFile, PUT: handleWriteFile } },
  { pattern: /^servers\/([^/]+)\/files\/directory$/, methods: { POST: handleCreateDirectory } },
  { pattern: /^servers\/([^/]+)\/files\/rename$/, methods: { POST: handleRenameFile } },
  { pattern: /^servers\/([^/]+)\/files\/copy$/, methods: { POST: handleCopyFile } },
  { pattern: /^servers\/([^/]+)\/files\/download$/, methods: { GET: handleDownloadFile } },
  { pattern: /^servers\/([^/]+)\/files\/upload$/, methods: { POST: handleUploadFile } },
  { pattern: /^servers\/([^/]+)\/files\/pull$/, methods: { POST: handlePullFromUrl } },
  // Literal plugin paths must be matched before the `:pluginId` pattern,
  // otherwise POST /plugins/install matches the toggle route's :pluginId
  // capture and returns 405.
  { pattern: /^servers\/([^/]+)\/plugins$/, methods: { GET: handleListServerPlugins, PATCH: handlePluginSettings } },
  { pattern: /^servers\/([^/]+)\/plugins\/search$/, methods: { GET: handleSearchServerPlugins } },
  { pattern: /^servers\/([^/]+)\/plugins\/install$/, methods: { POST: handleInstallPlugin } },
  { pattern: /^servers\/([^/]+)\/plugins\/versions\/([^/]+)$/, methods: { GET: handleListPluginVersions } },
  { pattern: /^servers\/([^/]+)\/plugins\/([^/]+)\/toggle$/, methods: { POST: handleTogglePlugin } },
  { pattern: /^servers\/([^/]+)\/plugins\/([^/]+)$/, methods: { DELETE: handleRemovePlugin } },
  // Backups (see routes/backups.ts). The literal sub-paths (`settings`,
  // `snapshots`, `start-server`) must come before the bare `:backupId` pattern,
  // otherwise e.g. PATCH /backups/settings is captured as a backup id and
  // returns 405 instead of reaching the handler.
  { pattern: /^servers\/([^/]+)\/backups$/, methods: { GET: handleListServerBackups, POST: handleCreateServerBackup } },
  { pattern: /^servers\/([^/]+)\/backups\/settings$/, methods: { PATCH: handleUpdateServerBackupSettings } },
  { pattern: /^servers\/([^/]+)\/backups\/snapshots$/, methods: { GET: handleListRepositorySnapshots } },
  { pattern: /^servers\/([^/]+)\/backups\/start-server$/, methods: { POST: handleStartServerAfterRestore } },
  { pattern: /^servers\/([^/]+)\/backups\/([^/]+)\/logs$/, methods: { GET: handleGetServerBackupLogs } },
  { pattern: /^servers\/([^/]+)\/backups\/([^/]+)\/restore$/, methods: { POST: handleRestoreServerBackup } },
  { pattern: /^servers\/([^/]+)\/backups\/([^/]+)$/, methods: { GET: handleGetServerBackup, DELETE: handleDeleteServerBackup } },
  { pattern: /^servers\/([^/]+)\/subusers$/, methods: { GET: handleListSubusers, POST: handleInviteSubuser } },
  { pattern: /^servers\/([^/]+)\/subusers\/([^/]+)$/, methods: { PATCH: handleUpdateSubuser, DELETE: handleRemoveSubuser } },
  { pattern: /^servers\/([^/]+)\/sftp\/connection$/, methods: { GET: handleGetSftpConnection } },
  { pattern: /^servers\/([^/]+)\/sftp\/credentials$/, methods: { GET: handleListSftpCredentials, POST: handleCreateSftpCredential } },
  // `regenerate` must be matched before the `:credentialId` pattern, otherwise
  // POST /sftp/credentials/regenerate matches the DELETE-only credential route
  // and returns 405 instead of reaching the regenerate handler.
  { pattern: /^servers\/([^/]+)\/sftp\/credentials\/regenerate$/, methods: { POST: handleRegenerateSftpCredential } },
  { pattern: /^servers\/([^/]+)\/sftp\/credentials\/([^/]+)$/, methods: { DELETE: handleDeleteSftpCredential } },
  // Node database backups. Literal sub-paths before the bare :runId pattern, and
  // all of them before the `admin/nodes/:id` routes, which they do not share a
  // prefix with but are easy to confuse when reading.
  { pattern: /^admin\/backups\/databases\/([^/]+)$/, methods: { GET: handleListNodeDatabaseBackups, POST: handleCreateNodeDatabaseBackup, PATCH: handleUpdateNodeDatabaseBackupSettings } },
  { pattern: /^admin\/backups\/databases\/([^/]+)\/snapshots$/, methods: { GET: handleListNodeRepositorySnapshots } },
  { pattern: /^admin\/backups\/databases\/([^/]+)\/runs\/([^/]+)\/logs$/, methods: { GET: handleGetNodeDatabaseBackupLogs } },
  { pattern: /^admin\/backups\/databases\/([^/]+)\/runs\/([^/]+)\/restore$/, methods: { POST: handleRestoreNodeDatabaseBackup } },
  { pattern: /^admin\/backups\/databases\/([^/]+)\/runs\/([^/]+)$/, methods: { DELETE: handleDeleteNodeDatabaseBackup } },
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
  // API-key oversight (see routes/apiKeys.ts).
  { pattern: /^admin\/api-keys\/([^/]+)$/, methods: { PATCH: handleAdminSetApiKeyEnabled, DELETE: handleAdminDeleteApiKey } },
  // Terms of service / privacy policy source (see routes/legal.ts).
  { pattern: /^admin\/legal\/([^/]+)$/, methods: { PUT: handleUpdateLegal } },
  // Must come after the /role, /ban, /unban patterns so those more specific
  // paths match first rather than being captured by the bare :id GET.
  { pattern: /^admin\/users\/([^/]+)$/, methods: { GET: handleGetUser } },
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
