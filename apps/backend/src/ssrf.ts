/**
 * SSRF guard for agent-side URL fetches (the file-manager "pull from URL").
 *
 * The panel forwards an owner-supplied URL for the agent to download directly to
 * disk. The panel applies its own guard, but the agent is where the request
 * actually leaves the node's network, and, crucially, where redirects are
 * followed, so it defends itself rather than trusting the URL it was handed.
 *
 * Two things the panel's original guard could not cover on its own:
 *   - a hostname that resolves to an internal address (the literal string looks
 *     public, DNS says otherwise), and
 *   - a public URL that 302-redirects to an internal one.
 *
 * So this resolves the hostname and checks every address it maps to, and drives
 * redirects manually, re-checking each hop. It is a guardrail, not a hardened
 * boundary: a DNS-rebinding attacker who changes the answer between this check
 * and the socket connect can still win the race. Pinning the resolved IP into
 * the connection would close that, but Bun's fetch does not expose it; this
 * closes the practical vectors (internal hostnames and redirect bounces).
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { badRequest } from "./http";

/** RFC 1918 / loopback / link-local / CGNAT / multicast + reserved IPv4. */
export function isPrivateIpv4(ip: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Loopback / ULA / link-local IPv6, and IPv4-mapped forms. */
export function isPrivateIpv6(ip: string): boolean {
  const host = ip.toLowerCase().replace(/%.+$/, ""); // strip any zone id

  if (host === "::1" || host === "::") return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible, so defer to the v4 rules.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]!);

  if (host.startsWith("fe80")) return true; // link-local (fe80::/10)
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA (fc00::/7)
  return false;
}

/** True for any address that must not be reached from a server-side fetch. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return false;
}

/**
 * Throw a 400 unless `hostname` is safe to fetch: not an obvious internal name,
 * and every address it resolves to is public.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // unwrap [::1]

  if (host === "localhost" || host.endsWith(".localhost")) {
    throw badRequest("That host is not allowed.");
  }

  // An IP literal is checked directly; a name is resolved and every answer
  // checked, so a name pointing at an internal address is rejected too.
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw badRequest("That host is not allowed.");
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw badRequest("Could not resolve that host.");
  }
  if (addresses.length === 0) throw badRequest("Could not resolve that host.");
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw badRequest("That host is not allowed.");
  }
}

/**
 * Fetch a URL with SSRF checks on the initial host and every redirect hop.
 *
 * Redirects are followed manually (`redirect: "manual"`) so each `Location` is
 * re-validated before the next request. `redirect: "follow"` would chase a
 * bounce to an internal address without a second look. Only http(s) is allowed,
 * and the redirect chain is capped.
 */
export async function ssrfSafeFetch(
  initialUrl: string,
  maxRedirects = 5,
): Promise<Response> {
  let current = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw badRequest('"url" must be a valid URL.');
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw badRequest('"url" must be an http(s) URL.');
    }

    await assertPublicHost(url.hostname);

    const response = await fetch(current, { redirect: "manual" });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (isRedirect && location) {
      // Discard the redirect body and resolve the next hop relative to this one.
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      continue;
    }

    return response;
  }

  throw badRequest("Too many redirects while fetching that URL.");
}
