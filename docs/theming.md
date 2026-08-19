# Theming: three themes, one of them the operator's

The panel offers exactly three themes, in this order:

| Theme | `<html>` class | Where the colours come from |
|---|---|---|
| The site theme | `site-light` or `site-dark` | The operator, via `/admin/settings` |
| Light | `light` | `:root` in `app/globals.css` |
| Dark | `dark` | `.dark` in `app/globals.css` |

The site theme is the default — a visitor who has never touched the switcher
gets the operator's palette, which is the only arrangement in which configuring
it means anything.

## There is no "system" option any more

The switcher used to be light/dark/system. Adding a fourth entry would have made
the menu a two-axis question ("which palette?" and "or should I follow the OS?")
for a surface that has one obvious answer, so `system` was dropped rather than
kept alongside.

That leaves the stored preference of everyone who had picked it. next-themes
would take `"system"` out of `localStorage`, find no mapping for it, and write
`class="system"` onto `<html>` — a class no stylesheet defines, which renders
the light palette while the menu claims otherwise. So the storage key changed
from next-themes' default `theme` to **`panel-theme`**
(`components/theme-provider.tsx`). Old values are not migrated; they are
abandoned, and everyone lands on the site theme once.

## The base is in the class name, and that is load-bearing

The site theme is stored as a **base plus overrides**, not a complete palette:

```jsonc
{ "base": "dark", "colors": { "primary": "oklch(0.54 0.25 293)" }, "radius": null }
```

The base picks which of the two shipped palettes fills in everything the
operator did not set. Storing it sparsely is what makes the theme survive a
redesign — an operator who only ever set `--primary` keeps following the shipped
values for the other sixteen tokens, so a later tweak to the muted surface
reaches their panel too.

The base is then baked into the class next-themes applies, via its `value` map:

```tsx
value={{ site: siteThemeClass(base), light: "light", dark: "dark" }}
```

**This is why the base cannot live in a separate attribute.** Half the component
library reaches for Tailwind `dark:` utilities, and that variant is a compiled
selector — it cannot learn at runtime that a `site` class happens to be dark. So
`globals.css` widens the variant instead:

```css
@custom-variant dark (&:is(.dark *, .site-dark *));
```

and `.site-dark` is added to the selector list that carries the dark palette. A
dark-based site theme therefore behaves *exactly* like dark mode for every
component, with the operator's overrides layered on top. Without this, a
dark-based site theme would render light-on-light wherever a component uses a
`dark:` utility.

`.site-light` and `.site-dark` also set `color-scheme` explicitly, because
next-themes only sets it for themes it can see are light or dark, and "site" is
neither by name. Without it the native scrollbars and form controls stay light
under a dark site theme.

## The overrides are server-rendered, not fetched

`app/layout.tsx` reads the theme through `lib/server/site-settings.ts` and emits
`buildSiteThemeCss()` into a `<style>` element. It has to be in the same
response as the class next-themes puts on `<html>`, or the first paint shows the
base palette and then swaps.

The rule is emitted at `html.site-light, html.site-dark` specificity. `:root` and
`.dark` are both `(0,1,0)`; the extra element selector makes the override
`(0,1,1)` and therefore win *regardless of where React's style hoisting lands it
relative to the app stylesheet*. That is cheaper than `!important` and cheaper
than reasoning about hoist order.

When the operator has set nothing, `buildSiteThemeCss` returns `""` and the
layout emits no element at all.

`app/global-error.tsx` is the one exception. It replaces the root layout, so by
the time it renders, everything that could read the settings has already failed;
it falls back to the default base and ships none of the overrides, for the same
reason it hardcodes the site name.

## Colours are numbers by the time they are CSS

This is the one setting whose value reaches the browser as **CSS** rather than
as text content, so the write path is a parser rather than an escaper:

1. `parseColor` (`lib/color.ts`) accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
   and `oklch(L C H[ / A])`. Everything else — named colours, `rgb()`,
   `color-mix()`, `var()`, `none` — is rejected. It returns four numbers or
   null.
2. `formatOklch` writes the stored string. Nothing the operator typed survives
   into it.
3. `normalizeSiteTheme` (`lib/site-theme.ts`) runs this over the whole object on
   **read as well as write**, because a row written by an older version of the
   panel, or by hand, has never been through the validator.

So `buildSiteThemeCss` does no escaping, and is allowed not to: after
normalisation there is nothing left to escape. The API rejects a bad colour with
a 400 naming the token rather than letting the normaliser drop it silently —
that distinction is right for a stored row but would discard half of an admin's
form submission without telling them.

Storing `oklch` rather than hex is not cosmetic. Every token in `globals.css` is
an OKLCh triple; a hex `--primary` sitting next to an OKLCh `--primary-foreground`
makes contrast tuning guesswork. `lib/color.ts` carries the sRGB ↔ OKLab matrices
so the native `<input type="color">`, which only speaks hex, can still drive an
OKLCh token.

## Which tokens are editable

A curated subset of `globals.css`, listed in `SITE_THEME_TOKENS` with the group
labels the form renders: background/foreground, the accent ramp, the surfaces,
and the border/input/ring details. Plus `--radius`, in `rem`.

Omitted on purpose:

- **`--chart-*` and `--sidebar-*`** — nothing in the panel consumes them yet, so
  exposing them would be seventeen more fields that change nothing.
- **`--syntax-*`** (the file editor's highlighting, see `docs/file-editor.md`) —
  legibility rather than branding. It follows the base palette.

## The admin form

`components/admin/theme-card.tsx`, rendered by `general-settings.tsx` next to
the site identity card. Two things about it are worth knowing:

**Blank means inherit, and the placeholder proves it.** The inherited value is
*measured* — `getComputedStyle` on an off-screen probe element carrying the base
class — rather than kept as a second copy of the palette that could drift from
`globals.css`.

That measurement needs one detour. Lightning CSS downlevels `oklch()` to `lab()`
at build time for older browser targets, so the computed tokens come back in a
syntax `parseColor` deliberately refuses. Rather than teach the parser every
colour space a build step might emit, `resolveCssColor` hands the string to a
canvas 2D context and reads back the painted pixel. It reads *pixels* rather
than `fillStyle`, because the getter round-trips a wide-gamut colour in its own
space — ask it about a `lab()` and it says `lab()` again. This path is display
only; a stored colour still goes through `parseColor`.

**The preview uses the production builder.** `buildSiteThemeCss` takes a
selector argument, so the card renders the same declarations scoped to
`#site-theme-preview`. There is no second preview implementation that could
disagree with what the panel will actually render.

Saving reloads the page, like the branding card and for the same reason: the
palette is in server-rendered HTML, so a client-side state update would only
refresh the form.

## Related

- `docs/site-settings.md` — the branding, registration, SEO, and analytics
  groups this sits alongside, and why the site name is a setting.
- `docs/file-editor.md` — the CodeMirror theme, which reads the same CSS
  variables and is why `--syntax-*` exists.
