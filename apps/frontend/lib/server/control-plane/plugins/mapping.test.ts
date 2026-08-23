/**
 * Unit tests for the plugin fetch engine's pure mapping layer — the two things
 * the plugins tab draws conclusions from and therefore must not mangle: a
 * project's supported-game-version list (the compatibility badges) and the
 * composed project-page link (the only provider URL the browser ever sees).
 */

import { describe, expect, test } from "bun:test";

import {
  asChannel,
  asGameVersionList,
  asStringList,
  pick,
  providerProjectUrl,
} from "./mapping";
import { MODRINTH_PROVIDER_SPEC } from "@/lib/modrinth-preset";

const spec = MODRINTH_PROVIDER_SPEC as never;

describe("asGameVersionList", () => {
  test("keeps the whole list, however long", () => {
    // Modrinth's search index lists a project's versions oldest-first, so a
    // long-lived project has the *current* game version at the very end.
    // There used to be a 200 cap here; Simple Voice Chat lists 259 versions
    // with "26.2" at index 249, and the panel called it "Not for 26.2".
    const versions = [
      ...Array.from({ length: 258 }, (_, i) => `1.${i}`),
      "26.2",
    ];
    const mapped = asGameVersionList(versions);
    expect(mapped).toHaveLength(259);
    expect(mapped).toContain("26.2");
  });

  test("drops non-string entries instead of coercing them", () => {
    expect(asGameVersionList(["1.21.1", 42, null, "26.2"])).toEqual([
      "1.21.1",
      "26.2",
    ]);
  });

  test("a missing or non-array field maps to an empty list", () => {
    expect(asGameVersionList(undefined)).toEqual([]);
    expect(asGameVersionList("26.2")).toEqual([]);
  });

  test("display-only lists still get their cap", () => {
    expect(asStringList(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});

describe("pick", () => {
  test("reads a dot-path and tolerates missing keys", () => {
    expect(pick({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(pick({ a: { b: 1 } }, "a.c")).toBeUndefined();
    expect(pick(null, "a")).toBeUndefined();
    expect(pick({ a: 1 }, undefined)).toBeUndefined();
  });
});

describe("asChannel", () => {
  test("anything that is not beta/alpha is treated as a release", () => {
    expect(asChannel("beta")).toBe("beta");
    expect(asChannel("alpha")).toBe("alpha");
    expect(asChannel("release")).toBe("release");
    expect(asChannel(undefined)).toBe("release");
  });
});

describe("providerProjectUrl", () => {
  test("composes the catalog's project page from the spec", () => {
    expect(
      providerProjectUrl(spec, {
        projectId: "9eGKb6K1",
        slug: "simple-voice-chat",
        projectType: "plugin",
      }),
    ).toBe("https://modrinth.com/plugin/simple-voice-chat");
  });

  test("falls back to the project id when no slug was recorded", () => {
    expect(
      providerProjectUrl(spec, {
        projectId: "9eGKb6K1",
        slug: null,
        projectType: "mod",
      }),
    ).toBe("https://modrinth.com/mod/9eGKb6K1");
  });

  test("path material in a slug cannot escape the template", () => {
    expect(
      providerProjectUrl(spec, {
        projectId: "x",
        slug: "../../admin?a=b",
        projectType: "plugin",
      }),
    ).toBe("https://modrinth.com/plugin/..%2F..%2Fadmin%3Fa%3Db");
  });

  test("no site declared means no link", () => {
    const bare = { ...MODRINTH_PROVIDER_SPEC } as Record<string, unknown>;
    delete bare.siteUrl;
    delete bare.projectPath;
    expect(
      providerProjectUrl(bare as never, {
        projectId: "x",
        projectType: "plugin",
      }),
    ).toBeUndefined();
  });

  test("a non-https or blocked site host is refused at compose time", () => {
    for (const siteUrl of ["http://modrinth.com", "https://127.0.0.1", "nope"]) {
      expect(
        providerProjectUrl({ ...MODRINTH_PROVIDER_SPEC, siteUrl } as never, {
          projectId: "x",
          projectType: "plugin",
        }),
      ).toBeUndefined();
    }
  });
});
