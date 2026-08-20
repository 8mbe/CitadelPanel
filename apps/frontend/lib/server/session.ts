import "server-only";

import { headers } from "next/headers";

import { getAuthenticatedUser } from "@/lib/server/control-plane/auth/middleware";
import { loadMeProfile } from "@/lib/server/control-plane/services/me";
import { initials } from "@/lib/format";
import type { SessionUser } from "@/components/session-provider";

/**
 * Resolve the signed-in account from the request cookies, server-side.
 *
 * The panel layout is an async server component, so it can read the session
 * here — where Better Auth's cookie is already in the request headers — and
 * hand it to the client-side {@link SessionProvider} as `initialUser`. That
 * makes the provider start with a user in hand on first paint, instead of
 * blocking every panel page behind a `GET /api/me` round trip that fires only
 * after hydration.
 *
 * Returns null for an unauthenticated or banned visitor. The panel layout
 * handles the redirect; this function is the read, not the gate.
 */
export async function resolveSessionUser(): Promise<SessionUser | null> {
  const requestHeaders = await headers();
  const request = new Request("http://next.internal/", {
    headers: requestHeaders,
  });

  const authed = await getAuthenticatedUser(request).catch(() => null);
  if (!authed) return null;

  const profile = await loadMeProfile(authed);

  // Mirror the SessionProvider's fallback: the stored name wins, but an account
  // without one still gets a non-blank header from its email local-part.
  const name =
    profile.name?.trim()
      ? profile.name
      : (authed.email.split("@")[0] ?? authed.email);

  return {
    id: authed.id,
    name,
    email: authed.email,
    role: authed.role,
    avatarSeed: initials(name),
    twoFactorEnabled: profile.twoFactorEnabled,
    ownedServers: profile.ownedServers,
    subuserServers: profile.subuserServers,
    pendingReviews: profile.pendingReviews,
  };
}
