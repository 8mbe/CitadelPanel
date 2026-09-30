import { describe, expect, test } from "bun:test";
import { isContentFilename, pickContentFile } from "./files";

const jar = {
  url: "https://cdn.modrinth.com/mod.jar",
  filename: "content+1.21.jar",
  sizeBytes: 10,
  primary: true,
};
const zip = {
  ...jar,
  filename: "content.zip",
  url: "https://cdn.modrinth.com/content.zip",
  primary: false,
};

describe("content files", () => {
  test("datapacks select ZIPs even when a mod wrapper is primary", () => {
    expect(pickContentFile([jar, zip], "datapack")).toEqual(zip);
    expect(pickContentFile([jar, zip], "mod")).toEqual(jar);
    expect(pickContentFile([jar], "datapack")).toBeUndefined();
    expect(pickContentFile([zip], "plugin")).toBeUndefined();
  });

  test("primary preference applies only among files of the correct type", () => {
    const primaryZip = { ...zip, filename: "preferred.zip", primary: true };
    expect(pickContentFile([jar, zip, primaryZip], "datapack")).toEqual(
      primaryZip,
    );
  });

  test("filenames are contained basenames with the type's extension", () => {
    for (const filename of [
      "../escape.zip",
      "/absolute.zip",
      "dir/file.zip",
      "hidden/.pack.zip",
      ".pack.zip",
      "pack.zip.disabled",
      "pack.exe",
      "pack.jar",
    ])
      expect(isContentFilename(filename, "datapack")).toBe(false);
    expect(isContentFilename("fabric-api+1.21.1.jar", "mod")).toBe(true);
    expect(isContentFilename("World Pack-1.2.zip", "datapack")).toBe(true);
  });
});
