import { describe, expect, test } from "bun:test";
import {
  fileToForm,
  formToPayload,
  parseBlueprintFile,
  type BlueprintFile,
} from "./blueprint-io";
import { MODRINTH_PROVIDER_SPEC } from "./modrinth-preset";
import { HANGAR_PROVIDER_SPEC } from "./hangar-preset";

const base: BlueprintFile = {
  key: "content-test",
  name: "Content test",
  dockerImage: "example:test",
  dataPath: "/data",
  expectedResourceProfile: "bursty",
  defaultPorts: [{ container: 25565, primary: true }],
  envSchema: {
    TYPE: { options: ["PAPER", "FABRIC"] },
    VERSION: { default: "LATEST" },
  },
  minimums: { cpuLimit: 1, memoryLimitMb: 1024, diskLimitMb: 2048 },
};

describe("blueprint content I/O", () => {
  test("import and form edits preserve every tab, provider and profile", () => {
    const plugins = {
      tabs: [
        {
          id: "plugins",
          label: "Extensions",
          envField: "TYPE",
          variants: {
            PAPER: {
              directory: "plugins",
              projectType: "plugin" as const,
              gameVersionEnv: "VERSION",
            },
            FABRIC: {
              label: "Mods",
              directory: "mods",
              projectType: "mod" as const,
              providerIds: ["modrinth"],
            },
          },
          providers: [MODRINTH_PROVIDER_SPEC, HANGAR_PROVIDER_SPEC],
        },
        {
          id: "datapacks",
          label: "World packs",
          default: {
            directory: "world/datapacks",
            projectType: "datapack" as const,
            loaders: ["datapack"],
          },
          providers: [MODRINTH_PROVIDER_SPEC],
        },
      ],
    };
    const form = fileToForm(
      parseBlueprintFile(JSON.stringify({ ...base, plugins })),
    );
    expect(form.pluginTabs).toHaveLength(2);
    expect(formToPayload(form).plugins).toEqual(plugins);
    form.pluginTabs[1].label = "Datapacks";
    const payload = formToPayload(form).plugins;
    expect(payload && "tabs" in payload && payload.tabs[1].label).toBe(
      "Datapacks",
    );
  });

  test("legacy declarations become the same plugins identity with one source", () => {
    const form = fileToForm({
      ...base,
      plugins: {
        default: { directory: "plugins", projectType: "plugin" },
        provider: MODRINTH_PROVIDER_SPEC,
      },
    });
    const payload = formToPayload(form).plugins;
    expect(payload && "tabs" in payload && payload.tabs[0]).toMatchObject({
      id: "plugins",
      default: { directory: "plugins", projectType: "plugin" },
      providers: [MODRINTH_PROVIDER_SPEC],
    });
  });

  test("invalid provider JSON names the affected tab and disabled support stays absent", () => {
    const form = fileToForm(base);
    expect(formToPayload(form).plugins).toBeNull();
    form.pluginsEnabled = true;
    form.pluginTabs[0].providerSpec = "{";
    expect(() => formToPayload(form)).toThrow(/tab "plugins"/);
  });
});
