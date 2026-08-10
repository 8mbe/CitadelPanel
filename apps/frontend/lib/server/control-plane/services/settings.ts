/**
 * Panel settings — runtime configuration held in `panel_settings`.
 *
 * These are the knobs an admin turns in the UI (timezone, captcha), as opposed
 * to the boot-critical values in `.env`. The split matters: anything the backend
 * needs in order to *reach* Postgres cannot be stored in Postgres.
 *
 * Reads are cached in-process because the captcha config is consulted on every
 * sign-in and sign-up. The cache is invalidated on write, and its TTL bounds how
 * long a second panel replica can serve stale settings after the first one
 * changed them — a few seconds of staleness on a timezone or captcha toggle is
 * acceptable; a per-request round trip on every auth call is not.
 */

import { sql } from "../db/client";
import { decryptSecret, encryptSecret } from "../lib/crypto";

/** Captcha providers the panel knows how to verify server-side. */
export const CAPTCHA_PROVIDERS = [
  "cloudflare-turnstile",
  "google-recaptcha",
  "cap",
] as const;
export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];

export function isCaptchaProvider(value: unknown): value is CaptchaProvider {
  return (
    typeof value === "string" &&
    (CAPTCHA_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Captcha config as stored, with the secret still encrypted. */
export interface StoredCaptchaSettings {
  enabled: boolean;
  provider: CaptchaProvider | null;
  siteKey: string | null;
  secretKeyEncrypted: string | null;
  /**
   * Self-hosted verification base URL. Only meaningful for `cap`, which is
   * self-hosted and therefore has no fixed provider endpoint — Turnstile and
   * reCAPTCHA verify against known Cloudflare/Google URLs.
   */
  apiEndpoint: string | null;
  /** reCAPTCHA v3 score floor. Ignored by the other providers. */
  minScore: number;
}

/** Captcha config safe to hand to a browser: site key only, never the secret. */
export interface PublicCaptchaSettings {
  enabled: boolean;
  provider: CaptchaProvider | null;
  siteKey: string | null;
  apiEndpoint: string | null;
}

export interface SetupState {
  /** ISO timestamp of when the wizard was completed, or null while pending. */
  completedAt: string | null;
}

const DEFAULT_CAPTCHA: StoredCaptchaSettings = {
  enabled: false,
  provider: null,
  siteKey: null,
  secretKeyEncrypted: null,
  apiEndpoint: null,
  minScore: 0.5,
};

/** Short TTL: bounded staleness across replicas without per-request queries. */
const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop cached settings. Called after every write, and by tests. */
export function invalidateSettingsCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const rows = (await sql`
    SELECT value FROM panel_settings WHERE key = ${key}
  `) as { value: unknown }[];

  // Bun.sql returns jsonb already parsed; a string only appears if a caller
  // wrote a bare JSON scalar, which `timezone` does.
  let value = rows[0] === undefined ? fallback : (rows[0].value as T);
  // Older Bun-SQL writes used JSON.stringify before the cast. postgres.js
  // serializes parameters itself, so those rows can appear double-encoded.
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    try {
      value = JSON.parse(value) as T;
    } catch {
      value = fallback;
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function writeSetting(
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  await sql`
    INSERT INTO panel_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${sql.json(value as never)}, ${updatedBy}, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
  `;
  invalidateSettingsCache(key);
}

// --- Timezone -----------------------------------------------------------------

/**
 * The panel's display timezone, as an IANA name.
 *
 * Timestamps are stored as `TIMESTAMPTZ` and served as ISO strings; this is
 * purely how the frontend renders them. Storing a zone name rather than an
 * offset is what makes DST correct without a scheduled job to shift it.
 */
export function getTimezone(): Promise<string> {
  return readSetting<string>("timezone", "UTC");
}

/**
 * Validate an IANA timezone name using the runtime's own tz database, so the
 * accepted set matches what `Intl.DateTimeFormat` can actually render.
 */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function setTimezone(
  timezone: string,
  updatedBy: string | null,
): Promise<void> {
  if (!isValidTimezone(timezone)) {
    throw new Error(`Not a valid IANA timezone: ${timezone}`);
  }
  return writeSetting("timezone", timezone, updatedBy);
}

// --- Captcha ------------------------------------------------------------------

export async function getCaptchaSettings(): Promise<StoredCaptchaSettings> {
  const stored = await readSetting<Partial<StoredCaptchaSettings>>(
    "captcha",
    DEFAULT_CAPTCHA,
  );
  return { ...DEFAULT_CAPTCHA, ...stored };
}

/**
 * Captcha config for the browser.
 *
 * `enabled` is reported false unless the config is actually usable. A provider
 * with no site key would render a broken widget, and a widget the user cannot
 * solve locks them out of sign-in entirely — worse than no captcha.
 */
export async function getPublicCaptchaSettings(): Promise<PublicCaptchaSettings> {
  const captcha = await getCaptchaSettings();
  const usable = Boolean(
    captcha.enabled &&
      captcha.provider &&
      captcha.siteKey &&
      captcha.secretKeyEncrypted,
  );

  return {
    enabled: usable,
    provider: usable ? captcha.provider : null,
    siteKey: usable ? captcha.siteKey : null,
    apiEndpoint: usable ? captcha.apiEndpoint : null,
  };
}

/** The decrypted secret key, or null when captcha is not configured. */
export async function getCaptchaSecret(): Promise<string | null> {
  const captcha = await getCaptchaSettings();
  if (!captcha.secretKeyEncrypted) return null;
  return decryptSecret(captcha.secretKeyEncrypted);
}

export interface CaptchaUpdate {
  enabled: boolean;
  provider?: CaptchaProvider | null;
  siteKey?: string | null;
  /** Plaintext; encrypted here. Omit to keep the stored secret unchanged. */
  secretKey?: string | null;
  apiEndpoint?: string | null;
  minScore?: number;
}

/**
 * Update the captcha configuration.
 *
 * Enabling requires a complete config, checked here rather than at the route so
 * every caller (setup wizard, admin settings) gets the same guarantee. Disabling
 * keeps the stored keys so toggling back on does not mean re-entering them.
 */
export async function setCaptchaSettings(
  update: CaptchaUpdate,
  updatedBy: string | null,
): Promise<void> {
  const current = await getCaptchaSettings();

  const provider =
    update.provider === undefined ? current.provider : update.provider;
  const siteKey = update.siteKey === undefined ? current.siteKey : update.siteKey;
  const apiEndpoint =
    update.apiEndpoint === undefined ? current.apiEndpoint : update.apiEndpoint;

  // An omitted secretKey keeps the existing ciphertext — the plaintext is never
  // readable again, so a settings form cannot round-trip it.
  const secretKeyEncrypted =
    update.secretKey === undefined
      ? current.secretKeyEncrypted
      : update.secretKey
        ? encryptSecret(update.secretKey)
        : null;

  if (update.enabled) {
    if (!provider) throw new Error("A captcha provider is required to enable captcha.");
    if (!siteKey) throw new Error("A captcha site key is required to enable captcha.");
    if (!secretKeyEncrypted) {
      throw new Error("A captcha secret key is required to enable captcha.");
    }
    // Cap is self-hosted, so there is no default URL to fall back to.
    if (provider === "cap" && !apiEndpoint) {
      throw new Error(
        "Cap requires an API endpoint, e.g. https://cap.example.com/<site-key>/",
      );
    }
  }

  await writeSetting(
    "captcha",
    {
      enabled: update.enabled,
      provider,
      siteKey,
      secretKeyEncrypted,
      apiEndpoint,
      minScore: update.minScore ?? current.minScore,
    } satisfies StoredCaptchaSettings,
    updatedBy,
  );
}

// --- Mail ---------------------------------------------------------------------

/**
 * Outbound email transport, chosen by the operator in the admin settings.
 *
 * Mirrors the captcha pattern deliberately: a provider picked at runtime and
 * stored here, with secrets encrypted at rest. Better Auth's email callbacks
 * (`sendVerificationEmail`, `sendResetPassword`, `sendChangeEmailConfirmation`)
 * are functions, so they can read this on each send — a change in the admin UI
 * takes effect immediately, with no restart, which the static `emailVerification`
 * config options could not offer.
 *
 * When no provider is configured (`enabled: false`), the panel runs without
 * email: signup still works, email changes apply immediately (see `changeEmail`
 * in `auth/betterAuth.ts`), and password reset is simply unavailable.
 */
export const MAIL_PROVIDERS = ["smtp", "resend"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export function isMailProvider(value: unknown): value is MailProvider {
  return (
    typeof value === "string" &&
    (MAIL_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Mail config as stored, with transport secrets still encrypted. */
export interface StoredMailSettings {
  enabled: boolean;
  provider: MailProvider | null;
  /** Display name for the From header, e.g. "CitadelPanel". */
  fromName: string | null;
  /** From address, e.g. "panel@example.com". */
  fromEmail: string | null;
  // SMTP transport.
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpPasswordEncrypted: string | null;
  /** true = implicit TLS (465); false = plain/STARTTLS (587/25). */
  smtpSecure: boolean;
  // Resend HTTP API transport.
  resendApiKeyEncrypted: string | null;
}

/** Mail config safe to hand to a browser: no secrets, just "is one stored?". */
export interface PublicMailSettings {
  enabled: boolean;
  provider: MailProvider | null;
  fromName: string | null;
  fromEmail: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean;
  hasSmtpPassword: boolean;
  hasResendApiKey: boolean;
}

const DEFAULT_MAIL: StoredMailSettings = {
  enabled: false,
  provider: null,
  fromName: null,
  fromEmail: null,
  smtpHost: null,
  smtpPort: null,
  smtpUser: null,
  smtpPasswordEncrypted: null,
  smtpSecure: false,
  resendApiKeyEncrypted: null,
};

export async function getMailSettings(): Promise<StoredMailSettings> {
  const stored = await readSetting<Partial<StoredMailSettings>>(
    "mail",
    DEFAULT_MAIL,
  );
  return { ...DEFAULT_MAIL, ...stored };
}

/**
 * Mail config for the browser, reporting only that a secret exists (never the
 * value). `enabled` is reported false unless the config is actually usable — a
 * half-entered provider must never be treated as "mail is on".
 */
export async function getPublicMailSettings(): Promise<PublicMailSettings> {
  const mail = await getMailSettings();
  const usable = isMailUsable(mail);
  return {
    enabled: usable,
    provider: usable ? mail.provider : null,
    fromName: mail.fromName,
    fromEmail: mail.fromEmail,
    smtpHost: mail.smtpHost,
    smtpPort: mail.smtpPort,
    smtpUser: mail.smtpUser,
    smtpSecure: mail.smtpSecure,
    hasSmtpPassword: mail.smtpPasswordEncrypted !== null,
    hasResendApiKey: mail.resendApiKeyEncrypted !== null,
  };
}

/** True when the stored config has everything needed to actually send mail. */
export function isMailUsable(mail: StoredMailSettings): boolean {
  if (!mail.enabled || !mail.provider || !mail.fromEmail) return false;
  if (mail.provider === "smtp") {
    return Boolean(mail.smtpHost && mail.smtpPasswordEncrypted !== null);
  }
  if (mail.provider === "resend") {
    return mail.resendApiKeyEncrypted !== null;
  }
  return false;
}

/** The decrypted SMTP password, or null. */
export async function getSmtpPassword(): Promise<string | null> {
  const mail = await getMailSettings();
  if (!mail.smtpPasswordEncrypted) return null;
  return decryptSecret(mail.smtpPasswordEncrypted);
}

/** The decrypted Resend API key, or null. */
export async function getResendApiKey(): Promise<string | null> {
  const mail = await getMailSettings();
  if (!mail.resendApiKeyEncrypted) return null;
  return decryptSecret(mail.resendApiKeyEncrypted);
}

export interface MailUpdate {
  enabled: boolean;
  provider?: MailProvider | null;
  fromName?: string | null;
  fromEmail?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  /** Plaintext; encrypted here. Omit to keep the stored secret unchanged. */
  smtpPassword?: string | null;
  smtpSecure?: boolean;
  /** Plaintext; encrypted here. Omit to keep the stored secret unchanged. */
  resendApiKey?: string | null;
}

/**
 * Update the mail configuration.
 *
 * Enabling requires a complete, usable config — checked here so the setup
 * wizard, admin settings page, and the runtime `isMailUsable` check all agree.
 * Disabling keeps the stored secrets so toggling back on does not mean
 * re-entering them.
 */
export async function setMailSettings(
  update: MailUpdate,
  updatedBy: string | null,
): Promise<void> {
  const current = await getMailSettings();

  const provider = update.provider === undefined ? current.provider : update.provider;
  const fromName = update.fromName === undefined ? current.fromName : update.fromName;
  const fromEmail =
    update.fromEmail === undefined ? current.fromEmail : update.fromEmail;
  const smtpHost = update.smtpHost === undefined ? current.smtpHost : update.smtpHost;
  const smtpPort = update.smtpPort === undefined ? current.smtpPort : update.smtpPort;
  const smtpUser = update.smtpUser === undefined ? current.smtpUser : update.smtpUser;
  const smtpSecure =
    update.smtpSecure === undefined ? current.smtpSecure : update.smtpSecure;

  // Omitted secret fields keep the existing ciphertext; an explicit empty
  // string clears it.
  const smtpPasswordEncrypted =
    update.smtpPassword === undefined
      ? current.smtpPasswordEncrypted
      : update.smtpPassword
        ? encryptSecret(update.smtpPassword)
        : null;
  const resendApiKeyEncrypted =
    update.resendApiKey === undefined
      ? current.resendApiKeyEncrypted
      : update.resendApiKey
        ? encryptSecret(update.resendApiKey)
        : null;

  const next: StoredMailSettings = {
    enabled: update.enabled,
    provider,
    fromName,
    fromEmail,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPasswordEncrypted,
    smtpSecure,
    resendApiKeyEncrypted,
  };

  if (next.enabled && !isMailUsable(next)) {
    throw new Error(
      "A complete mail configuration is required to enable email: provider, from address, and the provider's credentials.",
    );
  }

  await writeSetting("mail", next satisfies StoredMailSettings, updatedBy);
}

// --- Email verification policy ------------------------------------------------

/**
 * Whether the panel requires a verified email address before a session can be
 * created. Driven by the admin settings page, read by the sign-in before-hook
 * in `auth/betterAuth.ts`.
 *
 * This is a runtime knob rather than Better Auth's static `requireEmailVerification`
 * option precisely so an admin can toggle it without a redeploy. It is only
 * meaningful when mail is configured — there is no way to verify an email
 * without a way to send one — so the hook also checks `isMailUsable`.
 */
export interface VerificationPolicy {
  requireVerifiedSignIn: boolean;
}

const DEFAULT_VERIFICATION: VerificationPolicy = { requireVerifiedSignIn: false };

export async function getVerificationPolicy(): Promise<VerificationPolicy> {
  const stored = await readSetting<Partial<VerificationPolicy>>(
    "verification",
    DEFAULT_VERIFICATION,
  );
  return { ...DEFAULT_VERIFICATION, ...stored };
}

export async function setVerificationPolicy(
  update: Partial<VerificationPolicy>,
  updatedBy: string | null,
): Promise<void> {
  const current = await getVerificationPolicy();
  await writeSetting(
    "verification",
    { ...current, ...update } satisfies VerificationPolicy,
    updatedBy,
  );
}

// --- Setup state --------------------------------------------------------------

export function getSetupState(): Promise<SetupState> {
  return readSetting<SetupState>("setup", { completedAt: null });
}

/**
 * Has first-time setup finished?
 *
 * Two conditions, and both matter. `completedAt` alone would leave an install
 * whose wizard was interrupted permanently unreachable; the admin count alone
 * would let an admin created by CLI or promotion silently skip the wizard.
 * Setup is complete when it was finished *and* an admin exists to sign in as.
 */
export async function isSetupComplete(): Promise<boolean> {
  const [state, admins] = await Promise.all([getSetupState(), countAdmins()]);
  return typeof state.completedAt === "string" && state.completedAt.length > 0 && admins > 0;
}

export async function markSetupComplete(updatedBy: string | null): Promise<void> {
  await writeSetting(
    "setup",
    { completedAt: new Date().toISOString() } satisfies SetupState,
    updatedBy,
  );
}

/**
 * Number of admin accounts.
 *
 * This is the gate on the bootstrap endpoint: while it is zero, anyone who can
 * reach the panel can claim the first admin account, which is the intended
 * trade-off (no shipped default credential). The moment it is non-zero, the
 * bootstrap endpoint must refuse.
 */
export async function countAdmins(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM "user" WHERE role = 'admin'
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/** Total accounts, so the wizard can explain *why* bootstrap is closed. */
export async function countUsers(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM "user"
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}
