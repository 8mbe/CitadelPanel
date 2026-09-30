/**
 * Plugin lifecycle service.
 *
 * Coordinates the `server_plugins` table, the blueprint's provider fetch spec
 * (executed by `plugins/engine.ts`) and the node agent's file operations. The
 * table is the panel's project↔version linkage, which powers update checks and
 * the pre-start auto-updater. It is not a filesystem inventory: rows are
 * reconciled against the real directory listing when displayed, so manually
 * added or deleted jars surface as untracked/missing instead of being silently
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
  resolvePluginTabs,
  resolvedTabSupport,
  type ResolvedPluginTab,
  type ResolvedPluginSupport,
} from "../blueprints/plugins";
import {
  assertDownloadUrl,
  engineGetProject,
  engineGetVersion,
  engineListVersions,
  providerProjectUrl,
  versionMatchesSupport,
  type ProviderVersion,
} from "../plugins/engine";
import {
  deleteServerFile,
  listServerFiles,
  pullServerFileFromUrl,
  renameServerFile,
} from "../nodes/nodeServerApi";
import { recordAudit } from "./auditLog";
import { isContentFilename, pickContentFile } from "../plugins/files";
import { beginPluginWrite } from "../plugins/write-lock";

async function withPluginMutation<T>(
  serverId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = beginPluginWrite(serverId);
  if (!release)
    throw conflict("Another content change is in progress. Try again shortly.");
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Disabled plugins keep the same file with this suffix, which loaders skip. */
const DISABLED_SUFFIX = ".disabled";
const CONTENT_LIKE = /\.(jar|zip)(\.disabled)?$/;

interface PluginRow {
  id: string;
  tab_id: string;
  install_directory: string | null;
  provider: string;
  project_id: string;
  project_slug: string | null;
  project_author: string | null;
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
  providerId: string;
  tabId: string;
  directory: string;
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
  /** The catalog's page for this project; null when the provider has no site. */
  projectUrl: string | null;
}

export interface ServerPluginList {
  support: {
    id: string;
    label: string;
    directory: string;
    projectType: string;
    gameVersion?: string;
    /** Surfaced in the UI so the content source is never hidden. */
    provider: { id: string; baseUrl: string; downloadHosts: string[] };
    providers: { id: string; baseUrl: string; downloadHosts: string[] }[];
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
  tabId: string;
  tabs: ResolvedPluginTab[];
}

/**
 * The server columns the plugin context needs.
 *
 * Exposed so a caller that has already read the row, as the server detail view
 * does on every page load, can hand it over instead of paying for a second
 * read of the same three columns.
 */
export interface PluginServerFields {
  node_id: string;
  blueprint_id: string;
  plugin_auto_update: boolean;
}

async function loadPluginServerFields(
  serverId: string,
): Promise<PluginServerFields> {
  const rows = (await sql`
    SELECT node_id, blueprint_id, plugin_auto_update
    FROM servers WHERE id = ${serverId}
  `) as PluginServerFields[];
  const server = rows[0];
  if (!server) throw notFound("Server not found");
  return server;
}

async function loadPluginContext(
  serverId: string,
  preloaded?: PluginServerFields,
  selection?: { tabId?: string; providerId?: string },
): Promise<PluginContext | null> {
  const server = preloaded ?? (await loadPluginServerFields(serverId));

  // Blueprints are cached in the registry, so this is a map read, not a query.
  const blueprint = await getBlueprintById(server.blueprint_id);
  if (!blueprint?.plugins) return null;

  const envRows = (await sql`
    SELECT key, value FROM server_env
    WHERE server_id = ${serverId} AND is_secret = false
  `) as { key: string; value: string }[];
  const env = Object.fromEntries(envRows.map((r) => [r.key, r.value]));

  const tabs = resolvePluginTabs(blueprint, env);
  const tab = selection?.tabId
    ? tabs.find((tab) => tab.id === selection.tabId)
    : tabs[0];
  if (!tab) return null;
  const provider = selection?.providerId
    ? tab.providers.find((provider) => provider.id === selection.providerId)
    : tab.providers[0];
  if (!provider)
    throw badRequest("That provider is not configured for this tab.");
  const tabId = tab.id;
  const support = resolvedTabSupport(tab, provider);

  return {
    serverId,
    nodeId: server.node_id,
    autoUpdate: server.plugin_auto_update,
    support,
    tabId,
    tabs,
  };
}

/** Like {@link loadPluginContext} but throws for routes. */
export async function requirePluginContext(
  serverId: string,
  selection?: { tabId?: string; providerId?: string },
): Promise<PluginContext> {
  const ctx = await loadPluginContext(serverId, undefined, selection);
  if (!ctx) {
    throw notFound(
      "This server's blueprint has no plugin support for its current configuration.",
    );
  }
  return ctx;
}

/**
 * The minimal capability flag for the server detail response: what the tab is
 * called and who serves it. Null means no tab.
 *
 * `preloaded` lets the detail view pass the server row it already holds, which
 * turns this from two queries into one.
 */
export async function getServerPluginSupportSummary(
  serverId: string,
  preloaded?: PluginServerFields,
): Promise<{
  label: string;
  providerId: string;
  directory: string;
  tabs: {
    id: string;
    label: string;
    directory: string;
    providerIds: string[];
  }[];
} | null> {
  const ctx = await loadPluginContext(serverId, preloaded);
  if (!ctx) return null;
  return {
    label: ctx.support.label,
    providerId: ctx.support.provider.id,
    directory: ctx.support.directory,
    tabs: ctx.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      directory: tab.directory,
      providerIds: tab.providers.map((provider) => provider.id),
    })),
  };
}

