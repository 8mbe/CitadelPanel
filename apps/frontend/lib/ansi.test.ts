import { test, expect } from "bun:test";
import { parseAnsi } from "./ansi";

/** Concatenate run text, convenient for asserting the readable content. */
function textOf(runs: ReturnType<typeof parseAnsi>): string {
  return runs.map((r) => r.text).join("");
}

test("plain text passes through unstyled", () => {
  const runs = parseAnsi("hello world");
  expect(textOf(runs)).toBe("hello world");
  expect(runs.every((r) => r.style === null)).toBe(true);
});

test("basic 16-color fg", () => {
  const runs = parseAnsi("\x1b[31mred\x1b[0m reset");
  expect(textOf(runs)).toBe("red reset");
  expect(runs[0].style?.color).toBe("#ff5555");
  expect(runs[1].style).toBe(null); // reset clears
});

test("bold + fg, then reset", () => {
  const runs = parseAnsi("\x1b[1;32mbold green\x1b[0m");
  expect(runs[0].style?.fontWeight).toBe("bold");
  expect(runs[0].style?.color).toBe("#50fa7b");
});

test("256-color palette", () => {
  const runs = parseAnsi("\x1b[38;5;196mfirebrick\x1b[0m");
  expect(runs[0].style?.color).toBe("#ff0000");
});

test("256-color grayscale", () => {
  const runs = parseAnsi("\x1b[38;5;240mgray\x1b[0m");
  expect(runs[0].style?.color).toMatch(/^#[0-9a-f]{6}$/);
});

test("24-bit truecolor", () => {
  const runs = parseAnsi("\x1b[38;2;10;20;30mrgb\x1b[0m");
  expect(runs[0].style?.color).toBe("rgb(10, 20, 30)");
});

test("background color", () => {
  const runs = parseAnsi("\x1b[44mblue bg\x1b[49m reset");
  expect(runs[0].style?.backgroundColor).toBe("#bd93f9");
  expect(runs[1].style?.backgroundColor).toBeUndefined();
});

test("underline and strikethrough", () => {
  const runs = parseAnsi("\x1b[4mu\x1b[24m \x1b[9ms\x1b[29m");
  expect(runs[0].style?.textDecorationLine).toBe("underline");
  expect(runs[1].style?.textDecorationLine).toBeUndefined();
  expect(runs[2].style?.textDecorationLine).toBe("line-through");
});

test("inverse swaps fg/bg, using defaults when unset", () => {
  const runs = parseAnsi("\x1b[7minverse\x1b[27m");
  // With no explicit colors, inverse uses DEFAULT_FG/DEFAULT_BG swapped.
  expect(runs[0].style?.color).toBe("#09090b");
  expect(runs[0].style?.backgroundColor).toBe("#d4d4d8");
});

test("inverse with explicit colors", () => {
  const runs = parseAnsi("\x1b[31;42m\x1b[7mhi\x1b[0m");
  expect(runs[0].style?.color).toBe("#50fa7b"); // bg became fg
  expect(runs[0].style?.backgroundColor).toBe("#ff5555"); // fg became bg
});

test("conceal/hidden renders invisible", () => {
  const runs = parseAnsi("\x1b[8msecret\x1b[28m");
  expect(runs[0].style?.opacity).toBe("0");
});

test("dim renders at half opacity", () => {
  const runs = parseAnsi("\x1b[2mdim\x1b[22m");
  expect(runs[0].style?.opacity).toBe("0.5");
});

test("non-SGR CSI sequences are stripped, not rendered as garbage", () => {
  // Cursor moves, erase line, and so on. These must vanish from output.
  const runs = parseAnsi("a\x1b[2Kbc\x1b[10;5Hde");
  expect(textOf(runs)).toBe("abcde");
});

test("OSC title sequence is stripped", () => {
  const runs = parseAnsi("\x1b]0;evil title\x07visible");
  expect(textOf(runs)).toBe("visible");
});

test("OSC with ST terminator is stripped", () => {
  const runs = parseAnsi("\x1b]2;window title\x1b\\visible");
  expect(textOf(runs)).toBe("visible");
});

test("DCS / APC / PM string sequences are stripped", () => {
  const runs = parseAnsi("a\x1bP1$q\x1b\\b\x1b_abc\x1b\\c");
  expect(textOf(runs)).toBe("abc");
});

test("two-char escapes (ESC c reset, ESC =) are skipped", () => {
  const runs = parseAnsi("a\x1b=bc");
  expect(textOf(runs)).toBe("abc");
});

test("C0 control chars (except tab) are stripped", () => {
  const runs = parseAnsi("a\x00b\x07c\td");
  // \x00 (NUL) and \x07 (BEL) are dropped; \t (0x09) is kept as printable.
  expect(textOf(runs)).toBe("abc\td");
});

test("ANSI split across the boundary of two parse calls is NOT auto-joined", () => {
  // parseAnsi is stateless per call, so a sequence split across frames would
  // be broken. The console-panel handles this by buffering on newlines so a full
  // line (including its escapes) is parsed as one unit. This test documents
  // that contract: each call is independent.
  const a = parseAnsi("\x1b[3");
  const b = parseAnsi("1mred\x1b[0m");
  // First call sees a malformed CSI (no final byte). It drops the ESC, and the
  // leftover "[" / "3" pass through as printable text.
  expect(textOf(a)).toBe("[3");
  // Second call has no ESC, so "1mred" is plain text and "\x1b[0m" resets.
  expect(textOf(b)).toBe("1mred");
});

test("HTML/script content in text is preserved as text, never executed", () => {
  // The parser returns structured runs; rendering as React children escapes
  // this. There is no HTML surface in the output, so <script> is just text.
  const runs = parseAnsi("\x1b[31m<script>alert(1)</script>\x1b[0m");
  expect(runs[0].text).toBe("<script>alert(1)</script>");
  expect(runs[0].style?.color).toBe("#ff5555");
  // No dangerouslySetInnerHTML, no href. The style object is the only attr.
  expect(typeof runs[0].style).toBe("object");
});

test("empty/blank input yields no runs", () => {
  expect(parseAnsi("")).toEqual([]);
  expect(parseAnsi("\x1b[0m")).toEqual([]);
});

test("multiple style changes coalesce into distinct runs", () => {
  const runs = parseAnsi("\x1b[31mred\x1b[32mgreen\x1b[33myellow\x1b[0m");
  expect(runs).toHaveLength(3);
  expect(runs[0].style?.color).toBe("#ff5555");
  expect(runs[1].style?.color).toBe("#50fa7b");
  expect(runs[2].style?.color).toBe("#f1fa8c");
});
