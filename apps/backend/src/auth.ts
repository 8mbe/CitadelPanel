/**
 * Bearer-token authentication.
 *
 * The agent has exactly one credential and one caller (the panel), so there is
 * no session or user model here. Authorization is the panel's job and has
 * already happened by the time a request arrives.
 */

import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { unauthorized } from "./http";

/** Constant-time comparison, so the token cannot be recovered byte-by-byte. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extract a bearer token from an Authorization header value. */
export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** True when the request carries the configured token. */
export function isAuthorized(request: Request): boolean {
  const presented = extractBearer(request.headers.get("authorization"));
  if (!presented) return false;
  return safeEqual(presented, config.token);
}

/** Throw a 401 unless the request is authenticated. */
export function requireAuth(request: Request): void {
  if (!isAuthorized(request)) {
    throw unauthorized("A valid bearer token is required.");
  }
}
