# Plugins, mods and datapacks

Blueprints declare content tabs and their catalog sources as JSON data. The panel
resolves each tab against the server's current configuration. Paper can expose
Plugins and Datapacks at the same time, while Fabric exposes Mods and Datapacks.
A tab that has no matching profile stays hidden; other tabs still work.

## Tabs own their profiles and sources

The `plugins` section accepts `tabs`, an ordered array. Each tab has:

- A stable `id` for URLs and installed rows, and an optional `label` for the
  displayed name. Profile labels can override it, so one tab can be called
  Plugins on Paper and Mods on Fabric. Changing a label is harmless; changing
  an ID disconnects that tab from its existing install records.
- A static `default` profile, or an `envField` and `variants` map. An unmatched
  env value falls back to `default`, if present. Profiles select the relative
  install `directory`, `projectType` (`plugin`, `mod`, `datapack`), loader
  facets, and the non-secret `gameVersionEnv`.
- A `providers` array of full fetch specs. Their IDs must be unique within the
  tab. A profile may restrict the array with `providerIds`, for example letting
  Paper use Modrinth and Hangar while Fabric uses only Modrinth.

The built-in presets illustrate the declaration. These constants produce plain
JSON objects; exported blueprints carry the full specs, with no code references:

```ts
plugins: {
  tabs: [
    {
      id: "plugins",
      label: "Plugins",
      default: {
        directory: "plugins",
        projectType: "plugin",
        loaders: ["paper"],
        gameVersionEnv: "VERSION",
      },
      providers: [MODRINTH_PROVIDER_SPEC, HANGAR_PROVIDER_SPEC],
    },
    {
      id: "datapacks",
      label: "Datapacks",
      default: {
        directory: "world/datapacks",
        projectType: "datapack",
        loaders: ["datapack"],
        gameVersionEnv: "VERSION",
      },
      providers: [MODRINTH_PROVIDER_SPEC],
    },
  ],
}
```

The blueprint editor names and adds tabs, edits each tab's profiles, and provides
Add Modrinth / Add Hangar buttons beside its provider JSON array. Adding a preset
preserves other sources. Import review uses that same editor and lists every
catalog and download host before saving. Validation caps a section at eight tabs,
four providers per tab and 64 KB.

The older single-`provider` declaration remains valid. It resolves to one tab
with the ID `plugins`, and opening it in the editor converts it to the new shape
without changing that identity. The API also keeps its default selection when
`tab` and `provider` are omitted. This preserves existing clients and installs.
Migration `028_plugin_tabs.sql` gives old rows that ID and backfills their
install directories from their previous blueprint profiles.

## Built-in Minecraft behavior

The Java blueprint retains the `plugins` identity for its TYPE-driven
Plugins/Mods tab. Paper and Purpur use Modrinth and Hangar; Spigot, Fabric and
Forge use Modrinth. The fixed `purpur`, `fabric` and `forge` blueprints reuse
the corresponding profile and provider rules while locking `TYPE` to that
software. Every Java server, including vanilla, also gets Datapacks from
Modrinth, filtered with the `datapack` loader. The default directory is
`world/datapacks`; a blueprint for another world name must set that directory
explicitly. The panel does not inspect world names or expand env values in paths.

[Velocity](velocity-proxy.md) has one static Plugins tab with Modrinth and
Hangar's Velocity platform. It has no datapack tab because the proxy hosts no
worlds. Hangar's Velocity platform versions are proxy versions, so that preset
does not confuse them with the blueprint's backend `MINECRAFT_VERSION` filter.

Tabs have separate routes under `/servers/:id/plugins/:tabId`. The legacy
`/servers/:id/plugins` route opens the first applicable tab, and remains the
canonical link for the `plugins` identity. Catalog search selects one source at
a time. Installed rows show all sources in that tab, identify their provider,
and use it for the version picker rather than the currently selected search
source. Equal project IDs from different catalogs remain separate installs.

## Panel-mediated flow

```text
browser -> panel routes (files permission; tab + provider IDs)
              |
              | blueprint + server_env -> applicable tab -> declared provider
              v
         plugins/engine.ts (GET templates and response mappings)
              |
              | re-resolve version, check project and compatibility,
              | select JAR/ZIP and validate its pinned download host
              v
         agent files/pull -> staged, contained write into the tab's directory
```

The browser never fetches a catalog or submits a download URL. Requests to
`/api/servers/:id/plugins` select a tab with `?tab=...`; search and versions also
accept `?provider=...`. Installs carry `tabId`, `providerId`, `projectId` and
`versionId`. The panel rejects providers that the active profile does not allow,
then re-resolves the catalog version before touching files. Single-version
endpoints may ignore search filters, so installation checks compatibility again.

Catalog search fetches ten projects per page through the panel's `offset`
parameter and displays the provider's total with previous/next controls.
Changing the query, tab or source returns to the first page. Responses from an
older search are ignored, and the displayed results are keyed by server, tab,
provider, query and offset. Offsets are non-negative safe integers rather than
clamped to 500, so later pages do not repeat earlier results.

Concrete versions such as `1.21.1` or `26.2` filter search and versions. Sentinels
such as `LATEST` leave game-version filtering off. The UI asks the operator to
set a concrete version instead of guessing. Loader filtering still applies.

The manual version picker tries the compatible, installable list first. If
that list is empty, the panel fetches the selected provider's project versions
again with loader and game-version filters removed, including providers using
the plain `{gameVersion}` template. `compatibilityFallback` marks this result,
and the dialog warns before listing all project versions. Rows show their game
versions, loaders and selected filename; versions without a JAR/ZIP for the
active tab remain visible with installation disabled. Both lists are paged
locally, ten versions at a time, because a provider need not offer a paginated
version endpoint. Opening another project or source resets the page; moving
between pages resets the list's scroll position.

