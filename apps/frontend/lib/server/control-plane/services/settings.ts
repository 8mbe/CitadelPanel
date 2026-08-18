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

// --- Server limits ------------------------------------------------------------

/**
 * Owner-facing limits on what a server owner may self-provision.
 *
 * `maxAdditionalPortsPerServer` caps how many *additional* (non-blueprint, non
 * -primary) port mappings an owner may add to a single server. Blueprint ports
 * assigned at creation are never counted against this — only ports the owner
 * adds afterwards through the settings page.
 *
 * A panel-wide knob (rather than per-owner or per-blueprint) on purpose: it is a
 * guard against pool fragmentation and port exhaustion, tuned to the fleet's
 * port pools, not a per-user entitlement.
 */
export interface ServerLimits {
  maxAdditionalPortsPerServer: number;
  /** Max databases a server owner may self-provision. 0 forbids them entirely. */
  maxDatabasesPerServer: number;
}

const DEFAULT_SERVER_LIMITS: ServerLimits = {
  maxAdditionalPortsPerServer: 5,
  maxDatabasesPerServer: 2,
};

export async function getServerLimits(): Promise<ServerLimits> {
  const stored = await readSetting<Partial<ServerLimits>>(
    "serverLimits",
    DEFAULT_SERVER_LIMITS,
  );
  const maxAdditionalPortsPerServer =
    typeof stored.maxAdditionalPortsPerServer === "number" &&
    Number.isFinite(stored.maxAdditionalPortsPerServer) &&
    stored.maxAdditionalPortsPerServer >= 0
      ? Math.floor(stored.maxAdditionalPortsPerServer)
      : DEFAULT_SERVER_LIMITS.maxAdditionalPortsPerServer;
  const maxDatabasesPerServer =
    typeof stored.maxDatabasesPerServer === "number" &&
    Number.isFinite(stored.maxDatabasesPerServer) &&
    stored.maxDatabasesPerServer >= 0
      ? Math.floor(stored.maxDatabasesPerServer)
      : DEFAULT_SERVER_LIMITS.maxDatabasesPerServer;
  return { maxAdditionalPortsPerServer, maxDatabasesPerServer };
}

/**
 * Validate and persist an update to the server limits.
 *
 * Only the supplied fields change. `maxAdditionalPortsPerServer` is floored at
 * 0 (an admin may forbid additional ports entirely) and capped at a sane upper
 * bound so a typo cannot disable the guard by accident.
 */
export async function setServerLimits(
  update: Partial<ServerLimits>,
  updatedBy: string | null,
): Promise<ServerLimits> {
  const current = await getServerLimits();
  let maxAdditionalPortsPerServer = current.maxAdditionalPortsPerServer;
  let maxDatabasesPerServer = current.maxDatabasesPerServer;
  if (update.maxAdditionalPortsPerServer !== undefined) {
    const value = Number(update.maxAdditionalPortsPerServer);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error("maxAdditionalPortsPerServer must be a whole number between 0 and 100.");
    }
    maxAdditionalPortsPerServer = Math.floor(value);
  }
  if (update.maxDatabasesPerServer !== undefined) {
    const value = Number(update.maxDatabasesPerServer);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error("maxDatabasesPerServer must be a whole number between 0 and 100.");
    }
    maxDatabasesPerServer = Math.floor(value);
  }
  const next: ServerLimits = { maxAdditionalPortsPerServer, maxDatabasesPerServer };
  await writeSetting("serverLimits", next satisfies ServerLimits, updatedBy);
  return next;
}

// --- AI assistant -------------------------------------------------------------

