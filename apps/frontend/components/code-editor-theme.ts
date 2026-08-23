"use client";

import type { editor } from "monaco-editor/editor";

/**
 * The Monaco theme, derived from the panel's CSS variables.
 *
 * Every other component in the panel switches theme purely in CSS: the `.dark`
 * class flips the variables and that is the end of it. Monaco cannot work that
 * way. `defineTheme` takes literal colors, which it bakes into a generated
 * stylesheet and into the classes it puts on tokens, so `var(--card)` never
 * reaches a browser that would resolve it. The editor is therefore the one
 * place that has to be re-themed from JS when the active theme changes.
 *
 * What does *not* change is where the colors come from: they are still read
 * out of `app/globals.css` (and so pick up an operator's site theme, which
 * layers its own values onto the same variables), so the codebase keeps one
 * palette rather than growing a second one for the editor.
 */

export const THEME_NAME = "citadel";

// ---------------------------------------------------------------------------
// CSS color -> hex
//
// This is harder than it looks, and getting it wrong is what made the editor
// render light in dark mode the first time round.
//
// The variables are authored as `oklch()`, but that is not what a browser hands
// back: Next's CSS transformer rewrites them to `lab()` (behind an `@supports`,
// with a hex line underneath as the fallback), and `getComputedStyle` returns
// whichever line won, a modern-colour function rather than `rgb()`. Monaco
// wants plain hex. So something has to convert, and it cannot be a hand-written
// oklch/lab→sRGB implementation: the value could be any syntax an operator's
// site theme uses, and the browser already knows all of them.
//
// The trick is to make the browser normalise into sRGB and then serialise:
// `color-mix(in srgb, X, X)` is X, computed in sRGB, which every engine
// serialises as `color(srgb …)` or `rgb()`. Canvas `fillStyle` does the same job
// in one step, but its colour parser is not the CSS one everywhere. Firefox
// accepts `lab()`, some Chrome versions do not, so it is the second attempt
// rather than the first.
// ---------------------------------------------------------------------------

// Written before every probe: an unparseable colour is a silent no-op in both
// mechanisms, so a value that comes back unchanged means "rejected".
const SENTINEL = "#010203";
const SENTINEL_RGB = "rgb(1, 2, 3)";

function hexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function toHex(r: number, g: number, b: number, a: number): string {
  const rgb = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  return a >= 1 ? rgb : `${rgb}${hexByte(a * 255)}`;
}

