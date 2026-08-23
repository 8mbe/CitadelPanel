# Plugins / mods

Blueprint-declared, panel-mediated plugin and mod management. A server gets a
"Plugins" (or "Mods", or whatever the blueprint names it) tab when its
blueprint declares plugin support **that resolves for the server's current
configuration**. No declaration, no tab.

## The shape of a declaration

Everything lives in the blueprint's `plugins` section, as pure JSON data:

- **Profiles.** The tab label, the install directory inside the data dir
  (`plugins`, `mods`, `world/datapacks`, …), the content type facet
  (`mod` / `plugin` / `datapack`), loader facets, and which env key holds the
  game version. Profiles can be **static** (one `default`) or **env-driven**
  (`envField` + `variants`): minecraft-java keys off `TYPE`, so a Paper server
  gets "Plugins" into `plugins/`, a Fabric server gets "Mods" into `mods/`,
  and a vanilla server gets no tab at all (VANILLA has no variant). The
  `velocity` blueprint is the static case. A proxy only ever loads Velocity
  plugins from `plugins/`, so there is nothing to switch on
  (`velocity-proxy.md`).
- **Provider fetch spec.** How to talk to the catalog: the https API origin,
  endpoint path/query **templates** (`{query}`, `{projectId}`, `{loaders}`,
  `{facets}`, …), response field mappings as dot-paths, facet composition
  rules, the pinned `downloadHosts`, and optionally the catalog's site origin +
  project-page path (for the "open the project page" link). The Modrinth
  declaration lives in
  `apps/frontend/lib/modrinth-preset.ts` and is shared by the built-in
  minecraft-java blueprint and the blueprint form's "Modrinth preset" button.

The whole section travels with blueprint export/import (shareable like the
rest of the blueprint) and is validated on every admin write. See the safety
model below. Servers store their installed set in the `server_plugins` table
(project/version linkage, filename, enabled flag, who installed what).

## Flow

```
browser ──> panel routes (routes/plugins.ts, `files` permission)
                │  resolve blueprint + server_env → ResolvedPluginSupport
                ▼
          plugins/engine.ts interprets the fetch spec (search / versions /
          version), size-capped, timeout, host-checked
                │  file URL from the catalog response
                ▼
          agent POST /v1/servers/:id/files/pull, staged, size-capped,
          path-contained binary write into <directory>/<filename>
```

The browser never talks to the catalog; the panel never executes catalog
content. The agent is unchanged. Installs are ordinary `files/pull`
operations, contained by `paths.ts` like every other file write. Enable/disable
is a rename to `<file>.jar.disabled` (which Bukkit-family loaders and Fabric
ignore).

Removal deletes the jar and the row; optionally (`deleteData`, a checkbox in
the confirm dialog, default on) it also deletes the plugin's config/data
folder. Bukkit-family plugins name that folder after the *plugin*, not the jar
(`plugins/EssentialsX/` for `EssentialsX-2.20.1.jar`), so the panel matches
install-directory subfolders against the project's title and slug
(case-insensitive) and deletes the matches. Matching rather than name-deriving
means it can only touch folders the catalog's own names point at. Wiped
folders are recorded in the audit row; a failed directory listing leaves the
configs in place rather than failing the removal.

## Safety model for shared blueprints

A blueprint file is already a dangerous object (it carries a Docker image and
an install script); the plugins section is designed to add **zero new
code-execution primitives**:

- **Interpreted, never executed.** Templates are substituted from a fixed
  variable vocabulary. There is no expression parser, no scripts, no
  headers, no request bodies, no non-GET methods. Responses are read only
  through declared dot-path mappings and trimmed.
- **Hosts are pinned and public.** Validation (`parsePluginSupport`) enforces
  https-only origins that pass the SSRF blocklist (no loopback/RFC1918/
  link-local), exact hostname pins for downloads, and the engine re-checks
  the origin at fetch time, including the host a redirect actually landed on.
  A shared blueprint cannot aim the panel or its auto-updater at internal
  networks.
- **Downloads are fenced twice.** Every file URL must be https, exactly match
  a declared `downloadHosts` entry and pass the blocklist before the agent is
  asked to fetch it; the filename must match a strict `.jar` pattern (no path
  separators). The agent's `paths.ts` containment is the backstop.
- **The source is never hidden.** The blueprint form (and the import review
  step, which is that form) shows a "Network access" callout naming the catalog
  and download hosts before saving; the server's plugins tab footers the same
  list. Importing a blueprint is the trust decision, made explicit rather
  than silent.
- **No secrets in templates.** Template variables carry no env values, so
  server secrets can't leak into catalog queries.

Residual risks, stated plainly: an admin who imports a blueprint without
reading the callout has delegated plugin downloads to that blueprint's
(public) hosts; the SSRF guard is hostname-based (see `lib/ssrf.ts`, the same
guard that protects blueprint import-URL and files-pull), so DNS rebinding to
a private IP is a panel-wide, pre-existing limitation; nothing scans jars for
malware, since mods are third-party code by nature.

## Game-version filtering

