import Script from "next/script";

import type { AnalyticsSettings } from "@/lib/server/control-plane/services/settings";

/**
 * Third-party web analytics, emitted only when an operator has configured them.
 *
 * Two providers, chosen because they are the two an operator actually asks for
 * and because both are pure script tags — no server-side key, no request
 * proxying, nothing for the panel to store encrypted:
 *
 *   - **Plausible** — cookieless and self-hostable. `plausibleScriptUrl` points
 *     at a self-hosted instance; omitted, it falls back to plausible.io.
 *   - **Google Analytics 4** — the standard gtag snippet.
 *
 * When analytics are off this component renders `null`, which is the whole point
 * of the toggle: a private panel makes zero third-party requests, rather than
 * loading a script that reports nothing.
 *
 * `afterInteractive` (the default strategy) rather than `beforeInteractive`:
 * analytics are never required for the page to work, and blocking first paint on
 * a third-party host for a pageview beacon is the wrong trade in a control panel.
 *
 * Note for operators in consent jurisdictions: Google Analytics sets cookies and
 * shares data with Google, so enabling it generally requires consent from the
 * visitor before this script loads. The panel does not ship a consent banner —
 * see `docs/site-settings.md`.
 */
export function Analytics({ settings }: { settings: AnalyticsSettings | null }) {
  if (!settings) return null;

  if (settings.provider === "plausible" && settings.plausibleDomain) {
    return (
      <Script
        // `defer` + `data-domain` is Plausible's documented install.
        src={settings.plausibleScriptUrl ?? "https://plausible.io/js/script.js"}
        data-domain={settings.plausibleDomain}
        defer
      />
    );
  }

  if (settings.provider === "google" && settings.googleMeasurementId) {
    const id = settings.googleMeasurementId;
    return (
      <>
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`}
        />
        <Script id="ga-init">
          {/* The measurement id is validated against /^G-[A-Z0-9]{4,}$/ on write,
              so it cannot carry a quote or a script terminator into this inline
              snippet. */}
          {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');`}
        </Script>
      </>
    );
  }

  return null;
}
