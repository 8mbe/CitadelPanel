-- Outbound email + email-verification policy (plan.md: admin general settings).
--
-- Stored in panel_settings for the same reasons as timezone and captcha:
-- these are runtime knobs an operator tunes in the UI, not boot-critical
-- values. Transport secrets (SMTP password, Resend API key) live inside the
-- JSON value but are AES-256-GCM encrypted by lib/crypto before they are
-- written, so nothing in `value` is trusted to be safe to serve to a client.
--
-- See services/settings.ts (getMailSettings / getVerificationPolicy) for the
-- shapes these objects take; this migration only seeds the off-by-default
-- state so a read never has to distinguish "unset" from "missing".

-- Mail transport, off by default. `provider` is null while disabled so a
-- half-configured provider can never be treated as active (same invariant the
-- captcha config holds).
INSERT INTO panel_settings (key, value)
VALUES (
  'mail',
  '{
    "enabled": false,
    "provider": null,
    "fromName": null,
    "fromEmail": null,
    "smtpHost": null,
    "smtpPort": null,
    "smtpUser": null,
    "smtpPasswordEncrypted": null,
    "smtpSecure": false,
    "resendApiKeyEncrypted": null
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- Email-verification policy. False until an admin turns it on, and only
-- meaningful once mail is configured, enforced by the sign-in before-hook.
INSERT INTO panel_settings (key, value)
VALUES ('verification', '{"requireVerifiedSignIn": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;
