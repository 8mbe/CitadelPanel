import type { CSSProperties } from "react";

/**
 * ANSI SGR (Select Graphic Rendition) parser.
 *
 * Converts a raw terminal string — which may carry ANSI escape sequences for
 * color and text styling — into an ordered list of plain-text runs, each tagged
 * with the CSS style to apply. The parser yields structured data only, never
 * HTML, so rendering the runs as React children is XSS-safe by construction:
 *
 *  - Every text run is emitted as a React text child, so React escapes it
 *    (`<script>` in the output becomes visible text, not executed markup).
 *  - The only attribute ever set is a hardcoded `style` object whose values are
 *    derived solely from ANSI numeric parameters — there is no string
 *    interpolation into HTML, no `dangerouslySetInnerHTML`, and no URL/href
 *    surface. Color values come from a fixed palette or `rgb(r, g, b)` of
 *    numeric parameters, so they cannot carry CSS or markup injection.
 *
 * Supported SGR range:
 *  - reset (0), bold (1), dim/faint (2), italic (3), underline (4), inverse (7),
 *    conceal/hidden (8), strikethrough (9), and their disable codes (22–29)
 *  - 16-color fg/bg (30–37, 40–47, 90–97, 100–107) and defaults (39, 49)
 *  - 256-color palette (38;5;n / 48;5;n)
 *  - 24-bit truecolor (38;2;r;g;b / 48;2;r;g;b)
 *
 * Non-SGR control sequences (cursor movement, screen/line clears, OSC titles,
 * DCS/APC/PM strings, single-char ESC escapes) are consumed and discarded so
 * they cannot render as visible garbage or affect the DOM. C0 control
 * characters (other than tab) and DEL are likewise stripped.
 */

/** Dracula-derived 16-color palette — vibrant and readable on a near-black bg. */
const PALETTE: readonly string[] = [
  // 0–7 standard
  "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
  "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
  // 8–15 bright
  "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
  "#d6acff", "#ff92d0", "#a4ffff", "#ffffff",
];

/**
 * Default fg/bg used when no explicit color is set. These match the console
 * container's `text-zinc-300` on `bg-zinc-950` so that inverse video swaps the
 * right values (SGR 7 with default colors inverts to dark-on-light).
 */
const DEFAULT_FG = "#d4d4d8";
const DEFAULT_BG = "#09090b";

interface SGRState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  inverse: boolean;
  hidden: boolean;
}

function freshState(): SGRState {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    inverse: false,
    hidden: false,
  };
}

