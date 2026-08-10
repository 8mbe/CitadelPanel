import { test, expect, describe } from "bun:test";

import {
  parsePortSpec,
  formatPortsCompact,
  PortSpecError,
} from "./portSpec";

describe("parsePortSpec", () => {
  test("a single port", () => {
    expect(parsePortSpec("25565")).toEqual([25565]);
  });

  test("an inclusive range", () => {
    expect(parsePortSpec("25565-25570")).toEqual([
      25565, 25566, 25567, 25568, 25569, 25570,
    ]);
  });

  test("a comma-separated list", () => {
    expect(parsePortSpec("25565,25578,25580")).toEqual([
      25565, 25578, 25580,
    ]);
  });

  test("a mix of ranges and singletons", () => {
    expect(parsePortSpec("25565-25570, 25578, 25580-25582")).toEqual([
      25565, 25566, 25567, 25568, 25569, 25570, 25578, 25580, 25581, 25582,
    ]);
  });

  test("ignores surrounding and internal whitespace", () => {
    expect(parsePortSpec("  25565 , 25566 - 25567  ")).toEqual([
      25565, 25566, 25567,
    ]);
  });

  test("returns a sorted list regardless of input order", () => {
    expect(parsePortSpec("25578,25565,25570")).toEqual([
      25565, 25570, 25578,
    ]);
  });

  test("accepts boundary ports 1 and 65535", () => {
    expect(parsePortSpec("1,65535")).toEqual([1, 65535]);
  });

  test("a single-port range is valid", () => {
    expect(parsePortSpec("25565-25565")).toEqual([25565]);
  });
});

describe("parsePortSpec errors", () => {
  test("empty string", () => {
    expect(() => parsePortSpec("")).toThrow(PortSpecError);
    expect(() => parsePortSpec("   ")).toThrow(PortSpecError);
  });

  test("empty segment from trailing comma", () => {
    expect(() => parsePortSpec("25565,")).toThrow(PortSpecError);
    expect(() => parsePortSpec(",25565")).toThrow(PortSpecError);
    expect(() => parsePortSpec("25565,,25566")).toThrow(PortSpecError);
  });

  test("non-numeric port", () => {
    expect(() => parsePortSpec("abc")).toThrow(PortSpecError);
    expect(() => parsePortSpec("25565-abc")).toThrow(PortSpecError);
  });

  test("out of range", () => {
    expect(() => parsePortSpec("0")).toThrow(PortSpecError);
    expect(() => parsePortSpec("65536")).toThrow(PortSpecError);
    expect(() => parsePortSpec("-5")).toThrow(PortSpecError);
  });

  test("reversed range", () => {
    expect(() => parsePortSpec("25570-25565")).toThrow(/reversed/i);
  });

  test("duplicate port within one spec", () => {
    expect(() => parsePortSpec("25565,25565")).toThrow(/more than once/i);
    expect(() => parsePortSpec("25565-25567,25566")).toThrow(/more than once/i);
  });

  test("a range with two dashes is rejected", () => {
    expect(() => parsePortSpec("1-2-3")).toThrow(PortSpecError);
  });
});

describe("formatPortsCompact", () => {
  test("empty list", () => {
    expect(formatPortsCompact([])).toBe("");
  });

  test("a single port", () => {
    expect(formatPortsCompact([25565])).toBe("25565");
  });

  test("a consecutive run collapses to a range", () => {
    expect(formatPortsCompact([25565, 25566, 25567])).toBe("25565-25567");
  });

  test("mixed runs and singletons", () => {
    expect(
      formatPortsCompact([25565, 25566, 25570, 25578, 25579, 25580]),
    ).toBe("25565-25566, 25570, 25578-25580");
  });

  test("accepts unsorted input", () => {
    expect(formatPortsCompact([25580, 25565, 25566])).toBe("25565-25566, 25580");
  });

  test("round-trips through parsePortSpec", () => {
    const spec = "25565-25570, 25578, 25580-25582";
    // formatPortsCompact joins with ", " for readability; parsePortSpec ignores
    // whitespace, so the two are inverse modulo spacing.
    expect(formatPortsCompact(parsePortSpec(spec))).toBe(
      "25565-25570, 25578, 25580-25582",
    );
  });
});