/**
 * AI assistant configuration — an OpenAI-compatible chat endpoint the panel
 * calls server-side to help users read their console output.
 *
 * Mirrors the captcha/mail pattern deliberately: a provider picked at runtime
 * and stored here, with the API key encrypted at rest. The panel composes every
 * prompt (logs, game, version, the user's question) and the browser only sends
 * the free-text question — so the prompt is never client-controlled, the same
 * "panel-composed, never browser-supplied" posture the database explorer takes
 * with SQL. The API key never reaches the browser; the public view reports only
 * that one is stored.
 *
 * When `enabled` is false, the AI helper button is hidden from every console,
 * so users never see a feature the operator has not configured.
 */
/** AI config as stored, with the API key still encrypted. */
export interface StoredAiSettings {
  enabled: boolean;
  /**
   * Base URL of an OpenAI-compatible endpoint, e.g. "https://api.openai.com/v1".
   * The panel appends "/models" and "/chat/completions" to this.
   */
  apiUrl: string | null;
  apiKeyEncrypted: string | null;
  /** The chosen model id, as returned by the provider's /models endpoint. */
  model: string | null;
}

/** AI config safe to hand to a browser: no secrets, just "is one stored?". */
export interface PublicAiSettings {
  enabled: boolean;
  apiUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
}

const DEFAULT_AI: StoredAiSettings = {
  enabled: false,
  apiUrl: null,
  apiKeyEncrypted: null,
  model: null,
};

export async function getAiSettings(): Promise<StoredAiSettings> {
  const stored = await readSetting<Partial<StoredAiSettings>>(
    "ai",
    DEFAULT_AI,
  );
  return { ...DEFAULT_AI, ...stored };
}

/**
 * AI config for the browser, reporting only that a key exists (never the
 * value). `enabled` is reported false unless the config is actually usable — a
 * half-entered provider must never be treated as "AI is on".
 */
export async function getPublicAiSettings(): Promise<PublicAiSettings> {
  const ai = await getAiSettings();
  const usable = isAiUsable(ai);
  return {
    enabled: usable,
    apiUrl: usable ? ai.apiUrl : null,
    model: usable ? ai.model : null,
    hasApiKey: ai.apiKeyEncrypted !== null,
  };
}

/** True when the stored config has everything needed to actually call the AI. */
export function isAiUsable(ai: StoredAiSettings): boolean {
  return Boolean(
    ai.enabled &&
      ai.apiUrl &&
      ai.apiKeyEncrypted &&
      ai.model,
  );
}

/** The decrypted API key, or null when AI is not configured. */
export async function getAiApiKey(): Promise<string | null> {
  const ai = await getAiSettings();
  if (!ai.apiKeyEncrypted) return null;
  return decryptSecret(ai.apiKeyEncrypted);
}

export interface AiUpdate {
  enabled: boolean;
  apiUrl?: string | null;
  /** Plaintext; encrypted here. Omit to keep the stored secret unchanged. */
  apiKey?: string | null;
  model?: string | null;
}

/**
 * Update the AI configuration.
 *
 * Enabling requires a complete, usable config — checked here so the setup
 * wizard, admin settings page, and the runtime `isAiUsable` check all agree.
 * Disabling keeps the stored key so toggling back on does not mean re-entering
 * it.
 */
export async function setAiSettings(
  update: AiUpdate,
  updatedBy: string | null,
): Promise<void> {
  const current = await getAiSettings();

  const apiUrl = update.apiUrl === undefined ? current.apiUrl : update.apiUrl;
  const model = update.model === undefined ? current.model : update.model;

  // Omitted secret field keeps the existing ciphertext; an explicit empty
  // string clears it.
  const apiKeyEncrypted =
    update.apiKey === undefined
      ? current.apiKeyEncrypted
      : update.apiKey
        ? encryptSecret(update.apiKey)
        : null;

  const next: StoredAiSettings = {
    enabled: update.enabled,
    apiUrl,
    apiKeyEncrypted,
    model,
  };

  if (next.enabled && !isAiUsable(next)) {
    throw new Error(
      "A complete AI configuration is required to enable the assistant: API URL, API key, and a model.",
    );
  }

  await writeSetting("ai", next satisfies StoredAiSettings, updatedBy);
}

