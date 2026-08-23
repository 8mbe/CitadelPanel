import { SessionProvider } from "@/components/session-provider";
import { PanelShell } from "@/components/panel-shell";
import { getLegalAvailability } from "@/lib/server/site-settings";
import { resolveSessionUser } from "@/lib/server/session";
import { isSetupComplete } from "@/lib/server/control-plane/services/settings";
import { redirect } from "next/navigation";

/**
 * A server component so the footer's legal links and the session are decided
 * before the first byte: which documents are published lives in
 * `panel_settings`, and reading it here avoids a client fetch that would shift
 * the footer in after paint.
 *
 * The session is resolved the same way, server-side, from the request cookie,
 * and handed to {@link SessionProvider} as `initialUser`. That makes the provider
 * start with a user in hand on first paint, so no panel page waits on a client
 * `GET /api/me` round trip before it can fetch its own data. An unauthenticated
 * visitor is redirected here, before the shell ever renders.
 *
 * Everything interactive is in `PanelShell` (a client component). This file
 * exists only to resolve that state and hand it down.
 */
export default async function PanelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [legal, user] = await Promise.all([
    getLegalAvailability(),
    resolveSessionUser(),
  ]);

  if (!user) {
    // An unauthenticated visitor belongs on the setup wizard (fresh install)
    // or the sign-in page. Resolved here, on the server, so there is no flash
    // of the panel shell for a logged-out visitor, and no client-side redirect
    // that could be raced by keeping a tab open.
    redirect((await isSetupComplete()) ? "/login" : "/setup");
  }

  return (
    <SessionProvider initialUser={user}>
      <PanelShell legal={legal}>{children}</PanelShell>
    </SessionProvider>
  );
}
