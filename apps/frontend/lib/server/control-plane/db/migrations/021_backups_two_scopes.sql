-- CitadelPanel: split backups into two scopes.
--
-- 020 shipped a single per-server backup that carried both a server's files and
-- dumps of its databases, with a calendar retention policy. That was the wrong
-- shape for two reasons, and this migration fixes both:
--
--   1. Dumping a server's databases needs the node's MariaDB admin credential,
--      which is root-equivalent on an instance shared by every tenant on that
--      node. An owner-triggered backup should not reach into that. Database
--      backups are therefore now **node-scoped and admin-owned**, and a server
--      backup is files only.
--   2. Retention is now a plain snapshot count per subject, "keep 5, a new
--      backup removes the oldest", which is what an operator can actually
--      reason about and multiply by their fleet size.
--
-- This runs on databases that already applied 020, so every step is written to be
-- idempotent and to be a no-op on a fresh install where 020 already created the
-- new shape. That matters because 020's INSERT is `ON CONFLICT DO NOTHING`: a
-- panel whose operator had already configured backups kept the old JSON, and the
-- reshape at the bottom is the only thing that migrates it.

-- --- Repository bookkeeping --------------------------------------------------------

-- Storage accounting, added for the admin page's used/allowed/total line. NULL
-- means "never measured", which is deliberately distinct from 0.
ALTER TABLE server_backup_repos ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE server_backup_repos ADD COLUMN IF NOT EXISTS size_measured_at TIMESTAMPTZ;

-- One repository per node, for its database dumps. A separate table from
-- `server_backup_repos` rather than a polymorphic one so each keeps a real
-- foreign key and cascades correctly when its subject is deleted.
CREATE TABLE IF NOT EXISTS node_backup_repos (
  node_id UUID PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  repo_password_encrypted TEXT NOT NULL,
  initialized_at TIMESTAMPTZ,
  size_bytes BIGINT,
  size_measured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Runs -------------------------------------------------------------------------

-- One table for both scopes: a run is a run, and the lifecycle, progress reporting
-- and log are identical. Two tables would have meant two reconcilers that could
-- drift apart.
CREATE TABLE IF NOT EXISTS backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('server', 'node')),
  server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'backup' CHECK (kind IN ('backup', 'restore')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  job_id TEXT,
  phase TEXT,
  percent INTEGER NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  snapshot_id TEXT,
  bytes_processed BIGINT,
  bytes_added BIGINT,
  databases JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  log_cursor INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- A server run must name its server; a node run must not. In the schema because
  -- every query filters on one or the other, so a row that is neither would be
  -- invisible to both.
  CONSTRAINT backup_runs_scope_subject CHECK (
    (scope = 'server' AND server_id IS NOT NULL)
    OR (scope = 'node' AND server_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS backup_runs_server_idx
  ON backup_runs(server_id, created_at DESC) WHERE scope = 'server';
CREATE INDEX IF NOT EXISTS backup_runs_node_idx
  ON backup_runs(node_id, created_at DESC) WHERE scope = 'node';
CREATE INDEX IF NOT EXISTS backup_runs_active_idx
  ON backup_runs(status) WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS backup_run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS backup_run_logs_run_idx ON backup_run_logs(run_id, seq);

-- Whether the database-backup schedule includes this node. Default TRUE, matching
-- `servers.backups_enabled`: an operator who configures a destination and a
-- schedule means "back up my fleet", and an opt-in would leave most of it
-- unprotected.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS database_backups_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- --- Retire the old single-scope tables ---------------------------------------------

-- Dropped rather than migrated. Their rows describe backups whose snapshots mixed
-- files and database dumps in one tree, which nothing can now restore correctly.
-- A server restore would try to write `/dumps` that the new code does not mount,
-- and a database restore would not find the per-node layout it expects. Keeping
-- rows that point at unrestorable snapshots would be worse than an empty history,
-- because the UI would offer a Restore button that cannot work.
--
-- The snapshots themselves are left in S3. Anything already uploaded stays where it
-- is under the old `<prefix>/<serverId>` path (the new code addresses
-- `<prefix>/servers/<serverId>`), so nothing is deleted behind the operator's
-- back. It is also no longer referenced, and can be removed from the bucket by
-- hand once they are satisfied they do not want it.
DROP TABLE IF EXISTS server_backup_logs;
DROP TABLE IF EXISTS server_backups;

-- --- Reshape the settings ------------------------------------------------------------

-- Move the flat 020 keys into the nested groups, then drop them.
--
-- Guarded on `servers` being absent so this is a no-op on a fresh install (where
-- the rewritten 020 seeded the new shape directly) and runs exactly once on an
-- upgraded one.
--
-- `useTls` defaults to true so an upgrade never quietly starts sending bucket
-- credentials in the clear. Operators pointing at a self-hosted Garage or MinIO on
-- a LAN, which usually has no certificate, turn it off deliberately in the UI.
--
-- The old calendar retention (`keepLast`/`keepDaily`/`keepWeekly`/`keepMonthly`) has
-- no faithful translation into a single count, so it is dropped rather than guessed
-- at: `maxPerServer` starts at the 5 the new default uses, and the operator can
-- change it. Silently reinterpreting "7 daily, 4 weekly, 6 monthly" as some number
-- would be inventing a decision they did not make.
UPDATE panel_settings
SET value = (value - 'schedule' - 'retention' - 'exclude' - 'concurrency')
  || jsonb_build_object(
       'useTls', COALESCE(value->'useTls', 'true'::jsonb),
       'storage', COALESCE(
         value->'storage',
         jsonb_build_object('quotaBytes', 0, 'capacityBytes', 0)
       ),
       'servers', jsonb_build_object(
         -- The old top-level schedule drove server backups, so it carries over.
         'schedule', COALESCE(value->'schedule', '""'::jsonb),
         'maxPerServer', 5,
         'exclude', COALESCE(value->'exclude', '[]'::jsonb),
         'concurrency', COALESCE(value->'concurrency', '2'::jsonb)
       ),
       'databases', jsonb_build_object(
         -- Deliberately empty: database backups are a new, more privileged
         -- operation, and inheriting a schedule the operator set for file backups
         -- would start sweeping every tenant's database without them asking.
         'schedule', '""'::jsonb,
         'maxPerNode', 5
       )
     ),
    updated_at = now()
WHERE key = 'backups'
  AND value->'servers' IS NULL;
