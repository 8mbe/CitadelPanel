-- CitadelPanel: game presets become "blueprints".
--
-- A blueprint is the reusable definition of how a server is built and run:
-- runtime image, ports, env schema, a startup command, an optional one-time
-- install script that provisions the data directory before first launch, and
-- the resource floor. Until now half of this lived only in code (data path,
-- minimums, read-only-root support) with the table as a partial projection.
-- This migration makes the table the COMPLETE store, so the node agent can be
-- handed everything it needs at server-create time from the database alone.
--
-- Renames preserve the primary keys and every foreign key pointing at them, so
-- existing `servers` rows keep referencing their blueprint across the rename.

-- ---------------------------------------------------------------------------
-- Table + column renames (game_presets -> blueprints).
-- ---------------------------------------------------------------------------
ALTER TABLE game_presets RENAME TO blueprints;
ALTER TABLE blueprints RENAME COLUMN startup_cmd_template TO startup_command;

ALTER TABLE servers RENAME COLUMN preset_id TO blueprint_id;

-- ---------------------------------------------------------------------------
-- Setup-script and provisioning columns.
--
-- install_* describe a one-time, run-to-completion provisioning step executed
-- in a throwaway container (often a lighter installer image than the runtime
-- one) with the server's data volume mounted, BEFORE the server first starts.
-- All three are nullable: a blueprint whose runtime image self-provisions from
-- env (like itzg/minecraft-server) needs no install step at all.
-- ---------------------------------------------------------------------------
ALTER TABLE blueprints
  ADD COLUMN IF NOT EXISTS description        TEXT,
  ADD COLUMN IF NOT EXISTS install_image      TEXT,
  ADD COLUMN IF NOT EXISTS install_script     TEXT,
  ADD COLUMN IF NOT EXISTS install_entrypoint JSONB,
  -- Graceful shutdown command sent to the game console before Docker's SIGKILL
  -- (e.g. "stop" for Minecraft). NULL falls back to a normal container stop.
  ADD COLUMN IF NOT EXISTS stop_command       TEXT,

  -- Formerly code-only fields, now stored so the table is self-contained.
  ADD COLUMN IF NOT EXISTS data_path          TEXT NOT NULL DEFAULT '/data',
  ADD COLUMN IF NOT EXISTS min_cpu            NUMERIC(6, 2) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS min_memory_mb      INTEGER NOT NULL DEFAULT 512,
  ADD COLUMN IF NOT EXISTS min_disk_mb        INTEGER NOT NULL DEFAULT 1024,
  ADD COLUMN IF NOT EXISTS supports_readonly_root BOOLEAN NOT NULL DEFAULT FALSE,

  -- True for blueprints defined in code and seeded on boot; false for any an
  -- admin creates directly. The sync-on-boot only ever upserts is_builtin rows.
  ADD COLUMN IF NOT EXISTS is_builtin         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT now();