Choosing a fallback release explicitly sends `allowIncompatible: true` on the
install request. Without that boolean, the install route retains its normal
loader/game-version check. The override is recorded in the install audit row
when a chosen release mismatches the profile. It only relaxes compatibility:
project identity, tab/provider selection, file type, filename collision checks
and pinned download hosts still apply. Providers without a single-version
endpoint resolve the chosen ID through the unfiltered project list. Automatic
updates keep using the compatible list and never enter this fallback.

Plugins and mods select `.jar` files; datapacks select `.zip` files. A Modrinth
project can offer both, and a datapack install must select its ZIP even if the
provider marks a mod wrapper JAR as primary. ZIPs stay packaged. The panel never
extracts catalog archives or runs their contents. Manually extracted packs are
managed through Files rather than this installed-file registry.

## Fetch specs remain data

A provider declares its public HTTPS API origin, endpoint path/query templates,
dot-path response mappings, optional search facets, pinned `downloadHosts`, and
optional project-page origin/path. The presets live in `modrinth-preset.ts` and
`hangar-preset.ts`, shared between built-ins and the blueprint editor.

Hangar's public API has numeric IDs and a single file object per platform, so
mapping accepts numeric identities and the optional `files.single` flag.
`{gameVersion}` supplies a plain version string alongside the existing
`{gameVersions}` JSON array. These are bounded data operations, with no custom
scripts, headers, request bodies or expressions. Hangar project links also need
an author; that catalog identity is recorded with the install.

Hangar allows arbitrary channel names. Its preset explicitly declares
`releaseChannels: ["Release"]`; other names normalize to prerelease channels
and cannot enter auto-update. That prevents a channel named Snapshot or Dev
from being treated as a stable release. Files uploaded to Hangar are pinned to
`hangarcdn.papermc.io`. Releases that only link to an external website have no
mapped installable file; the panel does not follow arbitrary external download
links or loosen host pins. Endpoint shapes follow
[Hangar's public API schema](https://hangar.papermc.io/v3/api-docs) and
[Modrinth's API documentation](https://docs.modrinth.com/api/).

## Safety and install identity

Every provider, including secondary sources, passes the same validation on
admin writes and import. Origins are HTTPS and blocklist-checked; download
hosts are exact pins. The engine repeats host checks at fetch time, size-caps
metadata responses and sets timeouts. Templates use a fixed vocabulary and
receive no secret env values. Catalog filenames must be safe basenames of the
expected type. The agent's `paths.ts` containment remains the final boundary.

The install registry is keyed by `(server, tab, provider, project)` and stores
the actual install directory. Changing a profile's directory cannot redirect a
removal at a different directory. Lists reconcile each recorded directory with
disk and show missing or untracked files; a node outage returns DB state with
`reconciled: false`. Installs refuse filenames claimed by another project or
untracked files already on disk, rather than silently replacing another source's
content. Concurrent content writes on the same server are rejected within the
panel process, so two catalog installs cannot both pass the filename check
before either claims the file. Reinstalling the same identity updates it in place and preserves its
enabled flag, including the `.disabled` filename state.

Enable/disable renames the file with a `.disabled` suffix; changes take effect
on the next load or restart. Removal deletes its recorded file and row. Only
plugin profiles offer optional config/data-folder removal: Bukkit-family folders
are matched against the recorded title and slug, case-insensitively. Datapacks
and mods never use that plugin-folder cleanup heuristic. Wiped folders are
recorded in the audit row; a failed directory listing leaves them intact.

The optional project-page URL is composed by the panel from validated data,
with percent-encoded project, slug and author values. It is the one catalog URL
intended for browser navigation. Links use `noopener noreferrer`. Built-ins are
synced into PostgreSQL at boot, so changing a preset takes effect after the
panel starts again. Apply the schema migration before running the new panel.

## Auto-update and permissions

`servers.plugin_auto_update` is one server-wide setting shared by all tabs.
Before start/restart, the updater checks every enabled install against its
recorded tab and provider, keeping its recorded directory. A removed provider
or an inactive tab is skipped. It chooses only a compatible release with an
installable file of the right type. Catalog outages and individual failures
remain best-effort and never block startup. One summary audit row records a
pass that changed anything.

Reinstalling a server clears the registry with its files, so the next start
cannot silently restore content that reinstall removed. See
[server-lifecycle.md](server-lifecycle.md).

Every content route and tab uses the `files` subuser permission, because an
install is a filesystem write. See [subusers.md](subusers.md). Audited actions
remain `server.plugin.install`, `.remove`, `.toggle`, `.settings` and
`.auto-update`; install/removal/toggle metadata identifies the tab and source.
Blueprint create/update audits cover the declared content section.

## Files

| Piece | Where |
| --- | --- |
| Schema, validation, resolution | `apps/frontend/lib/server/control-plane/blueprints/plugins.ts` |
| Fetch engine and mapping | `.../plugins/engine.ts`, `mapping.ts` |
| File-type selection | `.../plugins/files.ts` |
| Catalog presets | `apps/frontend/lib/modrinth-preset.ts`, `hangar-preset.ts` |
| Lifecycle and auto-update | `.../services/pluginManager.ts` |
| API routes | `.../routes/plugins.ts` |
| Registry migration | `.../db/migrations/028_plugin_tabs.sql` |
| Tab UI and navigation | `apps/frontend/components/server/plugins-tab.tsx`, `server-tabs.tsx` |
| Blueprint editor and I/O | `apps/frontend/components/admin/blueprint-form-dialog.tsx`, `lib/blueprint-io.ts` |
