/**
 * SSRF guardrail for server-side fetches of caller-supplied URLs.
 *
 * Callers differ in how much they are trusted:
 *   - blueprint import-from-url and plugin-provider fetches are admin-only;
 *   - the file-manager pull-from-url is reachable by a server owner or a subuser
 *     with the `files` grant, i.e. a semi-trusted tenant, not an operator.
 *
 * `isBlockedHost` is the fast literal check (loopback, link-local, RFC-1918) and
 * stays synchronous for the admin paths. The pull path additionally uses
 * `isBlockedUrlResolved`, which resolves the hostname and checks every address
 * it maps to — so a name that points at an internal IP is rejected too. The
 * agent that actually performs the pull re-checks the host and every redirect
 * hop as well (see `apps/backend/src/ssrf.ts`); this is the panel-side layer.
 *
 * It remains a guardrail, not a hardened boundary: it does not defend against
 * DNS rebinding (the answer changing between this check and the agent's connect).
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * True for obviously-internal hostnames by their literal form: loopback,
 * link-local, and the three RFC-1918 private ranges. A caller who points a URL
 * fetch at one of these is probing the control-plane's own network.
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

/** RFC 1918 / loopback / link-local / CGNAT / multicast + reserved IPv4. */
function isPrivateIpv4(ip: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Loopback / ULA / link-local IPv6, and IPv4-mapped forms. */
function isPrivateIpv6(ip: string): boolean {
  const host = ip.toLowerCase().replace(/%.+$/, "");
  if (host === "::1" || host === "::") return true;
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (host.startsWith("fe80")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return false;
}

/**
 * Like {@link isBlockedHost} but also resolves the hostname and blocks it when
 * any resolved address is internal — closing the "public-looking name that
 * resolves to 127.0.0.1 / 169.254.169.254 / a LAN host" gap for the
 * owner-reachable pull path. A name that cannot be resolved is blocked (there is
 * nothing safe to fetch from it).
 */
export async function isBlockedUrlResolved(hostname: string): Promise<boolean> {
  if (isBlockedHost(hostname)) return true;

  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host);

  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return true;
    return addresses.some(({ address }) => isPrivateAddress(address));
  } catch {
    return true;
  }
}