// --- Branding -----------------------------------------------------------------

/**
 * The panel's public identity: the name in the header, on the sign-in page, and
 * in every `<title>`.
 *
 * "CitadelPanel" is the default, not a constant. An operator running this for a
 * hosting brand renames it here once and every surface follows, because the name
 * is read from settings rather than hardcoded per component — which is also why
 * the header no longer carries a fixed product glyph beside it.
 */
export interface BrandingSettings {
  siteName: string;
  /** One-line strapline under the name on the sign-in page. */
  tagline: string;
}

const DEFAULT_BRANDING: BrandingSettings = {
  siteName: "CitadelPanel",
  tagline: "Self-hosted game server management.",
};

export async function getBranding(): Promise<BrandingSettings> {
  const stored = await readSetting<Partial<BrandingSettings>>(
    "branding",
    DEFAULT_BRANDING,
  );
  // A blank name would render an empty header and an empty <title>, so an empty
  // stored value falls back rather than being honoured.
  const siteName =
    typeof stored.siteName === "string" && stored.siteName.trim()
      ? stored.siteName.trim()
      : DEFAULT_BRANDING.siteName;
  const tagline =
    typeof stored.tagline === "string" ? stored.tagline : DEFAULT_BRANDING.tagline;
  return { siteName, tagline };
}

export async function setBranding(
  update: Partial<BrandingSettings>,
  updatedBy: string | null,
): Promise<BrandingSettings> {
  const current = await getBranding();
  const next: BrandingSettings = {
    siteName: update.siteName === undefined ? current.siteName : update.siteName.trim(),
    tagline: update.tagline === undefined ? current.tagline : update.tagline.trim(),
  };
  if (!next.siteName) throw new Error("The site name cannot be empty.");
  if (next.siteName.length > 64) {
    throw new Error("The site name must be 64 characters or fewer.");
  }
  if (next.tagline.length > 160) {
    throw new Error("The tagline must be 160 characters or fewer.");
  }
  await writeSetting("branding", next satisfies BrandingSettings, updatedBy);
  return next;
}

// --- Registration ---------------------------------------------------------------

/**
 * Whether strangers may create their own accounts.
 *
 * Turning this off makes the panel invite-only in the only way that matters:
 * the sign-up endpoint refuses. The login form hides its "Create account" tab
 * too, but that is cosmetic — the gate is the Better Auth before-hook in
 * `auth/betterAuth.ts`, which every client shares.
 *
 * The bootstrap window is exempt: while no admin exists, sign-up must work or a
 * fresh install could lock itself out before anyone can sign in to turn the
 * toggle back on.
 */
export interface RegistrationSettings {
  enabled: boolean;
  /** Shown on the sign-in page in place of the sign-up tab. */
  disabledMessage: string;
}

const DEFAULT_REGISTRATION: RegistrationSettings = {
  enabled: true,
  disabledMessage: "Registration is closed. Ask an administrator for an account.",
};

export async function getRegistrationSettings(): Promise<RegistrationSettings> {
  const stored = await readSetting<Partial<RegistrationSettings>>(
    "registration",
    DEFAULT_REGISTRATION,
  );
  return {
    enabled: stored.enabled !== false,
    disabledMessage:
      typeof stored.disabledMessage === "string" && stored.disabledMessage.trim()
        ? stored.disabledMessage.trim()
        : DEFAULT_REGISTRATION.disabledMessage,
  };
}

export async function setRegistrationSettings(
  update: Partial<RegistrationSettings>,
  updatedBy: string | null,
): Promise<RegistrationSettings> {
  const current = await getRegistrationSettings();
  const next: RegistrationSettings = {
    enabled: update.enabled === undefined ? current.enabled : update.enabled,
    disabledMessage:
      update.disabledMessage === undefined
        ? current.disabledMessage
        : update.disabledMessage.trim() || DEFAULT_REGISTRATION.disabledMessage,
  };
  if (next.disabledMessage.length > 240) {
    throw new Error("The message must be 240 characters or fewer.");
  }
  await writeSetting("registration", next satisfies RegistrationSettings, updatedBy);
  return next;
}

