"use client";

import * as React from "react";
import Link from "next/link";

import {
  Download,
  ExternalLink,
  History,
  Puzzle,
  Search,
  Settings,
  Trash2,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  compareGameVersions,
  formatBytes,
  formatRelative,
  initials,
  newestGameVersion,
} from "@/lib/format";
import {
  ApiError,
  getServerPluginVersions,
  getServerPlugins,
  installServerPlugin,
  removeServerPlugin,
  searchServerPlugins,
  toggleServerPlugin,
  updateServerPluginSettings,
} from "@/lib/api";
import type {
  InstalledPluginView,
  PluginSearchResult,
  PluginVersionView,
  ServerPluginList,
} from "@/lib/types";

const compact = new Intl.NumberFormat("en", { notation: "compact" });

function ChannelBadge({ channel }: { channel: string }) {
  if (channel === "beta" || channel === "alpha") {
    return <Badge variant="outline">{channel}</Badge>;
  }
  return <Badge variant="secondary">release</Badge>;
}

function StatusBadge({ status }: { status: InstalledPluginView["status"] }) {
  if (status === "missing") return <Badge variant="destructive">Missing</Badge>;
  if (status === "disabled") return <Badge variant="secondary">Disabled</Badge>;
  return <Badge variant="default">Enabled</Badge>;
}

/**
 * The version picker: one catalog project's installable versions, newest
 * first. Installing an older version is allowed (a downgrade is sometimes the
 * fix for a bad release); the currently installed one is marked.
 */