/** Resolve a 256-color index to a CSS hex color. */
function color256(n: number): string {
  if (n < 0) n = 0;
  if (n > 255) n = 255;
  if (n < 16) return PALETTE[n];
  if (n >= 232) {
    // Grayscale ramp 232–255: value = 8 + 10*(n-232), ranging 8..238.
    const v = 8 + (n - 232) * 10;
    const hex = v.toString(16).padStart(2, "0");
    return `#${hex}${hex}${hex}`;
  }
  // 6×6×6 color cube: index = 16 + 36*r + 6*g + b, each component 0..5.
  const i = n - 16;
  const r = Math.floor(i / 36) % 6;
  const g = Math.floor(i / 6) % 6;
  const b = i % 6;
  // Cube levels map to 0, 95, 135, 175, 215, 255.
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  const toHex = (x: number) => level(x).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Apply one SGR parameter list to `state`, mutating it in place. */
function applySGR(state: SGRState, codes: number[]): void {
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    switch (c) {
      case 0:
        Object.assign(state, freshState());
        break;
      case 1: state.bold = true; break;
      case 2: state.dim = true; break;
      case 3: state.italic = true; break;
      case 4: state.underline = true; break;
      case 5: case 6: break; // blink — ignored (no DOM representation)
      case 7: state.inverse = true; break;
      case 8: state.hidden = true; break;
      case 9: state.strikethrough = true; break;
      case 22: state.bold = false; state.dim = false; break;
      case 23: state.italic = false; break;
      case 24: state.underline = false; break;
      case 25: break; // blink off — ignored
      case 27: state.inverse = false; break;
      case 28: state.hidden = false; break;
      case 29: state.strikethrough = false; break;
      case 39: state.fg = null; break;
      case 49: state.bg = null; break;
      default:
        if (c >= 30 && c <= 37) state.fg = PALETTE[c - 30];
        else if (c >= 40 && c <= 47) state.bg = PALETTE[c - 40];
        else if (c >= 90 && c <= 97) state.fg = PALETTE[c - 90 + 8];
        else if (c >= 100 && c <= 107) state.bg = PALETTE[c - 100 + 8];
        else if (c === 38 || c === 48) {
          const mode = codes[i + 1];
          if (mode === 5) {
            const color = color256(codes[i + 2] ?? 0);
            if (c === 38) state.fg = color;
            else state.bg = color;
            i += 2;
          } else if (mode === 2) {
            const color = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`;
            if (c === 38) state.fg = color;
            else state.bg = color;
            i += 4;
          }
          // Unknown extended-color mode: skip the mode byte only.
        }
        // Unrecognized codes are ignored.
        break;
    }
  }
}

/** Build a CSSProperties object for the current state, or null when default. */
function styleForState(state: SGRState): CSSProperties | null {
  const style: CSSProperties = {};
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    fg = fg ?? DEFAULT_FG;
    bg = bg ?? DEFAULT_BG;
    [fg, bg] = [bg, fg];
  }
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (state.bold) style.fontWeight = "bold";
  if (state.dim) style.opacity = "0.5";
  if (state.italic) style.fontStyle = "italic";
  const deco: string[] = [];
  if (state.underline) deco.push("underline");
  if (state.strikethrough) deco.push("line-through");
  if (deco.length) style.textDecorationLine = deco.join(" ");
  if (state.hidden) style.opacity = "0";
  return Object.keys(style).length === 0 ? null : style;
}

/** Keep tab; strip other C0 controls and DEL so they don't render as garbage. */
function isPrintable(code: number): boolean {
  return code === 0x09 || (code >= 0x20 && code !== 0x7f);
}

const ESC = 0x1b;

export interface AnsiRun {
  text: string;
  style: CSSProperties | null;
}

/**
 * Parse a terminal string into styled text runs. All ANSI escape sequences are
 * consumed — SGR codes mutate the active style; everything else is discarded —
 * and control characters are stripped, so the returned runs contain only
 * printable text ready to render as escaped React children.
 */
export function parseAnsi(input: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  const state = freshState();
  let text = "";

  const flush = () => {
    if (text.length === 0) return;
    runs.push({ text, style: styleForState(state) });
    text = "";
  };

  let i = 0;
  const len = input.length;
  while (i < len) {
    const code = input.charCodeAt(i);

    if (code === ESC) {
      const next = i + 1 < len ? input.charCodeAt(i + 1) : -1;

      if (next === 0x5b /* [ */) {
        // CSI: ESC [ <params/intermediate> <final>
        let j = i + 2;
        while (j < len) {
          const b = input.charCodeAt(j);
          if (b >= 0x20 && b <= 0x3f) j++;
          else break;
        }
        const final = j < len ? input.charCodeAt(j) : -1;
        if (final >= 0x40 && final <= 0x7e) {
          const params = input.slice(i + 2, j);
          if (final === 0x6d /* m */ && !params.includes("?")) {
            flush();
            const codes = params
              .split(/[;:]/)
              .filter((p) => p !== "")
              .map((p) => Number(p) || 0);
            applySGR(state, codes.length ? codes : [0]);
          }
          // Non-SGR CSI (cursor moves, erases, private modes): strip.
          i = j + 1;
          continue;
        }
        // Malformed CSI with no final byte: drop the ESC and reprocess.
        i++;
        continue;
      } else if (next === 0x5d /* ] */) {
        // OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \).
        let j = i + 2;
        while (j < len) {
          if (input.charCodeAt(j) === 0x07) {
            j++;
            break;
          }
          if (
            input.charCodeAt(j) === ESC &&
            j + 1 < len &&
            input.charCodeAt(j + 1) === 0x5c
          ) {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      } else if (
        next === 0x50 /* P (DCS) */ ||
        next === 0x58 /* X (SOS) */ ||
        next === 0x5e /* ^ (PM) */ ||
        next === 0x5f /* _ (APC) */
      ) {
        // String terminator: ESC \
        let j = i + 2;
        while (j < len) {
          if (
            input.charCodeAt(j) === ESC &&
            j + 1 < len &&
            input.charCodeAt(j + 1) === 0x5c
          ) {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      } else if (next !== -1) {
        // Other two-char escape (ESC =, ESC >, ESC 7, ESC c, ...): skip both.
        i += 2;
        continue;
      }
      // Lone ESC at end of input: drop it.
      i++;
      continue;
    }

    if (isPrintable(code)) {
      text += input[i];
    }
    // Non-printable controls (other than ESC, handled above) are dropped.
    i++;
  }

  flush();
  return runs;
}