/**
 * Is self-service sign-up allowed right now?
 *
 * The admin count is checked here rather than at the call site so the bootstrap
 * exemption cannot be forgotten by a second caller.
 */
export async function isRegistrationOpen(): Promise<boolean> {
  const registration = await getRegistrationSettings();
  if (registration.enabled) return true;
  return (await countAdmins()) === 0;
}

// --- SEO ----------------------------------------------------------------------

/**
 * Search-engine facing configuration.
 *
 * `allowIndexing` defaults to **false**, which is the opposite of most SEO
 * settings and deliberate: a game-server control panel is an authenticated
 * surface with no public content worth ranking, and its URLs leak the fact that
 * a given host runs one. An operator who *does* want the sign-in page indexed
 * (a public hosting brand, say) opts in. The toggle drives both `robots.txt`
 * and the per-page `robots` meta, so the two can never disagree.
 *
 * `siteUrl` is the panel's public origin. It is what `metadataBase` needs to
 * turn relative OG image paths into the absolute URLs crawlers require; when
 * unset the panel falls back to `FRONTEND_URL`.
 */
export interface SeoSettings {
  allowIndexing: boolean;
  siteUrl: string | null;
  /** Meta description and OG description. Falls back to the branding tagline. */
  description: string;
  keywords: string[];
  /** Absolute URL or panel-relative path to the social preview image. */
  ogImageUrl: string | null;
}

const DEFAULT_SEO: SeoSettings = {
  allowIndexing: false,
  siteUrl: null,
  description: "",
  keywords: [],
  ogImageUrl: null,
};

export async function getSeoSettings(): Promise<SeoSettings> {
  const stored = await readSetting<Partial<SeoSettings>>("seo", DEFAULT_SEO);
  return {
    allowIndexing: stored.allowIndexing === true,
    siteUrl: typeof stored.siteUrl === "string" && stored.siteUrl ? stored.siteUrl : null,
    description: typeof stored.description === "string" ? stored.description : "",
    keywords: Array.isArray(stored.keywords)
      ? stored.keywords.filter((k): k is string => typeof k === "string")
      : [],
    ogImageUrl:
      typeof stored.ogImageUrl === "string" && stored.ogImageUrl
        ? stored.ogImageUrl
        : null,
  };
}

export async function setSeoSettings(
  update: Partial<SeoSettings>,
  updatedBy: string | null,
): Promise<SeoSettings> {
  const current = await getSeoSettings();
  const siteUrl =
    update.siteUrl === undefined ? current.siteUrl : (update.siteUrl?.trim() || null);
  if (siteUrl) {
    let parsed: URL;
    try {
      parsed = new URL(siteUrl);
    } catch {
      throw new Error("The site URL must be absolute, e.g. https://panel.example.com");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("The site URL must use http or https.");
    }
  }

  const next: SeoSettings = {
    allowIndexing:
      update.allowIndexing === undefined ? current.allowIndexing : update.allowIndexing,
    // Store without a trailing slash so callers can concatenate paths freely.
    siteUrl: siteUrl ? siteUrl.replace(/\/+$/, "") : null,
    description:
      update.description === undefined ? current.description : update.description.trim(),
    keywords:
      update.keywords === undefined
        ? current.keywords
        : update.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 20),
    ogImageUrl:
      update.ogImageUrl === undefined
        ? current.ogImageUrl
        : (update.ogImageUrl?.trim() || null),
  };
  if (next.description.length > 300) {
    throw new Error("The description must be 300 characters or fewer.");
  }
  await writeSetting("seo", next satisfies SeoSettings, updatedBy);
  return next;
}

// --- Analytics ----------------------------------------------------------------

