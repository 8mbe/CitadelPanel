-- AI assistant configuration (plan.md: admin general settings).
--
-- Stored in panel_settings for the same reasons as timezone, captcha and mail:
-- these are runtime knobs an operator tunes in the UI, not boot-critical values.
-- The transport secret (the API key for the OpenAI-compatible provider) lives
-- inside the JSON value but is AES-256-GCM encrypted by lib/crypto before it is
-- written, so nothing in `value` is trusted to be safe to serve to a client.
--
-- See services/settings.ts (getAiSettings / getPublicAiSettings) for the shapes
-- these objects take; this migration only seeds the off-by-default state so a
-- read never has to distinguish "unset" from "missing".

INSERT INTO panel_settings (key, value)
VALUES (
  'ai',
  '{
    "enabled": false,
    "apiUrl": null,
    "apiKeyEncrypted": null,
    "model": null
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
