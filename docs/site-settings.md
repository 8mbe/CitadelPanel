# Site settings: branding, registration, SEO, and analytics

Four runtime-configurable groups that shape how the panel presents itself to the
outside world. All four live in `panel_settings` alongside captcha, mail, and AI
(`services/settings.ts`), read through the same 10-second in-process cache, and
take effect without a restart.

The admin surface is `components/admin/general-settings.tsx`
(`/admin/settings`), one card per group, each saving independently.

## Branding: the site name is not a constant

`branding` holds two strings: `siteName` and `tagline`. `siteName` defaults to
"CitadelPanel" and everything user-facing reads it from here:

- the panel header (`components/panel-shell.tsx`)
- the sign-in page heading (`app/login/login-form.tsx`)
- every `<title>`, via the metadata template `"%s · <siteName>"`
- outbound email subjects and bodies (`auth/betterAuth.ts`, the test email in
  `routes/setup.ts`)

**The header carries no product glyph.** It used to show a `Castle` icon in a
primary-coloured square. Once the name is the operator's, a fixed icon beside it
reads as someone else's logo on a panel they have branded as their own, so the
brand is text only. The same reasoning removed it from the sign-in page.

Two places deliberately keep the hardcoded name:

- **The 2FA issuer** (`twoFactor({ issuer: "CitadelPanel" })`). It is baked into
  every enrolled authenticator's QR code. Changing it would not rename existing
  entries. It would only make new enrolments inconsistent with old ones, for no
  benefit.
- **`app/global-error.tsx`**, which renders when the root layout itself failed.
  Everything that could resolve the name is what has already failed.

### How server components get the branding

`lib/server/site-settings.ts` is the single read path. It exists rather than
calling the settings service directly because of two properties the root layout
needs:

- **It cannot throw.** The root layout wraps every route, including the setup
  wizard on an install whose database is not reachable yet. Each read falls back
  to the built-in default, so a settings failure never replaces a useful error
  page with an unhandled one.
- **It is request-deduplicated** with React's `cache`, so `generateMetadata` and
  the layout body share one read.

Client components read the name from `useBranding()`
(`components/branding-provider.tsx`), fed by the root layout. That is a context
rather than a `/api/settings/public` fetch on purpose: the name is then in the
first HTML response, so there is never a frame showing the wrong brand.

Saving the branding card reloads the page, because the name is baked into
server-rendered HTML and the document title. A client-side state update would
only refresh the form.

## Registration: invite-only means the endpoint refuses

`registration` holds `enabled` and `disabledMessage`.

The gate is `registrationGateHook` in `auth/betterAuth.ts`, composed into the
single Better Auth `before` middleware alongside the captcha, verification, and
ban hooks. It rejects `/sign-up/email` with a 403 and the operator's own
message. Hiding the "Create account" tab on the sign-in page is cosmetic; the
hook is what makes the setting mean anything against curl, a cached page, or a
script.

**The bootstrap window is exempt.** `isRegistrationOpen()` returns true whenever
no admin exists, so:

- a fresh install can always claim its first admin account, and
- an operator who disables registration and later wipes the user table is not
  locked out of their own panel.

The setup wizard's `auth.api.signUpEmail` call passes through the same hook and
relies on the same exemption, so there is no second code path to keep in sync.
`GET /api/settings/public` reports `registration.enabled` with the exemption
already applied, which is what the sign-in page renders from.

With registration closed, accounts arrive through the admin instead: see
`docs/user-invites.md` for the "Add user" flow, which is a separate
admin-gated endpoint rather than an exemption inside this gate.

## SEO: indexing is off by default

`seo` holds `allowIndexing`, `siteUrl`, `description`, `keywords`, and
`ogImageUrl`.

`allowIndexing` defaults to **false**, which is the opposite of most SEO
settings. A game-server control panel is an authenticated surface with no public
content worth ranking, and its indexed URLs advertise that a given host runs
one. An operator who wants the sign-in page listed, say a public hosting brand,
opts in.

The toggle drives two things that must never disagree:

| | `allowIndexing: false` | `allowIndexing: true` |
|---|---|---|
| `robots.txt` (`app/robots.ts`) | `Disallow: /` | `Allow: /` plus explicit `Disallow` for `/api/`, `/admin/`, `/servers/`, `/settings`, `/setup`, `/2fa`, and a `Sitemap:` line |
| per-page meta | `noindex, nofollow` | `index, follow` |
| `sitemap.xml` (`app/sitemap.ts`) | empty `<urlset>` | `/login` plus each published legal document |

