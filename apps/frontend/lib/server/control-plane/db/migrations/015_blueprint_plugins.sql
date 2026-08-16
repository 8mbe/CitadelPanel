-- CitadelPanel: blueprint-declared plugin/mod support.
--
-- A blueprint's plugins section is pure data: the tab label, the install
-- directory, the env-driven profile selection (a Paper server shows "Plugins"
-- into /plugins, Fabric shows "Mods" into /mods, vanilla shows no tab), and
-- the provider definition itself — the catalog's https API origin, endpoint
-- path/query templates, response field mappings and pinned download hosts.
-- The panel's fetch engine interprets that declaration with fixed semantics;
-- there are no scripts and no expression evaluation, so the section travels
-- through blueprint export/import without adding code-execution surface.
--
-- Safety: validation enforces https-only hosts that pass the SSRF blocklist
-- (a shared blueprint cannot aim the panel or its auto-updater at internal
-- networks), downloads are re-checked against the declared hosts on every
-- install, and metadata responses are size-capped and read only through the
-- declared mappings. See docs/plugins.md.

ALTER TABLE blueprints ADD COLUMN IF NOT EXISTS plugins JSONB;
