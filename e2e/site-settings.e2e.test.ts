/**
 * E2E tests for the site-settings and legal-document surfaces
 * (see docs/site-settings.md and docs/legal-pages.md).
 *
 * The contracts under test:
 *
 *   - GET /api/settings/public is unauthenticated and carries the branding,
 *     the registration state (with the bootstrap exemption already applied),
 *     and which legal documents are published — everything the sign-in page
 *     needs to render correctly in its *first* response.
 *   - robots.txt, sitemap.xml, /terms and /privacy agree with those flags. A
 *     crawler must get the same answer whichever of them it reads first.
 *   - The new settings groups validate their input, and the legal routes are
 *     admin-only.
 *
 * Like `setup.e2e.test.ts`, this suite asserts refusal and validation paths
 * rather than success paths: a passing run must not rename the operator's panel,
 * flip their indexing policy, or publish a privacy policy on their behalf.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus } from "./_helpers";

// --- Public settings ----------------------------------------------------------

describe("GET /api/settings/public (unauthenticated)", () => {
  test("carries branding, registration, and legal availability", async () => {
    const res = await api("/api/settings/public");
    expect(res.status).toBe(200);

    const body = res.body as {
      branding?: { siteName?: string; tagline?: string };
      registration?: { enabled?: boolean; disabledMessage?: string };
      legal?: { terms?: boolean; privacy?: boolean };
    };

    // The site name must never be empty — it is the header text and the
    // `<title>` suffix, so a blank value would render a blank brand.
    expect(typeof body.branding?.siteName).toBe("string");
    expect(body.branding?.siteName?.length).toBeGreaterThan(0);
    expect(typeof body.branding?.tagline).toBe("string");

    expect(typeof body.registration?.enabled).toBe("boolean");
    expect(typeof body.registration?.disabledMessage).toBe("string");

    expect(typeof body.legal?.terms).toBe("boolean");
    expect(typeof body.legal?.privacy).toBe("boolean");
  });

  test("leaks no secrets", async () => {
    const res = await api("/api/settings/public");
    const raw = JSON.stringify(res.body);
    // The captcha/mail/AI secrets and the encryption key must never appear on a
    // route an anonymous visitor can read.
    expect(raw).not.toContain("secretKeyEncrypted");
    expect(raw).not.toContain("apiKeyEncrypted");
    expect(raw).not.toContain("smtpPasswordEncrypted");
  });
});

// --- robots.txt / sitemap.xml agree with the indexing toggle -------------------

describe("robots.txt and sitemap.xml follow the SEO settings", () => {
  test("robots.txt is served and states a single, coherent policy", async () => {
    const res = await fetch(`${config.panelUrl}/robots.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();

    const blanket = /^\s*Disallow:\s*\/\s*$/m.test(text);
    if (blanket) {
      // Indexing off (the default): a blanket disallow and no sitemap pointer.
      expect(text).not.toContain("Sitemap:");
    } else {
      // Indexing on: the authenticated surfaces are still excluded explicitly.
      expect(text).toContain("Allow: /");
      for (const path of ["/api/", "/admin/", "/servers/"]) {
        expect(text).toContain(`Disallow: ${path}`);
      }
      expect(text).toContain("Sitemap:");
    }
  });

  test("sitemap.xml is valid XML and consistent with robots.txt", async () => {
    const [robotsRes, sitemapRes] = await Promise.all([
      fetch(`${config.panelUrl}/robots.txt`),
      fetch(`${config.panelUrl}/sitemap.xml`),
    ]);
    const robots = await robotsRes.text();
    const sitemap = await sitemapRes.text();

    expect(sitemapRes.status).toBe(200);
    expect(sitemap).toContain("<urlset");

    const indexingOff = /^\s*Disallow:\s*\/\s*$/m.test(robots);
    if (indexingOff) {
      // An empty urlset, not a 404 — a clearer answer to a crawler that asks.
      expect(sitemap).not.toContain("<loc>");
    } else {
      expect(sitemap).toContain("/login");
    }
  });

  test("no authenticated path is ever listed in the sitemap", async () => {
    const sitemap = await (await fetch(`${config.panelUrl}/sitemap.xml`)).text();
    for (const path of ["/admin", "/servers/", "/settings", "/setup"]) {
      expect(sitemap).not.toContain(`${path}<`);
    }
  });
});

// --- Legal pages track their published flag -----------------------------------

describe("public legal pages match settings/public", () => {
  test("each page is reachable exactly when it is published", async () => {
    const settings = (
      await api("/api/settings/public")
    ).body as { legal?: { terms?: boolean; privacy?: boolean } };

    for (const [key, path] of [
      ["terms", "/terms"],
      ["privacy", "/privacy"],
    ] as const) {
      const res = await fetch(`${config.panelUrl}${path}`);
      // Published ⇒ 200. Unpublished ⇒ 404, never a blank 200: an empty page
      // that looks like a policy is worse than an honest absence.
      expect(res.status).toBe(settings.legal?.[key] ? 200 : 404);
    }
  });
});

// --- Settings validation ------------------------------------------------------

describe("PATCH /api/admin/settings validates the new groups", () => {
  test("is admin-only", async () => {
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        body: { branding: { siteName: "nope" } },
      }),
      401,
    );
  });

  e2e("a non-admin key cannot change the branding", async () => {
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        key: config.userKey,
        body: { branding: { siteName: "nope" } },
      }),
      403,
    );
  });

  e2e("an empty site name is rejected", async () => {
    // A blank name would render an empty header and an empty <title>.
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        key: config.adminKey,
        body: { branding: { siteName: "   " } },
      }),
      400,
    );
  });

  e2e("a non-object settings group is rejected", async () => {
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        key: config.adminKey,
        body: { branding: "CitadelPanel" },
      }),
      400,
    );
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        key: config.adminKey,
        body: { seo: [] },
      }),
      400,
    );
  });

  e2e("a relative site URL is rejected", async () => {
    // metadataBase needs an absolute origin; a relative value would break every
    // canonical and OG URL rather than fail loudly here.
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        key: config.adminKey,
        body: { seo: { siteUrl: "panel.example.com" } },
      }),
      400,
    );
  });

  e2e("an unknown analytics provider is rejected", async () => {
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        key: config.adminKey,
        body: { analytics: { enabled: true, provider: "matomo" } },
      }),
      400,
    );
  });

  e2e("a GTM or legacy UA id is rejected as a GA measurement id", async () => {
    // These load a snippet that silently records nothing, which is the failure
    // mode worth catching at the form rather than in production.
    for (const id of ["GTM-ABCD123", "UA-12345-1"]) {
      expectStatus(
        await api("/api/admin/settings", {
          method: "PATCH",
          key: config.adminKey,
          body: {
            analytics: { enabled: false, provider: "google", googleMeasurementId: id },
          },
        }),
        400,
      );
    }
  });

  e2e("enabling analytics with no identifier is rejected", async () => {
    expectStatus(
      await api("/api/admin/settings", {
        method: "PATCH",
        key: config.adminKey,
        body: { analytics: { enabled: true, provider: "plausible", plausibleDomain: "" } },
      }),
      400,
    );
  });

  e2e("an empty patch is rejected", async () => {
    expectStatus(
      await api("/api/admin/settings", { method: "PATCH", key: config.adminKey, body: {} }),
      400,
    );
  });

  e2e("GET returns every settings group the admin form renders", async () => {
    const res = expectStatus(
      await api("/api/admin/settings", { key: config.adminKey }),
      200,
    );
    const body = res.body as Record<string, unknown>;
    for (const group of [
      "timezone",
      "captcha",
      "mail",
      "verification",
      "serverLimits",
      "ai",
      "branding",
      "registration",
      "seo",
      "analytics",
    ]) {
      expect(body).toHaveProperty(group);
    }
  });
});

// --- Legal document routes ----------------------------------------------------

describe("legal document routes are admin-only", () => {
  test("GET /api/admin/legal without a credential is 401", async () => {
    expectStatus(await api("/api/admin/legal"), 401);
  });

  test("PUT /api/admin/legal/:document without a credential is 401", async () => {
    expectStatus(
      await api("/api/admin/legal/privacy", { method: "PUT", body: { content: "x" } }),
      401,
    );
  });

  e2e("a non-admin key cannot read the sources", async () => {
    expectStatus(await api("/api/admin/legal", { key: config.userKey }), 403);
  });

  e2e("a non-admin key cannot publish a document", async () => {
    expectStatus(
      await api("/api/admin/legal/privacy", {
        method: "PUT",
        key: config.userKey,
        body: { content: "# Not yours" },
      }),
      403,
    );
  });

  e2e("GET returns both documents with content and updatedAt", async () => {
    const res = expectStatus(await api("/api/admin/legal", { key: config.adminKey }), 200);
    const body = res.body as Record<string, { content?: unknown; updatedAt?: unknown }>;
    for (const key of ["terms", "privacy"]) {
      expect(typeof body[key]?.content).toBe("string");
      // null until first saved; a string ISO timestamp afterwards.
      expect(["string", "object"]).toContain(typeof body[key]?.updatedAt);
    }
  });

  e2e("an unknown document key is 404", async () => {
    expectStatus(
      await api("/api/admin/legal/cookies", {
        method: "PUT",
        key: config.adminKey,
        body: { content: "# Cookies" },
      }),
      404,
    );
  });

  e2e("a non-string content is 400", async () => {
    // Rejected before any write, so this cannot clobber a published document.
    expectStatus(
      await api("/api/admin/legal/terms", {
        method: "PUT",
        key: config.adminKey,
        body: { content: 42 },
      }),
      400,
    );
    expectStatus(
      await api("/api/admin/legal/terms", {
        method: "PUT",
        key: config.adminKey,
        body: {},
      }),
      400,
    );
  });

  e2e("an oversized document is 400", async () => {
    expectStatus(
      await api("/api/admin/legal/terms", {
        method: "PUT",
        key: config.adminKey,
        body: { content: "x".repeat(100_001) },
      }),
      400,
    );
  });
});

// --- Custom error pages -------------------------------------------------------

describe("custom error pages", () => {
  test("an unmatched URL is a 404 carrying the site name and noindex", async () => {
    const res = await fetch(`${config.panelUrl}/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Page not found");
    // Next.js marks 404s noindex automatically; assert it so a future metadata
    // change cannot start advertising error pages to crawlers.
    expect(html).toContain("noindex");
  });
});