Both routes are generated rather than static files, because the toggle and the
canonical URL live in the database. The authenticated paths are disallowed
explicitly even though they already require a session. A crawler would only
ever see a redirect, but stating it keeps them out of crawl budget and out of the
"crawled but not indexed" reports operators worry about.

`siteUrl` is the panel's public origin. It becomes `metadataBase`, which is what
turns a relative `ogImageUrl` into the absolute URL crawlers require, and it
prefixes the sitemap entries. It is validated as an absolute http(s) URL on
write and stored without a trailing slash; blank falls back to `FRONTEND_URL`.

`description` falls back to the branding tagline, so the meta description is
never empty.

An empty sitemap rather than a missing one is deliberate: it is a clearer answer
to a crawler that requests it than a 404, and it agrees with `Disallow: /`.

## Analytics: Plausible or Google Analytics 4

`analytics` holds `enabled`, `provider`, and the per-provider fields.
`components/analytics.tsx` emits the snippet from the root layout.

Two providers, both pure script tags:

- **Plausible**: `plausibleDomain` becomes the script's `data-domain`.
  `plausibleScriptUrl` points at a self-hosted instance; blank uses
  `plausible.io`. Cookieless.
- **Google Analytics 4**: `googleMeasurementId`, validated against
  `/^G-[A-Z0-9]{4,}$/`. That check exists to catch the common paste of a `GTM-`
  container id or a legacy `UA-` id, either of which would load a snippet that
  silently records nothing. The validation also means the id cannot carry a
  quote into the inline `gtag` snippet.

**There is nothing here to encrypt.** Unlike captcha, mail, and AI, a
measurement id and a site domain are public by construction. They are visible
in the page source of every site that uses them. So the admin view carries the
real values rather than a "is one stored?" boolean, and there is no write-only
field.

When `enabled` is false the component renders `null`: a private panel makes zero
third-party requests, rather than loading a script that reports nothing. The
snippet uses the default `afterInteractive` strategy. Analytics are never
required for the page to work, and blocking first paint on a third-party host
for a pageview beacon is the wrong trade in a control panel.

`isAnalyticsUsable()` gates on the provider's identifier being present, so a
provider chosen but left unconfigured is not treated as "analytics is on". That
would inject a script tag that 404s on every page load.

### Consent is the operator's problem, and the panel says so

The panel ships **no consent banner**. Plausible sets no cookies and collects no
personal data, so in most jurisdictions it needs none. Google Analytics does set
cookies and does share data with Google, and in many jurisdictions that requires
consent *before* the script loads, which this implementation does not gate on.
The GA field's help text says so and links to `/admin/legal`, and the privacy
policy draft has a section for it. An operator enabling GA in a consent
jurisdiction needs to solve that themselves.

## Error pages

Not a setting, but the same surface. All four are built on the existing `Empty`
primitive via `components/error-page.tsx`. An error page is an empty state with
a status code.

- `app/not-found.tsx`: unmatched URLs and `notFound()` above the panel.
- `app/error.tsx`: the root 500.
- `app/(panel)/not-found.tsx`, `app/(panel)/error.tsx`: the same two states
  *inside* the panel shell, so the user keeps their session and navigation
  instead of being dropped onto a bare full-screen error. The in-panel 404
  wording does not distinguish "does not exist" from "not yours": for a server
  the caller has no access to, those must be indistinguishable or the 404
  becomes an existence oracle.
- `app/global-error.tsx`: the root layout itself failed. Supplies its own
  `<html>`, `<body>`, and stylesheet, and cannot export `metadata` (error
  boundaries are Client Components), so it uses React's `<title>`.

The boundaries call `unstable_retry()` rather than `reset()`. Next 16 renamed
this, and retry is the right one here: the usual cause is a failed data read, and
retry re-fetches before re-rendering where `reset` would re-render the same
stale failure.

403 is **not** a route. The panel denies access in place: `SectionDenied` in the
server layout for a section a subuser lacks, and a JSON 403 from the API. That
keeps the user's context. Next's `forbidden.js`/`unauthorized.js` conventions
would need the experimental `authInterrupts` flag, which is not worth enabling
for a case already handled.

## Related

- `docs/theming.md`: the site theme, the fourth thing on this admin page. The
  operator's own palette, offered next to light and dark.
- `docs/legal-pages.md`: the terms and privacy documents these settings link to.
- `docs/first-time-setup.md`: the wizard that writes the first settings.
- `docs/api-keys.md`: the other consumer of `GET /api/settings/public`.
