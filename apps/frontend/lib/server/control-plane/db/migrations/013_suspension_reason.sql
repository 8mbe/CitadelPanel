-- Suspension reason + timestamp, surfaced to the server owner.
--
-- The reason was previously recorded only in audit-log metadata, so the owner
-- had no way to see *why* their server was suspended. Storing it on the row
-- makes it readable on every server fetch. Both columns are nullable: a server
-- that is not suspended has no reason/timestamp, and unsuspend clears them.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
