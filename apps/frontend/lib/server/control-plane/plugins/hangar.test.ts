import { describe, expect, test } from "bun:test";
import { HANGAR_PROVIDER_SPEC, hangarProviderSpec } from "@/lib/hangar-preset";
import {
  asChannel,
  mapVersion,
  providerProjectUrl,
  versionMatchesSupport,
} from "./mapping";
import type { ResolvedPluginSupport } from "../blueprints/plugins";

const version = {
  id: 123,
  projectId: 42,
  name: "1.2.0",
  channel: { name: "Release" },
  createdAt: "2026-09-30T12:00:00Z",
  platformDependencies: { PAPER: ["1.21.1"], VELOCITY: ["3.4"] },
  downloads: {
    PAPER: {
      downloadUrl:
        "https://hangarcdn.papermc.io/plugins/owner/project/file.jar",
      fileInfo: { name: "file.jar", sizeBytes: 200 },
    },
  },
};

describe("Hangar mapping", () => {
  test("numeric IDs and platform file objects map to install metadata", () => {
    const mapped = mapVersion(
      HANGAR_PROVIDER_SPEC,
      HANGAR_PROVIDER_SPEC.versions,
      version,
    );
    expect(mapped).toMatchObject({
      versionId: "123",
      projectId: "42",
      versionNumber: "1.2.0",
      channel: "release",
      gameVersions: ["1.21.1"],
    });
    expect(mapped?.files).toEqual([
      {
        url: version.downloads.PAPER.downloadUrl,
        filename: "file.jar",
        sizeBytes: 200,
        primary: false,
      },
    ]);
    expect(HANGAR_PROVIDER_SPEC.downloadHosts).toContain(
      new URL(mapped!.files[0].url).hostname,
    );
  });

  test("external releases and missing platform downloads have no installable file", () => {
    for (const downloads of [
      {
        PAPER: { externalUrl: "https://example.org/download", fileInfo: null },
      },
      { VELOCITY: version.downloads.PAPER },
    ]) {
      expect(
        mapVersion(HANGAR_PROVIDER_SPEC, HANGAR_PROVIDER_SPEC.versions, {
          ...version,
          downloads,
        })?.files,
      ).toEqual([]);
    }
  });

  test("Hangar channel names retain beta and alpha distinctions", () => {
    expect(asChannel("Beta")).toBe("beta");
    expect(asChannel("Alpha")).toBe("alpha");
    expect(
      mapVersion(HANGAR_PROVIDER_SPEC, HANGAR_PROVIDER_SPEC.versions, {
        ...version,
        channel: { name: "Snapshot" },
      })?.channel,
    ).toBe("beta");
  });

  test("single-version responses must match game and loader filters", () => {
    const mapped = mapVersion(
      HANGAR_PROVIDER_SPEC,
      HANGAR_PROVIDER_SPEC.versions,
      version,
    )!;
    const support: ResolvedPluginSupport = {
      label: "Plugins",
      directory: "plugins",
      projectType: "plugin",
      loaders: ["paper"],
      gameVersion: "1.21.1",
      provider: HANGAR_PROVIDER_SPEC,
    };
    expect(versionMatchesSupport(support, mapped)).toBe(true);
    expect(
      versionMatchesSupport({ ...support, gameVersion: "1.20.4" }, mapped),
    ).toBe(false);
    expect(
      versionMatchesSupport(support, { ...mapped, loaders: ["fabric"] }),
    ).toBe(false);
  });

  test("Velocity platform versions are not treated as Minecraft versions", () => {
    const spec = hangarProviderSpec("VELOCITY");
    expect(spec.versions.query).not.toHaveProperty("platformVersion");
    expect(spec.search.query).not.toHaveProperty("version");
    expect(spec.versions.fields.gameVersions).toBeUndefined();
  });

  test("project links carry the encoded owner and slug", () => {
    expect(
      providerProjectUrl(HANGAR_PROVIDER_SPEC, {
        projectId: "42",
        slug: "Project",
        author: "Owner",
        projectType: "plugin",
      }),
    ).toBe("https://hangar.papermc.io/Owner/Project");
    expect(
      providerProjectUrl(HANGAR_PROVIDER_SPEC, {
        projectId: "42",
        slug: "Project",
        projectType: "plugin",
      }),
    ).toBeUndefined();
    expect(
      providerProjectUrl(HANGAR_PROVIDER_SPEC, {
        projectId: "42",
        slug: "Project",
        author: "a/b",
        projectType: "plugin",
      }),
    ).toContain("/a%2Fb/Project");
  });
});
