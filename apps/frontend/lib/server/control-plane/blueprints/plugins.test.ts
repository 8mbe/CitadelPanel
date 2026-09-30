/**
 * Unit tests for the blueprint plugins schema: profile resolution against a
 * server's env (the thing that decides whether a server gets the tab at all,
 * and which directory/facets apply) and fetch-spec validation (the security
 * boundary for shared blueprints).
 */

import { describe, expect, test } from "bun:test";

import {
  parsePluginSupport,
  resolvePluginSupport,
  resolvePluginTabs,
  type BlueprintPluginSupport,
} from "./plugins";
import { MODRINTH_PROVIDER_SPEC } from "@/lib/modrinth-preset";
import { minecraftJava } from "./definitions/minecraft-java";
import { HANGAR_PROVIDER_SPEC } from "@/lib/hangar-preset";
import type { Blueprint, BlueprintEnvField } from "./types";

const envSchema: Record<string, BlueprintEnvField> = {
  TYPE: {
    required: false,
    default: "PAPER",
    options: ["VANILLA", "PAPER", "FABRIC"],
    editable: true,
  },
  VERSION: { required: false, default: "LATEST", editable: true },
  API_TOKEN: { required: false, secret: true },
};

/** The minecraft-java shape: env-driven variants, no default. */
const support: BlueprintPluginSupport = {
  envField: "TYPE",
  variants: {
    PAPER: {
      label: "Plugins",
      directory: "plugins",
      projectType: "plugin",
      loaders: ["paper"],
      gameVersionEnv: "VERSION",
    },
    FABRIC: {
      directory: "mods",
      projectType: "mod",
      loaders: ["fabric"],
      gameVersionEnv: "VERSION",
    },
    // VANILLA deliberately absent.
  },
  provider: MODRINTH_PROVIDER_SPEC as never,
};

function blueprintWith(plugins?: BlueprintPluginSupport): Blueprint {
  return {
    key: "test",
    name: "Test",
    dockerImage: "test:latest",
    defaultPorts: [{ container: 25565, primary: true }],
    envSchema,
    expectedResourceProfile: "bursty",
    dataPath: "/data",
    minimums: { cpuLimit: 0.5, memoryLimitMb: 512, diskLimitMb: 1024 },
    ...(plugins ? { plugins } : {}),
  } as Blueprint;
}

