-- Per-node port pools (admin-managed, host-verified).
--
-- An admin reserves a set of host ports per node per protocol; new servers draw
-- their published ports from that pool instead of the default 25565-26565 range.
-- Each row keeps the raw `spec` the admin typed (for display/audit) alongside
-- the expanded `ports` array (for fast lookup and overlap checks). One row per
-- spec, not one per port, so a large range does not explode the table.

CREATE TABLE IF NOT EXISTS node_port_pools (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     UUID NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  -- Raw entry as the admin typed it, e.g. "25565-25570" or "25565,25578".
  spec        TEXT NOT NULL,
  protocol    TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
  -- The individual ports the spec resolves to. GIN-indexed for overlap checks.
  ports       INTEGER[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, spec, protocol)
);

CREATE INDEX IF NOT EXISTS node_port_pools_node_idx ON node_port_pools (node_id);
CREATE INDEX IF NOT EXISTS node_port_pools_ports_gin_idx
  ON node_port_pools USING GIN (ports);
