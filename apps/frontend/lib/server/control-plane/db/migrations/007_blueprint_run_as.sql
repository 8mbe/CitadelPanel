-- CitadelPanel: blueprint run-as user.
--
-- Some images drop privileges internally (itzg/minecraft-server runs as root,
-- then `gosu`s to `minecraft` and `chown`s /data). That needs setuid/chown
-- capabilities the panel deliberately drops (CapDrop: ALL + no-new-privileges),
-- so a blueprint can instead pin the container to run as the data directory's
-- owner (uid 1000) and skip the image's own drop entirely — strictly safer,
-- since the container never runs as root at all.
--
-- Nullable: existing blueprints and servers keep the image's default USER.

ALTER TABLE blueprints ADD COLUMN IF NOT EXISTS run_as TEXT;
