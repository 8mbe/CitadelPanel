import type { MetadataRoute } from "next";

import { getLegalSettings } from "@/lib/server/control-plane/services/settings";
import { getSiteSettings } from "@/lib/server/site-settings";

/**
 * `sitemap.xml`, listing only the pages a crawler can actually read.
 *
 * That is a short list by design: the sign-in page and whichever legal documents
 * the operator has published. Every other route requires a session, so listing
 * it would advertise URLs that answer with a redirect.
 *
 * When indexing is off the sitemap is empty rather than absent — an empty
 * document is a clearer answer to a crawler that requests it than a 404, and it
 * agrees with the `Disallow: /` in `robots.txt`.
 *
 * `lastModified` on the legal entries is the real save timestamp from
 * `panel_settings`, so a re-published policy actually reads as changed.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { seo, siteUrl } = await getSiteSettings();
  if (!seo.allowIndexing) return [];

  const legal = await getLegalSettings().catch(() => null);

  const entries: MetadataRoute.Sitemap = [
    {
      url: `${siteUrl}/login`,
      changeFrequency: "yearly",
      priority: 1,
    },
  ];

  for (const [key, path] of [
    ["terms", "/terms"],
    ["privacy", "/privacy"],
  ] as const) {
    const document = legal?.[key];
    if (!document?.content) continue;
    entries.push({
      url: `${siteUrl}${path}`,
      ...(document.updatedAt
        ? { lastModified: new Date(document.updatedAt) }
        : {}),
      changeFrequency: "yearly",
      priority: 0.5,
    });
  }

  return entries;
}
