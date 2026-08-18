import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { SetupStatus } from "@/lib/api";
import { getAuthenticatedUser } from "@/lib/server/control-plane/auth/middleware";
import { handleSetupStatus } from "@/lib/server/control-plane/routes/setup";
import {
  getRegistrationSettings,
  isRegistrationOpen,
} from "@/lib/server/control-plane/services/settings";
import { getLegalAvailability } from "@/lib/server/site-settings";

import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

/**
 * The credential entry point, gated before it renders.
 *
 * Two visitors must never reach the form:
 *   - anyone arriving at a fresh install whose first-admin slot is still
 *     claimable — they belong in the wizard;
 *   - anyone who already holds a session, who has nothing to gain from signing
 *     in again and would otherwise be able to create a second account on top of
 *     a live one.
 *
 * Both checks run on the server rather than in an effect, so there is no flash of
 * a sign-in form for an already-authenticated visitor, and no way to stay on it
 * by racing or blocking a client-side redirect.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const requestHeaders = await headers();
  const request = new Request("http://next.internal/login", {
    headers: requestHeaders,
  });

  const status = await loadSetupStatus();

  // Only the claimable first-admin state redirects away from login. If an admin
  // exists but setup is unfinished, that admin must be able to sign back in and
  // resume the protected remainder of the wizard.
  if (status?.needsSetup && status.canCreateAdmin) redirect("/setup");

  const next = safeNext((await searchParams).next);

  // A banned account throws here instead of resolving to a user, and that is
  // treated as "not signed in" on purpose: the sign-in attempt is what surfaces
  // the ban reason to them.
  const session = await getAuthenticatedUser(request).catch(() => null);
  if (session) {
    // An admin on an unfinished install continues into the remaining wizard
    // steps; everyone else lands on the panel they already have access to.
    redirect(next ?? (status?.needsSetup && session.role === "admin" ? "/setup" : "/"));
  }

  // Resolved here rather than in the form so the sign-up tab and the legal links
  // are correct in the first HTML response. `isRegistrationOpen` already accounts
  // for the bootstrap exemption; a read failure falls back to offering sign-up,
  // which the Better Auth gate will still refuse if it is actually closed.
  const [registration, legal] = await Promise.all([
    getRegistrationSettings()
      .then(async (settings) => ({
        enabled: await isRegistrationOpen(),
        disabledMessage: settings.disabledMessage,
      }))
      .catch(() => ({ enabled: true, disabledMessage: "" })),
    getLegalAvailability(),
  ]);

  return <LoginForm next={next} registration={registration} legal={legal} />;
}

async function loadSetupStatus(): Promise<SetupStatus | null> {
  try {
    const response = await handleSetupStatus();
    if (!response.ok) return null;
    return (await response.json()) as SetupStatus;
  } catch {
    // A failing status check must not block sign-in: fall through to the form,
    // which is the only route back into a working panel.
    return null;
  }
}

/**
 * Reduce a `?next=` value to a safe same-origin path, or undefined.
 *
 * Anything that could leave this origin — absolute URLs, protocol-relative
 * `//host`, the backslash variants browsers normalise — is dropped, so the
 * parameter cannot be used as an open redirect. `/login` itself is dropped too,
 * since honouring it would bounce the visitor straight back here.
 */
function safeNext(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/")) return undefined;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return undefined;
  if (raw === "/login" || raw.startsWith("/login?")) return undefined;
  return raw;
}