/**
 * Optional first-party-ish web analytics, injected into the document head.
 *
 * Two providers, both script-tag-only: Plausible (cookieless, self-hostable)
 * and Google Analytics 4. Neither needs a server-side secret, so unlike captcha
 * or mail there is nothing here to encrypt — the measurement id and domain are
 * public by construction, visible in the page source of any site using them.
 *
 * The panel never proxies analytics traffic. When `enabled` is false no script
 * is emitted at all, which is the point of the toggle: an operator running a
 * private panel ships zero third-party requests.
 */
export const ANALYTICS_PROVIDERS = ["plausible", "google"] as const;
export type AnalyticsProvider = (typeof ANALYTICS_PROVIDERS)[number];

export function isAnalyticsProvider(value: unknown): value is AnalyticsProvider {
  return (
    typeof value === "string" &&
    (ANALYTICS_PROVIDERS as readonly string[]).includes(value)
  );
}

export interface AnalyticsSettings {
  enabled: boolean;
  provider: AnalyticsProvider | null;
  /** Plausible: the site name registered with the provider, e.g. "panel.example.com". */
  plausibleDomain: string | null;
  /**
   * Plausible: full script URL for a self-hosted instance, e.g.
   * "https://analytics.example.com/js/script.js". Defaults to plausible.io.
   */
  plausibleScriptUrl: string | null;
  /** Google Analytics 4 measurement id, e.g. "G-XXXXXXXXXX". */
  googleMeasurementId: string | null;
}

const DEFAULT_ANALYTICS: AnalyticsSettings = {
  enabled: false,
  provider: null,
  plausibleDomain: null,
  plausibleScriptUrl: null,
  googleMeasurementId: null,
};

export async function getAnalyticsSettings(): Promise<AnalyticsSettings> {
  const stored = await readSetting<Partial<AnalyticsSettings>>(
    "analytics",
    DEFAULT_ANALYTICS,
  );
  return { ...DEFAULT_ANALYTICS, ...stored };
}

/**
 * True when the stored config can actually emit a working snippet. A provider
 * chosen but left unconfigured must not be treated as "analytics is on" — it
 * would inject a script tag that 404s on every page load.
 */
export function isAnalyticsUsable(analytics: AnalyticsSettings): boolean {
  if (!analytics.enabled || !analytics.provider) return false;
  if (analytics.provider === "plausible") return Boolean(analytics.plausibleDomain);
  if (analytics.provider === "google") return Boolean(analytics.googleMeasurementId);
  return false;
}

/** The analytics config as the document head needs it, or null when off. */
export async function getActiveAnalytics(): Promise<AnalyticsSettings | null> {
  const analytics = await getAnalyticsSettings();
  return isAnalyticsUsable(analytics) ? analytics : null;
}

export async function setAnalyticsSettings(
  update: Partial<AnalyticsSettings>,
  updatedBy: string | null,
): Promise<AnalyticsSettings> {
  const current = await getAnalyticsSettings();
  const next: AnalyticsSettings = {
    enabled: update.enabled === undefined ? current.enabled : update.enabled,
    provider: update.provider === undefined ? current.provider : update.provider,
    plausibleDomain:
      update.plausibleDomain === undefined
        ? current.plausibleDomain
        : (update.plausibleDomain?.trim() || null),
    plausibleScriptUrl:
      update.plausibleScriptUrl === undefined
        ? current.plausibleScriptUrl
        : (update.plausibleScriptUrl?.trim() || null),
    googleMeasurementId:
      update.googleMeasurementId === undefined
        ? current.googleMeasurementId
        : (update.googleMeasurementId?.trim() || null),
  };

  if (next.plausibleScriptUrl) {
    try {
      const parsed = new URL(next.plausibleScriptUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("protocol");
      }
    } catch {
      throw new Error(
        "The Plausible script URL must be absolute, e.g. https://analytics.example.com/js/script.js",
      );
    }
  }
  // GA4 ids are "G-" followed by an alphanumeric stream id. Rejecting anything
  // else here catches the common paste of a UA- or GTM- id, which would load a
  // snippet that silently records nothing.
  if (next.googleMeasurementId && !/^G-[A-Z0-9]{4,}$/i.test(next.googleMeasurementId)) {
    throw new Error(
      'A Google Analytics measurement id looks like "G-XXXXXXXXXX". GTM container and legacy UA ids are not supported.',
    );
  }

  if (next.enabled && !isAnalyticsUsable(next)) {
    throw new Error(
      "A complete analytics configuration is required to enable it: a provider and its site identifier.",
    );
  }

  await writeSetting("analytics", next satisfies AnalyticsSettings, updatedBy);
  return next;
}