function VersionsDialog({
  serverId,
  project,
  installedVersionId,
  gameVersion,
  open,
  onOpenChange,
  onInstalled,
}: {
  serverId: string;
  project: { projectId: string; title: string; projectUrl?: string };
  installedVersionId?: string;
  gameVersion?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  const [versions, setVersions] = React.useState<PluginVersionView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [installingId, setInstallingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setVersions(null);
      setError(null);
      try {
        const list = await getServerPluginVersions(serverId, project.projectId);
        if (!cancelled) setVersions(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load versions.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, serverId, project.projectId]);

  const install = async (version: PluginVersionView) => {
    setInstallingId(version.versionId);
    setError(null);
    try {
      await installServerPlugin(serverId, project.projectId, version.versionId);
      onInstalled();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to install.");
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1">
            <span className="truncate">{project.title}</span>
            {project.projectUrl && (
              <ProjectPageLink
                url={project.projectUrl}
                title={project.title}
                className="shrink-0"
              />
            )}
          </DialogTitle>
          <DialogDescription>
            Pick a version to install. The newest is first; game-version
            compatibility is shown per version.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto">
          {versions === null ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : (
                <Spinner />
              )}
            </div>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No versions match this server&apos;s loader and game version.
            </p>
          ) : (
            versions.map((version) => {
              const file = version.files.find((f) => f.primary) ?? version.files[0];
              const installed = version.versionId === installedVersionId;
              const incompatible =
                gameVersion !== undefined &&
                version.gameVersions.length > 0 &&
                !version.gameVersions.includes(gameVersion);
              return (
                <div
                  key={version.versionId}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-sm">
                        {version.versionNumber}
                      </span>
                      <ChannelBadge channel={version.channel} />
                      {installed && <Badge variant="default">Installed</Badge>}
                      {incompatible && (
                        <Badge variant="destructive">
                          Not for {gameVersion}
                        </Badge>
                      )}
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {[...version.gameVersions]
                        .sort((a, b) => compareGameVersions(b, a))
                        .slice(0, 3)
                        .join(", ") || "any version"}
                      {file ? ` · ${formatBytes(file.sizeBytes)}` : ""}
                      {version.datePublished
                        ? ` · ${formatRelative(version.datePublished)}`
                        : ""}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={installed ? "outline" : "default"}
                    disabled={installingId !== null}
                    onClick={() => install(version)}
                  >
                    {installingId === version.versionId ? (
                      <Spinner />
                    ) : (
                      <Download />
                    )}
                    {installed ? "Reinstall" : "Install"}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The catalog's own page for a project, in a new tab. `noreferrer` keeps the
 * panel's URL (which can carry a server id) out of the catalog's logs.
 */
function ProjectPageLink({
  url,
  title,
  className,
}: {
  url: string;
  title: string;
  className?: string;
}) {
  return (
    <Button
      render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      nativeButton={false}
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label={`Open the ${title} page in a new tab`}
    >
      <ExternalLink />
    </Button>
  );
}

/**
 * One catalog search hit. Clicking the row opens the version picker; the
 * trailing link opens the project's own page. Two controls means the row is a
 * div wrapping a button, not a button (an anchor inside a button is invalid
 * markup and the nested click never behaves).
 */
function SearchResultRow({
  result,
  installed,
  gameVersion,
  onPick,
}: {
  result: PluginSearchResult;
  installed: boolean;
  gameVersion?: string;
  onPick: () => void;
}) {
  const incompatible =
    gameVersion !== undefined &&
    result.gameVersions.length > 0 &&
    !result.gameVersions.includes(gameVersion);
  // Catalogs list supported versions in arbitrary order (Modrinth's search is
  // oldest-first), so the newest must be computed, not indexed.
  const newest = newestGameVersion(result.gameVersions);
  return (
    <div className="flex items-center gap-1 rounded-lg border pr-1 transition-colors hover:bg-muted/50">
      <button
        type="button"
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
      >
        <Avatar className="size-8 rounded-md">
          {result.iconUrl ? (
            <AvatarImage src={result.iconUrl} alt="" />
          ) : null}
          <AvatarFallback className="rounded-md text-xs">
            {initials(result.title)}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{result.title}</span>
            {installed && <Badge variant="secondary">Installed</Badge>}
            {incompatible && (
              <Badge variant="outline">Not for {gameVersion}</Badge>
            )}
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {result.author} · {compact.format(result.downloads)} downloads
            {newest ? ` · up to ${newest}` : ""}
          </span>
        </div>
      </button>
      {result.projectUrl && (
        <ProjectPageLink url={result.projectUrl} title={result.title} />
      )}
    </div>
  );
}

/**
 * The Plugins/Mods tab.
 *
 * Search and installs go through the panel, which executes the blueprint's
 * provider fetch spec (Modrinth for the built-in Minecraft blueprints) and
 * pins every download to the spec's declared hosts — the tab footer always
 * shows which catalog serves this server, so the content source is never
 * hidden. The installed list is reconciled against the server's actual
 * directory: jars deleted through the Files tab show as missing, manually
 * added ones as untracked.
 *
 * Plugin changes apply the next time the server starts (or restarts — which
 * also runs the release-channel auto-updater first when enabled).
 */
export function PluginsTab({ serverId }: { serverId: string }) {
  const [list, setList] = React.useState<ServerPluginList | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [unsupported, setUnsupported] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PluginSearchResult[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [versionPicker, setVersionPicker] = React.useState<{
    projectId: string;
    title: string;
    projectUrl?: string;
  } | null>(null);
  // Removal goes through a confirm dialog: the jar always goes, the plugin's
  // config/data folder only when the (default-on) checkbox says so.
  const [removeTarget, setRemoveTarget] = React.useState<InstalledPluginView | null>(null);
  const [removeConfigs, setRemoveConfigs] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getServerPlugins(serverId);
        if (!cancelled) setList(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          if (!cancelled) setDenied(true);
        } else if (err instanceof ApiError && err.status === 404) {
          if (!cancelled) setUnsupported(true);
        } else if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load plugins.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, refreshKey]);

  // Debounced search: 300ms after the last keystroke, matching the combobox
  // pattern. Empty query clears rather than browsing.
  React.useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await searchServerPlugins(serverId, text);
        setResults(data.results);
        setSearchError(null);
      } catch (err) {
        setSearchError(
          err instanceof ApiError ? err.message : "Search failed.",
        );
        setResults(null);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [serverId, query]);

  const reload = () => setRefreshKey((k) => k + 1);

  const toggle = async (plugin: InstalledPluginView) => {
    setBusyId(plugin.id);
    setError(null);
    setNote(null);
    try {
      await toggleServerPlugin(serverId, plugin.id);
      setNote(
        plugin.enabled
          ? `Disabled ${plugin.title}. Reload or restart to apply.`
          : `Enabled ${plugin.title}. Reload or restart to apply.`,
      );
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to toggle plugin.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    setBusyId(removeTarget.id);
    setError(null);
    setNote(null);
    try {
      await removeServerPlugin(serverId, removeTarget.id, removeConfigs);
      setNote(
        `Removed ${removeTarget.title}${
          removeConfigs ? " and its config folder" : ""
        }. Restart to apply.`,
      );
      setRemoveTarget(null);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove plugin.");
    } finally {
      setBusyId(null);
    }
  };

  const setAutoUpdate = async (enabled: boolean) => {
    if (!list) return;
    setList({ ...list, autoUpdate: enabled });
    try {
      await updateServerPluginSettings(serverId, enabled);
    } catch (err) {
      setList({ ...list, autoUpdate: !enabled });
      setError(
        err instanceof ApiError ? err.message : "Failed to update the setting.",
      );
    }
  };

  if (denied) {
    return (
      <Empty className="min-h-[12rem]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Puzzle />
          </EmptyMedia>
          <EmptyTitle>No access</EmptyTitle>
          <EmptyDescription>
            You need permission to manage this server&apos;s files to view its
            plugins.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (unsupported) {
    return (
      <Empty className="min-h-[12rem]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Puzzle />
          </EmptyMedia>
          <EmptyTitle>Not supported</EmptyTitle>
          <EmptyDescription>
            This server&apos;s blueprint doesn&apos;t declare plugin support for
            its current configuration.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {list && !list.support.gameVersion && (
        <Alert>
          <Settings />
          <AlertTitle>Set your server&apos;s game version</AlertTitle>
          <AlertDescription>
            The version env is a sentinel like{" "}
            <span className="font-mono">LATEST</span>, so search results and
            updates aren&apos;t filtered by game version.{" "}
            <Link
              href={`/servers/${serverId}/settings`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Set a concrete version in Settings
            </Link>{" "}
            for accurate filtering.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{list?.support.label ?? "Plugins"}</CardTitle>
          <CardDescription>
            Search the catalog and install{" "}
            {list?.support.projectType === "mod" ? "mods" : "plugins"} into{" "}
            <span className="font-mono">{list?.support.directory ?? "…"}</span>
            {list?.support.gameVersion
              ? ` for Minecraft ${list.support.gameVersion}`
              : ""}
            . Changes apply the next time the server starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the catalog…"
              className="pl-8"
              aria-label="Search the catalog"
            />
          </div>

          {searching ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <Spinner />
            </div>
          ) : searchError ? (
            <p className="text-sm text-destructive">{searchError}</p>
          ) : results === null ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              Type at least two characters to search.
            </p>
          ) : results.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              No results.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {results.map((result) => (
                <SearchResultRow
                  key={result.projectId}
                  result={result}
                  installed={list?.plugins.some(
                    (p) => p.projectId === result.projectId,
                  ) === true}
                  gameVersion={list?.support.gameVersion}
                  onPick={() =>
                    setVersionPicker({
                      projectId: result.projectId,
                      title: result.title,
                      ...(result.projectUrl
                        ? { projectUrl: result.projectUrl }
                        : {}),
                    })
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Installed</CardTitle>
          <CardDescription>
            {list?.reconciled === false
              ? "The node could not be reached, so this is the panel's record — files on disk are unknown."
              : "Tracked against the server's directory. Changes apply the next time the server starts."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Spinner />
            </div>
          ) : error && list === null ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (list?.plugins.length ?? 0) === 0 ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              Nothing installed yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {list?.plugins.map((plugin) => (
                <div
                  key={plugin.id}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-8 rounded-md">
                      {plugin.iconUrl ? (
                        <AvatarImage src={plugin.iconUrl} alt="" />
                      ) : null}
                      <AvatarFallback className="rounded-md text-xs">
                        {initials(plugin.title)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {plugin.title}
                        </span>
                        <StatusBadge status={plugin.status} />
                      </div>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {plugin.versionNumber} · {plugin.filename}
                        {plugin.fileSizeBytes !== null
                          ? ` · ${formatBytes(plugin.fileSizeBytes)}`
                          : ""}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {plugin.projectUrl && (
                      <ProjectPageLink
                        url={plugin.projectUrl}
                        title={plugin.title}
                      />
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === plugin.id}
                      onClick={() => toggle(plugin)}
                    >
                      {plugin.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Versions for ${plugin.title}`}
                      disabled={busyId === plugin.id}
                      onClick={() =>
                        setVersionPicker({
                          projectId: plugin.projectId,
                          title: plugin.title,
                          ...(plugin.projectUrl
                            ? { projectUrl: plugin.projectUrl }
                            : {}),
                        })
                      }
                    >
                      <History />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${plugin.title}`}
                      disabled={busyId === plugin.id}
                      onClick={() => {
                        setRemoveConfigs(true);
                        setRemoveTarget(plugin);
                      }}
                    >
                      {busyId === plugin.id ? <Spinner /> : <Trash2 />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {list && list.untracked.length > 0 && (
            <div className="rounded-lg border border-dashed px-3 py-2">
              <p className="text-xs font-medium text-muted-foreground">
                Present in {list.support.directory} but not managed by the panel:
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {list.untracked.map((name) => (
                  <li key={name} className="font-mono text-xs text-muted-foreground">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && list !== null && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-update</CardTitle>
          <CardDescription>
            Check every installed plugin for a newer release-channel version
            before each start, and install it automatically. Beta and alpha
            versions are never taken automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <label
            htmlFor="plugin-auto-update"
            className="text-sm text-muted-foreground"
          >
            Update plugins automatically before start
          </label>
          <Switch
            id="plugin-auto-update"
            checked={list?.autoUpdate ?? false}
            onCheckedChange={setAutoUpdate}
          />
        </CardContent>
      </Card>

      {list && (
        <p className="text-xs text-muted-foreground">
          Content via {list.support.provider.id} —{" "}
          {list.support.provider.baseUrl}, downloads from{" "}
          {list.support.provider.downloadHosts.join(", ")}.
        </p>
      )}

      {versionPicker && (
        <VersionsDialog
          serverId={serverId}
          project={versionPicker}
          installedVersionId={list?.plugins.find(
            (p) => p.projectId === versionPicker.projectId,
          )?.versionId}
          gameVersion={list?.support.gameVersion}
          open={versionPicker !== null}
          onOpenChange={(open) => {
            if (!open) setVersionPicker(null);
          }}
          onInstalled={() => {
            setNote("Installed. Restart the server to load it.");
            reload();
          }}
        />
      )}

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.title}</DialogTitle>
            <DialogDescription>
              Deletes{" "}
              <span className="font-mono">{removeTarget?.filename}</span> from{" "}
              <span className="font-mono">
                {list?.support.directory}
              </span>{" "}
              and removes it from this list.
            </DialogDescription>
          </DialogHeader>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={removeConfigs}
              onCheckedChange={(checked) => setRemoveConfigs(checked === true)}
              aria-label="Also delete the plugin's config folder"
            />
            <span className="text-muted-foreground">
              Also delete the plugin&apos;s config folder (
              <span className="font-mono">
                {list?.support.directory}/{removeTarget?.title}/
              </span>
              ) — its settings and data. Uncheck to keep configs for a
              reinstall.
            </span>
          </label>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busyId !== null}
              onClick={remove}
            >
              {busyId !== null && <Spinner />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
