/**
 * Server plugin/mod routes.
 *
 * All of these require the `files` permission: installing, removing or
 * toggling a plugin is a filesystem write, so the same grant that lets a
 * subuser manage files lets them manage plugins (the same reasoning that puts
 * the ports tab under `settings`).
 *
 * Catalog calls (search, version lists) are proxied through the panel — the
 * browser never learns the catalog's address from us and never talks to it
 * directly — and are executed by the fetch engine against the blueprint's
 * validated provider spec. Every mutation is audited by the service layer.
 */

import { requireServerPermission } from "../auth/middleware";
import { badRequest, json, noContent, parseJsonBody, requireUuidParam } from "../lib/http";
import { engineListVersions, engineSearch } from "../plugins/engine";
import {
  installPlugin,
  listServerPlugins,
  removePlugin,
  requirePluginContext,
  setPluginAutoUpdate,
  togglePlugin,
} from "../services/pluginManager";

/** Catalog project ids/slugs: base62-ish, no path or query material. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** GET /api/servers/:id/plugins — installed plugins, reconciled with disk. */
export async function handleListServerPlugins(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");
  return json(await listServerPlugins(id));
}

/** GET /api/servers/:id/plugins/search?q=&offset= — catalog search proxy. */
export async function handleSearchServerPlugins(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");
  const ctx = await requirePluginContext(id);

  const url = new URL(request.url);
  const text = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const offset = Math.max(0, Math.min(Number(url.searchParams.get("offset") ?? 0) || 0, 500));

  return json(
    await engineSearch(ctx.support, { text, offset, limit: 10 }),
  );
}

/** GET /api/servers/:id/plugins/versions/:projectId — installable versions. */
export async function handleListPluginVersions(
  request: Request,
  serverId: string,
  projectId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");
  const ctx = await requirePluginContext(id);

  if (!PROJECT_ID.test(projectId)) {
    throw badRequest("Invalid project id.");
  }
  return json({
    versions: await engineListVersions(ctx.support, projectId),
  });
}

/**
 * POST /api/servers/:id/plugins/install — install or update to a version.
 *
 * Only the ids come from the client; the version (and its file URL) are
 * re-resolved from the catalog and host-checked before the agent pulls it.
 */
export async function handleInstallPlugin(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (typeof body.projectId !== "string" || !PROJECT_ID.test(body.projectId)) {
    throw badRequest('"projectId" is required');
  }
  if (typeof body.versionId !== "string" || !PROJECT_ID.test(body.versionId)) {
    throw badRequest('"versionId" is required');
  }

  await installPlugin(id, user.id, body.projectId, body.versionId);
  return json({ installed: true }, 201);
}

/** POST /api/servers/:id/plugins/:pluginId/toggle — enable/disable. */
export async function handleTogglePlugin(
  request: Request,
  serverId: string,
  pluginId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");
  const plugin = requireUuidParam(pluginId, "pluginId");

  await togglePlugin(id, user.id, plugin);
  return noContent();
}

/** DELETE /api/servers/:id/plugins/:pluginId — remove file and row. */
export async function handleRemovePlugin(
  request: Request,
  serverId: string,
  pluginId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");
  const plugin = requireUuidParam(pluginId, "pluginId");

  await removePlugin(id, user.id, plugin);
  return noContent();
}

/** PATCH /api/servers/:id/plugins — per-server plugin settings. */
export async function handlePluginSettings(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (typeof body.autoUpdate !== "boolean") {
    throw badRequest('"autoUpdate" must be a boolean');
  }

  await setPluginAutoUpdate(id, user.id, body.autoUpdate);
  return json({ autoUpdate: body.autoUpdate });
}
