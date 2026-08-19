/**
 * Tests for the colour parser and the OKLCh conversion.
 *
 * The parser is the site theme's security boundary — everything it accepts gets
 * re-emitted into a `<style>` element as numbers — so the rejection cases carry
 * as much weight as the happy path. The conversion tests pin the anchors
 * (black, white, the primaries) and the round trip rather than every digit,
 * which is what a hand-written matrix can actually promise.
 */

import { describe, expect, test } from "bun:test";

import { formatOklch, oklchToHex, parseColor } from "./color";

describe("parseColor", () => {
  test("reads the hex forms the native colour picker produces", () => {
    expect(parseColor("#000")!.l).toBeCloseTo(0, 5);
    expect(parseColor("#ffffff")!.l).toBeCloseTo(1, 3);
    // Short and long forms of the same colour must agree.
    expect(oklchToHex(parseColor("#abc")!)).toBe("#aabbcc");
  });

  test("carries alpha from #rrggbbaa and oklch's slash syntax", () => {
    expect(parseColor("#ffffff80")!.alpha).toBeCloseTo(128 / 255, 4);
    expect(parseColor("oklch(1 0 0 / 10%)")!.alpha).toBeCloseTo(0.1, 5);
    expect(parseColor("oklch(1 0 0 / 0.25)")!.alpha).toBeCloseTo(0.25, 5);
    expect(parseColor("#fff")!.alpha).toBe(1);
  });

  test("accepts percentage lightness and degree hues", () => {
    expect(parseColor("oklch(50% 0.1 30)")!.l).toBeCloseTo(0.5, 5);
    expect(parseColor("oklch(0.5 0.1 30deg)")!.h).toBeCloseTo(30, 5);
  });

  test("normalises hue into a single turn", () => {
    expect(parseColor("oklch(0.5 0.1 400)")!.h).toBeCloseTo(40, 4);
    expect(parseColor("oklch(0.5 0.1 -30)")!.h).toBeCloseTo(330, 4);
  });

  test("clamps components rather than emitting out-of-range CSS", () => {
    expect(parseColor("oklch(2 9 0)")!.l).toBe(1);
    expect(parseColor("oklch(2 9 0)")!.c).toBe(0.5);
    expect(parseColor("oklch(-1 0 0)")!.l).toBe(0);
  });

  test("rejects everything that is not a plain hex or oklch triple", () => {
    // Named colours and other functions would work in CSS but cannot be
    // re-emitted as numbers, which is the property the theme relies on.
    for (const input of [
      "",
      "   ",
      "red",
      "rgb(255 0 0)",
      "hsl(0 100% 50%)",
      "var(--primary)",
      "color-mix(in oklch, red, blue)",
      "oklch(none 0 0)",
      "oklch(0.5 0.1)",
      "oklch(0.5 0.1 30 40)",
      "#12345",
      "#gggggg",
      "oklch(0.5 0.1 30",
      "oklch(calc(1) 0 0)",
    ]) {
      expect(parseColor(input)).toBeNull();
    }
  });

  test("refuses a payload dressed up as a colour", () => {
    // The parse is what stands between an admin-supplied string and a
    // stylesheet, so the injection shapes have to fail closed.
    expect(parseColor("#fff;} html { display: none } .x {")).toBeNull();
    expect(parseColor("oklch(1 0 0);}body{background:url(//evil)")).toBeNull();
    expect(parseColor("</style><script>alert(1)</script>")).toBeNull();
  });

  test("treats a degree suffix as valid only on the hue", () => {
    expect(parseColor("oklch(0.5deg 0.1 30)")).toBeNull();
    expect(parseColor("oklch(0.5 0.1deg 30)")).toBeNull();
  });
});

describe("formatOklch", () => {
  test("omits alpha when the colour is opaque", () => {
    expect(formatOklch({ l: 0.5, c: 0.1, h: 30, alpha: 1 })).toBe(
      "oklch(0.5 0.1 30)",
    );
  });

  test("emits alpha as a percentage, matching the shipped tokens", () => {
    expect(formatOklch({ l: 1, c: 0, h: 0, alpha: 0.1 })).toBe(
      "oklch(1 0 0 / 10%)",
    );
  });

  test("round-trips through the parser", () => {
    const source = "oklch(0.514 0.222 16.94)";
    expect(formatOklch(parseColor(source)!)).toBe(source);
  });
});

describe("sRGB round trip", () => {
  test("hex survives a trip through OKLCh", () => {
    for (const hex of [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#7c3aed",
      "#3b82f6",
      "#808080",
    ]) {
      expect(oklchToHex(parseColor(hex)!)).toBe(hex);
    }
  });

  test("greys get a pinned hue instead of atan2 noise", () => {
    // Otherwise the same grey could serialise differently on each save.
    expect(parseColor("#808080")!.h).toBe(0);
    expect(parseColor("#ffffff")!.h).toBe(0);
  });

  test("a colour outside sRGB is clamped into a renderable hex", () => {
    const hex = oklchToHex({ l: 0.7, c: 0.4, h: 150, alpha: 1 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});
