# Plugins / mods

Blueprint-declared, panel-mediated plugin and mod management. A server gets a
"Plugins" (or "Mods", or whatever the blueprint names it) tab when its
blueprint declares plugin support **that resolves for the server's current
configuration** — no declaration, no tab.

## The shape of a declaration

Everything lives in the blueprint's `plugins` section, as pure JSON data:

- **Profiles** — the tab label, the install directory inside the data dir
  (`plugins`, `mods`, `world/datapacks`, …), the content type facet
  (`mod` / `plugin` / `datapack`), loader facets, and which env key holds the
  game version. Profiles can be **static** (one `default`) or **env-driven**
  (`envField` + `variants`): minecraft-java keys off `TYPE`, so a Paper server
  gets "Plugins" into `plugins/`, a Fabric server gets "Mods" into `mods/`,
  and a vanilla server gets no tab at all (VANILLA has no variant). The
  `velocity` blueprint is the static case — a proxy only ever loads Velocity
  plugins from `plugins/`, so there is nothing to switch on
  (`velocity-proxy.md`).
- **Provider fetch spec** — how to talk to the catalog: the https API origin,
  endpoint path/query **templates** (`{query}`, `{projectId}`, `{loaders}`,
  `{facets}`, …), response field mappings as dot-paths, facet composition
  rules, and the pinned `downloadHosts`. The Modrinth declaration lives in
  `apps/frontend/lib/modrinth-preset.ts` and is shared by the built-in
  minecraft-java blueprint and the blueprint form's "Modrinth preset" button.

The whole section travels with blueprint export/import (shareable like the
rest of the blueprint) and is validated on every admin write — see the safety
model below. Servers store their installed set in the `server_plugins` table
(project/version linkage, filename, enabled flag, who installed what).

## Flow

```
browser ──> panel routes (routes/plugins.ts, `files` permission)
                │  resolve blueprint + server_env → ResolvedPluginSupport
                ▼
          plugins/engine.ts — interprets the fetch spec (search / versions /
          version), size-capped, timeout, host-checked
                │  file URL from the catalog response
                ▼
          agent POST /v1/servers/:id/files/pull — staged, size-capped,
          path-contained binary write into <directory>/<filename>
```

The browser never talks to the catalog; the panel never executes catalog
content. The agent is unchanged — installs are ordinary `files/pull`
operations, contained by `paths.ts` like every other file write. Enable/disable
is a rename to `<file>.jar.disabled` (which Bukkit-family loaders and Fabric
ignore).

Removal deletes the jar and the row; optionally (`deleteData`, a checkbox in
the confirm dialog, default on) it also deletes the plugin's config/data
folder. Bukkit-family plugins name that folder after the *plugin*, not the jar
(`plugins/EssentialsX/` for `EssentialsX-2.20.1.jar`), so the panel matches
install-directory subfolders against the project's title and slug
(case-insensitive) and deletes the matches — matching rather than name-deriving
means it can only touch folders the catalog's own names point at. Wiped
folders are recorded in the audit row; a failed directory listing leaves the
configs in place rather than failing the removal.

## Safety model for shared blueprints

A blueprint file is already a dangerous object (it carries a Docker image and
an install script); the plugins section is designed to add **zero new
code-execution primitives**:

- **Interpreted, never executed.** Templates are substituted from a fixed
  variable vocabulary — there is no expression parser, no scripts, no
  headers, no request bodies, no non-GET methods. Responses are read only
  through declared dot-path mappings and trimmed.
- **Hosts are pinned and public.** Validation (`parsePluginSupport`) enforces
  https-only origins that pass the SSRF blocklist (no loopback/RFC1918/
  link-local), exact hostname pins for downloads, and the engine re-checks the
  origin — and the host a redirect actually landed on — at fetch time. A
  shared blueprint cannot aim the panel or its auto-updater at internal
  networks.
