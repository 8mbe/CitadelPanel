-- CitadelPanel: backups to S3.
--
-- Two scopes, owned by different people (see docs/backups.md):
--
--   server — a server's data DIRECTORY, taken by its owner, capped at a fixed
--            number of snapshots. Files only.
--   node   — SQL dumps of EVERY database provisioned on one node, taken by an
--            administrator. Reading every tenant's data at once needs the node's
--            MariaDB admin credential, so it is not an owner-triggered action.
--
-- The tables below are shared by both scopes, because a run is a run: the
-- lifecycle, the progress reporting and the log are identical, and only the
-- subject differs. One `backup_runs` table therefore means one reconciler and one
-- log path, instead of two of each that could drift apart.
--
-- Why the panel keeps rows at all when restic's repository already lists
-- snapshots: a failed backup produces no snapshot, and "the backup failed and
-- here is why" is the single most useful thing an operator can be told. A
-- snapshot list can only ever show successes.

-- The restic repository password for one server's file repository.
--
-- Encrypted with lib/crypto (AES-256-GCM, keyed from PANEL_ENCRYPTION_KEY), like
-- node agent tokens and provisioned database passwords. Consequence worth stating
-- plainly: rotating PANEL_ENCRYPTION_KEY makes these unreadable, and an
-- unreadable repository password means unreadable backups.
--
-- `size_bytes` is the deduplicated size restic reports for the repository,
-- refreshed after every backup (the index is already cached at that point, so it
-- costs a metadata pass rather than a download). Summing this column across both
-- repo tables is how the admin page reports storage use — NULL means "not
-- measured", which is deliberately distinct from 0.
CREATE TABLE IF NOT EXISTS server_backup_repos (
  server_id UUID PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  repo_password_encrypted TEXT NOT NULL,
  initialized_at TIMESTAMPTZ,
  size_bytes BIGINT,
  size_measured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same, for one node's database repository.
--
-- A separate table rather than a generic (scope, id) one so each keeps a real
-- foreign key: deleting a server or a node should take its repository password
-- with it, and a polymorphic column cannot express that.
CREATE TABLE IF NOT EXISTS node_backup_repos (
  node_id UUID PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  repo_password_encrypted TEXT NOT NULL,
  initialized_at TIMESTAMPTZ,
  size_bytes BIGINT,
  size_measured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One backup or restore run, of either scope.
--
-- `status` is the panel's view, advanced by the reconciler in
-- nodes/backupScheduler.ts as it polls the agent's job:
--   pending   — row written, the agent has not accepted the job yet
--   running   — the agent has a job id for it
--   succeeded — a snapshot exists (backup) or the data is back (restore)
--   failed    — see `error`
--
-- `snapshot_id` is restic's id and is the only handle a restore needs, so a
-- successful backup always has one. `bytes_added` is what actually went to S3
-- after deduplication and compression — the number that maps to the operator's
-- bill — as distinct from `bytes_processed`, which is what was read from disk.
--
-- `node_id` is NOT NULL for both scopes and is denormalised from `servers` for
-- server runs on purpose: a snapshot lives in the repository some specific node
-- wrote, and a server later migrated to another node must not silently look for
-- its history in the wrong place.
--
-- `databases` lists the dumps inside a node-scope snapshot; it stays empty for
-- server runs, which no longer carry databases at all.
CREATE TABLE IF NOT EXISTS backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('server', 'node')),
  server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'backup' CHECK (kind IN ('backup', 'restore')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  -- What triggered it: a person clicking the button, or the cron schedule.
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  -- The agent's in-memory job id, for polling. NULL once the job has finished and
  -- been reconciled, or if the agent never accepted it.
  job_id TEXT,
  phase TEXT,
  percent INTEGER NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  snapshot_id TEXT,
  bytes_processed BIGINT,
  bytes_added BIGINT,
  databases JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  -- Highest log sequence number drained from the agent, so the reconciler resumes
  -- where it left off instead of re-importing the whole log each tick.
  log_cursor INTEGER NOT NULL DEFAULT 0,
  -- NULL for a scheduled run: nobody asked for it.
  requested_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- A server run must name its server; a node run must not. Enforced in the
  -- schema because every query filters on one or the other, and a row that is
  -- neither would be invisible to both.
  CONSTRAINT backup_runs_scope_subject CHECK (
    (scope = 'server' AND server_id IS NOT NULL)
    OR (scope = 'node' AND server_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS backup_runs_server_idx
  ON backup_runs(server_id, created_at DESC)
  WHERE scope = 'server';

CREATE INDEX IF NOT EXISTS backup_runs_node_idx
  ON backup_runs(node_id, created_at DESC)
  WHERE scope = 'node';

-- Partial index for the reconciler's hot query: "which runs are still in
-- flight?". Without it that sweep scans the whole history every tick.
CREATE INDEX IF NOT EXISTS backup_runs_active_idx
  ON backup_runs(status)
  WHERE status IN ('pending', 'running');

-- A run's log.
--
-- One row per line rather than an appended TEXT column so the UI can tail it:
-- `WHERE seq > $cursor` returns just the new lines, which is what makes a live log
-- cheap to poll. `seq` comes from the agent, so ordering is the agent's ordering
-- and not the order rows happened to be inserted in.
--
-- UNIQUE (run_id, seq) also makes the reconciler's drain idempotent: a retried
-- poll re-inserts nothing.
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

-- Whether the file-backup schedule includes this server.
--
-- Default TRUE: an operator who configures S3 and a schedule means "back up my
-- fleet", and a per-server opt-in would leave most servers silently unprotected.
-- Owners can turn it off per server from the backups tab.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS backups_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Whether the database-backup schedule includes this node. Same default and same
-- reasoning; admins can exclude a node that has no databases worth keeping.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS database_backups_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Backup configuration.
--
-- In panel_settings for the same reason as captcha, mail and AI: these are knobs
-- an operator turns in the UI, not boot-critical values. The S3 secret key lives
-- inside this JSON but is AES-256-GCM encrypted by lib/crypto before it is
-- written, so nothing in `value` may be served to a client as-is.
--
-- Seeded off-by-default and with empty schedules so a read never has to
-- distinguish "unset" from "missing", and so upgrading a panel never starts
-- uploading a fleet's data to a bucket nobody configured.
--
-- Retention is a plain count per scope, not a calendar policy. Five is the
-- default on both: enough history to undo a bad afternoon, bounded enough that an
-- operator can multiply it by their fleet size and predict the bill. Zero means
-- unlimited.
--
-- `storage.quotaBytes` is an enforced ceiling on total backup storage — a backup
-- is refused once the fleet is over it, rather than discovering the overage on an
-- invoice. `storage.capacityBytes` is display-only: S3 has no capacity API, so
-- the size of the operator's storage plan is something only they can tell us.
-- Both default to 0, meaning unset.
--
-- `useTls` defaults to true so an upgrade never quietly starts sending bucket
-- credentials in the clear. It exists at all because a self-hosted Garage or MinIO
-- on a LAN typically has no certificate, and refusing that would mean no backups
-- for exactly the operator this panel is built for.
--
-- `servers.exclude` is admin-controlled and applies to server FILE backups only.
-- Database dumps have nothing to exclude — the staging directory contains exactly
-- the dumps the run just wrote.
INSERT INTO panel_settings (key, value)
VALUES (
  'backups',
  '{
    "enabled": false,
    "endpoint": null,
    "useTls": true,
    "region": "us-east-1",
    "bucket": null,
    "prefix": "citadel",
    "accessKeyId": null,
    "secretAccessKeyEncrypted": null,
    "storage": {
      "quotaBytes": 0,
      "capacityBytes": 0
    },
    "servers": {
      "schedule": "",
      "maxPerServer": 5,
      "exclude": [],
      "concurrency": 2
    },
    "databases": {
      "schedule": "",
      "maxPerNode": 5
    }
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
