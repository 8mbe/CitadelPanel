/**
 * Server-side captcha verification.
 *
 * A captcha is only worth anything if the *server* validates the token. The
 * widget in the browser proves nothing on its own — a client can simply not run
 * it and post the form directly. So every protected endpoint goes through
 * `verifyCaptcha` before the underlying handler sees the request.
 *
 * Three providers are supported and chosen at runtime from panel settings, not
 * at build time: the operator picks one in the setup wizard, and switching does
 * not require a redeploy.
 *
 *   cloudflare-turnstile  hosted, free, no user interaction in the common case
 *   google-recaptcha      hosted, v2 checkbox or v3 score (minScore applies)
 *   cap                   self-hosted (capjs / trycap.dev), proof-of-work
 *
 * FAIL CLOSED: if verification cannot be completed — provider unreachable,
 * timeout, malformed response — the request is rejected. Failing open would mean
 * an attacker gets a free pass by making the provider unreachable, which is the
 * one condition they can most easily induce.
 */

import { getCaptchaSecret, getCaptchaSettings } from "../services/settings";
import type { CaptchaProvider } from "../services/settings";

/** Header the frontend sends the token in. Matches Better Auth's convention. */
export const CAPTCHA_HEADER = "x-captcha-response";

/**
 * Verification must not hang a sign-in request. 10s is generous for all three
 * providers while still failing before a user assumes the page is broken.
 */
const VERIFY_TIMEOUT_MS = 10_000;

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

export interface CaptchaResult {
  ok: boolean;
  /** Operator-facing reason. Safe to show a user: names no secrets. */
  error?: string;
}

/** Shape shared by Turnstile and reCAPTCHA (`cap` mimics it too). */
interface SiteVerifyResponse {
  success?: boolean;
  score?: number;
  "error-codes"?: string[];
}

/**
 * Turnstile and reCAPTCHA both take form-encoded `secret` + `response`.
 * Kept as one function because the response contract is identical as well.
 */
async function verifyFormEncoded(
  url: string,
  secret: string,
  token: string,
  remoteIp: string | null,
): Promise<SiteVerifyResponse> {
  const body = new URLSearchParams({ secret, response: token });
  // Optional for both providers, and it tightens the check when present.
  if (remoteIp) body.set("remoteip", remoteIp);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`verification endpoint returned ${response.status}`);
  }
  return (await response.json()) as SiteVerifyResponse;
}

/**
 * Cap posts JSON to `<apiEndpoint>siteverify`, where apiEndpoint already
 * includes the site key path segment and a trailing slash.
 *
 * The URL is joined rather than concatenated so a missing trailing slash in the
 * stored setting does not silently drop the site key segment.
 */
async function verifyCap(
  apiEndpoint: string,
  secret: string,
  token: string,
): Promise<SiteVerifyResponse> {
  const base = apiEndpoint.endsWith("/") ? apiEndpoint : `${apiEndpoint}/`;
  const url = new URL("siteverify", base);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, response: token }),
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`verification endpoint returned ${response.status}`);
  }
  return (await response.json()) as SiteVerifyResponse;
}

/**
 * Verify a captcha token against the configured provider.
 *
 * Returns `{ ok: true }` when captcha is disabled, so callers can invoke this
 * unconditionally instead of duplicating the enabled check at every call site.
 */
export async function verifyCaptcha(
  token: string | null,
  remoteIp: string | null = null,
): Promise<CaptchaResult> {
  const settings = await getCaptchaSettings();
  if (!settings.enabled || !settings.provider) return { ok: true };

  const secret = await getCaptchaSecret();
  if (!secret) {
    // Enabled but unconfigured. Refusing is the safe read of the operator's
    // intent, and `getPublicCaptchaSettings` already hides the widget in this
    // state, so it should not be reachable in practice.
    console.error("[captcha] enabled but no secret key is stored");
    return { ok: false, error: "Captcha is misconfigured. Contact an administrator." };
  }

  if (!token) {
    return { ok: false, error: "Captcha verification is required." };
  }

  let result: SiteVerifyResponse;
  try {
    result = await verifyForProvider(settings.provider, {
      secret,
      token,
      remoteIp,
      apiEndpoint: settings.apiEndpoint,
    });
  } catch (error) {
    console.error("[captcha] verification failed:", error);
    return {
      ok: false,
      error: "Could not verify the captcha. Please try again.",
    };
  }

  if (!result.success) {
    return { ok: false, error: "Captcha verification failed. Please try again." };
  }

  // reCAPTCHA v3 returns a score instead of a hard pass/fail; v2 omits it.
  if (
    settings.provider === "google-recaptcha" &&
    typeof result.score === "number" &&
    result.score < settings.minScore
  ) {
    return {
      ok: false,
      error: "Captcha verification failed. Please try again.",
    };
  }

  return { ok: true };
}

function verifyForProvider(
  provider: CaptchaProvider,
  args: {
    secret: string;
    token: string;
    remoteIp: string | null;
    apiEndpoint: string | null;
  },
): Promise<SiteVerifyResponse> {
  switch (provider) {
    case "cloudflare-turnstile":
      return verifyFormEncoded(
        TURNSTILE_VERIFY_URL,
        args.secret,
        args.token,
        args.remoteIp,
      );

    case "google-recaptcha":
      return verifyFormEncoded(
        RECAPTCHA_VERIFY_URL,
        args.secret,
        args.token,
        args.remoteIp,
      );

    case "cap":
      if (!args.apiEndpoint) {
        throw new Error("Cap is selected but no API endpoint is configured");
      }
      return verifyCap(args.apiEndpoint, args.secret, args.token);
  }
}

/**
 * Verify the captcha carried by a request, if any.
 *
 * Reads the token from the header the frontend sets. A body field is not used:
 * Better Auth owns the credential request bodies, and adding a field to them
 * would mean intercepting and re-serialising every auth request.
 */
export function verifyCaptchaForRequest(
  request: Request,
  remoteIp: string | null = null,
): Promise<CaptchaResult> {
  return verifyCaptcha(request.headers.get(CAPTCHA_HEADER), remoteIp);
}
