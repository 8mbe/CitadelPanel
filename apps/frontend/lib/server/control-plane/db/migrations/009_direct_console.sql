-- CitadelPanel: direct-console WebSocket capability tokens.
--
-- The live console now opens a browser → agent WebSocket directly (not the
-- panel-proxied SSE stream). The panel mints a short-lived, single-use
-- capability token; the browser presents it in the WS URL path, and the agent
-- calls the panel back to validate it and to audit each command typed.
--
-- `console_sessions` is the panel-side source of truth for those tokens. The
-- agent stays stateless (it pulls validation per-connection), so this table
-- gives instant revocation, survives agent restarts, and enforces single-use
-- atomically (the `upgraded_at IS NULL` guard in the consume UPDATE). A token
-- expires in 60s if never upgraded, and remains audit-usable for 1h after
-- upgrade so the live session's per-command callbacks keep resolving.
--
-- `user_id` is TEXT (not UUID) to match Better Auth's string user ids and the
-- existing `audit_logs.user_id` column it joins against. The audit row the
-- agent's callback writes must FK-reference the same user.
--
-- `nodes.console_url` is the optional public/browser address for the direct
-- WebSocket. When null the panel derives it from `api_url` (ws/wss from the
-- scheme), which is the zero-config homelab case. Keeping it separate from
-- `api_url` lets the panel→agent link stay on a private address while the
-- browser reaches the agent via a public one.

CREATE TABLE IF NOT EXISTS console_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       UUID NOT NULL UNIQUE,
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  node_id     UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  upgraded_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS console_sessions_token_idx ON console_sessions(token);

COMMENT ON TABLE console_sessions IS
  'Short-lived, single-use capability tokens for the browser→agent console WebSocket.';
COMMENT ON COLUMN console_sessions.token IS
  'The capability token carried in the WS URL path. Single-use for upgrade, reusable for per-command audit callbacks.';
COMMENT ON COLUMN console_sessions.expires_at IS
  'Pre-upgrade deadline (mint + 60s). An unupgraded token past this is rejected.';
COMMENT ON COLUMN console_sessions.upgraded_at IS
  'Set atomically when the agent first validates the token (WS open). NULL ⇒ not yet consumed.';
COMMENT ON COLUMN console_sessions.revoked_at IS
  'Set by an explicit revoke. Blocks new upgrades and new audit writes for this token.';

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS console_url TEXT;
COMMENT ON COLUMN nodes.console_url IS
  'Optional public browser URL for the direct console WebSocket (wss://). When null, derived from api_url.';
