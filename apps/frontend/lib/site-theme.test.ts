/**
 * Tests for the site theme's normaliser and CSS builder.
 *
 * `buildSiteThemeCss` does no escaping. It is allowed not to, because
 * `normalizeSiteTheme` guarantees every value it sees was produced by
 * `formatOklch`. These tests are what that guarantee rests on, so they cover
 * the stored-row cases (unknown keys, wrong types, a value that was never
 * validated) rather than only the shapes the admin form can produce.
 */

import { describe, expect, test } from "bun:test";

import {
  buildSiteThemeCss,
  DEFAULT_SITE_THEME,
  isSiteThemeToken,
  MAX_SITE_RADIUS,
  normalizeSiteTheme,
  siteThemeClass,
  SITE_THEME_TOKENS,
} from "./site-theme";

describe("normalizeSiteTheme", () => {
  test("an empty or absent row is the default theme", () => {
    expect(normalizeSiteTheme(undefined)).toEqual(DEFAULT_SITE_THEME);
    expect(normalizeSiteTheme({})).toEqual(DEFAULT_SITE_THEME);
    expect(normalizeSiteTheme(null)).toEqual(DEFAULT_SITE_THEME);
  });

  test("only light and dark are bases; anything else falls back", () => {
    expect(normalizeSiteTheme({ base: "light" }).base).toBe("light");
    expect(normalizeSiteTheme({ base: "dark" }).base).toBe("dark");
    expect(normalizeSiteTheme({ base: "system" as never }).base).toBe(
      DEFAULT_SITE_THEME.base,
    );
  });

  test("colours are re-emitted in canonical form, not echoed", () => {
    const theme = normalizeSiteTheme({ colors: { primary: "#7c3aed" } });
    expect(theme.colors.primary).toMatch(/^oklch\([\d. ]+\)$/);
  });

  test("unknown tokens and unparseable values are dropped", () => {
    const theme = normalizeSiteTheme({
      colors: {
        primary: "oklch(0.5 0.1 30)",
        "not-a-token": "#fff",
        background: "chartreuse",
        border: 42 as never,
      },
    });
    expect(Object.keys(theme.colors)).toEqual(["primary"]);
  });

  test("radius is clamped, and anything non-numeric means inherit", () => {
    expect(normalizeSiteTheme({ radius: 0.5 }).radius).toBe(0.5);
    expect(normalizeSiteTheme({ radius: 99 }).radius).toBe(MAX_SITE_RADIUS);
    expect(normalizeSiteTheme({ radius: -1 }).radius).toBe(0);
    expect(normalizeSiteTheme({ radius: "0.5" as never }).radius).toBeNull();
    expect(normalizeSiteTheme({ radius: Number.NaN }).radius).toBeNull();
  });

  test("normalising twice changes nothing", () => {
    const once = normalizeSiteTheme({
      base: "light",
      colors: { primary: "#7c3aed", ring: "oklch(0.7 0.01 56 / 40%)" },
      radius: 1,
    });
    expect(normalizeSiteTheme(once)).toEqual(once);
  });
});

describe("buildSiteThemeCss", () => {
  test("a theme with no overrides emits nothing at all", () => {
    // The root layout skips the <style> element entirely in this case.
    expect(buildSiteThemeCss(DEFAULT_SITE_THEME)).toBe("");
    expect(buildSiteThemeCss({ base: "light", colors: {}, radius: null })).toBe("");
  });

  test("declarations target both site classes at html specificity", () => {
    const css = buildSiteThemeCss(
      normalizeSiteTheme({ colors: { primary: "oklch(0.5 0.1 30)" } }),
    );
    expect(css).toBe(
      "html.site-light,html.site-dark{--primary:oklch(0.5 0.1 30)}",
    );
  });

  test("radius rides along in rem", () => {
    const css = buildSiteThemeCss(normalizeSiteTheme({ radius: 1.25 }));
    expect(css).toContain("--radius:1.25rem");
  });

  test("the selector can be scoped, which is how the admin preview works", () => {
    const css = buildSiteThemeCss(
      normalizeSiteTheme({ colors: { background: "#000" } }),
      "#site-theme-preview",
    );
    expect(css.startsWith("#site-theme-preview{")).toBe(true);
  });

  test("a normalised theme cannot break out of its rule", () => {
    // The stored row is hostile here: none of it survives normalisation, so the
    // builder has nothing to escape.
    const css = buildSiteThemeCss(
      normalizeSiteTheme({
        colors: {
          primary: "red;} html {display:none} .x{color:red",
          background: "</style><script>alert(1)</script>",
        },
      }),
    );
    expect(css).toBe("");
  });

  test("emits tokens in the declared order, not object order", () => {
    const css = buildSiteThemeCss(
      normalizeSiteTheme({
        colors: { ring: "#000", background: "#fff" },
      }),
    );
    expect(css.indexOf("--background")).toBeLessThan(css.indexOf("--ring"));
  });
});

describe("token list", () => {
  test("keys are unique and recognised", () => {
    const keys = SITE_THEME_TOKENS.map((token) => token.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(isSiteThemeToken(key)).toBe(true);
    expect(isSiteThemeToken("chart-1")).toBe(false);
  });
});

describe("siteThemeClass", () => {
  test("bakes the base into the class, which is what `dark:` matches", () => {
    expect(siteThemeClass("dark")).toBe("site-dark");
    expect(siteThemeClass("light")).toBe("site-light");
  });
});
