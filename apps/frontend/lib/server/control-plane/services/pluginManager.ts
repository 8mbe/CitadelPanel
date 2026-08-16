/**
 * Plugin lifecycle service.
 *
 * Coordinates the `server_plugins` table, the blueprint's provider fetch spec
 * (executed by `plugins/engine.ts`) and the node agent's file operations. The
 * table is the panel's project↔version linkage — what powers update checks and
 * the pre-start auto-updater — not a filesystem inventory: rows are reconciled
 * against the real directory listing when displayed, so manually added or
 * deleted jars surface as untracked/missing instead of being silently
 * overwritten.
 *
 * Install mechanics reuse the agent's generic `files/pull`: the panel resolves
 * a version through the catalog, pins the file URL against the spec's declared
 * download hosts, and the agent writes it as a staged, size-capped, contained
 * binary file. Nothing here ever executes catalog content.
 */

import { sql } from "../db/client";
import { badRequest, conflict, HttpError, notFound } from "../lib/http";
import { getBlueprintById } from "../blueprints/registry";
import {
  resolvePluginSupport,
  type ResolvedPluginSupport,
} from "../blueprints/plugins";
import {
  assertDownloadUrl,
  engineGetProject,
  engineGetVersion,
  engineListVersions,
  pickVersionFile,
  type ProviderVersion,
} from "../plugins/engine";
import {
  deleteServerFile,
  listServerFiles,
  pullServerFileFromUrl,
  renameServerFile,
} from "../nodes/nodeServerApi";
import { recordAudit } from "./auditLog";

/**
 * Only plain `.jar` files, no path separators, no leading dot — a hostile
 * catalog response must not be able to name its way out of the install
 * directory (the agent's path containment is the backstop, this is the fence).
 */
const JAR_FILENAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}\.jar$/;
/** Disabled plugins keep the same file with this suffix, which loaders skip. */
const DISABLED_SUFFIX = ".disabled";
const JAR_LIKE = /\.jar(\.disabled)?$/;

interface PluginRow {
  id: string;
  provider: string;
  project_id: string;
  project_slug: string | null;
  project_title: string;
  project_icon_url: string | null;
  version_id: string;
  version_number: string;
  version_type: string;
  filename: string;
  file_size_bytes: string | null;
  enabled: boolean;
  installed_at: Date;
  updated_at: Date;
}

export interface InstalledPluginView {
  id: string;
  projectId: string;
  slug: string | null;
  title: string;
  iconUrl: string | null;
  versionId: string;
  versionNumber: string;
  channel: string;
  filename: string;
  fileSizeBytes: number | null;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  /** Reconciled against the directory listing: enabled | disabled | missing. */
  status: "enabled" | "disabled" | "missing";
}

export interface ServerPluginList {
  support: {
    label: string;
    directory: string;
    projectType: string;
    gameVersion?: string;
    /** Surfaced in the UI so the content source is never hidden. */
    provider: { id: string; baseUrl: string; downloadHosts: string[] };
  };
  autoUpdate: boolean;
  /** False when the directory listing failed (node down): DB state only. */
  reconciled: boolean;
  plugins: InstalledPluginView[];
  untracked: string[];
}

export interface PluginContext {
  serverId: string;
  nodeId: string;
  autoUpdate: boolean;
  support: ResolvedPluginSupport;
}

async function loadPluginContext(
  serverId: string,
): Promise<PluginContext | null> {
  const rows = (await sql`
    SELECT node_id, blueprint_id, plugin_auto_update
    FROM servers WHERE id = ${serverId}
  `) as {
    node_id: string;
    blueprint_id: string;
    plugin_auto_update: boolean;
  }[];
  const server = rows[0];
  if (!server) throw notFound("Server not found");

  const blueprint = await getBlueprintById(server.blueprint_id);
  if (!blueprint?.plugins) return null;

  const envRows = (await sql`
    SELECT key, value FROM server_env
    WHERE server_id = ${serverId} AND is_secret = false
  `) as { key: string; value: string }[];
  const env = Object.fromEntries(envRows.map((r) => [r.key, r.value]));

  const support = resolvePluginSupport(blueprint, env);
  if (!support) return null;

  return {
    serverId,
    nodeId: server.node_id,
    autoUpdate: server.plugin_auto_update,
    support,
  };
}

