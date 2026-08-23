"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

import { siteThemeClass, type SiteThemeBase } from "@/lib/site-theme";

/** The three themes the panel offers, in the order the switcher lists them. */
export const PANEL_THEMES = ["site", "light", "dark"] as const;
export type PanelTheme = (typeof PANEL_THEMES)[number];

/**
 * Not `"theme"`, which is next-themes' default.
 *
 * The switcher used to offer light/dark/system, so anyone who chose "system" has
 * that string in `localStorage.theme`. There is no system option any more, and
 * next-themes would happily write `class="system"` onto `<html>`, a class no
 * stylesheet defines, which renders the light palette while the switcher claims
 * otherwise. A new key retires those values instead of migrating them.
 */
const STORAGE_KEY = "panel-theme";

/**
 * Theme state for the whole panel.
 *
 * The base of the site theme is baked into the class it applies (`site-light` /
 * `site-dark`) via next-themes' `value` map, which the provider also hands to
 * its blocking inline script, so the correct palette, including the operator's
 * one, is on `<html>` before first paint rather than after hydration.
 *
 * `enableSystem` is off: the panel offers exactly three themes, and the site
 * theme is the default. See `docs/theming.md`.
 */
export function ThemeProvider({
  siteThemeBase,
  children,
}: {
  siteThemeBase: SiteThemeBase;
  children: React.ReactNode;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      themes={[...PANEL_THEMES]}
      value={{
        site: siteThemeClass(siteThemeBase),
        light: "light",
        dark: "dark",
      }}
      defaultTheme="site"
      enableSystem={false}
      storageKey={STORAGE_KEY}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
