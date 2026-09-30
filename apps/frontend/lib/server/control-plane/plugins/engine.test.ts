import { afterEach, describe, expect, mock, test } from "bun:test";
import { MODRINTH_PROVIDER_SPEC } from "@/lib/modrinth-preset";
import type { PluginFetchSpec, ResolvedPluginSupport } from "../blueprints/plugins";

mock.module("server-only", () => ({}));
const { engineGetVersion, engineListInstallVersions, engineListVersions, assertDownloadUrl } = await import("./engine");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const support: ResolvedPluginSupport = {
  label: "Datapacks",
  directory: "world/datapacks",
  projectType: "datapack",
  loaders: ["datapack"],
  gameVersion: "26.2",
  provider: MODRINTH_PROVIDER_SPEC as PluginFetchSpec,
};

const release = (id = "v1", overrides: Record<string, unknown> = {}) => ({
  id,
  project_id: "clumps",
  version_number: "1.1.0",
  version_type: "release",
  game_versions: ["26.2"],
  loaders: ["datapack"],
  date_published: "2026-07-01T00:00:00Z",
  files: [{ url: "https://cdn.modrinth.com/clumps.zip", filename: "clumps.zip", primary: true }],
  ...overrides,
});

function catalog(responses: unknown[], status = 200): URL[] {
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const response = new Response(JSON.stringify(responses.shift()), { status });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  }) as typeof fetch;
  return requests;
}

describe("manual version picker fallback", () => {
  test("keeps compatible datapack results without a second request", async () => {
    const requests = catalog([[release()]]);
    const result = await engineListInstallVersions(support, "clumps");
    expect(result.compatibilityFallback).toBe(false);
    expect(result.versions.map((v) => v.versionId)).toEqual(["v1"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("loaders")).toBe('["datapack"]');
    expect(requests[0]!.searchParams.get("game_versions")).toBe('["26.2"]');
  });

  test("an empty match fetches all releases without loader or game-version filters", async () => {
    const requests = catalog([[], [release("older", { game_versions: ["1.21.1"] }), release("otherLoader", { loaders: ["fabric"] })]]);
    const result = await engineListInstallVersions(support, "clumps");
    expect(result.compatibilityFallback).toBe(true);
    expect(result.versions.map((v) => v.versionId)).toEqual(["older", "otherLoader"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.pathname).toBe("/v2/project/clumps/version");
    expect(requests[1]!.searchParams.has("loaders")).toBe(false);
    expect(requests[1]!.searchParams.has("game_versions")).toBe(false);
  });

  test("a catalog result without a file for the tab also triggers fallback", async () => {
    const jar = release("jar", { files: [{ url: "https://cdn.modrinth.com/clumps.jar", filename: "clumps.jar", primary: true }] });
    catalog([[jar], [jar, release("zip")]]);
    const result = await engineListInstallVersions(support, "clumps");
    expect(result.compatibilityFallback).toBe(true);
    expect(result.versions.map((v) => v.versionId)).toEqual(["jar", "zip"]);
  });

  test("checks compatibility when a provider ignores the query filters", async () => {
    const incompatible = [release("wrongGame", { game_versions: ["1.21.1"] }), release("wrongLoader", { loaders: ["fabric"] })];
    catalog([incompatible, incompatible]);
    expect((await engineListInstallVersions(support, "clumps")).compatibilityFallback).toBe(true);
  });

  test("supports mod and plugin fallbacks as well as datapacks", async () => {
    for (const projectType of ["mod", "plugin"] as const) {
      const version = release("jar", { files: [{ url: "https://cdn.modrinth.com/clumps.jar", filename: "clumps.jar", primary: true }] });
      catalog([[], [version]]);
      const result = await engineListInstallVersions({ ...support, projectType }, "clumps");
      expect(result.compatibilityFallback).toBe(true);
      expect(result.versions).toHaveLength(1);
    }
  });

  test("a project with no releases stays empty", async () => {
    catalog([[], []]);
    expect((await engineListInstallVersions(support, "clumps")).versions).toEqual([]);
  });

  test("a catalog failure remains an error instead of claiming incompatibility", async () => {
    const requests = catalog([{}], 503);
    await expect(engineListInstallVersions(support, "clumps")).rejects.toThrow("request failed (503)");
    expect(requests).toHaveLength(1);
  });

  test("automatic update listing never falls back", async () => {
    const requests = catalog([[]]);
    expect(await engineListVersions(support, "clumps")).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.has("game_versions")).toBe(true);
  });

  test("a manually selected fallback resolves without a single-version endpoint", async () => {
    const requests = catalog([[release("older", { game_versions: ["1.21.1"] })]]);
    const provider = { ...support.provider, version: undefined };
    expect((await engineGetVersion({ ...support, provider }, "clumps", "older"))?.versionId).toBe("older");
    expect(requests[0]!.searchParams.has("game_versions")).toBe(false);
    expect(requests[0]!.searchParams.has("loaders")).toBe(false);
  });

  test("fallback downloads retain host and HTTPS checks", () => {
    expect(() => assertDownloadUrl(support.provider, "https://evil.example/clumps.zip")).toThrow("unexpected host");
    expect(() => assertDownloadUrl(support.provider, "http://cdn.modrinth.com/clumps.zip")).toThrow("non-https");
  });
});
