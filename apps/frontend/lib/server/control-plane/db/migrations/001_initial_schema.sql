-- CitadelPanel initial schema (plan.md sections 4 and 7.1.3)
--
-- Better Auth owns and manages its own tables ("user", "session", "account",
-- "verification"). Those are created by the Better Auth CLI, not here. This
-- migration only creates panel-specific tables and references "user"(id).
--
-- Ordering note: this migration is applied AFTER the Better Auth CLI migration
-- so that foreign keys to "user"(id) resolve. See src/db/migrate.ts.

-- ---------------------------------------------------------------------------
-- Nodes: the machines that actually run game-server containers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nodes (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL UNIQUE,
  hostname                  TEXT NOT NULL,
  -- e.g. "tcp://10.0.0.5:2376" for a remote node, or
  -- "http://docker-socket-proxy:2375" for a co-located node.
  docker_endpoint           TEXT NOT NULL,

  -- mutual-TLS material for remote Docker Engine API access.
  -- Encrypted at rest with AES-256-GCM (plan.md section 7).
  tls_ca                    TEXT,
  tls_cert                  TEXT,
  tls_key                   TEXT,

  -- Reported capacity, used by the capacity-aware scheduler.
  cpu_total                 NUMERIC(6, 2) NOT NULL DEFAULT 0,
  memory_total_mb           INTEGER NOT NULL DEFAULT 0,
  disk_total_mb             INTEGER NOT NULL DEFAULT 0,

  -- Shared per-node database server (plan.md section 7.1). Optional: a node
  -- without these configured simply cannot provision databases.
  db_admin_host             TEXT,
  db_admin_port             INTEGER,
  db_admin_user             TEXT,
  db_admin_password_encrypted TEXT,

  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  last_heartbeat_at         TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nodes_is_active_idx ON nodes (is_active);

-- ---------------------------------------------------------------------------
-- Game presets: one row per supported game type.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_presets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  docker_image          TEXT NOT NULL,
  default_ports         JSONB NOT NULL DEFAULT '[]'::jsonb,
  env_schema            JSONB NOT NULL DEFAULT '{}'::jsonb,
  startup_cmd_template  TEXT,
  -- Feeds the abuse-heuristics baseline: "bursty" | "steady-low" | "steady-high"
  expected_resource_profile TEXT NOT NULL DEFAULT 'bursty'
    CHECK (expected_resource_profile IN ('bursty', 'steady-low', 'steady-high')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Servers: a single game-server container, owned by a user, placed on a node.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  owner_id          TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  node_id           UUID NOT NULL REFERENCES nodes (id) ON DELETE RESTRICT,
  preset_id         UUID NOT NULL REFERENCES game_presets (id) ON DELETE RESTRICT,

  container_id      TEXT,
  status            TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN (
      'creating', 'installing', 'stopped', 'starting',
      'running', 'stopping', 'suspended', 'error', 'deleting'
    )),

  -- Hard resource limits, enforced by Docker (plan.md section 8).
  cpu_limit         NUMERIC(6, 2) NOT NULL,
  memory_limit_mb   INTEGER NOT NULL,
  disk_limit_mb     INTEGER NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS servers_owner_id_idx ON servers (owner_id);
CREATE INDEX IF NOT EXISTS servers_node_id_idx ON servers (node_id);
CREATE INDEX IF NOT EXISTS servers_status_idx ON servers (status);

-- Published host ports per server, so the scheduler can avoid collisions.
CREATE TABLE IF NOT EXISTS server_ports (
  server_id       UUID NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  node_id         UUID NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  host_port       INTEGER NOT NULL,
  container_port  INTEGER NOT NULL,
  protocol        TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (server_id, container_port, protocol),
  -- A host port can only be bound once per node per protocol.
  UNIQUE (node_id, host_port, protocol)
);

-- Environment variables for a server. Secret values are encrypted at rest.
CREATE TABLE IF NOT EXISTS server_env (
  server_id   UUID NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  is_secret   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (server_id, key)
);

-- ---------------------------------------------------------------------------
-- Subusers: per-server delegated access, independent of the 2 global roles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_subusers (
  server_id   UUID NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  -- e.g. { "console": true, "files": true, "start_stop": true,
  --        "settings": false, "backups": false, "database": false }
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  invited_by  TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS server_subusers_user_id_idx ON server_subusers (user_id);

-- ---------------------------------------------------------------------------
-- Auto-provisioned databases on the shared per-node DB server (section 7.1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_databases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id             UUID NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  node_id               UUID NOT NULL REFERENCES nodes (id) ON DELETE RESTRICT,
  db_name               TEXT NOT NULL,
  db_user               TEXT NOT NULL,
  db_password_encrypted TEXT NOT NULL,
  host                  TEXT NOT NULL,
  port                  INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One database name per node; also prevents duplicate provisioning.
  UNIQUE (node_id, db_name)
);

CREATE INDEX IF NOT EXISTS server_databases_server_id_idx
  ON server_databases (server_id);

-- ---------------------------------------------------------------------------
-- Security / abuse detection (plan.md section 9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suspicious_activity (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  score        INTEGER NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed     BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by  TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS suspicious_activity_reviewed_idx
  ON suspicious_activity (reviewed, detected_at DESC);
CREATE INDEX IF NOT EXISTS suspicious_activity_server_id_idx
  ON suspicious_activity (server_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  ip          TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (target_type, target_id);
