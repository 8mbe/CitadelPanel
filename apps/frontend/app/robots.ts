import type { MetadataRoute } from "next";

import { getSiteSettings } from "@/lib/server/site-settings";

/**
 * `robots.txt`, generated from the operator's SEO settings.
 *
 * Two states, and the default is the restrictive one:
 *
 *   - **Indexing off (default)**: `Disallow: /`. A game-server control panel is
 *     an authenticated surface with nothing to rank, and its indexed URLs would
 *     advertise that a given host runs one. This matches the `noindex` meta tag
 *     the root layout emits, so a crawler gets the same answer whichever it
 *     reads first.
 *   - **Indexing on**: the sign-in page and the operator's legal documents are
 *     crawlable; everything an authenticated user reaches is not. `/api/`,
 *     `/admin/`, `/servers/`, `/settings`, `/setup`, and `/2fa` are disallowed
 *     explicitly. They already require a session, so a crawler would only ever
 *     see a redirect, but stating it keeps those paths out of crawl budget and
 *     out of the "pages crawled but not indexed" reports operators worry about.
 *
 * Dynamic rather than a static `app/robots.txt` because the toggle and the
 * sitemap URL both live in the database; a static file could not follow them.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const { seo, siteUrl } = await getSiteSettings();

  if (!seo.allowIndexing) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/admin/",
        "/servers/",
        "/settings",
        "/setup",
        "/2fa",
      ],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
