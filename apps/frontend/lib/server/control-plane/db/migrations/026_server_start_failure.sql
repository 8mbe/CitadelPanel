-- Why a start did not take, kept on the server row.
--
-- `docker start` returning success means the container was created and its
-- entrypoint was handed to the kernel. It says nothing about whether the
-- process survived. A server whose data directory is unwritable, whose port is
-- taken, or whose config is malformed exits a second or two later, and the
-- panel used to record `running` and then let the status reconciler quietly
-- rewrite it to `stopped`. The operator saw a server that "won't start" with
-- no reason anywhere in the panel: the explanation was in the container's
-- output, and the container that produced it was already gone.
--
-- So a start is now watched for a fixed window, and if it does not hold, the
-- reason and the container's last output are written here. The row is the only
-- durable place for it -- by the time anyone reads it, the failed container has
-- usually been restarted or removed, taking `docker logs` with it.
--
-- These are deliberately NOT derived from `status`. A failed start leaves the
-- server `stopped`, which is a true statement about it, and the reconciler is
-- free to keep correcting the status without erasing the explanation. The
-- columns are cleared only when a start is observed to succeed.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS start_failure_reason TEXT;

-- The captured container output. NOT NULL with a default so every existing row
-- reads as "nothing captured" rather than null, matching install_log.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS start_failure_log TEXT NOT NULL DEFAULT '';

-- When the failed start was observed. Nullable, and null is the "no failure on
-- record" case that the API reads as `startFailure: null`.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS start_failed_at TIMESTAMPTZ;
