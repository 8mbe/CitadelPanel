-- CitadelPanel: moving a server from one node to another (see
-- docs/server-migration.md).
--
-- A migration is a copy followed by a cutover, never a move. Everything the
-- source node holds -- container, data directory, published ports -- stays
-- exactly where it is until the destination has been built and proved, and the
-- panel's record of which node owns the server is the *last* thing that
-- changes. That ordering is the whole feature: it is what makes a failure at
-- any step a server that is still running on the node it started on, rather
-- than a server that exists on neither.
--
-- Which is also why this is a table and not a background promise. A migration
-- takes as long as it takes to copy a world across a network, the admin who
-- started it will close the tab, and the single most useful thing to be able to
-- say afterwards is "it failed at the transfer, and the server is still on
-- node-1". A row survives that; an in-memory job does not.

-- ---------------------------------------------------------------------------
-- The server status a migration holds the row in.
-- ---------------------------------------------------------------------------

-- `migrating` is a transitional status like `starting`, with one difference
-- that matters: the fleet sweeper and the detail-page reconcile must never
-- overwrite it. Both of them ask the SOURCE node what the container is doing,
-- and for most of a migration the honest answer is "exited", which would
-- rewrite the row to `stopped` and take the migration's own progress reporting
-- with it. Suspended is exempted from reconciliation for the same shape of
-- reason -- the status is a decision the panel is holding, not an observation
-- it is making.
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_status_check;
ALTER TABLE servers ADD CONSTRAINT servers_status_check CHECK (status IN (
  'creating', 'installing', 'stopped', 'starting',
  'running', 'stopping', 'suspended', 'error', 'deleting',
  'migrating'
));

-- ---------------------------------------------------------------------------
-- One migration attempt.
-- ---------------------------------------------------------------------------

-- `status` is the panel's view of the attempt:
--   pending      row written, nothing has been done yet
--   running      a phase is in progress
--   succeeded    the server is on the destination node and the source is clean
--   failed       it did not complete; `rollback` says what state that leaves
--   cancelling / cancelled  an admin asked for it to stop at the next safe point
--
-- `phase` is the coarse stage, so the UI can say what is happening rather than
-- only how far along it is. It is also what a failure is reported *against*:
-- "failed during transfer" and "failed during cutover" are different incidents
-- with different manual follow-ups, and an operator should never have to infer
-- which one they had from a percentage.
--
-- `rollback` is the answer to the only question that matters after a failure:
-- is the server still working? `restored` means the source node is intact and
-- the server has been put back the way it was found. `partial` means the
-- rollback itself hit something it could not undo, and a human has to look --
-- the detail is in `error` and in the log. `not_needed` is a failure early
-- enough that nothing had been changed yet.
--
-- `source_ports` / `destination_ports` are the port numbers on each side, kept
-- as JSONB arrays so a completed migration can be read as a receipt: "25565 on
-- node-1 became 25578 on node-2". The panel cannot reconstruct that afterwards
-- -- the source allocation is released at the end -- so the row has to carry it.
--
-- `bytes_total` / `bytes_transferred` drive the progress bar. `bytes_total` is
-- measured on the source before the copy starts and may be NULL if that
-- measurement failed, which is deliberately distinct from zero: an unmeasured
-- transfer shows a spinner, an empty one shows 100%.
--
-- `backup_run_id` is the safety backup taken before anything moved. SET NULL
-- rather than CASCADE: the backup ageing out of its retention window must not
-- delete the record of the migration that took it.
CREATE TABLE IF NOT EXISTS server_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  source_node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  destination_node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled'
  )),
  phase TEXT NOT NULL DEFAULT 'queued' CHECK (phase IN (
    'queued',
    'preflight',
    'backup',
    'stopping',
    'transferring',
    'allocating_ports',
    'building',
    'verifying',
    'cutover',
    'cleanup',
    'rollback',
    'finished'
  )),
  percent INTEGER NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  bytes_total BIGINT,
  bytes_transferred BIGINT NOT NULL DEFAULT 0,
  source_ports JSONB NOT NULL DEFAULT '[]'::jsonb,
  destination_ports JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Whether the server was running when the migration started, so a successful
  -- cutover can put it back the way the owner had it and a rollback can too.
  was_running BOOLEAN NOT NULL DEFAULT FALSE,
  backup_run_id UUID REFERENCES backup_runs(id) ON DELETE SET NULL,
  error TEXT,
  -- The phase the failure happened in, kept separately from `phase` because
  -- `phase` moves on to `rollback` while the error is being cleaned up after.
  failed_phase TEXT,
  rollback TEXT CHECK (rollback IN ('not_needed', 'restored', 'partial')),
  requested_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- A server cannot be migrated to the node it is already on. Checked here as
  -- well as in the service because a row that says otherwise is nonsense no
  -- reader could act on.
  CONSTRAINT server_migrations_distinct_nodes CHECK (source_node_id <> destination_node_id)
);

CREATE INDEX IF NOT EXISTS server_migrations_server_idx
  ON server_migrations(server_id, created_at DESC);

-- The "is this server already migrating?" guard and the boot sweep both ask for
-- in-flight rows. Partial, because a finished migration is never a candidate.
CREATE INDEX IF NOT EXISTS server_migrations_active_idx
  ON server_migrations(server_id)
  WHERE status IN ('pending', 'running', 'cancelling');

-- ---------------------------------------------------------------------------
-- A migration's log.
-- ---------------------------------------------------------------------------

-- The same shape as `backup_run_logs`, and for the same reason: one row per
-- line so the UI can tail it with `WHERE seq > $cursor` instead of
-- re-downloading a growing log every two seconds.
--
-- `seq` is assigned by the panel here (a migration is orchestrated panel-side,
-- unlike a backup, whose sequence numbers come from the agent's job). UNIQUE
-- (migration_id, seq) still makes an appended line idempotent under a retry.
CREATE TABLE IF NOT EXISTS server_migration_logs (
  id BIGSERIAL PRIMARY KEY,
  migration_id UUID NOT NULL REFERENCES server_migrations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (migration_id, seq)
);

CREATE INDEX IF NOT EXISTS server_migration_logs_migration_idx
  ON server_migration_logs(migration_id, seq);
