"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { getMe } from "@/lib/api";
import { initials } from "@/lib/format";
import { checkSetup } from "@/lib/setup-gate";

/**
 * The signed-in account, as the UI needs it.
 *
 * `role` gates every admin affordance in the panel — the admin navigation, the
 * resource-limit editor, the enforcement actions. It is a display concern only:
 * the backend re-checks the role on every admin route, so a tampered client
 * gains nothing but a broken-looking UI.
 */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  avatarSeed: string;
  ownedServers: number;
  subuserServers: number;
  /** Unreviewed suspicious-activity flags. Admin-only, hence optional. */
  pendingReviews?: number;
}

interface SessionValue {
  user: SessionUser;
  loading: boolean;
  /** Re-fetch `/api/me` and update the shared user, so a settings change (name,
   *  email) is reflected in the shell without a full reload. Returns the
   *  refreshed user (or null on failure) so the caller can act on the new
   *  value without a stale closure. */
  refresh: () => Promise<SessionUser | null>;
}

const SessionContext = React.createContext<SessionValue | null>(null);

/**
 * Loads the caller's account once and shares it with the whole panel shell.
 *
 * There is no demo fallback: the panel requires a real backend and a signed-in
 * account. If `/api/me` fails, the visitor is redirected — to `/setup` when the
 * panel has not been configured yet, otherwise to `/login`. Children are not
 * rendered until a session is in hand, so no panel page ever runs without a
 * `user`.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Resolve a `/api/me` response into the display shape the shell renders.
  // The stored name wins; if it is missing (older accounts, or never set), fall
  // back to the email local-part so the avatar/header is never blank.
  const toSessionUser = React.useCallback((me: Awaited<ReturnType<typeof getMe>>): SessionUser => {
    const name = me.name?.trim() ? me.name : (me.email.split("@")[0] ?? me.email);
    return {
      id: me.id,
      name,
      email: me.email,
      role: me.role,
      avatarSeed: initials(name),
      ownedServers: me.ownedServers,
      subuserServers: me.subuserServers,
      pendingReviews: me.pendingReviews,
    };
  }, []);

  // Re-fetch the account so a settings page can refresh the shell after a name
  // or email change. Returns the refreshed user (null on failure) so a caller
  // can compare the before/after value without depending on a stale closure.
  const refresh = React.useCallback(async (): Promise<SessionUser | null> => {
    try {
      const me = await getMe();
      const next = toSessionUser(me);
      setUser(next);
      return next;
    } catch {
      // A refresh failure leaves the existing session as-is; the initial load
      // effect already handles the unauthenticated case.
      return null;
    }
  }, [toSessionUser]);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const me = await getMe();
        if (cancelled) return;
        setUser(toSessionUser(me));
        setLoading(false);
      } catch {
        if (cancelled) return;
        // Not signed in (or backend unreachable). If the panel has never been
        // set up, that is where the visitor belongs; otherwise send them to
        // sign in. A completed-setup result is cached, so this is usually free.
        const setup = await checkSetup();
        if (cancelled) return;
        router.replace(setup === "needs-setup" ? "/setup" : "/login");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, toSessionUser]);

  if (loading || !user) {
    // A minimal, theme-aware loading state. The redirect (if any) fires from the
    // effect above; until it does, or until the session resolves, show nothing
    // heavy so there is no flash of an unauthenticated shell.
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const value: SessionValue = { user, loading: false, refresh };

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used inside a SessionProvider");
  }
  return ctx;
}