describe("resolvePluginSupport", () => {
  test("no plugins section means no support", () => {
    expect(resolvePluginSupport(blueprintWith(), {})).toBeNull();
  });

  test("an env value with a variant resolves to it", () => {
    const resolved = resolvePluginSupport(blueprintWith(support), {
      TYPE: "PAPER",
      VERSION: "1.20.4",
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.directory).toBe("plugins");
    expect(resolved!.projectType).toBe("plugin");
    expect(resolved!.loaders).toEqual(["paper"]);
    expect(resolved!.label).toBe("Plugins");
    expect(resolved!.gameVersion).toBe("1.20.4");
  });

  test("an env value without a variant and no default means no support (vanilla)", () => {
    expect(
      resolvePluginSupport(blueprintWith(support), { TYPE: "VANILLA" }),
    ).toBeNull();
  });

  test("a missing env value also falls through to the default (none here)", () => {
    expect(resolvePluginSupport(blueprintWith(support), {})).toBeNull();
  });

  test("a default profile catches unmatched env values", () => {
    const withDefault: BlueprintPluginSupport = {
      ...support,
      default: {
        directory: "plugins",
        projectType: "plugin",
      },
    };
    const resolved = resolvePluginSupport(blueprintWith(withDefault), {
      TYPE: "SPIGOT",
    });
    expect(resolved!.directory).toBe("plugins");
  });

  test("static blueprints (no envField) use the default profile", () => {
    const staticSupport: BlueprintPluginSupport = {
      default: { directory: "addons", projectType: "mod", loaders: ["quilt"] },
      provider: MODRINTH_PROVIDER_SPEC as never,
    };
    const resolved = resolvePluginSupport(blueprintWith(staticSupport), {});
    expect(resolved!.directory).toBe("addons");
    expect(resolved!.label).toBe("Mods");
  });

  test("label falls back profile → section → project-type default", () => {
    const unlabeled: BlueprintPluginSupport = {
      label: "Content",
      default: { directory: "mods", projectType: "mod" },
      provider: MODRINTH_PROVIDER_SPEC as never,
    };
    expect(resolvePluginSupport(blueprintWith(unlabeled), {}).label).toBe(
      "Content",
    );

    const noSectionLabel: BlueprintPluginSupport = {
      default: { directory: "mods", projectType: "mod" },
      provider: MODRINTH_PROVIDER_SPEC as never,
    };
    expect(resolvePluginSupport(blueprintWith(noSectionLabel), {}).label).toBe(
      "Mods",
    );
  });

  test("sentinel game versions don't filter (LATEST is not concrete)", () => {
    const resolved = resolvePluginSupport(blueprintWith(support), {
      TYPE: "FABRIC",
      VERSION: "LATEST",
    });
    expect(resolved!.gameVersion).toBeUndefined();
  });
});

describe("parsePluginSupport", () => {
  const allowAll = () => false;
  const blockAll = (host: string) => true;
  const blockLoopback = (host: string) =>
    host === "localhost" || host === "127.0.0.1";

  test("the shipped Modrinth spec validates", () => {
    const parsed = parsePluginSupport(support, envSchema, allowAll);
    expect(parsed.envField).toBe("TYPE");
    expect(parsed.provider.baseUrl).toBe("https://api.modrinth.com");
    expect(parsed.provider.downloadHosts).toEqual(["cdn.modrinth.com"]);
  });

  test("a static spec with only a default profile validates", () => {
    const parsed = parsePluginSupport(
      {
        default: { directory: "plugins", projectType: "plugin" },
        provider: MODRINTH_PROVIDER_SPEC,
      },
      envSchema,
      allowAll,
    );
    expect(parsed.default!.directory).toBe("plugins");
  });

  test("plain-http catalog origins are rejected", () => {
    expect(() =>
      parsePluginSupport(
        {
          ...support,
          provider: {
            ...MODRINTH_PROVIDER_SPEC,
            baseUrl: "http://api.modrinth.com",
          },
        },
        envSchema,
        allowAll,
      ),
    ).toThrow(/https/);
  });

  test("catalog and download hosts must pass the SSRF blocklist", () => {
    expect(() => parsePluginSupport(support, envSchema, blockAll)).toThrow(
      /not an allowed catalog host/,
    );

    expect(() =>
      parsePluginSupport(
        {
          default: { directory: "plugins", projectType: "plugin" },
          provider: { ...MODRINTH_PROVIDER_SPEC, downloadHosts: ["localhost"] },
        },
        envSchema,
        blockLoopback,
      ),
    ).toThrow(/download host/);
  });

  test("empty download host pins are rejected", () => {
    expect(() =>
      parsePluginSupport(
        {
          default: { directory: "plugins", projectType: "plugin" },
          provider: { ...MODRINTH_PROVIDER_SPEC, downloadHosts: [] },
        },
        envSchema,
        allowAll,
      ),
    ).toThrow(/downloadHosts/);
  });

  test("templates may only use the fixed variable vocabulary", () => {
    expect(() =>
      parsePluginSupport(
        {
          default: { directory: "plugins", projectType: "plugin" },
          provider: {
            ...MODRINTH_PROVIDER_SPEC,
            search: {
              ...MODRINTH_PROVIDER_SPEC.search,
              query: { q: "{apiKey}" },
            },
          },
        },
        envSchema,
        allowAll,
      ),
    ).toThrow(/unknown template variable/);
  });

  test("envField and gameVersionEnv must be non-secret schema fields", () => {
    expect(() =>
      parsePluginSupport({ ...support, envField: "NOPE" }, envSchema, allowAll),
    ).toThrow(/envField/);

    expect(() =>
      parsePluginSupport(
        {
          default: {
            directory: "plugins",
            projectType: "plugin",
            gameVersionEnv: "API_TOKEN",
          },
          provider: MODRINTH_PROVIDER_SPEC,
        },
        envSchema,
        allowAll,
      ),
    ).toThrow(/gameVersionEnv/);
  });

  test("directories must stay relative and simple", () => {
    for (const directory of ["../escape", "/abs", "a/b/c/d/e", ""]) {
      expect(() =>
        parsePluginSupport(
          {
            default: { directory, projectType: "plugin" },
            provider: MODRINTH_PROVIDER_SPEC,
          },
          envSchema,
          allowAll,
        ),
      ).toThrow(/directory/);
    }
  });

  test("the project-page link is validated like any other host", () => {
    const parsed = parsePluginSupport(support, envSchema, allowAll);
    expect(parsed.provider.siteUrl).toBe("https://modrinth.com");
    expect(parsed.provider.projectPath).toBe("/{projectType}/{slug}");

    expect(() =>
      parsePluginSupport(
        {
          ...support,
          provider: {
            ...MODRINTH_PROVIDER_SPEC,
            siteUrl: "http://modrinth.com",
          },
        },
        envSchema,
        allowAll,
      ),
    ).toThrow(/siteUrl/);

    expect(() =>
      parsePluginSupport(
        {
          ...support,
          provider: { ...MODRINTH_PROVIDER_SPEC, siteUrl: "https://localhost" },
        },
        envSchema,
        blockLoopback,
      ),
    ).toThrow(/siteUrl/);
  });

  test("project-page templates may only use page variables", () => {
    expect(() =>
      parsePluginSupport(
        {
          ...support,
          provider: {
            ...MODRINTH_PROVIDER_SPEC,
            projectPath: "/mod/{versionId}",
          },
        },
        envSchema,
        allowAll,
      ),
    ).toThrow(/unknown template variable/);
  });

  test("a site without a page path (or the reverse) is rejected", () => {
    const withoutPath = { ...MODRINTH_PROVIDER_SPEC } as Record<
      string,
      unknown
    >;
    delete withoutPath.projectPath;
    expect(() =>
      parsePluginSupport(
        { ...support, provider: withoutPath as never },
        envSchema,
        allowAll,
      ),
    ).toThrow(/go together/);

    const withoutSite = { ...MODRINTH_PROVIDER_SPEC } as Record<
      string,
      unknown
    >;
    delete withoutSite.siteUrl;
    expect(() =>
      parsePluginSupport(
        { ...support, provider: withoutSite as never },
        envSchema,
        allowAll,
      ),
    ).toThrow(/go together/);
  });

  test("a provider with no site at all is still valid (no link, no error)", () => {
    const bare = { ...MODRINTH_PROVIDER_SPEC } as Record<string, unknown>;
    delete bare.siteUrl;
    delete bare.projectPath;
    const parsed = parsePluginSupport(
      { ...support, provider: bare as never },
      envSchema,
      allowAll,
    );
    expect(parsed.provider.siteUrl).toBeUndefined();
    expect(parsed.provider.projectPath).toBeUndefined();
  });

  test("nothing to resolve is an error, not a silent no-op", () => {
    expect(() =>
      parsePluginSupport(
        { provider: MODRINTH_PROVIDER_SPEC },
        envSchema,
        allowAll,
      ),
    ).toThrow(/nothing to resolve/);
  });
});

describe("content tabs", () => {
  const declaration = {
    tabs: [
      {
        id: "plugins",
        label: "Extensions",
        envField: "TYPE",
        variants: support.variants,
        providers: [MODRINTH_PROVIDER_SPEC, HANGAR_PROVIDER_SPEC],
      },
      {
        id: "datapacks",
        label: "World packs",
        default: {
          directory: "world/datapacks",
          projectType: "datapack",
          loaders: ["datapack"],
          gameVersionEnv: "VERSION",
        },
        providers: [MODRINTH_PROVIDER_SPEC],
      },
    ],
  };

  test("Paper resolves independent directories, labels and provider sets", () => {
    const parsed = parsePluginSupport(declaration, envSchema, () => false);
    const tabs = resolvePluginTabs(blueprintWith(parsed), {
      TYPE: "PAPER",
      VERSION: "26.2",
    });
    expect(tabs.map((tab) => tab.id)).toEqual(["plugins", "datapacks"]);
    expect(tabs[0].providers.map((provider) => provider.id)).toEqual([
      "modrinth",
      "hangar",
    ]);
    expect(tabs[1]).toMatchObject({
      label: "World packs",
      directory: "world/datapacks",
      loaders: ["datapack"],
      gameVersion: "26.2",
    });
    expect(tabs[1].providers.map((provider) => provider.id)).toEqual([
      "modrinth",
    ]);
  });

  test("one unresolved tab does not hide an independent static tab", () => {
    const parsed = parsePluginSupport(declaration, envSchema, () => false);
    expect(
      resolvePluginTabs(blueprintWith(parsed), { TYPE: "VANILLA" }).map(
        (tab) => tab.id,
      ),
    ).toEqual(["datapacks"]);
  });

  test("legacy declarations retain the plugins tab ID", () => {
    const tabs = resolvePluginTabs(blueprintWith(support), { TYPE: "FABRIC" });
    expect(tabs[0]).toMatchObject({
      id: "plugins",
      directory: "mods",
      label: "Mods",
    });
    expect(tabs[0].providers).toHaveLength(1);
  });

  test("built-in loader profiles limit sources without losing datapacks", () => {
    parsePluginSupport(
      minecraftJava.plugins,
      minecraftJava.envSchema,
      () => false,
    );
    for (const type of ["FABRIC", "FORGE", "SPIGOT"]) {
      const tabs = resolvePluginTabs(minecraftJava, { TYPE: type });
      expect(tabs[0].providers.map((provider) => provider.id)).toEqual([
        "modrinth",
      ]);
      expect(tabs[1].id).toBe("datapacks");
    }
    expect(
      resolvePluginTabs(minecraftJava, { TYPE: "PAPER" })[0].providers.map(
        (provider) => provider.id,
      ),
    ).toEqual(["modrinth", "hangar"]);
  });

  test("duplicate IDs, unknown profile providers and mixed schemas are rejected", () => {
    expect(() =>
      parsePluginSupport(
        { tabs: [declaration.tabs[0], declaration.tabs[0]] },
        envSchema,
        () => false,
      ),
    ).toThrow(/duplicate id/);
    expect(() =>
      parsePluginSupport(
        {
          tabs: [
            {
              ...declaration.tabs[0],
              providers: [MODRINTH_PROVIDER_SPEC, MODRINTH_PROVIDER_SPEC],
            },
          ],
        },
        envSchema,
        () => false,
      ),
    ).toThrow(/duplicate provider/);
    expect(() =>
      parsePluginSupport(
        {
          tabs: [
            {
              ...declaration.tabs[1],
              default: {
                ...declaration.tabs[1].default,
                providerIds: ["missing"],
              },
            },
          ],
        },
        envSchema,
        () => false,
      ),
    ).toThrow(/unknown provider/);
    expect(() =>
      parsePluginSupport(
        { ...declaration, provider: MODRINTH_PROVIDER_SPEC },
        envSchema,
        () => false,
      ),
    ).toThrow(/combined/);
  });

  test("every provider is validated, including non-default sources", () => {
    const blocked = {
      tabs: [
        {
          ...declaration.tabs[0],
          providers: [
            MODRINTH_PROVIDER_SPEC,
            { ...HANGAR_PROVIDER_SPEC, baseUrl: "http://hangar.papermc.io" },
          ],
        },
      ],
    };
    expect(() => parsePluginSupport(blocked, envSchema, () => false)).toThrow(
      /https/,
    );
    expect(() =>
      parsePluginSupport(
        declaration,
        envSchema,
        (host) => host === "hangarcdn.papermc.io",
      ),
    ).toThrow(/not allowed/);
  });

  test("provider extensions survive validation and unknown templates fail", () => {
    const parsed = parsePluginSupport(declaration, envSchema, () => false);
    if (!("tabs" in parsed)) throw new Error("Expected tabs");
    const hangar = parsed.tabs[0].providers[1];
    expect(hangar.versions.fields.files.single).toBe(true);
    expect(hangar.project?.fields.author).toBe("namespace.owner");
    expect(hangar.search.query?.version).toBe("{gameVersion}");
    const invalid = structuredClone(declaration);
    invalid.tabs[0].providers[1].versions.fields.files.single = "true" as never;
    expect(() => parsePluginSupport(invalid, envSchema, () => false)).toThrow(
      /boolean/,
    );
  });
});