- **Downloads are fenced twice.** Every file URL must be https, exactly match
  a declared `downloadHosts` entry and pass the blocklist before the agent is
  asked to fetch it; the filename must match a strict `.jar` pattern (no path
  separators). The agent's `paths.ts` containment is the backstop.
- **The source is never hidden.** The blueprint form (and the import review
  step, which is that form) shows a "Network access" callout naming the catalog
  and download hosts before saving; the server's plugins tab footers the same
  list. Importing a blueprint is the trust decision — it is made explicit,
  not silent.
- **No secrets in templates.** Template variables carry no env values, so
  server secrets can't leak into catalog queries.

Residual risks, stated plainly: an admin who imports a blueprint without
reading the callout has delegated plugin downloads to that blueprint's
(public) hosts; the SSRF guard is hostname-based (see `lib/ssrf.ts` — the same
guard that protects blueprint import-URL and files-pull), so DNS rebinding to
a private IP is a panel-wide, pre-existing limitation; nothing scans jars for
malware — mods are third-party code by nature.

## Game-version filtering

Compatibility filtering uses the version the user sets: the profile's
`gameVersionEnv` (minecraft-java: `VERSION`). A concrete value (`1.21.1`)
drives the search facet, version-list filtering and auto-update selection, and
is shown in the tab header ("… for Minecraft 1.21.1"); search results and
version rows that don't support it are badged "Not for <version>". The panel
deliberately does not guess a version — when the env is a sentinel like
`LATEST`, filtering is simply unversioned and the plugins tab asks the user to
set a concrete version in Settings → Environment (the editable-env flow
already lives there). Version strings are compared numerically per segment,
never lexicographically ("1.8.8" is *older* than "1.21.1"; see
`compareGameVersions` in `lib/format.ts`), and catalog version lists arrive in
arbitrary order (Modrinth's search is oldest-first), so the newest is computed,
not indexed.

## Auto-update before start

When `servers.plugin_auto_update` is on (default), `startServer` and
`restartServer` run `autoUpdateServerPlugins` before touching the container:
every **enabled** plugin's project is checked for a newer **release-channel**
version (betas/alphas are never auto-taken) and updated in place, filtered by
the user-set game version above. The whole pass is best-effort — a catalog
outage or a single failed download logs a warning and the start proceeds. One
summary audit row (`server.plugin.auto-update`) is written when anything
changed.

## Permissions & auditing

The tab and all plugin routes ride the `files` subuser permission (installing
a plugin *is* a filesystem write; the same reasoning that puts ports under
`settings`). Audited actions: `server.plugin.install`, `.remove`, `.toggle`,
`.settings`, `.auto-update`, and `blueprint.plugins.update` (via blueprint
create/update).

## Adding another game

Write the catalog's fetch spec as data — either by hand or by extending
`modrinth-preset.ts`-style presets — and reference it from a blueprint's
plugins section. If the catalog's grammar doesn't fit the engine's model
(paginated cursors, auth headers, POST searches), extend the engine
deliberately: every capability added there is a capability a shared blueprint
can invoke, so keep it declarative and host-pinned.

## Files

| Piece | Where |
| --- | --- |
| Schema, validation, resolution | `apps/frontend/lib/server/control-plane/blueprints/plugins.ts` |
| Fetch engine | `apps/frontend/lib/server/control-plane/plugins/engine.ts` |
| Modrinth declaration (preset) | `apps/frontend/lib/modrinth-preset.ts` |
| Lifecycle + auto-update | `apps/frontend/lib/server/control-plane/services/pluginManager.ts` |
| Routes | `apps/frontend/lib/server/control-plane/routes/plugins.ts` |
| Migrations | `.../db/migrations/015_blueprint_plugins.sql`, `016_server_plugins.sql` |
| Tab UI | `apps/frontend/components/server/plugins-tab.tsx` |
| Blueprint form section + review callout | `apps/frontend/components/admin/blueprint-form-dialog.tsx` |