Compatibility filtering uses the version the user sets: the profile's
`gameVersionEnv` (minecraft-java: `VERSION`). A concrete value (`1.21.1`)
drives the search facet, version-list filtering and auto-update selection, and
is shown in the tab header ("… for Minecraft 1.21.1"); search results and
version rows that don't support it are badged "Not for <version>". The panel
deliberately does not guess a version. When the env is a sentinel like
`LATEST`, filtering is unversioned and the plugins tab asks the user to
set a concrete version in Settings → Environment (the editable-env flow
already lives there). Version strings are compared numerically per segment,
never lexicographically ("1.8.8" is *older* than "1.21.1"; see
`compareGameVersions` in `lib/format.ts`), and catalog version lists arrive in
arbitrary order (Modrinth's search is oldest-first), so the newest is computed,
not indexed.

That ordering is also why the supported-version list is the **one** mapped
array the engine never caps (`asGameVersionList` in `plugins/mapping.ts`).
Every other mapped list gets a display cap; capping this one truncates the
*end* of an oldest-first list, which holds the current versions, and
compatibility is decided by `includes(gameVersion)`. A 200-entry cap did
exactly that: Simple Voice Chat lists 259 supported game versions with the
current one at index 249, so the tab badged it "Not for 26.2" while its
version picker showed every release supporting 26.2. Response size
(`MAX_RESPONSE_BYTES`) is the bound that matters here, not element count.

Note also what the badge can and cannot tell you: when the provider spec has a
`gameVersion` facet (Modrinth does), search results are already filtered by
the server's version server-side, so a badge on a search row means the
catalog's *project-level* list disagrees with its own filter, usually a
mapping bug, as above. The badge stays for providers with no such facet, where
it is the only compatibility signal.

## Opening the catalog's own page

Note the seeding lag this shares with every other spec field: blueprints are
read from the `blueprints` table at run time, and built-ins are written there
by `syncBlueprintsToDatabase` at process boot. Editing `modrinth-preset.ts`
therefore changes nothing for a *running* panel. The new spec (and the link)
appears after a restart, which an upgrade does anyway.

A fetch spec may declare `siteUrl` (the catalog's human-facing origin, e.g.
`https://modrinth.com`, distinct from `baseUrl`, its API) plus a
`projectPath` template (`/{projectType}/{slug}`). When both are present, the
plugins tab shows an external-link button on search hits, on installed rows
and in the version picker's header; when either is missing, no link appears
and nothing else changes.

The panel composes that URL (`providerProjectUrl`) rather than letting the
browser assemble one from spec fields. It is the only provider URL a user's
browser ever sees, so it goes through the same discipline as everything else
here: the origin is validated https and blocklist-checked at write time *and*
again at compose time (the spec lives in a database row), the template
vocabulary is its own small set (`projectId`, `slug`, `projectType`, with no
API variables), and interpolated values are percent-encoded so a hostile slug
cannot add path segments or query material. The slug is preferred but the
project id works as a fallback (Modrinth redirects `/mod/<id>` to the
canonical page), so plugins installed before a slug was recorded still link
somewhere useful. Links open in a new tab with `rel="noopener noreferrer"`,
which also keeps the panel URL (it carries a server id) out of the catalog's
referrer logs.

## Auto-update before start

When `servers.plugin_auto_update` is on (default), `startServer` and
`restartServer` run `autoUpdateServerPlugins` before touching the container:
every **enabled** plugin's project is checked for a newer **release-channel**
version (betas/alphas are never auto-taken) and updated in place, filtered by
the user-set game version above. The whole pass is best-effort. A catalog
outage or a single failed download logs a warning and the start proceeds. One
summary audit row (`server.plugin.auto-update`) is written when anything
changed.

This is also why reinstalling a server deletes its `server_plugins` rows rather
than leaving them: the jars are wiped with everything else, and rows pointing at
files that no longer exist would have this pass re-download every one of them on
the next start, giving a fresh install that quietly restores the plugins it
was asked to remove. See [server-lifecycle.md](server-lifecycle.md).

## Permissions & auditing

The tab and all plugin routes ride the `files` subuser permission (installing
a plugin *is* a filesystem write; the same reasoning that puts ports under
`settings`). Audited actions: `server.plugin.install`, `.remove`, `.toggle`,
`.settings`, `.auto-update`, and `blueprint.plugins.update` (via blueprint
create/update).

## Adding another game

Write the catalog's fetch spec as data, either by hand or by extending
`modrinth-preset.ts`-style presets, and reference it from a blueprint's
plugins section. If the catalog's grammar doesn't fit the engine's model
(paginated cursors, auth headers, POST searches), extend the engine
deliberately: every capability added there is a capability a shared blueprint
can invoke, so keep it declarative and host-pinned.

## Files

| Piece | Where |
| --- | --- |
| Schema, validation, resolution | `apps/frontend/lib/server/control-plane/blueprints/plugins.ts` |
| Fetch engine | `apps/frontend/lib/server/control-plane/plugins/engine.ts` |
| Response mapping + project-page URL (pure, unit-tested) | `apps/frontend/lib/server/control-plane/plugins/mapping.ts` |
| Modrinth declaration (preset) | `apps/frontend/lib/modrinth-preset.ts` |
| Lifecycle + auto-update | `apps/frontend/lib/server/control-plane/services/pluginManager.ts` |
| Routes | `apps/frontend/lib/server/control-plane/routes/plugins.ts` |
| Migrations | `.../db/migrations/015_blueprint_plugins.sql`, `016_server_plugins.sql` |
| Tab UI | `apps/frontend/components/server/plugins-tab.tsx` |
| Blueprint form section + review callout | `apps/frontend/components/admin/blueprint-form-dialog.tsx` |
