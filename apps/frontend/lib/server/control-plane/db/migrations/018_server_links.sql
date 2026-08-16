-- Server links: an explicit, owner-initiated grant of network connectivity
-- between exactly two servers (see docs/server-links.md).
--
-- A row is stored one-directionally (server -> target) but the connectivity
-- it grants is bidirectional: the pair shares one Docker network whose name is
-- canonicalized over the unordered pair (citadel_link_<min>_<max> on the
-- agent). Creating the reverse row is rejected by the service, so one row per
-- pair is the invariant.

CREATE TABLE IF NOT EXISTS server_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id  UUID NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  target_id  UUID NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES "user" (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, target_id),
  CHECK (server_id <> target_id)
);

CREATE INDEX IF NOT EXISTS idx_server_links_target ON server_links (target_id);