function toView(
  row: PluginRow,
  status: InstalledPluginView["status"],
  support: ResolvedPluginSupport,
): InstalledPluginView {
  return {
    id: row.id,
    providerId: row.provider,
    tabId: row.tab_id,
    directory: row.install_directory ?? support.directory,
    projectId: row.project_id,
    slug: row.project_slug,
    title: row.project_title,
    iconUrl: row.project_icon_url,
    versionId: row.version_id,
    versionNumber: row.version_number,
    channel: row.version_type,
    filename: row.filename,
    fileSizeBytes:
      row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    enabled: row.enabled,
    installedAt: row.installed_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    status,
    projectUrl:
      row.provider === support.provider.id
        ? (providerProjectUrl(support.provider, {
            projectId: row.project_id,
            slug: row.project_slug,
            author: row.project_author,
            projectType: support.projectType,
          }) ?? null)
        : null,
  };
}

async function requireInstalledPlugin(
  serverId: string,
  pluginId: string,
): Promise<{ ctx: PluginContext; row: PluginRow }> {
  const ctx = await requirePluginContext(serverId);
  const rows =
    (await sql`SELECT * FROM server_plugins WHERE id = ${pluginId} AND server_id = ${serverId}`) as unknown as PluginRow[];
  const row = rows[0];
  if (!row) throw notFound("Plugin not found");
  const tab = ctx.tabs.find((tab) => tab.id === row.tab_id);
  return {
    row,
    ctx: {
      ...ctx,
      tabId: row.tab_id,
      support: {
        ...(tab ?? ctx.support),
        provider:
          tab?.providers.find((provider) => provider.id === row.provider) ??
          ctx.support.provider,
        directory:
          row.install_directory ?? tab?.directory ?? ctx.support.directory,
      },
    },
  };
}

