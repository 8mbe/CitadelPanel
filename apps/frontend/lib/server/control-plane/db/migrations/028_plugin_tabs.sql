-- Tab identity survives label edits; the stored directory survives profile edits.
ALTER TABLE server_plugins ADD COLUMN tab_id TEXT NOT NULL DEFAULT 'plugins';
ALTER TABLE server_plugins ADD COLUMN install_directory TEXT;
ALTER TABLE server_plugins ADD COLUMN project_author TEXT;

UPDATE server_plugins AS installed
SET install_directory = COALESCE(
  b.plugins->'variants'->env.value->>'directory',
  b.plugins->'default'->>'directory'
)
FROM servers AS s
JOIN blueprints AS b ON b.id = s.blueprint_id
LEFT JOIN server_env AS env ON env.server_id = s.id AND env.key = b.plugins->>'envField'
WHERE installed.server_id = s.id;

ALTER TABLE server_plugins DROP CONSTRAINT server_plugins_server_id_provider_project_id_key;
ALTER TABLE server_plugins ADD UNIQUE (server_id, tab_id, provider, project_id);
