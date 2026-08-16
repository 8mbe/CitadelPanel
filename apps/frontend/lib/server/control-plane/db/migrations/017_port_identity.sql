-- Identity port mappings.
--
-- Published ports no longer split into "host port" and "container port": a
-- binding is one number, published as host N → container N. The game is told
-- to bind that number inside the container through the blueprint's new
-- `primary_port_env` (SERVER_PORT for both itzg Minecraft images, which write
-- server.properties from it), and the panel re-syncs that env var on every
-- container recreate so an allocation change never desyncs the game from its
-- binding. The node agent's hardening layer now rejects any non-identity
-- mapping outright.

-- Env var that carries the primary port's number to the game process, so it
-- binds inside the container exactly where Docker published it. Nullable: a
-- blueprint whose image cannot re-bind via env leaves it null.
ALTER TABLE blueprints
  ADD COLUMN IF NOT EXISTS primary_port_env TEXT;

-- Collapse any legacy split mappings onto the identity form. Safe against the
-- PRIMARY KEY (server_id, container_port, protocol): host ports are already
-- distinct per (node, protocol) via UNIQUE (node_id, host_port, protocol), and
-- all of a server's ports share a node, so the rewritten container ports
-- cannot collide within a server.
UPDATE server_ports SET container_port = host_port;
