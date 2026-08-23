-- A published port is a number, claimed on both TCP and UDP.
--
-- Protocol was a dimension nobody could answer correctly. It was asked three
-- times — when an admin reserved a pool entry, when an admin declared a
-- blueprint's ports, and when an owner published an extra port — and the right
-- answer was almost always "both": a Java server that adds a Geyser/voice-chat
-- plugin needs the same number on UDP, and a Bedrock port pool reserved as UDP
-- silently could not host a Java server. Worse, the two halves of a number
-- could be handed to *different* servers, so 25565/tcp and 25565/udp were two
-- allocations that looked like one port to everybody reading the panel.
--
-- So the number is the unit of allocation now: reserving it reserves both
-- protocols, and publishing it publishes both. `server_ports` and
-- `node_port_pools` lose their protocol column, and blueprint port
-- declarations lose their protocol key. The agent's container spec is
-- unchanged — the panel expands each stored number into a tcp and a udp
-- binding at create/recreate time, so no node needs upgrading for this.

-- ---------------------------------------------------------------------------
-- server_ports: one row per published number.
-- ---------------------------------------------------------------------------

-- Same number on both protocols within one server collapses to one row. The
-- surviving row is the one carrying the most authority (primary first, then a
-- blueprint port over an additional one) so no flag is lost in the collapse.
WITH ranked AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (
      PARTITION BY server_id, host_port
      ORDER BY is_primary DESC, is_additional ASC, protocol ASC
    ) AS rn
  FROM server_ports
)
DELETE FROM server_ports sp
USING ranked r
WHERE sp.ctid = r.ctid AND r.rn > 1;

-- The same number split across two *different* servers on one node is the case
-- the dual claim cannot preserve: 25565/tcp on server A and 25565/udp on
-- server B were legal before and are mutually exclusive now. One row keeps the
-- number (primary bindings win, then blueprint over additional); the other
-- server loses that binding here and will be rebuilt without it the next time
-- its container is recreated. Nothing is silently rebound: the losing server's
-- remaining ports are untouched, and its owner sees one fewer published port.
WITH ranked AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (
      PARTITION BY node_id, host_port
      ORDER BY is_primary DESC, is_additional ASC, protocol ASC, server_id ASC
    ) AS rn
  FROM server_ports
)
DELETE FROM server_ports sp
USING ranked r
WHERE sp.ctid = r.ctid AND r.rn > 1;

ALTER TABLE server_ports DROP CONSTRAINT IF EXISTS server_ports_pkey;
ALTER TABLE server_ports
  DROP CONSTRAINT IF EXISTS server_ports_node_id_host_port_protocol_key;
ALTER TABLE server_ports DROP COLUMN IF EXISTS protocol;

-- container_port still exists (it equals host_port since 017_port_identity)
-- and still carries the primary key, so the key survives the column drop.
ALTER TABLE server_ports ADD PRIMARY KEY (server_id, container_port);
-- A host port belongs to at most one server per node — now across both
-- protocols at once, which is what makes the claim indivisible.
ALTER TABLE server_ports
  ADD CONSTRAINT server_ports_node_id_host_port_key UNIQUE (node_id, host_port);

-- ---------------------------------------------------------------------------
-- node_port_pools: a reserved number is reserved for both protocols.
-- ---------------------------------------------------------------------------

-- An admin who reserved the same spec twice (once per protocol) meant one
-- entry; keep the older row.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY node_id, spec
      ORDER BY created_at ASC, protocol ASC
    ) AS rn
  FROM node_port_pools
)
DELETE FROM node_port_pools p
USING ranked r
WHERE p.id = r.id AND r.rn > 1;

ALTER TABLE node_port_pools
  DROP CONSTRAINT IF EXISTS node_port_pools_node_id_spec_protocol_key;
ALTER TABLE node_port_pools DROP COLUMN IF EXISTS protocol;
ALTER TABLE node_port_pools
  ADD CONSTRAINT node_port_pools_node_id_spec_key UNIQUE (node_id, spec);

-- Overlaps between surviving entries are possible here (a tcp "25565-25570"
-- entry and a udp "25565" entry are now two entries covering 25565). They are
-- harmless — the pool is read as a set — and the add path keeps every *new*
-- entry disjoint.

-- ---------------------------------------------------------------------------
-- blueprints.default_ports: drop the protocol key from every declaration.
-- ---------------------------------------------------------------------------

-- Built-in blueprints are re-synced from code on every boot, so this is really
-- for admin-created ones. Entries that differed only by protocol collapse to a
-- single declaration, keeping the primary flag if either carried it.
UPDATE blueprints
SET default_ports = COALESCE(sub.ports, '[]'::jsonb)
FROM (
  SELECT
    b.id,
    jsonb_agg(port ORDER BY container) AS ports
  FROM blueprints b
  CROSS JOIN LATERAL (
    SELECT
      (elem->>'container')::int AS container,
      jsonb_strip_nulls(
        jsonb_build_object(
          'container', (elem->>'container')::int,
          'primary', NULLIF(bool_or(elem->>'primary' = 'true'), FALSE)
        )
      ) AS port
    FROM jsonb_array_elements(b.default_ports) AS elem
    WHERE elem ? 'container'
    GROUP BY (elem->>'container')::int
  ) AS collapsed
  GROUP BY b.id
) AS sub
WHERE blueprints.id = sub.id;
