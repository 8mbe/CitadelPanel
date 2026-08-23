-- CitadelPanel: per-server installed plugin registry.
--
-- One row per installed provider project: what was installed (project/version
-- ids and display metadata), where (filename inside the profile's directory),
-- by whom, and whether it is enabled (a disabled plugin is the same file with
-- a ".disabled" suffix, which Bukkit-family loaders and Fabric ignore).
--
-- The table is the panel's linkage for update checks, including the
-- auto-updater that runs before every start. It is not a filesystem inventory:
-- rows are reconciled against the actual directory listing when displayed, so
-- manually added or deleted jars show up as untracked/missing rather than
-- being silently overwritten. UNIQUE (server_id, provider, project_id) makes
-- re-installing a project an in-place update (new file in, old file out).

CREATE TABLE IF NOT EXISTS server_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_slug TEXT,
  project_title TEXT NOT NULL,
  project_icon_url TEXT,
  version_id TEXT NOT NULL,
  version_number TEXT NOT NULL,
  version_type TEXT NOT NULL DEFAULT 'release',
  filename TEXT NOT NULL,
  file_size_bytes BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  installed_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, provider, project_id)
);

CREATE INDEX IF NOT EXISTS server_plugins_server_id_idx ON server_plugins(server_id);

-- Whether the pre-start auto-updater checks this server's plugins for new
-- release-channel versions. On by default; owners can turn it off per server
-- from the plugins tab.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS plugin_auto_update BOOLEAN NOT NULL DEFAULT TRUE;
