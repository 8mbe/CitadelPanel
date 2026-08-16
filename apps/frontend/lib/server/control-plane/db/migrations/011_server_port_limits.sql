-- Additional per-server port assignments, plus an owner-configurable limit.
--
-- A server's blueprint defines its default ports (the primary game port plus any
-- the game always needs). Owners can additionally publish extra host ports that
-- map to container ports — useful for plugins, RCON, metrics, or a second game
-- mode on a different port. Each such mapping is a row in `server_ports` with
-- `is_additional = TRUE`; the PRIMARY KEY already keeps (container_port, protocol)
-- unique per server, and UNIQUE (node_id, host_port, protocol) keeps a host port
-- bound to at most one server per node.
--
-- `is_additional` separates owner-added ports from the blueprint's own (which are
-- `FALSE` and not removable through the settings page). It defaults FALSE so the
-- existing `createServer` insert — which does not name the column — is unchanged.
--
-- `label` is an optional, owner-supplied note ("RCON", "Map maker web") shown in
-- the ports card so a row is recognisable beyond its numbers. Nullable and not
-- part of any constraint.

ALTER TABLE server_ports
  ADD COLUMN IF NOT EXISTS is_additional BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS label TEXT;

-- Owner-configurable limit on how many *additional* (non-blueprint) ports a
-- server may have. Stored in panel_settings so an admin can tune it at runtime
-- without a redeploy; the default of 5 keeps an idle fleet from fragmenting its
-- port pools.
INSERT INTO panel_settings (key, value)
VALUES ('serverLimits', '{"maxAdditionalPortsPerServer": 5}'::jsonb)
ON CONFLICT (key) DO NOTHING;

