/**
 * The site theme: the operator's own palette, offered alongside light and dark.
 *
 * The panel has three themes and no "system" option (see `docs/theming.md`).
 * Light and dark are the shadcn `stone` palettes in `app/globals.css` and are
 * fixed. The site theme is the third: it picks one of those two as its base and
 * overrides whichever design tokens the operator has set, so a brand only has
 * to specify the colours it actually cares about.
 *
 * Everything here is pure and shared by both sides:
 *
 *   - the settings service normalises through `normalizeSiteTheme` on read and
 *     on write, so a hand-edited `panel_settings` row cannot smuggle anything
 *     into the stylesheet either;
 *   - the root layout emits `buildSiteThemeCss` into a `<style>` element, which
 *     is why the theme is correct in the first HTML response rather than after
 *     a fetch;
 *   - the admin form uses the same builder for its live preview, so what the
 *     preview shows is what the panel will render.
 *
 * The class names are the contract with `globals.css`: `.site-light` and
 * `.site-dark` carry the base palette *and* are matched by the `dark:` variant,
 * which is the whole reason the base is baked into the class rather than kept
 * in a separate attribute. A dark-based site theme has to make `dark:` utilities
 * apply or half the components render light-on-light.
 */

import { formatOklch, parseColor } from "@/lib/color";

/** Which built-in palette the site theme starts from. */
export type SiteThemeBase = "light" | "dark";

export const SITE_THEME_BASES = ["light", "dark"] as const;

export interface SiteThemeToken {
  /** The CSS custom property, without the leading `--`. */
  key: string;
  label: string;
  /** What the token actually paints, for the admin form. */
  hint: string;
  group: string;
}

/**
 * The tokens an operator may override.
 *
 * A curated subset of `globals.css`, not all of it. The `--chart-*` and
 * `--sidebar-*` blocks are omitted because nothing in the panel consumes them
 * yet, and `--syntax-*` because the editor's highlighting is a legibility
 * concern rather than a branding one — it follows the base palette.
 */
export const SITE_THEME_TOKENS: readonly SiteThemeToken[] = [
  {
    key: "background",
    label: "Background",
    hint: "The page behind everything.",
    group: "Base",
  },
  {
    key: "foreground",
    label: "Foreground",
    hint: "Default body text.",
    group: "Base",
  },
  {
    key: "primary",
    label: "Primary",
    hint: "Main buttons and active state.",
    group: "Accent",
  },
  {
    key: "primary-foreground",
    label: "On primary",
    hint: "Text on a primary surface.",
    group: "Accent",
  },
  {
    key: "secondary",
    label: "Secondary",
    hint: "Secondary buttons and badges.",
    group: "Accent",
  },
  {
    key: "secondary-foreground",
    label: "On secondary",
    hint: "Text on a secondary surface.",
    group: "Accent",
  },
  {
    key: "accent",
    label: "Accent",
    hint: "Hover and highlight fills.",
    group: "Accent",
  },
  {
    key: "accent-foreground",
    label: "On accent",
    hint: "Text on an accent fill.",
    group: "Accent",
  },
  {
    key: "destructive",
    label: "Destructive",
    hint: "Delete buttons and errors.",
    group: "Accent",
  },
  { key: "card", label: "Card", hint: "Panels and cards.", group: "Surface" },
  {
    key: "card-foreground",
    label: "On card",
    hint: "Text inside a card.",
    group: "Surface",
  },
  {
    key: "popover",
    label: "Popover",
    hint: "Menus, dialogs, tooltips.",
    group: "Surface",
  },
  {
    key: "popover-foreground",
    label: "On popover",
    hint: "Text inside a menu.",
    group: "Surface",
  },
  {
    key: "muted",
    label: "Muted",
    hint: "Subdued fills and table headers.",
    group: "Surface",
  },
  {
    key: "muted-foreground",
    label: "Muted text",
    hint: "Captions and help text.",
    group: "Surface",
  },
  { key: "border", label: "Border", hint: "Every hairline rule.", group: "Detail" },
  { key: "input", label: "Input", hint: "Form field borders.", group: "Detail" },
  { key: "ring", label: "Focus ring", hint: "Keyboard focus outline.", group: "Detail" },
] as const;

/** Group order for the admin form; derived so the two can never disagree. */
export const SITE_THEME_GROUPS: readonly string[] = [
  ...new Set(SITE_THEME_TOKENS.map((token) => token.group)),
];

const TOKEN_KEYS = new Set(SITE_THEME_TOKENS.map((token) => token.key));

/** Is this an overridable token? The API rejects colours for anything else. */
export function isSiteThemeToken(key: string): boolean {
  return TOKEN_KEYS.has(key);
}

export interface SiteThemeSettings {
  base: SiteThemeBase;
  /**
   * Token key → canonical `oklch(…)` string. Only overridden tokens appear;
   * everything absent falls through to the base palette, which is what lets an
   * operator change one colour without pinning the other sixteen.
   */
  colors: Record<string, string>;
  /** Corner radius in `rem`, or null to keep the base 0.625. */
  radius: number | null;
}

/**
 * Dark by default. This is a control panel that people keep open next to a
 * terminal, and with no overrides set the site theme should still look like a
 * finished thing rather than an unstyled one.
 */
export const DEFAULT_SITE_THEME: SiteThemeSettings = {
  base: "dark",
  colors: {},
  radius: null,
};

export const MIN_SITE_RADIUS = 0;
export const MAX_SITE_RADIUS = 2;

/** The `<html>` class for a site theme with the given base. */
export function siteThemeClass(base: SiteThemeBase): string {
  return base === "dark" ? "site-dark" : "site-light";
}

/**
 * Coerce anything into a valid `SiteThemeSettings`.
 *
 * Unknown token keys are dropped and every colour is re-parsed and re-formatted
 * rather than trusted, so the returned object only ever contains strings this
 * module produced. `buildSiteThemeCss` depends on that: it does no escaping,
 * because after normalisation there is nothing left to escape.
 */
export function normalizeSiteTheme(raw: unknown): SiteThemeSettings {
  const input = (raw ?? {}) as Partial<SiteThemeSettings>;
  const colors: Record<string, string> = {};

  if (input.colors && typeof input.colors === "object") {
    for (const [key, value] of Object.entries(input.colors)) {
      if (!TOKEN_KEYS.has(key) || typeof value !== "string") continue;
      const parsed = parseColor(value);
      if (parsed) colors[key] = formatOklch(parsed);
    }
  }

  const radius =
    typeof input.radius === "number" && Number.isFinite(input.radius)
      ? Math.min(Math.max(input.radius, MIN_SITE_RADIUS), MAX_SITE_RADIUS)
      : null;

  return {
    base: input.base === "light" ? "light" : "dark",
    colors,
    radius,
  };
}

/**
 * The stylesheet body for the site theme, or `""` when it is pure base palette.
 *
 * `html.site-*` rather than `.site-*` on purpose: the declaration has to beat
 * both `:root` and `.dark` from `globals.css` regardless of which stylesheet
 * the browser applies first, and the extra element selector buys that without
 * `!important` or a guess about React's style hoisting order.
 */
export function buildSiteThemeCss(
  theme: SiteThemeSettings,
  selector = "html.site-light,html.site-dark",
): string {
  const declarations = SITE_THEME_TOKENS.filter(
    (token) => theme.colors[token.key],
  ).map((token) => `--${token.key}:${theme.colors[token.key]}`);

  if (theme.radius !== null) declarations.push(`--radius:${theme.radius}rem`);
  if (declarations.length === 0) return "";

  return `${selector}{${declarations.join(";")}}`;
}
