-- Panel settings: runtime configuration an admin can change without a redeploy.
--
-- Key/value rather than one column per setting, because these values are chosen
-- in the UI and will keep accruing (timezone, captcha, branding, ...). A typed
-- column per knob would mean a migration for each one, and the read path is
-- always "load the whole set into memory" regardless of shape.
--
-- WHAT BELONGS HERE: things an operator tunes while the panel is running.
-- WHAT DOES NOT: anything the backend needs in order to boot (DATABASE_URL,
-- PANEL_ENCRYPTION_KEY, BETTER_AUTH_SECRET). Those stay in `.env` — a setting
-- required to read the settings table cannot live in the settings table.
--
-- Secret values (captcha secret keys) are AES-256-GCM encrypted before they are
-- written here, the same as node agent tokens. Nothing in `value` is trusted to
-- be safe to serve to a client: the API layer decides field by field.

CREATE TABLE IF NOT EXISTS panel_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who last changed it. ON DELETE SET NULL so removing an account does not
  -- delete panel configuration along with it.
  updated_by  TEXT REFERENCES "user" (id) ON DELETE SET NULL
);

COMMENT ON TABLE panel_settings IS
  'Runtime panel configuration set through the setup wizard and admin settings.';
COMMENT ON COLUMN panel_settings.value IS
  'JSON value. Secret fields inside it are encrypted at rest by lib/crypto.';

-- Seed the defaults so a read never has to distinguish "unset" from "missing".
-- ON CONFLICT DO NOTHING keeps a re-run of the migration non-destructive.

-- UTC until the operator picks a zone: an explicit, unambiguous default beats
-- inheriting whatever timezone the container happens to have.
INSERT INTO panel_settings (key, value)
VALUES ('timezone', '"UTC"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Captcha off by default. `provider` is null while disabled so a half-configured
-- provider can never be treated as active.
INSERT INTO panel_settings (key, value)
VALUES (
  'captcha',
  '{"enabled": false, "provider": null, "siteKey": null, "secretKeyEncrypted": null, "apiEndpoint": null, "minScore": 0.5}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- Setup state. `completedAt` being null is what makes the setup wizard reachable
-- and the one-time bootstrap endpoints live, so it is the panel's install latch.
INSERT INTO panel_settings (key, value)
VALUES ('setup', '{"completedAt": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
