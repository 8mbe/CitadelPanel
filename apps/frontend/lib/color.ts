/**
 * sRGB ↔ OKLCh conversion, and the strict parser the site theme is built on.
 *
 * Two reasons this exists rather than a colour library:
 *
 *   - **The design tokens are `oklch`.** Every value in `app/globals.css` is an
 *     OKLCh triple, so an operator-supplied colour has to end up in the same
 *     space or the palette stops being perceptually uniform. A hex `--primary`
 *     next to an OKLCh `--primary-foreground` makes contrast tuning guesswork.
 *   - **The parse is a security boundary.** The site theme is interpolated into
 *     a `<style>` element (see `lib/site-theme.ts`). Nothing an operator types
 *     reaches that string: `parseColor` either yields four numbers or null, and
 *     `formatOklch` is what writes the CSS. A value that does not parse is
 *     rejected on write, so there is no path from stored text to stylesheet.
 *
 * `<input type="color">` only speaks hex, which is the other half of the job:
 * the admin form round-trips through `oklchToHex`/`parseColor` so the native
 * picker can drive an OKLCh token.
 */

/** A colour in OKLCh: lightness 0–1, chroma 0–0.5, hue in degrees, alpha 0–1. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

/** Chroma that a `%` chroma component refers to, per the CSS Color 4 spec. */
const CHROMA_100_PERCENT = 0.4;

/** One numeric component: a plain number, a percentage, or an angle. */
const COMPONENT = /^[+-]?(?:\d+\.?\d*|\.\d+)(%|deg)?$/;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const OKLCH =
  /^oklch\(\s*([^\s/)]+)\s+([^\s/)]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s/)]+)\s*)?\)$/i;

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or `oklch(L C H[ / A])`.
 *
 * Deliberately narrow. Named colours, `rgb()`, `color-mix()`, `var()`, and the
 * `none` keyword are all rejected: the point is that everything accepted here
 * can be re-emitted as numbers, and anything that cannot is not worth the risk
 * of passing through to a stylesheet.
 */
export function parseColor(input: string): Oklch | null {
  const value = input.trim();
  if (!value) return null;
  if (HEX.test(value)) return hexToOklch(value);

  const match = OKLCH.exec(value);
  if (!match) return null;

  const l = component(match[1]!, { percentOf: 1 });
  const c = component(match[2]!, { percentOf: CHROMA_100_PERCENT });
  const h = component(match[3]!, { percentOf: 1, allowDeg: true });
  const alpha = match[4] === undefined ? 1 : component(match[4], { percentOf: 1 });
  if (l === null || c === null || h === null || alpha === null) return null;

  return {
    l: clamp(l, 0, 1),
    c: clamp(c, 0, 0.5),
    h: ((h % 360) + 360) % 360,
    alpha: clamp(alpha, 0, 1),
  };
}

function component(
  raw: string,
  { percentOf, allowDeg = false }: { percentOf: number; allowDeg?: boolean },
): number | null {
  const match = COMPONENT.exec(raw);
  if (!match) return null;
  const unit = match[1];
  if (unit === "deg" && !allowDeg) return null;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return null;
  return unit === "%" ? (number / 100) * percentOf : number;
}

/**
 * Render an OKLCh colour as CSS.
 *
 * Rounded rather than exact so a value that came in through the hex picker
 * reads like the hand-written tokens in `globals.css` instead of carrying
 * sixteen digits of float noise. The alpha channel is only emitted when it is
 * not fully opaque, matching how `--border` is written in the dark palette.
 */
export function formatOklch({ l, c, h, alpha }: Oklch): string {
  const parts = `${round(l, 4)} ${round(c, 4)} ${round(h, 2)}`;
  return alpha >= 1
    ? `oklch(${parts})`
    : `oklch(${parts} / ${round(alpha * 100, 1)}%)`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** `#rrggbb` for the native colour picker. Alpha is dropped since it cannot show it. */
export function oklchToHex(color: Oklch): string {
  const [r, g, b] = oklchToSrgb(color);
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

const channel = (value: number): string =>
  Math.round(clamp(value, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");

function hexToOklch(hex: string): Oklch {
  const digits = hex.slice(1);
  const short = digits.length <= 4;
  const pair = (index: number): number => {
    const text = short
      ? digits[index]!.repeat(2)
      : digits.slice(index * 2, index * 2 + 2);
    return Number.parseInt(text, 16) / 255;
  };
  const alpha = digits.length === 4 || digits.length === 8 ? pair(3) : 1;
  return srgbToOklch(pair(0), pair(1), pair(2), alpha);
}

// --- The conversion itself ----------------------------------------------------
//
// Björn Ottosson's OKLab matrices, with the sRGB transfer function on both
// sides. Written out rather than pulled in as a dependency: it is thirty lines
// of arithmetic that will never change, and the panel only needs the two
// directions used above.

const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const toGamma = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

function srgbToOklch(r: number, g: number, b: number, alpha: number): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.629978701 * lb);

  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const chroma = Math.hypot(a, bb);
  // Hue is meaningless for a grey, and atan2 of two near-zero numbers is noise,
  // so pin it rather than let it wander between saves.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;

  return { l: clamp(lightness, 0, 1), c: chroma, h: hue, alpha };
}

function oklchToSrgb({ l, c, h }: Oklch): [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);

  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    toGamma(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    toGamma(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    toGamma(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ];
}
