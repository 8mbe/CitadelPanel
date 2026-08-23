/**
 * Unit tests for the game-version comparators. Catalogs return
 * supported-version lists in arbitrary order (Modrinth's search is
 * oldest-first), and plain string order is wrong for versions ("1.8.8" > 
 * "1.21.1", "26.2" < both). The UI's "up to X" and compatibility badges
 * depend on these comparing correctly.
 */

import { describe, expect, test } from "bun:test";

import { compareGameVersions, newestGameVersion } from "./format";

describe("compareGameVersions", () => {
  test("numeric segments, not lexicographic", () => {
    expect(compareGameVersions("1.8.8", "1.21.1")).toBeLessThan(0);
    expect(compareGameVersions("1.21.1", "1.8.8")).toBeGreaterThan(0);
    expect(compareGameVersions("1.21.1", "1.21.4")).toBeLessThan(0);
  });

  test("date-style versions compare by magnitude too", () => {
    expect(compareGameVersions("1.21.1", "26.2")).toBeLessThan(0);
    expect(compareGameVersions("26.2", "26.10")).toBeLessThan(0);
  });

  test("unequal depth and equality", () => {
    expect(compareGameVersions("1.21", "1.21.0")).toBe(0);
    expect(compareGameVersions("1.21", "1.21.1")).toBeLessThan(0);
  });

  test("pre-release suffixes sort just under their release", () => {
    expect(compareGameVersions("1.21.4-pre2", "1.21.4")).toBeLessThan(0);
  });
});

describe("newestGameVersion", () => {
  test("picks the newest from an oldest-first catalog list", () => {
    expect(
      newestGameVersion([
        "1.8.8", "1.8.9", "1.9.4", "1.10.2", "1.11.2",
        "1.12.2", "1.13.2", "1.14.4", "1.15.2", "1.16.5",
        "1.17.1", "1.18.2", "1.19.4", "1.20.4", "1.21", "1.21.1",
      ]),
    ).toBe("1.21.1");
  });

  test("handles mixed date-style and legacy versions", () => {
    expect(newestGameVersion(["1.8.8", "1.21.1", "26.2"])).toBe("26.2");
  });

  test("empty and single-entry lists", () => {
    expect(newestGameVersion([])).toBeUndefined();
    expect(newestGameVersion(["1.20.4"])).toBe("1.20.4");
  });
});
