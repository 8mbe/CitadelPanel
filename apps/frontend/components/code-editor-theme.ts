"use client";

import type { editor } from "monaco-editor/editor";

/**
 * The Monaco theme, derived from the panel's CSS variables.
 *
 * Every other component in the panel switches theme purely in CSS: the `.dark`
 * class flips the variables and that is the end of it. Monaco cannot work that
 * way — `defineTheme` takes literal colors, which it bakes into a generated
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
// ---------------------------------------------------------------------------

// Sentinel written before every probe: assigning an unparseable color to
// `fillStyle` is a silent no-op, so a value that comes back unchanged tells us
// the browser rejected it.
const SENTINEL = "#010203";

let probe: CanvasRenderingContext2D | null | undefined;

function probeContext(): CanvasRenderingContext2D | null {
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d");
  return probe;
}

function hexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/**
 * Resolve any CSS color to the `#rrggbb`/`#rrggbbaa` literal Monaco requires.
 *
 * The tokens are `oklch()` and an operator's overrides can be any syntax the
 * browser accepts, so rather than shipping an oklch→sRGB implementation this
 * hands the string to a canvas: `fillStyle` parses with the full CSS color
 * grammar and always reads back as hex or `rgb()`/`rgba()`.
 */
export function cssColorToHex(value: string, fallback: string): string {
  const ctx = probeContext();
  const input = value.trim();
  if (!ctx || !input) return fallback;

  ctx.fillStyle = SENTINEL;
  try {
    ctx.fillStyle = input;
  } catch {
    return fallback;
  }
  const out = ctx.fillStyle;
  if (typeof out !== "string") return fallback;
  if (out === SENTINEL && input.toLowerCase() !== SENTINEL) return fallback;
  if (out.startsWith("#")) return out;

  const match = /^rgba?\(([^)]+)\)$/.exec(out);
  if (!match) return fallback;
  const parts = match[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return fallback;
  const alpha = parts.length > 3 ? parts[3]! : 1;
  const rgb = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  return alpha >= 1 ? rgb : `${rgb}${hexByte(alpha * 255)}`;
}

/** Replace a hex color's alpha channel (Monaco has no `color-mix()`). */
function alpha(hex: string, value: number): string {
  return `${hex.slice(0, 7)}${hexByte(value * 255)}`;
}

/** Perceived lightness of an opaque hex color, used to pick Monaco's base. */
function isDark(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Fallbacks are only reached if a variable is missing entirely (a stylesheet
 * that has not landed yet), so they are the light palette's plain values.
 */
const TOKENS = {
  background: "#ffffff",
  foreground: "#292524",
  card: "#ffffff",
  cardForeground: "#292524",
  popover: "#ffffff",
  popoverForeground: "#292524",
  muted: "#f5f5f4",
  mutedForeground: "#78716c",
  accent: "#f5f5f4",
  accentForeground: "#292524",
  primary: "#be123c",
  border: "#e7e5e4",
  input: "#e7e5e4",
  ring: "#a8a29e",
  destructive: "#dc2626",
  syntaxKeyword: "#be123c",
  syntaxString: "#15803d",
  syntaxConstant: "#a16207",
  syntaxComment: "#78716c",
  syntaxFunction: "#1d4ed8",
  syntaxType: "#7e22ce",
  syntaxTag: "#be123c",
  syntaxAttribute: "#a16207",
} as const;

type TokenName = keyof typeof TOKENS;

/** `syntaxKeyword` -> `--syntax-keyword`, `cardForeground` -> `--card-foreground`. */
function cssVarName(token: TokenName): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function readTokens(): Record<TokenName, string> {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<TokenName, string>;
  for (const token of Object.keys(TOKENS) as TokenName[]) {
    out[token] = cssColorToHex(style.getPropertyValue(cssVarName(token)), TOKENS[token]);
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
  const dark = isDark(c.card);

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
      // and INI/properties keys `attribute.name` — all three land somewhere.
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
      // Widgets: find, suggest, hover, the parameter hints — the panel's own
      // popover/input tokens so they match every other floating surface.
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
