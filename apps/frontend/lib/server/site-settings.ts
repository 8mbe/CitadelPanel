import "server-only";

import { cache } from "react";
import type { Metadata } from "next";

import { env } from "@/lib/server/control-plane/config/env";
import {
  getAnalyticsSettings,
  getBranding,
  getLegalSettings,
  getSeoSettings,
  getThemeSettings,
  isAnalyticsUsable,
  type AnalyticsSettings,
  type BrandingSettings,
  type SeoSettings,
} from "@/lib/server/control-plane/services/settings";
import type { LegalAvailability } from "@/components/site-footer";
import { DEFAULT_SITE_THEME, type SiteThemeSettings } from "@/lib/site-theme";

/**
 * Site identity for server components: the branding, SEO, and analytics settings
 * the root layout needs before it renders anything.
 *
 * Why this module exists rather than calling the settings service directly:
 *
 *   - **It cannot throw.** The root layout wraps *every* route, including the
 *     setup wizard on an install whose database is not reachable yet, and
 *     including `global-error.tsx`'s siblings. A settings read that rejects
 *     there would replace a useful error page with an unhandled one, so each
 *     read falls back to the built-in defaults instead.
 *   - **It is request-deduplicated.** `generateMetadata` and the layout body
 *     both need the branding; React's `cache` collapses that to one read per
 *     request, on top of the settings service's own 10-second cache.
 */

/** What the shell and the document head need, resolved once per request. */
export interface SiteSettings {
  branding: BrandingSettings;
  seo: SeoSettings;
  /** Null unless analytics are enabled *and* completely configured. */
  analytics: AnalyticsSettings | null;
  /**
   * The panel's absolute public origin: the configured site URL, else
   * `FRONTEND_URL`. Used as `metadataBase` and by `robots.txt`/`sitemap.xml`.
   */
  siteUrl: string;
  /** The operator's palette — the third theme. See `docs/theming.md`. */
  theme: SiteThemeSettings;
}

const FALLBACK_BRANDING: BrandingSettings = {
  siteName: "CitadelPanel",
  tagline: "Self-hosted game server management.",
};

const FALLBACK_SEO: SeoSettings = {
  allowIndexing: false,
  siteUrl: null,
  description: "",
  keywords: [],
  ogImageUrl: null,
};

export const getSiteSettings = cache(async (): Promise<SiteSettings> => {
  const [branding, seo, analytics, theme] = await Promise.all([
    getBranding().catch(() => FALLBACK_BRANDING),
    getSeoSettings().catch(() => FALLBACK_SEO),
    getAnalyticsSettings().catch(() => null),
    getThemeSettings().catch(() => DEFAULT_SITE_THEME),
  ]);

  return {
    branding,
    seo,
    analytics: analytics && isAnalyticsUsable(analytics) ? analytics : null,
    siteUrl: (seo.siteUrl ?? env.frontendUrl).replace(/\/+$/, ""),
    theme,
  };
});

/**
 * Which legal documents are published, for the footer.
 *
 * Only the booleans — the bodies are large and the footer needs none of them.
 * Falls back to "neither" on a read failure, which degrades to a footer with no
 * legal links rather than a crashed layout.
 */
export const getLegalAvailability = cache(async (): Promise<LegalAvailability> => {
  const legal = await getLegalSettings().catch(() => null);
  return {
    terms: (legal?.terms.content.length ?? 0) > 0,
    privacy: (legal?.privacy.content.length ?? 0) > 0,
  };
});

/**
 * Build the document metadata from the operator's settings.
 *
 * The title template is what makes every page inherit the configured name: a
 * server page exports `title: "Console"` and gets "Console · <site name>" with
 * no page-level knowledge of the branding.
 *
 * `robots` is emitted explicitly rather than left to the default. A control
 * panel is an authenticated surface, so `allowIndexing` is off by default and
 * this sends `noindex, nofollow` until an operator opts in — which keeps the
 * meta tag and `robots.txt` (see `app/robots.ts`) making the same statement.
 */
export async function buildSiteMetadata(): Promise<Metadata> {
  const { branding, seo, siteUrl } = await getSiteSettings();
  const description = seo.description || branding.tagline;

  return {
    metadataBase: safeUrl(siteUrl),
    title: {
      default: branding.siteName,
      template: `%s · ${branding.siteName}`,
    },
    description,
    applicationName: branding.siteName,
    ...(seo.keywords.length > 0 ? { keywords: seo.keywords } : {}),
    robots: seo.allowIndexing
      ? { index: true, follow: true }
      : { index: false, follow: false },
    openGraph: {
      type: "website",
      siteName: branding.siteName,
      title: branding.siteName,
      description,
      url: siteUrl,
      ...(seo.ogImageUrl ? { images: [{ url: seo.ogImageUrl }] } : {}),
    },
    twitter: {
      card: seo.ogImageUrl ? "summary_large_image" : "summary",
      title: branding.siteName,
      description,
      ...(seo.ogImageUrl ? { images: [seo.ogImageUrl] } : {}),
    },
  };
}

/**
 * `metadataBase` must be a valid absolute URL or Next.js throws while resolving
 * relative OG image paths. An operator-supplied value is validated on write, but
 * `FRONTEND_URL` is not, so parse defensively and drop it rather than break
 * every page's head.
 */
function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