// --- Legal documents ----------------------------------------------------------

/**
 * Operator-authored terms of service and privacy policy, stored as Markdown.
 *
 * These are deliberately *not* shipped with default text. A privacy policy is a
 * legal statement about what a specific operator does with a specific set of
 * users' data, and a plausible-looking default would be worse than none: it
 * would be wrong for most installs and would still look authoritative. What the
 * panel does provide is a starter that enumerates the data this codebase
 * actually stores (see `legalTemplates.ts`), which the admin then edits in the
 * full editor at `/admin/legal`.
 *
 * An empty `content` means "not published": the public route 404s rather than
 * rendering a blank page, and the footer link disappears.
 */
export const LEGAL_DOCUMENTS = ["terms", "privacy"] as const;
export type LegalDocumentKey = (typeof LEGAL_DOCUMENTS)[number];

export function isLegalDocumentKey(value: unknown): value is LegalDocumentKey {
  return (
    typeof value === "string" &&
    (LEGAL_DOCUMENTS as readonly string[]).includes(value)
  );
}

export interface LegalDocument {
  /** Markdown source. Empty means the document is unpublished. */
  content: string;
  /** ISO timestamp of the last save, or null when never written. */
  updatedAt: string | null;
}

export type LegalSettings = Record<LegalDocumentKey, LegalDocument>;

const EMPTY_DOCUMENT: LegalDocument = { content: "", updatedAt: null };

/** Hard cap so a paste cannot put an unbounded blob in `panel_settings`. */
const LEGAL_MAX_CHARS = 100_000;

export async function getLegalSettings(): Promise<LegalSettings> {
  const stored = await readSetting<Partial<Record<LegalDocumentKey, Partial<LegalDocument>>>>(
    "legal",
    {},
  );
  const read = (key: LegalDocumentKey): LegalDocument => {
    const doc = stored[key];
    return {
      content: typeof doc?.content === "string" ? doc.content : EMPTY_DOCUMENT.content,
      updatedAt: typeof doc?.updatedAt === "string" ? doc.updatedAt : null,
    };
  };
  return { terms: read("terms"), privacy: read("privacy") };
}

export async function getLegalDocument(
  key: LegalDocumentKey,
): Promise<LegalDocument> {
  return (await getLegalSettings())[key];
}

export async function setLegalDocument(
  key: LegalDocumentKey,
  content: string,
  updatedBy: string | null,
): Promise<LegalSettings> {
  if (content.length > LEGAL_MAX_CHARS) {
    throw new Error(
      `The document must be ${LEGAL_MAX_CHARS.toLocaleString("en-US")} characters or fewer.`,
    );
  }
  const current = await getLegalSettings();
  const trimmed = content.trim();
  const next: LegalSettings = {
    ...current,
    [key]: {
      content: trimmed,
      // Clearing a document unpublishes it, so there is no "last updated" to
      // show; keeping a stale timestamp on an empty page would be a lie.
      updatedAt: trimmed ? new Date().toISOString() : null,
    },
  };
  await writeSetting("legal", next satisfies LegalSettings, updatedBy);
  return next;
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
