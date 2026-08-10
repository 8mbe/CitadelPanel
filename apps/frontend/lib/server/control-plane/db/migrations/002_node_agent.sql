-- Node agent migration.
--
-- Replaces direct Docker Engine API access with a per-node agent (apps/agent).
-- The panel no longer speaks the Docker protocol: it makes authenticated HTTP
-- calls to an agent that runs on the node and owns that machine's daemon and
-- server data.
--
-- Why the columns change shape:
--   docker_endpoint -> api_url    the target is now an agent, not a daemon
--   tls_ca/cert/key -> api_token  auth is a bearer token, not a client cert
--
-- The TLS columns are DROPPED rather than retained. They held mutual-TLS client
-- material for the Docker API, which nothing reads any more; keeping encrypted
-- private keys around that no code path can use is a liability, not a fallback.
--
-- Existing rows cannot be migrated automatically: there is no way to derive an
-- agent URL and token from a Docker endpoint and a client certificate. Any
-- previously registered node must be re-registered after its agent is deployed
-- (`bun run cli node:add`).

ALTER TABLE nodes
  DROP COLUMN IF EXISTS docker_endpoint,
  DROP COLUMN IF EXISTS tls_ca,
  DROP COLUMN IF EXISTS tls_cert,
  DROP COLUMN IF EXISTS tls_key;

-- Added nullable, then backfilled, then constrained: a plain NOT NULL ADD
-- COLUMN fails outright on a table that still has rows.
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS api_url TEXT,
  ADD COLUMN IF NOT EXISTS api_token_encrypted TEXT;

-- Any surviving row is unusable (no agent URL, no token). Deactivate rather than
-- delete: `servers.node_id` is ON DELETE RESTRICT, so deleting would fail while
-- servers reference it, and an operator needs to see the row to reconcile it.
UPDATE nodes
SET
  api_url = COALESCE(api_url, ''),
  is_active = FALSE
WHERE api_url IS NULL OR api_url = '';

ALTER TABLE nodes
  ALTER COLUMN api_url SET NOT NULL;

COMMENT ON COLUMN nodes.api_url IS
  'Base URL of the node''s CitadelPanel agent, e.g. https://node1.internal:8081';
COMMENT ON COLUMN nodes.api_token_encrypted IS
  'Bearer token for the node agent, AES-256-GCM encrypted at rest. Root-equivalent for that host.';
