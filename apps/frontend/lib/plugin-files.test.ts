import { describe, expect, test } from "bun:test";
import { isPluginFilename, selectPluginVersionFile } from "./plugin-files";

const file = (filename: string, primary = false) => ({
  filename,
  primary,
  url: `https://cdn.modrinth.com/${filename}`,
  sizeBytes: 123,
});

describe("plugin file selection", () => {
  test("selects a datapack zip even when a jar is primary", () => {
    const files = [file("clumps.jar", true), file("clumps-v1.1.0.zip")];
    expect(selectPluginVersionFile({ files }, "datapack")?.filename).toBe("clumps-v1.1.0.zip");
    expect(selectPluginVersionFile({ files }, "mod")?.filename).toBe("clumps.jar");
  });

  test("prefers a primary file within the tab's content type", () => {
    const files = [file("old.jar"), file("recommended.jar", true)];
    expect(selectPluginVersionFile({ files }, "plugin")?.filename).toBe("recommended.jar");
    expect(selectPluginVersionFile({ files }, "datapack")).toBeUndefined();
  });

  test("rejects paths and unsupported file extensions", () => {
    for (const filename of ["../escape.jar", "/escape.jar", "dir\\escape.jar", ".hidden.jar", "plugin.jar.disabled", "plugin.exe"]) {
      expect(isPluginFilename(filename, "mod")).toBe(false);
    }
    expect(isPluginFilename("clumps-26.2+build.1.jar", "mod")).toBe(true);
    expect(isPluginFilename("clumps.zip", "datapack")).toBe(true);
    expect(isPluginFilename("clumps.jar", "datapack")).toBe(false);
    expect(isPluginFilename("clumps.zip", "plugin")).toBe(false);
  });
});