/** Parse the forms a browser serialises a resolved sRGB colour into. */
function parseResolved(value: string): string | null {
  const input = value.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(input)) return input.toLowerCase();

  // `rgb(1 2 3)`, `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`. Channels are 0-255.
  const legacy = /^rgba?\(([^)]+)\)$/i.exec(input);
  if (legacy) {
    const parts = legacy[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return toHex(parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1);
  }

  // `color(srgb 0.1 0.09 0.09 / 0.5)`. Channels are 0-1 and may be out of
  // gamut, which `hexByte` clamps.
  const modern = /^color\(\s*srgb\s+([^)]+)\)$/i.exec(input);
  if (modern) {
    const parts = modern[1]!.split(/[\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return toHex(parts[0]! * 255, parts[1]! * 255, parts[2]! * 255, parts[3] ?? 1);
  }
  return null;
}

let cssProbe: HTMLElement | null = null;

function cssProbeElement(): HTMLElement | null {
  if (cssProbe?.isConnected) return cssProbe;
  if (typeof document === "undefined" || !document.body) return null;
  cssProbe = document.createElement("span");
  cssProbe.setAttribute("aria-hidden", "true");
  cssProbe.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  document.body.appendChild(cssProbe);
  return cssProbe;
}

/** Let CSS resolve the colour into sRGB, whatever syntax it arrived in. */
function resolveViaCss(value: string): string | null {
  const el = cssProbeElement();
  if (!el) return null;
  el.style.color = SENTINEL;
  el.style.color = `color-mix(in srgb, ${value}, ${value})`;
  const computed = getComputedStyle(el).color;
  if (!computed || computed === SENTINEL_RGB) return null;
  return parseResolved(computed);
}

let canvasProbe: CanvasRenderingContext2D | null | undefined;

/** Fallback for engines whose `color-mix` support lags their colour parser. */
function resolveViaCanvas(value: string): string | null {
  if (canvasProbe === undefined) {
    canvasProbe = document.createElement("canvas").getContext("2d");
  }
  if (!canvasProbe) return null;
  canvasProbe.fillStyle = SENTINEL;
  try {
    canvasProbe.fillStyle = value;
  } catch {
    return null;
  }
  const out = canvasProbe.fillStyle;
  if (typeof out !== "string" || out === SENTINEL) return null;
  return parseResolved(out);
}

/**
 * Resolve any CSS colour to the `#rrggbb`/`#rrggbbaa` literal Monaco requires,
 * or `null` if this browser could not make sense of it.
 */
export function cssColorToHex(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  return resolveViaCss(input) ?? resolveViaCanvas(input) ?? parseResolved(input);
}

/** Replace a hex color's alpha channel (Monaco has no `color-mix()`). */
function alpha(hex: string, value: number): string {
  return `${hex.slice(0, 7)}${hexByte(value * 255)}`;
}

/** Perceived lightness of an opaque hex color. */
function isDark(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/**
 * Is the panel currently dark?
 *
 * Asked of the `<html>` class first, and only measured from the resolved card
 * colour if the class says nothing. The class is the one signal that cannot be
 * lost to a colour-parsing failure, so a browser this file cannot read colours
 * in still gets Monaco's own *dark* theme in dark mode rather than a white
 * editor in a black panel.
 */
function panelIsDark(card: string | null): boolean {
  const classes = document.documentElement.classList;
  if (classes.contains("dark") || classes.contains("site-dark")) return true;
  if (classes.contains("light") || classes.contains("site-light")) return false;
  return card ? isDark(card) : false;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** The variables the theme is built from, in `--kebab-case` order-insensitive form. */
const TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "primary",
  "border",
  "input",
  "ring",
  "destructive",
  "syntaxKeyword",
  "syntaxString",
  "syntaxConstant",
  "syntaxComment",
  "syntaxFunction",
  "syntaxType",
  "syntaxTag",
  "syntaxAttribute",
] as const;

type TokenName = (typeof TOKEN_NAMES)[number];

/** `syntaxKeyword` -> `--syntax-keyword`, `cardForeground` -> `--card-foreground`. */
function cssVarName(token: TokenName): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Read every token, or return `null` if the palette could not be read at all.
 *
 * All-or-nothing on purpose: half a palette is worse than none, because the
 * missing half would have to be invented and Monaco would end up with this
 * panel's dark background under stock light token colours.
 */
function readTokens(): Record<TokenName, string> | null {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<TokenName, string>;
  for (const token of TOKEN_NAMES) {
    const hex = cssColorToHex(style.getPropertyValue(cssVarName(token)));
    if (!hex) return null;
    out[token] = hex;
  }
  return out;
}

/**
 * Build the theme from the variables currently in effect.
 *
 * The color keys are VS Code's own, so the editor reads as VS Code with this
 * panel's palette rather than as a differently-shaped editor: the same widgets
 * (find, suggest, hover, sticky scroll, context menu) are all styled from the
 * tokens that style the panel's own popovers and inputs.
 */
export function buildTheme(): editor.IStandaloneThemeData {
  const c = readTokens();
  const dark = panelIsDark(c?.card ?? null);

  // Nothing readable: hand Monaco its own theme of the right polarity rather
  // than a palette we made up. Say so, because silently rendering a stock
  // theme is exactly the kind of failure that gets reported as "the editor
  // ignores my theme" with nothing to go on.
  if (!c) {
    console.warn(
      "[code-editor] could not resolve the panel's CSS colour tokens; " +
        `falling back to Monaco's stock ${dark ? "dark" : "light"} theme.`,
    );
    return { base: dark ? "vs-dark" : "vs", inherit: true, rules: [], colors: {} };
  }

  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: c.cardForeground, background: c.card },
      { token: "comment", foreground: c.syntaxComment, fontStyle: "italic" },
      { token: "keyword", foreground: c.syntaxKeyword },
      { token: "keyword.flow", foreground: c.syntaxKeyword },
      { token: "operator", foreground: c.syntaxKeyword },
      { token: "metatag", foreground: c.syntaxKeyword },
      { token: "string", foreground: c.syntaxString },
      { token: "string.escape", foreground: c.syntaxConstant },
      { token: "regexp", foreground: c.syntaxString },
      { token: "number", foreground: c.syntaxConstant },
      { token: "constant", foreground: c.syntaxConstant },
      { token: "variable.predefined", foreground: c.syntaxConstant },
      { token: "type", foreground: c.syntaxType },
      { token: "type.identifier", foreground: c.syntaxType },
      { token: "namespace", foreground: c.syntaxType },
      { token: "annotation", foreground: c.syntaxAttribute },
      { token: "function", foreground: c.syntaxFunction },
      { token: "identifier", foreground: c.cardForeground },
      { token: "delimiter", foreground: alpha(c.mutedForeground, 0.9) },
      { token: "tag", foreground: c.syntaxTag },
      { token: "attribute.name", foreground: c.syntaxAttribute },
      { token: "attribute.value", foreground: c.syntaxString },
      // JSON/YAML keys. Monaco tags JSON keys `string.key`, YAML keys `type`,
      // and INI/properties keys `attribute.name`, so all three land somewhere.
      { token: "string.key", foreground: c.syntaxTag },
      { token: "string.value", foreground: c.syntaxString },
      { token: "invalid", foreground: c.destructive },
    ],
    colors: {
      "editor.background": c.card,
      "editor.foreground": c.cardForeground,
      "editorCursor.foreground": c.foreground,
      "editor.lineHighlightBackground": alpha(c.muted, dark ? 0.5 : 0.7),
      "editor.lineHighlightBorder": "#00000000",
      "editorLineNumber.foreground": alpha(c.mutedForeground, 0.7),
      "editorLineNumber.activeForeground": c.foreground,
      "editor.selectionBackground": alpha(c.primary, 0.3),
      "editor.inactiveSelectionBackground": alpha(c.primary, 0.18),
      "editor.selectionHighlightBackground": alpha(c.primary, 0.16),
      "editor.wordHighlightBackground": alpha(c.primary, 0.14),
      "editor.wordHighlightStrongBackground": alpha(c.primary, 0.2),
      "editor.findMatchBackground": alpha(c.primary, 0.4),
      "editor.findMatchHighlightBackground": alpha(c.primary, 0.2),
      "editor.findRangeHighlightBackground": alpha(c.primary, 0.1),
      "editorBracketMatch.background": alpha(c.primary, 0.2),
      "editorBracketMatch.border": alpha(c.primary, 0.45),
      "editorIndentGuide.background1": alpha(c.mutedForeground, 0.2),
      "editorIndentGuide.activeBackground1": alpha(c.mutedForeground, 0.45),
      "editorWhitespace.foreground": alpha(c.mutedForeground, 0.35),
      "editorRuler.foreground": alpha(c.mutedForeground, 0.2),
      "editorGutter.background": c.card,
      "editorOverviewRuler.border": "#00000000",
      "editorOverviewRuler.findMatchForeground": alpha(c.primary, 0.6),
      "editorError.foreground": c.destructive,
      "editorWarning.foreground": c.syntaxConstant,
      "editorStickyScroll.background": c.card,
      "editorStickyScrollHover.background": c.accent,
      "editorLink.activeForeground": c.syntaxFunction,
      // Widgets: find, suggest, hover, the parameter hints. These use the
      // panel's own popover/input tokens so they match every other surface.
      "editorWidget.background": c.popover,
      "editorWidget.foreground": c.popoverForeground,
      "editorWidget.border": c.border,
      "editorHoverWidget.background": c.popover,
      "editorHoverWidget.border": c.border,
      "editorSuggestWidget.background": c.popover,
      "editorSuggestWidget.foreground": c.popoverForeground,
      "editorSuggestWidget.border": c.border,
      "editorSuggestWidget.selectedBackground": c.accent,
      "editorSuggestWidget.highlightForeground": c.primary,
      "input.background": c.background,
      "input.foreground": c.foreground,
      "input.border": c.input,
      "inputOption.activeBorder": c.primary,
      "inputOption.activeBackground": alpha(c.primary, 0.2),
      "inputOption.activeForeground": c.foreground,
      "focusBorder": c.ring,
      "button.background": c.primary,
      "button.foreground": "#ffffff",
      "button.secondaryBackground": c.muted,
      "button.secondaryForeground": c.foreground,
      "badge.background": c.muted,
      "badge.foreground": c.mutedForeground,
      "list.hoverBackground": c.accent,
      "list.activeSelectionBackground": c.accent,
      "list.activeSelectionForeground": c.accentForeground,
      "list.highlightForeground": c.primary,
      "menu.background": c.popover,
      "menu.foreground": c.popoverForeground,
      "menu.border": c.border,
      "menu.selectionBackground": c.accent,
      "menu.selectionForeground": c.accentForeground,
      "menu.separatorBackground": c.border,
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": alpha(c.mutedForeground, 0.2),
      "scrollbarSlider.hoverBackground": alpha(c.mutedForeground, 0.3),
      "scrollbarSlider.activeBackground": alpha(c.mutedForeground, 0.4),
      "minimap.background": c.card,
      "minimapSlider.background": alpha(c.mutedForeground, 0.15),
      "minimapSlider.hoverBackground": alpha(c.mutedForeground, 0.25),
      "minimapSlider.activeBackground": alpha(c.mutedForeground, 0.35),
      "widget.shadow": alpha("#000000", dark ? 0.5 : 0.1),
      // Bracket pair colorization, from the syntax tokens so nesting depth
      // reads as the same family of colors as the code itself.
      "editorBracketHighlight.foreground1": c.syntaxConstant,
      "editorBracketHighlight.foreground2": c.syntaxFunction,
      "editorBracketHighlight.foreground3": c.syntaxType,
      "editorBracketHighlight.foreground4": c.syntaxTag,
      "editorBracketHighlight.foreground5": c.syntaxString,
      "editorBracketHighlight.foreground6": c.syntaxAttribute,
      "editorBracketHighlight.unexpectedBracket.foreground": c.destructive,
    },
  };
}

/**
 * Watch for theme switches and re-run `apply`.
 *
 * The three-theme switcher (see `docs/theming.md`) works by rewriting the
 * `<html>` class, so that is the single signal: `light`/`dark`/`site-*` all
 * arrive as a class change on the document element.
 */
export function observeTheme(apply: () => void): () => void {
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  return () => observer.disconnect();
}
