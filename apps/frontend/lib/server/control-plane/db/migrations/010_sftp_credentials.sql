-- CitadelPanel: per-(user,server) SFTP credentials.
--
-- The agent runs a custom SFTP server (ssh2, on port 8022). Each server's owner
-- (or a subuser with the `files` permission) can mint an SFTP credential from the
-- panel: a username and a generated password. The password is shown once on
-- creation/regeneration and stored only as a scrypt hash (the same scheme Better
-- Auth uses for login passwords, `salt:hash` hex). The agent validates the
-- credential by calling the panel back at connect time, so this table is the
-- source of truth and revocation is just `DELETE`.
--
-- Username format: `{slug(email-local-part)}-{first8(serverUUID)}`, e.g.
-- `admin-a1b2c3d4`. Human-readable and unique via the constraint below. The
-- username is looked up by exact match (not parsed), so the format is a UX
-- concern, not a security boundary.
--
-- One credential per (user, server). A user minting a new password for the
-- same server overwrites the row (ON CONFLICT update), which is the regenerate
-- flow. Deleting a server or user cascades, so orphaned SFTP credentials never
-- survive.

CREATE TABLE IF NOT EXISTS sftp_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS sftp_credentials_username_idx ON sftp_credentials(username);
CREATE INDEX IF NOT EXISTS sftp_credentials_server_idx ON sftp_credentials(server_id);

COMMENT ON TABLE sftp_credentials IS
  'Per-(user,server) SFTP credentials. Password stored as scrypt salt:hash (same as Better Auth). Validated by the agent via a panel callback on each SFTP connect.';
COMMENT ON COLUMN sftp_credentials.username IS
  'Format: {slug(email-local-part)}-{first8(serverUUID)}. Unique. Looked up by exact match.';
COMMENT ON COLUMN sftp_credentials.password_hash IS
  'scrypt hash in `salt:hex` format (Better Auth scheme). Never returned to the client after creation.';
