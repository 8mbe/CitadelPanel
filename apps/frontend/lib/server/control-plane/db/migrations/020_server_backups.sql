-- CitadelPanel: server backups to S3.
--
-- Three tables, because the three things being stored have different lifetimes
-- and different secrecy:
--
--   server_backup_repos  — one row per server, holding the restic repository
--                          password. Long-lived and secret. Separate from
--                          `servers` because losing this row means losing every
--                          snapshot that server ever took, so it should be
--                          obvious in the schema that it is not an attribute
--                          you can casually rewrite.
--   server_backups       — one row per backup attempt, including the ones that
--                          failed. The panel's durable record of a run: the
--                          agent's job state is in memory and evaporates on
--                          restart, so this row is what survives.
--   server_backup_logs   — the run's log, one row per line, sequence-numbered.
--
-- Why the panel keeps its own rows at all when restic's repository already lists
-- snapshots: a failed backup produces no snapshot, and "the backup failed and
-- here is why" is the single most useful thing an operator can be told. A
-- snapshot list can only ever show successes.

-- The restic repository password for one server's repository.
--
-- Encrypted with lib/crypto (AES-256-GCM, keyed from PANEL_ENCRYPTION_KEY), like
-- node agent tokens and provisioned database passwords. Consequence worth
-- stating plainly: rotating PANEL_ENCRYPTION_KEY makes these unreadable, and an
-- unreadable repository password means unreadable backups. `initialized_at`
-- records when the agent confirmed the repository exists in S3, which is what
-- distinguishes "no backups yet" from "the repository is unreachable".
CREATE TABLE IF NOT EXISTS server_backup_repos (
  server_id UUID PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  repo_password_encrypted TEXT NOT NULL,
  initialized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One backup or restore run.
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
-- `node_id` is denormalised from `servers` on purpose: a snapshot lives in the
-- repository this node wrote, and a server later migrated to another node must
-- not silently look for its history in the wrong place.
CREATE TABLE IF NOT EXISTS server_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  node_id UUID REFERENCES nodes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'backup' CHECK (kind IN ('backup', 'restore')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  -- What triggered it: a person clicking the button, or the cron schedule.
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  -- The agent's in-memory job id, for polling. Null once the job has finished
  -- and been reconciled, or if the agent never accepted it.
  job_id TEXT,
  phase TEXT,
  percent INTEGER NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  snapshot_id TEXT,
  bytes_processed BIGINT,
  bytes_added BIGINT,
  -- Names of the databases whose dumps are inside this snapshot, so a restore
  -- can say which ones it will overwrite before it does.
  databases JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  -- Highest log sequence number drained from the agent, so the reconciler
  -- resumes where it left off instead of re-importing the whole log each tick.
  log_cursor INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS server_backups_server_id_idx
  ON server_backups(server_id, created_at DESC);

-- Partial index for the reconciler's hot query: "which runs are still in
-- flight?". Without it that sweep scans the whole history every tick.
CREATE INDEX IF NOT EXISTS server_backups_active_idx
  ON server_backups(status)
  WHERE status IN ('pending', 'running');

-- The run's log.
--
-- One row per line rather than an appended TEXT column so the UI can tail it:
-- `WHERE seq > $cursor` returns just the new lines, which is what makes a live
-- log cheap to poll. `seq` comes from the agent, so ordering is the agent's
-- ordering and not the order rows happened to be inserted in.
--
-- Deleted with the backup row, since a log for a backup that no longer exists
-- has nothing to say.
CREATE TABLE IF NOT EXISTS server_backup_logs (
  id BIGSERIAL PRIMARY KEY,
  backup_id UUID NOT NULL REFERENCES server_backups(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The agent's sequence numbers are unique per job, so this also makes the
  -- reconciler's drain idempotent: a retried poll re-inserts nothing.
  UNIQUE (backup_id, seq)
);

CREATE INDEX IF NOT EXISTS server_backup_logs_backup_id_idx
  ON server_backup_logs(backup_id, seq);

-- Whether the cron schedule backs this server up.
--
-- Default TRUE: an operator who configures S3 and a schedule means "back up my
-- fleet", and a per-server opt-in would leave most servers silently unprotected.
-- Owners can turn it off per server from the backups tab.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS backups_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Backup configuration.
--
-- In panel_settings for the same reason as captcha, mail and AI: these are knobs
-- an operator turns in the UI, not boot-critical values. The S3 secret key lives
-- inside this JSON but is AES-256-GCM encrypted by lib/crypto before it is
-- written, so nothing in `value` may be served to a client as-is.
--
-- Seeded off-by-default and with an empty schedule so a read never has to
-- distinguish "unset" from "missing", and so upgrading a panel never starts
-- uploading a fleet's data to a bucket nobody configured.
--
-- The retention defaults keep a month of history at decreasing granularity —
-- seven dailies, four weeklies, six monthlies, plus the three most recent runs
-- whatever their age — which is the shape most operators want and none of them
-- enjoy deriving. `keepLast` being non-zero matters: it guarantees a very recent
-- backup survives even if the clock or the schedule is misconfigured.
INSERT INTO panel_settings (key, value)
VALUES (
  'backups',
  '{
    "enabled": false,
    "endpoint": null,
    "region": "us-east-1",
    "bucket": null,
    "prefix": "citadel",
    "accessKeyId": null,
    "secretAccessKeyEncrypted": null,
    "schedule": "",
    "retention": {
      "keepLast": 3,
      "keepDaily": 7,
      "keepWeekly": 4,
      "keepMonthly": 6
    },
    "exclude": [],
    "concurrency": 2
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
