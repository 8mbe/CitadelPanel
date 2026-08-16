/**
 * SSRF guardrail for server-side fetches of caller-supplied URLs.
 *
 * Used by the blueprint import-from-url flow and the file-manager pull-from-url
 * flow. Admins (the only callers of both) are already trusted — they author
 * install scripts that run root-equivalent on a node — so this is a guardrail
 * against accidents, not a hardened SSRF boundary. It does **not** defend
 * against DNS rebinding or non-RFC-1918 internal ranges.
 */

/**
 * True for obviously-internal hostnames: loopback, link-local, and the three
 * RFC-1918 private ranges. A caller who points a URL fetch at one of these is
 * probing the control-plane's own network, so the request is rejected.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}
