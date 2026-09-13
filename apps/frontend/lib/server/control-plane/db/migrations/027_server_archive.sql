-- CitadelPanel: archiving a server (see docs/archive.md).
--
-- An archived server is one whose files live in S3 and nowhere else. The panel
-- keeps the whole record -- name, ports, env, databases, subusers, links -- and
-- the node keeps nothing: no container, no data directory. Unarchiving rebuilds
-- the container and restores the snapshot back onto the same node, at the same
-- address.
--
-- This is deliberately NOT a variant of delete. A delete drops the row, and with
-- it the ports, the env and everything else that makes the server the server the
-- owner had. Archiving is the opposite trade: give up the node's disk, keep the
-- identity. That is what makes it something an operator can do automatically to
-- an idle server after N days without anyone losing anything.

-- ---------------------------------------------------------------------------
-- The three statuses an archive moves the row through.
-- ---------------------------------------------------------------------------

-- `archiving` and `restoring` are transitional, `archived` is settled, and all
-- three share the property that makes `migrating` special: nothing may reconcile
-- them away. The status sweeper and the detail-page reconcile both decide from
-- what the node reports about a container, and for these three the node's answer
-- is either about a container that is being taken away, or about no container at
-- all. Believing it would rewrite the row mid-archive and take the archive's own
-- progress reporting with it.
--
-- `archived` in particular is a status the panel *holds*, exactly like
-- `suspended`: it is a statement about where the files are, which no amount of
-- looking at the node can tell you. A node with no container for this server
-- looks identical whether the server was archived on purpose or lost its
-- container to a `docker rm`, and the two must not be confused -- the second is
-- what `healMissingContainer` repairs by rebuilding around the data directory,
-- and doing that to an archived server would build a container over an empty
-- disk and call it recovered.
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_status_check;
ALTER TABLE servers ADD CONSTRAINT servers_status_check CHECK (status IN (
  'creating', 'installing', 'stopped', 'starting',
  'running', 'stopping', 'suspended', 'error', 'deleting',
  'migrating', 'archiving', 'archived', 'restoring'
));

-- ---------------------------------------------------------------------------
-- Where the files went.
-- ---------------------------------------------------------------------------

-- When the archive completed. Null for a server that is not archived, and it is
-- the flag as well as the timestamp: it is written in the same statement that
-- writes `archived`, and cleared by the one that writes `stopped` on the way
-- back, so one null check answers "is this archived?" without parsing a status.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- The backup run that produced the archive snapshot, so the UI can show its log
-- and its size without a search, and so an interrupted archive can be resumed by
-- looking at the run it was waiting on rather than starting a second one.
--
-- ON DELETE SET NULL rather than CASCADE: losing the run row must never delete
-- the server. The row is a record of the transfer; the snapshot id below is the
-- thing that actually matters, and it is stored separately for exactly that
-- reason.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS archive_run_id UUID REFERENCES backup_runs(id) ON DELETE SET NULL;

-- The restic snapshot holding the server's files. This is the single most
-- important column in this migration: while a server is archived it is the only
-- pointer to the only copy of that server's data. It is denormalised out of
-- `backup_runs.snapshot_id` on purpose, so that a run row deleted by the
-- retention quota, by a failed-run trim, or by an operator cannot orphan a
-- server from its own files.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS archive_snapshot_id TEXT;

-- What asked for the archive: 'manual' (an owner or admin pressed the button) or
-- 'idle' (the auto-archive policy). Kept because the answer to "why is my server
-- archived?" is a different sentence in each case, and the owner of an
-- automatically archived server never pressed anything.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS archive_trigger TEXT
  CHECK (archive_trigger IS NULL OR archive_trigger IN ('manual', 'idle'));

-- Why the last archive or unarchive did not complete. Not derived from `status`:
-- a failed unarchive puts the row back to `archived`, which is a true statement
-- about where the files are, and the explanation has to survive that so the
-- owner can see why the button they pressed did nothing. Cleared when one
-- succeeds.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS archive_error TEXT;

-- ---------------------------------------------------------------------------
-- The idle clock.
-- ---------------------------------------------------------------------------

-- When this server last did anything: the timestamp of its last *status change*,
-- plus any explicit power action. Auto-archiving needs to answer "has this been
-- stopped for thirteen days?", and neither existing column can:
--
--   - `updated_at` is bumped by an env edit, a port change, a plugin install and
--     a dozen other things that say nothing about whether the server is in use.
--     A fleet where owners tweak settings would never auto-archive.
--   - `created_at` is fixed.
--
-- A status change is the right signal because it brackets the idle period from
-- both ends. A server that is started bumps it; a server that stops (gracefully,
-- or by crashing, which the sweeper notices and records) bumps it again, and the
-- clock then runs from the moment it actually went down. A server that has been
-- running for a month is never a candidate regardless of this column, because
-- the auto-archive query requires `status = 'stopped'`.
--
-- NOT NULL DEFAULT now() backfills every existing row with the migration's own
-- timestamp, which is the safe direction: an upgrade gives the whole fleet a
-- fresh idle period rather than archiving every long-stopped server on the first
-- tick after deploy.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The auto-archive sweep's query: stopped servers, oldest idle first. Partial on
-- the status so the index is the size of the candidate set rather than the fleet.
CREATE INDEX IF NOT EXISTS servers_idle_idx
  ON servers (last_active_at) WHERE status = 'stopped';

-- ---------------------------------------------------------------------------
-- The archive's own backup run.
-- ---------------------------------------------------------------------------

-- A third trigger alongside 'manual' and 'scheduled'.
--
-- It could have reused one of those -- the work is an ordinary server file
-- backup -- but both would have lied somewhere that matters. 'scheduled' feeds
-- the backup schedule's double-fire guard (`hasScheduledRunSince`), so an
-- auto-archive would suppress that minute's real backup for the same server.
-- 'manual' would make an automatic archive claim somebody pressed a button. The
-- UI also labels a run by its trigger, and "Archive" is what a reader of that
-- history needs to see next to the one snapshot they must not delete.
ALTER TABLE backup_runs DROP CONSTRAINT IF EXISTS backup_runs_trigger_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_trigger_check
  CHECK (trigger IN ('manual', 'scheduled', 'archive'));