/** Best-effort delete of a plugin file, tolerating "already gone" (404). */
async function deletePluginFileBestEffort(
  ctx: PluginContext,
  filename: string,
): Promise<void> {
  for (const name of [filename, `${filename}${DISABLED_SUFFIX}`]) {
    try {
      await deleteServerFile(
        ctx.nodeId,
        ctx.serverId,
        `/${ctx.support.directory}/${name}`,
      );
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
  meta: {
    projectId: string;
    slug?: string;
    author?: string;
    title: string;
    iconUrl?: string;
  },
  version: ProviderVersion,
  installedBy: string | null,
): Promise<void> {
  return withPluginMutation(ctx.serverId, async () => {
    const file = pickContentFile(version.files, ctx.support.projectType);
    if (!file)
      throw badRequest(
        `That version has no installable ${ctx.support.projectType === "datapack" ? "ZIP" : "JAR"} file.`,
      );
    assertDownloadUrl(ctx.support.provider, file.url);

    const target = `${ctx.support.directory}/${file.filename}`;
    const existing = (await sql`
    SELECT filename, enabled, install_directory FROM server_plugins
    WHERE server_id = ${ctx.serverId}
      AND tab_id = ${ctx.tabId}
      AND provider = ${ctx.support.provider.id}
      AND project_id = ${meta.projectId}
  `) as {
      filename: string;
      enabled: boolean;
      install_directory: string | null;
    }[];

    const conflicts = await sql`
    SELECT id FROM server_plugins
    WHERE server_id = ${ctx.serverId}
      AND COALESCE(install_directory, ${ctx.support.directory}) = ${ctx.support.directory}
      AND filename = ${file.filename}
      AND NOT (tab_id = ${ctx.tabId} AND provider = ${ctx.support.provider.id} AND project_id = ${meta.projectId})
  `;
    if (conflicts.length)
      throw conflict(
        "Another installed project already uses that filename in this directory.",
      );
    try {
      const listing = await listServerFiles(
        ctx.nodeId,
        ctx.serverId,
        `/${ctx.support.directory}`,
      );
      const ownsTarget =
        existing[0]?.filename === file.filename &&
        (existing[0].install_directory ?? ctx.support.directory) ===
          ctx.support.directory;
      if (
        !ownsTarget &&
        listing.entries.some(
          (entry) =>
            entry.name === file.filename ||
            entry.name === `${file.filename}${DISABLED_SUFFIX}`,
        )
      ) {
        throw conflict(
          "A file with that name already exists. Remove it or choose another version.",
        );
      }
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
    }

    const result = await pullServerFileFromUrl(
      ctx.nodeId,
      ctx.serverId,
      target,
      file.url,
    );

    if (existing[0]?.enabled === false) {
      if (
        existing[0].filename === file.filename &&
        (existing[0].install_directory ?? ctx.support.directory) ===
          ctx.support.directory
      ) {
        try {
          await deleteServerFile(
            ctx.nodeId,
            ctx.serverId,
            `/${target}${DISABLED_SUFFIX}`,
          );
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404))
            throw error;
        }
      }
      await renameServerFile(
        ctx.nodeId,
        ctx.serverId,
        `/${target}`,
        `/${target}${DISABLED_SUFFIX}`,
      );
    }

    if (
      existing[0] &&
      (existing[0].filename !== file.filename ||
        (existing[0].install_directory ?? ctx.support.directory) !==
          ctx.support.directory)
    ) {
      await deletePluginFileBestEffort(
        {
          ...ctx,
          support: {
            ...ctx.support,
            directory: existing[0].install_directory ?? ctx.support.directory,
          },
        },
        existing[0].filename,
      );
    }

    await sql`
    INSERT INTO server_plugins (
      server_id, tab_id, install_directory, provider, project_id, project_slug, project_author, project_title,
      project_icon_url, version_id, version_number, version_type, filename,
      file_size_bytes, enabled, installed_by, installed_at, updated_at
    ) VALUES (
      ${ctx.serverId},
      ${ctx.tabId},
      ${ctx.support.directory},
      ${ctx.support.provider.id},
      ${meta.projectId},
      ${meta.slug ?? null},
      ${meta.author ?? null},
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
    ON CONFLICT (server_id, tab_id, provider, project_id) DO UPDATE SET
      install_directory = EXCLUDED.install_directory,
      project_slug      = EXCLUDED.project_slug,
      project_author    = EXCLUDED.project_author,
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
  });
}

/**
 * Install (or update to) a specific catalog version. The version is
 * re-resolved from the catalog and never trusted from the request beyond its
 * ids, so a stale or mismatched versionId can't smuggle a different file.
 */
export async function installPlugin(
  serverId: string,
  actorId: string,
  projectId: string,
  versionId: string,
  selection?: { tabId?: string; providerId?: string },
): Promise<void> {
  const ctx = await requirePluginContext(serverId, selection);

  const version = await engineGetVersion(ctx.support, projectId, versionId);
  if (!version) throw badRequest("That version does not exist in the catalog.");
  if (version.projectId && version.projectId !== projectId) {
    throw badRequest("That version belongs to a different plugin.");
  }
  if (!versionMatchesSupport(ctx.support, version))
    throw badRequest(
      "That version does not match this tab's loader and game version.",
    );

  const project = await engineGetProject(ctx.support, projectId);
  await applyVersion(
    ctx,
    {
      projectId,
      ...(project?.slug ? { slug: project.slug } : {}),
      ...(project?.author ? { author: project.author } : {}),
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
      tab: ctx.tabId,
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
  return withPluginMutation(serverId, async () => {
    const { ctx, row } = await requireInstalledPlugin(serverId, pluginId);

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
        provider: row.provider,
        tab: row.tab_id,
        plugin: row.project_title,
        enabled,
      },
    });
  });
}

/**
 * Remove a plugin: delete its jar (either enable state), optionally the
 * plugin's config/data folder, then the row.
 *
 * Bukkit-family plugins keep their settings in a folder named after the
 * PLUGIN, not the jar (`plugins/EssentialsX/` for `EssentialsX-2.20.1.jar`),
 * so `deleteData` matches install-directory subfolders against the project's
 * title and slug, case-insensitively, and deletes the matches. Matching
 * rather than deriving a name is deliberate: it can only ever touch a
 * folder the catalog's own names point at, never a neighbour's. A failed
 * directory listing (node down) leaves the configs in place rather than
 * failing the whole removal; the audit row records what was wiped.
 */
export async function removePlugin(
  serverId: string,
  actorId: string,
  pluginId: string,
  deleteData: boolean,
): Promise<void> {
  return withPluginMutation(serverId, async () => {
    const { ctx, row } = await requireInstalledPlugin(serverId, pluginId);

    await deletePluginFileBestEffort(ctx, row.filename);

    const deletedConfigDirs: string[] = [];
    if (deleteData && ctx.support.projectType === "plugin") {
      const wanted = new Set(
        [row.project_title, row.project_slug]
          .filter((name): name is string => name !== null)
          .map((name) => name.toLowerCase()),
      );
      try {
        const listing = await listServerFiles(
          ctx.nodeId,
          serverId,
          `/${ctx.support.directory}`,
        );
        for (const entry of listing.entries) {
          if (
            entry.type === "directory" &&
            wanted.has(entry.name.toLowerCase())
          ) {
            await deleteServerFile(
              ctx.nodeId,
              serverId,
              `/${ctx.support.directory}/${entry.name}`,
            );
            deletedConfigDirs.push(entry.name);
          }
        }
      } catch {
        // The jar is already gone; leave the configs rather than aborting.
      }
    }

    await sql`DELETE FROM server_plugins WHERE id = ${pluginId}`;

    await recordAudit({
      userId: actorId,
      action: "server.plugin.remove",
      targetType: "server",
      targetId: serverId,
      metadata: {
        provider: row.provider,
        tab: row.tab_id,
        plugin: row.project_title,
        filename: row.filename,
        ...(deletedConfigDirs.length > 0 ? { deletedConfigDirs } : {}),
      },
    });
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
  tabId?: string,
): Promise<ServerPluginList> {
  const ctx = await requirePluginContext(serverId, { tabId });
  const support = ctx.support;

  const rows = (await sql`
    SELECT * FROM server_plugins WHERE server_id = ${serverId} AND tab_id = ${ctx.tabId}
    ORDER BY project_title ASC
  `) as unknown as PluginRow[];

  const tab = ctx.tabs.find((tab) => tab.id === ctx.tabId)!;
  const directories = [
    ...new Set([
      support.directory,
      ...rows.map((row) => row.install_directory ?? support.directory),
    ]),
  ];
  const listings = new Map(
    await Promise.all(
      directories.map(async (directory) => {
        try {
          const listing = await listServerFiles(
            ctx.nodeId,
            serverId,
            `/${directory}`,
          );
          return [
            directory,
            listing.entries
              .filter((entry) => entry.type === "file")
              .map((entry) => entry.name),
          ] as const;
        } catch {
          return [directory, null] as const;
        }
      }),
    ),
  );
  const claimed = new Set<string>();
  const plugins = rows.map((row) => {
    const directory = row.install_directory ?? support.directory;
    if (directory === support.directory) {
      claimed.add(row.filename);
      claimed.add(`${row.filename}${DISABLED_SUFFIX}`);
    }
    const files = listings.get(directory);
    const present =
      files == null ||
      files.includes(row.filename) ||
      files.includes(`${row.filename}${DISABLED_SUFFIX}`);
    const status: InstalledPluginView["status"] = !present
      ? "missing"
      : row.enabled
        ? "enabled"
        : "disabled";
    return toView(row, status, {
      ...support,
      provider:
        tab.providers.find((provider) => provider.id === row.provider) ??
        support.provider,
    });
  });
  const providerView = (provider: ResolvedPluginSupport["provider"]) => ({
    id: provider.id,
    baseUrl: provider.baseUrl,
    downloadHosts: provider.downloadHosts,
  });
  const files = listings.get(support.directory);
  return {
    support: {
      id: ctx.tabId,
      label: support.label,
      directory: support.directory,
      projectType: support.projectType,
      ...(support.gameVersion ? { gameVersion: support.gameVersion } : {}),
      provider: providerView(support.provider),
      providers: tab.providers.map(providerView),
    },
    autoUpdate: ctx.autoUpdate,
    reconciled: [...listings.values()].every((listing) => listing !== null),
    plugins,
    untracked:
      files == null
        ? []
        : files.filter((name) => CONTENT_LIKE.test(name) && !claimed.has(name)),
  };
}

/**
 * The pre-start auto-updater: for every enabled plugin, check the catalog for
 * a newer release-channel version and install it before the container boots.
 *
 * Deliberately best-effort in every dimension. A catalog outage, a failed
 * download for one plugin, anything at all, must never block a server start.
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
    const rows = (await sql`
      SELECT * FROM server_plugins
      WHERE server_id = ${serverId}
        AND enabled = TRUE
    `) as unknown as PluginRow[];
    if (rows.length === 0) return;

    const checks = await Promise.all(
      rows.map(async (row) => {
        const tab = ctx.tabs.find((tab) => tab.id === row.tab_id);
        const provider = tab?.providers.find(
          (provider) => provider.id === row.provider,
        );
        if (!tab || !provider) return { row, latest: null, context: ctx };
        const context: PluginContext = {
          ...ctx,
          tabId: tab.id,
          support: {
            ...tab,
            provider,
            directory: row.install_directory ?? tab.directory,
          },
        };
        try {
          const versions = await engineListVersions(
            context.support,
            row.project_id,
          );
          const latest =
            versions.find(
              (v) =>
                v.channel === "release" &&
                v.files.some((file) =>
                  isContentFilename(file.filename, tab.projectType),
                ),
            ) ?? null;
          return { row, latest, context };
        } catch {
          return { row, latest: null, context };
        }
      }),
    );

    const updated: {
      tab: string;
      provider: string;
      plugin: string;
      from: string;
      to: string;
    }[] = [];
    for (const { row, latest, context } of checks) {
      if (!latest || latest.versionId === row.version_id) continue;
      try {
        await applyVersion(
          context,
          {
            projectId: row.project_id,
            ...(row.project_slug ? { slug: row.project_slug } : {}),
            ...(row.project_author ? { author: row.project_author } : {}),
            title: row.project_title,
            ...(row.project_icon_url ? { iconUrl: row.project_icon_url } : {}),
          },
          latest,
          null,
        );
        updated.push({
          tab: row.tab_id,
          provider: row.provider,
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
        metadata: { updated },
      });
    }
  } catch (error) {
    console.warn(
      "[plugins] pre-start auto-update failed (start proceeds):",
      error,
    );
  }
}
