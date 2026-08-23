"use client";

/**
 * First-run setup gate.
 *
 * A fresh install must send its first visitor to `/setup`; a configured install
 * must never pay a network round trip to discover it is configured. The trick is
 * that setup completion is *irreversible*. Once `completedAt` is set it never
 * clears, so a completed result can be cached in `localStorage` forever and the
 * status endpoint is only ever called on installs that have not finished setup.
 *
 * Concretely:
 *   - First load on a fresh panel  → one GET /api/setup/status, redirect to /setup.
 *   - Every load after completion  → localStorage hit, zero network, no redirect.
 *
 * The cache is a one-way latch: we only ever *write* "complete", never "needs
 * setup", so a stale cache cannot trap a user on a login page for a panel that
 * was since reset (that path re-checks and the key simply is not there).
 */

import { getSetupStatus } from "./api";

const SETUP_DONE_KEY = "citadel.setupComplete";

/** Whether we have already proven, on this browser, that setup is done. */
function cachedComplete(): boolean {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === "1";
  } catch {
    // Private mode or storage disabled. Treat as "unknown" and fall through to
    // a live check. Correctness over speed when we cannot cache.
    return false;
  }
}

function rememberComplete(): void {
  try {
    localStorage.setItem(SETUP_DONE_KEY, "1");
  } catch {
    // Non-fatal: we just re-check next time.
  }
}

export type SetupGateResult = "complete" | "needs-setup" | "unknown";

/**
 * Resolve whether the panel still needs first-time setup.
 *
 * Returns immediately from cache once setup is known complete. Otherwise it asks
 * the backend and caches a positive result. On a network error it returns
 * "unknown" so the caller can decide (the login page stays put rather than
 * bouncing the user around on a transient failure).
 */
export async function checkSetup(): Promise<SetupGateResult> {
  if (cachedComplete()) return "complete";
  return checkSetupLive();
}

/**
 * Ask the backend directly, bypassing the cache but still writing to it.
 *
 * Used on paths where correctness matters more than saving one request: the
 * login page (which already calls the backend for its captcha config) and the
 * session provider's auth-failure path. Going live there is what makes the gate
 * self-heal: if the database is wiped after setup was cached, the next visit to
 * either path re-discovers `needsSetup` instead of trusting the stale latch.
 * Both paths are unauthenticated/low-frequency by definition, so the extra
 * request never lands on the hot path of a signed-in user.
 */
export async function checkSetupLive(): Promise<SetupGateResult> {
  try {
    const status = await getSetupStatus();
    if (status.needsSetup) return "needs-setup";
    rememberComplete();
    return "complete";
  } catch {
    return "unknown";
  }
}

/** Record completion from the wizard's final step, so the gate never re-checks. */
export function markSetupComplete(): void {
  rememberComplete();
}
