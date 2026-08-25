import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { SetupStatus } from "@/lib/api";
import { getAuthenticatedUser } from "@/lib/server/control-plane/auth/middleware";
import { handleSetupStatus } from "@/lib/server/control-plane/routes/setup";

import SetupWizard, { type SetupAdmin } from "./setup-wizard";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const requestHeaders = await headers();
  const request = new Request("http://next.internal/api/setup/status", {
    headers: requestHeaders,
  });

  const status = await loadSetupStatus();
  if (!status) return <SetupUnavailable />;
  if (!status.needsSetup) redirect("/");

  // Once the first account exists, every remaining setup action requires an
  // admin session. Do not expose a non-functional wizard to anonymous visitors.
  //
  // The resolved admin is handed to the wizard because `/setup` sits outside
  // the panel layout, and therefore outside `SessionProvider`: it has to work
  // before any account exists at all. The later steps still need to know who
  // they are acting as, to address a test email and to own the first server,
  // so the identity is passed down rather than read from a context that is not
  // there. On a fresh install it is null until step 1 creates it.
  let admin: SetupAdmin | null = null;
  if (!status.canCreateAdmin) {
    const session = await getAuthenticatedUser(request).catch(() => null);
    if (!session) redirect("/login?next=/setup");
    if (session.role !== "admin") redirect("/");
    admin = { id: session.id, email: session.email };
  }

  return <SetupWizard initialStatus={status} initialAdmin={admin} />;
}

async function loadSetupStatus(): Promise<SetupStatus | null> {
  try {
    const response = await handleSetupStatus();
    if (!response.ok) return null;
    return (await response.json()) as SetupStatus;
  } catch {
    return null;
  }
}

function SetupUnavailable() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="font-heading text-lg font-semibold">Setup unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The panel service could not be reached. Check the service configuration
          and reload this page.
        </p>
      </div>
    </main>
  );
}
