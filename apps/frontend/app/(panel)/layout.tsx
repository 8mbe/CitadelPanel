import { SessionProvider } from "@/components/session-provider";
import { PanelShell } from "@/components/panel-shell";
import { getLegalAvailability } from "@/lib/server/site-settings";

/**
 * A server component so the footer's legal links are decided before the first
 * byte: which documents are published lives in `panel_settings`, and reading it
 * here avoids a client fetch that would shift the footer in after paint.
 *
 * Everything interactive is in `PanelShell` (a client component) — this file
 * exists only to resolve that state and hand it down.
 */
export default async function PanelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const legal = await getLegalAvailability();

  return (
    <SessionProvider>
      <PanelShell legal={legal}>{children}</PanelShell>
    </SessionProvider>
  );
}