/** Like {@link loadPluginContext} but throws for routes. */
export async function requirePluginContext(
  serverId: string,
): Promise<PluginContext> {
  const ctx = await loadPluginContext(serverId);
  if (!ctx) {
    throw notFound("This server's blueprint has no plugin support for its current configuration.");
  }
  return ctx;
}

/**
 * The minimal capability flag for the server detail response: what the tab is
 * called and who serves it. Null means no tab.
 */
export async function getServerPluginSupportSummary(serverId: string): Promise<{
  label: string;
  providerId: string;
  directory: string;
} | null> {
  const ctx = await loadPluginContext(serverId);
  if (!ctx) return null;
  return {
    label: ctx.support.label,
    providerId: ctx.support.provider.id,
    directory: ctx.support.directory,
  };
}

function toView(row: PluginRow, status: InstalledPluginView["status"]): InstalledPluginView {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.project_slug,
    title: row.project_title,
    iconUrl: row.project_icon_url,
    versionId: row.version_id,
    versionNumber: row.version_number,
    channel: row.version_type,
    filename: row.filename,
    fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    enabled: row.enabled,
    installedAt: row.installed_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    status,
  };
}

/** Best-effort delete of a plugin file, tolerating "already gone" (404). */
async function deletePluginFileBestEffort(
  ctx: PluginContext,
  filename: string,
): Promise<void> {
  for (const name of [filename, `${filename}${DISABLED_SUFFIX}`]) {
    try {
      await deleteServerFile(ctx.nodeId, ctx.serverId, `/${ctx.support.directory}/${name}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      throw error;
    }
  }
}

/**
 * The shared install core: validate the version's file, pull it through the
 * agent, clean up a superseded file and upsert the row. Re-installing a
 * project updates in place (same UNIQUE row, old file removed if renamed);
 * the enabled flag survives an update.
 */
async function applyVersion(
  ctx: PluginContext,
  meta: { projectId: string; slug?: string; title: string; iconUrl?: string },
  version: ProviderVersion,
  installedBy: string | null,
): Promise<void> {
  const file = pickVersionFile(version);
  if (!file) throw badRequest("That version has no downloadable files.");
  assertDownloadUrl(ctx.support.provider, file.url);
  if (!JAR_FILENAME.test(file.filename)) {
    throw badRequest(
      `The catalog returned an unexpected filename ("${file.filename}").`,
    );
  }

  const target = `${ctx.support.directory}/${file.filename}`;
  const existing = (await sql`
    SELECT filename FROM server_plugins
    WHERE server_id = ${ctx.serverId}
      AND provider = ${ctx.support.provider.id}
      AND project_id = ${meta.projectId}
  `) as { filename: string }[];

  const result = await pullServerFileFromUrl(ctx.nodeId, ctx.serverId, target, file.url);

  if (existing[0] && existing[0].filename !== file.filename) {
    await deletePluginFileBestEffort(ctx, existing[0].filename);
  }

  await sql`
    INSERT INTO server_plugins (
      server_id, provider, project_id, project_slug, project_title,
      project_icon_url, version_id, version_number, version_type, filename,
      file_size_bytes, enabled, installed_by, installed_at, updated_at
    ) VALUES (
      ${ctx.serverId},
      ${ctx.support.provider.id},
      ${meta.projectId},
      ${meta.slug ?? null},
      ${meta.title},
      ${meta.iconUrl ?? null},
      ${version.versionId},
      ${version.versionNumber},
      ${version.channel},
      ${file.filename},
      ${result.sizeBytes},
      TRUE,
      ${installedBy},
      now(),
      now()
    )
    ON CONFLICT (server_id, provider, project_id) DO UPDATE SET
      project_slug      = EXCLUDED.project_slug,
      project_title     = EXCLUDED.project_title,
      project_icon_url  = EXCLUDED.project_icon_url,
      version_id        = EXCLUDED.version_id,
      version_number    = EXCLUDED.version_number,
      version_type      = EXCLUDED.version_type,
      filename          = EXCLUDED.filename,
      file_size_bytes   = EXCLUDED.file_size_bytes,
      installed_by      = EXCLUDED.installed_by,
      installed_at      = now(),
      updated_at        = now()
  `;
}

/**
 * Install (or update to) a specific catalog version. The version is
 * re-resolved from the catalog — never trusted from the request beyond its
 * ids — so a stale or mismatched versionId can't smuggle a different file.
 */
export async function installPlugin(
  serverId: string,
  actorId: string,
  projectId: string,
  versionId: string,
): Promise<void> {
  const ctx = await requirePluginContext(serverId);

  const version = await engineGetVersion(ctx.support, projectId, versionId);
  if (!version) throw badRequest("That version does not exist in the catalog.");
  if (version.projectId && version.projectId !== projectId) {
    throw badRequest("That version belongs to a different plugin.");
  }

  const project = await engineGetProject(ctx.support, projectId);
  await applyVersion(
    ctx,
    {
      projectId,
      ...(project?.slug ? { slug: project.slug } : {}),
      title: project?.title || projectId,
      ...(project?.iconUrl ? { iconUrl: project.iconUrl } : {}),
    },
    version,
    actorId,
  );

  await recordAudit({
    userId: actorId,
    action: "server.plugin.install",
    targetType: "server",
    targetId: serverId,
    metadata: {
      provider: ctx.support.provider.id,
      plugin: project?.title || projectId,
      version: version.versionNumber,
      path: `${ctx.support.directory}/*`,
    },
  });
}

/** Enable/disable by renaming `x.jar` ↔ `x.jar.disabled` on the node. */
export async function togglePlugin(
  serverId: string,
  actorId: string,
  pluginId: string,
): Promise<void> {
  const ctx = await requirePluginContext(serverId);

  const rows = (await sql`
    SELECT filename, enabled, project_title FROM server_plugins
    WHERE id = ${pluginId} AND server_id = ${serverId}
  `) as { filename: string; enabled: boolean; project_title: string }[];
  const row = rows[0];
  if (!row) throw notFound("Plugin not found");

  const base = `/${ctx.support.directory}/${row.filename}`;
  try {
    await renameServerFile(
      ctx.nodeId,
      ctx.serverId,
      row.enabled ? base : `${base}${DISABLED_SUFFIX}`,
      row.enabled ? `${base}${DISABLED_SUFFIX}` : base,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw conflict(
        "The plugin file is missing on disk. Reinstall or remove it instead.",
      );
    }
    throw error;
  }

  const enabled = !row.enabled;
  await sql`
    UPDATE server_plugins SET enabled = ${enabled}, updated_at = now()
    WHERE id = ${pluginId}
  `;

  await recordAudit({
    userId: actorId,
    action: "server.plugin.toggle",
    targetType: "server",
    targetId: serverId,
    metadata: {
      provider: ctx.support.provider.id,
      plugin: row.project_title,
      enabled,
    },
  });
}

export async function removePlugin(
  serverId: string,
  actorId: string,
  pluginId: string,
): Promise<void> {
  const ctx = await requirePluginContext(serverId);

  const rows = (await sql`
    SELECT filename, project_title FROM server_plugins
    WHERE id = ${pluginId} AND server_id = ${serverId}
  `) as { filename: string; project_title: string }[];
  const row = rows[0];
  if (!row) throw notFound("Plugin not found");

  await deletePluginFileBestEffort(ctx, row.filename);
  await sql`DELETE FROM server_plugins WHERE id = ${pluginId}`;

  await recordAudit({
    userId: actorId,
    action: "server.plugin.remove",
    targetType: "server",
    targetId: serverId,
    metadata: {
      provider: ctx.support.provider.id,
      plugin: row.project_title,
      filename: row.filename,
    },
  });
}

export async function setPluginAutoUpdate(
  serverId: string,
  actorId: string,
  enabled: boolean,
): Promise<void> {
  await sql`
    UPDATE servers SET plugin_auto_update = ${enabled}, updated_at = now()
    WHERE id = ${serverId}
  `;
  await recordAudit({
    userId: actorId,
    action: "server.plugin.settings",
    targetType: "server",
    targetId: serverId,
    metadata: { autoUpdate: enabled },
  });
}

/**
 * Installed plugins, reconciled against the directory the server actually
 * has. When the node can't be reached the rows are still returned (marked by
 * `reconciled: false`) so an outage degrades to DB state, not an error.
 */
export async function listServerPlugins(
  serverId: string,
): Promise<ServerPluginList> {
  const ctx = await requirePluginContext(serverId);
  const support = ctx.support;

  const rows = (await sql`
    SELECT * FROM server_plugins WHERE server_id = ${serverId}
    ORDER BY project_title ASC
  `) as unknown as PluginRow[];

  let files: string[] | null = null;
  try {
    const listing = await listServerFiles(
      ctx.nodeId,
      serverId,
      `/${ctx.support.directory}`,
    );
    files = listing.entries.filter((e) => e.type === "file").map((e) => e.name);
  } catch {
    files = null;
  }

  const claimed = new Set<string>();
  const plugins = rows.map((row) => {
    claimed.add(row.filename);
    claimed.add(`${row.filename}${DISABLED_SUFFIX}`);
    const present =
      files === null
        ? true
        : files.includes(row.filename) ||
          files.includes(`${row.filename}${DISABLED_SUFFIX}`);
    const status: InstalledPluginView["status"] = !present
      ? "missing"
      : row.enabled
        ? "enabled"
        : "disabled";
    return toView(row, status);
  });

  return {
    support: {
      label: support.label,
      directory: support.directory,
      projectType: support.projectType,
      ...(support.gameVersion ? { gameVersion: support.gameVersion } : {}),
      provider: {
        id: ctx.support.provider.id,
        baseUrl: ctx.support.provider.baseUrl,
        downloadHosts: ctx.support.provider.downloadHosts,
      },
    },
    autoUpdate: ctx.autoUpdate,
    reconciled: files !== null,
    plugins,
    untracked:
      files === null ? [] : files.filter((n) => JAR_LIKE.test(n) && !claimed.has(n)),
  };
}

/**
 * The pre-start auto-updater: for every enabled plugin, check the catalog for
 * a newer release-channel version and install it before the container boots.
 *
 * Deliberately best-effort in every dimension — a catalog outage, a failed
 * download for one plugin, anything at all — must never block a server start.
 * Only release-channel versions are taken, so an update never silently moves
 * a server from a stable build to a beta. One summary audit row per start
 * that changed anything.
 */
export async function autoUpdateServerPlugins(serverId: string): Promise<void> {
  try {
    const ctx = await loadPluginContext(serverId);
    if (!ctx || !ctx.autoUpdate) return;
    // Version filtering uses the user-set version env: a concrete value
    // filters update candidates by compatibility, a sentinel like LATEST
    // filters by loaders only.
    const support = ctx.support;

    const rows = (await sql`
      SELECT * FROM server_plugins
      WHERE server_id = ${serverId}
        AND provider = ${ctx.support.provider.id}
        AND enabled = TRUE
    `) as unknown as PluginRow[];
    if (rows.length === 0) return;

    const checks = await Promise.all(
      rows.map(async (row) => {
        try {
          const versions = await engineListVersions(support, row.project_id);
          const latest =
            versions.find((v) => v.channel === "release" && v.files.length > 0) ??
            null;
          return { row, latest };
        } catch {
          return { row, latest: null };
        }
      }),
    );

    const updated: { plugin: string; from: string; to: string }[] = [];
    for (const { row, latest } of checks) {
      if (!latest || latest.versionId === row.version_id) continue;
      try {
        await applyVersion(
          ctx,
          {
            projectId: row.project_id,
            ...(row.project_slug ? { slug: row.project_slug } : {}),
            title: row.project_title,
            ...(row.project_icon_url ? { iconUrl: row.project_icon_url } : {}),
          },
          latest,
          null,
        );
        updated.push({
          plugin: row.project_title,
          from: row.version_number,
          to: latest.versionNumber,
        });
      } catch (error) {
        console.warn(
          `[plugins] auto-update failed for "${row.project_title}" (start proceeds):`,
          error,
        );
      }
    }

    if (updated.length > 0) {
      await recordAudit({
        action: "server.plugin.auto-update",
        targetType: "server",
        targetId: serverId,
        metadata: {
          provider: ctx.support.provider.id,
          updated,
        },
      });
    }
  } catch (error) {
    console.warn(
      "[plugins] pre-start auto-update failed (start proceeds):",
      error,
    );
  }
}
