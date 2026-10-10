-- Docker fixes env at creation. Remember what was actually sent, rather than
-- marking the current settings applied after a potentially slow node request.
-- NULL means unknown: existing containers are refreshed on their next start.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS container_env_fingerprint TEXT;
