/**
 * Blueprint I/O: the conversions between a blueprint's several shapes.
 *
 *   BlueprintFile:    the canonical, hand-editable JSON format (import/export).
 *                     Mirrors the code `Blueprint` definition: env as a keyed
 *                     map, ports as `defaultPorts`.
 *   FormValues:       the editable UI shape used by the form dialog. Everything
 *                     numeric is a string so partial input doesn't fight inputs.
 *   BlueprintPayload: the wire shape the create/update API accepts (env as a
 *                     flat `envFields` array).
 *   AdminBlueprintDetail: what the API returns for an existing blueprint.
 *
 * Keeping all four conversions here means the form dialog, the import dialog and
 * the export action never re-derive them independently.
 */

import type {
  AdminBlueprintDetail,
  BlueprintPayload,
  BlueprintResourceProfile,
} from "./api";
import { MODRINTH_PROVIDER_SPEC } from "./modrinth-preset";
import type {
  BlueprintPluginProfileSpec,
  BlueprintPluginsSpec,
} from "./types";

export { MODRINTH_PROVIDER_SPEC };

const RESOURCE_PROFILES: BlueprintResourceProfile[] = [
  "bursty",
  "steady-low",
  "steady-high",
];

/** One allowed value / metadata entry for an environment variable. */
export interface BlueprintFileEnvField {
  required?: boolean;
  default?: string;
  description?: string;
  options?: string[];
  secret?: boolean;
  editable?: boolean;
}

/** The canonical, hand-editable JSON representation of a blueprint. */
export interface BlueprintFile {
  key: string;
  name: string;
  description?: string | null;
  dockerImage: string;
  dataPath?: string;
  expectedResourceProfile: BlueprintResourceProfile;
  supportsReadOnlyRoot?: boolean;
  startupCommand?: string | null;
  stopCommand?: string | null;
  /**
   * Port numbers the blueprint declares. No protocol: a published port is
   * claimed on TCP and UDP both. A `protocol` key in an older exported file is
   * accepted and ignored on import.
   */
  defaultPorts: { container: number; primary?: boolean }[];
  envSchema?: Record<string, BlueprintFileEnvField>;
  install?: { image: string; script: string; entrypoint?: string[] | null } | null;
  /**
   * Plugin/mod support, including the provider fetch spec. Travels with the
   * file (shareable like the rest of the blueprint); the backend validates it
   * strictly on save: https-only catalog hosts that pass the SSRF blocklist,
   * pinned download hosts, fixed template vocabulary.
   */
  plugins?: BlueprintPluginsSpec | null;
  minimums: { cpuLimit: number; memoryLimitMb: number; diskLimitMb: number };
}

// --- Editable UI shape --------------------------------------------------------

export interface PortRow {
  container: string;
  primary: boolean;
}

export interface EnvRow {
  key: string;
  required: boolean;
  secret: boolean;
  editable: boolean;
  default: string;
  description: string;
  /** Comma-separated allowed values; empty means free-form. */
  options: string;
}

export interface FormValues {
  key: string;
  name: string;
  description: string;
  dockerImage: string;
  dataPath: string;
  resourceProfile: BlueprintResourceProfile;
  supportsReadonlyRoot: boolean;
  startupCommand: string;
  stopCommand: string;
  minCpu: string;
  minMemoryMb: string;
  minDiskMb: string;
  ports: PortRow[];
  env: EnvRow[];
  installEnabled: boolean;
  installImage: string;
  installScript: string;
  /** Whitespace-separated; empty means the agent default (/bin/sh -c). */
  installEntrypoint: string;
  // Plugins section. Profiles are structured rows; the provider fetch spec is
  // edited as JSON (a "Modrinth preset" button fills the standard spec).
  pluginsEnabled: boolean;
  /** Env key whose value selects the active profile; empty = static default. */
  pluginEnvField: string;
  pluginProfiles: PluginProfileRow[];
  pluginProviderSpec: string;
}

/**
 * One install profile. With a `pluginEnvField` set, `envValue` names the env
 * value that activates this profile ("" never matches, since the default
 * profile is a separate row). `enabled` marks which env values support plugins at all
 * (e.g. PAPER yes, VANILLA no).
 */
export interface PluginProfileRow {
  enabled: boolean;
  /** Empty for the static default profile. */
  envValue: string;
  label: string;
  directory: string;
  projectType: "mod" | "plugin" | "datapack";
  /** Comma-separated loader facets; empty means no loader filter. */
  loaders: string;
  /** Env key holding the game version; empty means none. */
  gameVersionEnv: string;
}

export function emptyForm(): FormValues {
  return {
    key: "",
    name: "",
    description: "",
    dockerImage: "",
    dataPath: "/data",
    resourceProfile: "bursty",
    supportsReadonlyRoot: false,
    startupCommand: "",
    stopCommand: "",
    minCpu: "1",
    minMemoryMb: "1024",
    minDiskMb: "2048",
    ports: [{ container: "", primary: true }],
    env: [],
    installEnabled: false,
    installImage: "",
    installScript: "",
    installEntrypoint: "",
    pluginsEnabled: false,
    pluginEnvField: "",
    pluginProfiles: [{ ...EMPTY_PROFILE_ROW, envValue: "", enabled: true }],
    pluginProviderSpec: JSON.stringify(MODRINTH_PROVIDER_SPEC, null, 2),
  };
}

const EMPTY_PROFILE_ROW: Omit<PluginProfileRow, "envValue" | "enabled"> = {
  label: "",
  directory: "",
  projectType: "plugin",
  loaders: "",
  gameVersionEnv: "",
};

/** A plugins section → the editable pieces of the form. */
function pluginsToForm(
  plugins: BlueprintPluginsSpec | null | undefined,
): Pick<FormValues, "pluginsEnabled" | "pluginEnvField" | "pluginProfiles" | "pluginProviderSpec"> {
  if (!plugins) {
    return {
      pluginsEnabled: false,
      pluginEnvField: "",
      pluginProfiles: [{ ...EMPTY_PROFILE_ROW, envValue: "", enabled: true }],
      pluginProviderSpec: JSON.stringify(MODRINTH_PROVIDER_SPEC, null, 2),
    };
  }

  const toRow = (
    envValue: string,
    profile: BlueprintPluginProfileSpec,
  ): PluginProfileRow => ({
    enabled: true,
    envValue,
    label: profile.label ?? "",
    directory: profile.directory,
    projectType: profile.projectType,
    loaders: (profile.loaders ?? []).join(", "),
    gameVersionEnv: profile.gameVersionEnv ?? "",
  });

  const rows = Object.entries(plugins.variants ?? {}).map(([envValue, profile]) =>
    toRow(envValue, profile),
  );
  if (plugins.default) rows.unshift(toRow("", plugins.default));

  return {
    pluginsEnabled: true,
    pluginEnvField: plugins.envField ?? "",
    pluginProfiles: rows,
    pluginProviderSpec: JSON.stringify(plugins.provider, null, 2),
  };
}

/** Form values → the plugins section of an API payload. */
function formToPlugins(
  values: FormValues,
): BlueprintPluginsSpec | null {
  if (!values.pluginsEnabled) return null;

  let provider: BlueprintPluginsSpec["provider"];
  try {
    provider = JSON.parse(values.pluginProviderSpec);
  } catch {
    throw new Error("The plugin provider spec is not valid JSON.");
  }

  const variants: Record<string, BlueprintPluginProfileSpec> = {};
  let defaultProfile: BlueprintPluginProfileSpec | undefined;
  for (const row of values.pluginProfiles) {
    if (!row.enabled) continue;
    const loaders = row.loaders
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const profile: BlueprintPluginsSpec["default"] = {
      ...(row.label.trim() ? { label: row.label.trim() } : {}),
      directory: row.directory.trim(),
      projectType: row.projectType,
      ...(loaders.length > 0 ? { loaders } : {}),
      ...(row.gameVersionEnv ? { gameVersionEnv: row.gameVersionEnv } : {}),
    };
    if (row.envValue.trim()) variants[row.envValue.trim()] = profile;
    else defaultProfile = profile;
  }

  return {
    ...(values.pluginEnvField ? { envField: values.pluginEnvField } : {}),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(defaultProfile ? { default: defaultProfile } : {}),
    provider,
  };
}

/** Guarantee exactly one primary port, promoting the first when none is set. */
function ensurePrimary(ports: PortRow[]): PortRow[] {
  if (ports.length > 0 && !ports.some((p) => p.primary)) ports[0]!.primary = true;
  return ports;
}

// --- Conversions --------------------------------------------------------------

/** An existing blueprint's detail → editable form values. */
export function detailToForm(detail: AdminBlueprintDetail): FormValues {
  return {
    key: detail.key,
    name: detail.name,
    description: detail.description ?? "",
    dockerImage: detail.dockerImage,
    dataPath: detail.dataPath,
    resourceProfile: detail.expectedResourceProfile,
    supportsReadonlyRoot: detail.supportsReadOnlyRoot,
    startupCommand: detail.startupCommand ?? "",
    stopCommand: detail.stopCommand ?? "",
    minCpu: String(detail.minimums.cpuLimit),
    minMemoryMb: String(detail.minimums.memoryLimitMb),
    minDiskMb: String(detail.minimums.diskLimitMb),
    ports: ensurePrimary(
      detail.defaultPorts.map((p) => ({
        container: String(p.container),
        primary: p.primary === true,
      })),
    ),
    env: Object.entries(detail.envSchema).map(([key, field]) => ({
      key,
      required: field.required,
      secret: field.secret === true,
      editable: field.editable === true,
      default: field.default ?? "",
      description: field.description ?? "",
      options: (field.options ?? []).join(", "),
    })),
    installEnabled: detail.install !== null,
    installImage: detail.install?.image ?? "",
    installScript: detail.install?.script ?? "",
    installEntrypoint: (detail.install?.entrypoint ?? []).join(" "),
    ...pluginsToForm(detail.plugins),
  };
}

/** An imported blueprint file → editable form values. */
export function fileToForm(file: BlueprintFile): FormValues {
  const base = emptyForm();
  return {
    ...base,
    key: file.key ?? "",
    name: file.name ?? "",
    description: file.description ?? "",
    dockerImage: file.dockerImage ?? "",
    dataPath: file.dataPath ?? "/data",
    resourceProfile: file.expectedResourceProfile ?? "bursty",
    supportsReadonlyRoot: file.supportsReadOnlyRoot === true,
    startupCommand: file.startupCommand ?? "",
    stopCommand: file.stopCommand ?? "",
    minCpu: String(file.minimums?.cpuLimit ?? base.minCpu),
    minMemoryMb: String(file.minimums?.memoryLimitMb ?? base.minMemoryMb),
    minDiskMb: String(file.minimums?.diskLimitMb ?? base.minDiskMb),
    ports: ensurePrimary(
      (file.defaultPorts ?? []).map((p) => ({
        container: String(p.container),
        primary: p.primary === true,
      })),
    ),
    env: Object.entries(file.envSchema ?? {}).map(([key, field]) => ({
      key,
      required: field.required === true,
      secret: field.secret === true,
      editable: field.editable === true,
      default: field.default ?? "",
      description: field.description ?? "",
      options: (field.options ?? []).join(", "),
    })),
    installEnabled: file.install != null,
    installImage: file.install?.image ?? "",
    installScript: file.install?.script ?? "",
    installEntrypoint: (file.install?.entrypoint ?? []).join(" "),
    ...pluginsToForm(file.plugins),
  };
}

/** Editable form values → the API create/update payload. */
export function formToPayload(values: FormValues): BlueprintPayload {
  return {
    key: values.key.trim(),
    name: values.name.trim(),
    description: values.description.trim() || null,
    dockerImage: values.dockerImage.trim(),
    dataPath: values.dataPath.trim() || "/data",
    expectedResourceProfile: values.resourceProfile,
    supportsReadOnlyRoot: values.supportsReadonlyRoot,
    startupCommand: values.startupCommand.trim() || null,
    stopCommand: values.stopCommand.trim() || null,
    ports: values.ports.map((p) => ({
      container: Number(p.container),
      primary: p.primary,
    })),
    envFields: values.env.map((row) => ({
      key: row.key.trim(),
      required: row.required,
      secret: row.secret,
      editable: row.editable,
      default: row.default.trim() || undefined,
      description: row.description.trim() || undefined,
      options: row.options
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    })),
    install: values.installEnabled
      ? {
          image: values.installImage.trim(),
          script: values.installScript,
          entrypoint:
            values.installEntrypoint.trim().length > 0
              ? values.installEntrypoint.trim().split(/\s+/)
              : null,
        }
      : null,
    plugins: formToPlugins(values),
    minimums: {
      cpuLimit: Number(values.minCpu),
      memoryLimitMb: Number(values.minMemoryMb),
      diskLimitMb: Number(values.minDiskMb),
    },
  };
}

/** An existing blueprint → the canonical file format, for export/download. */
export function detailToFile(detail: AdminBlueprintDetail): BlueprintFile {
  return {
    key: detail.key,
    name: detail.name,
    description: detail.description,
    dockerImage: detail.dockerImage,
    dataPath: detail.dataPath,
    expectedResourceProfile: detail.expectedResourceProfile,
    supportsReadOnlyRoot: detail.supportsReadOnlyRoot,
    startupCommand: detail.startupCommand,
    stopCommand: detail.stopCommand,
    defaultPorts: detail.defaultPorts.map((p) => ({
      container: p.container,
      ...(p.primary ? { primary: true } : {}),
    })),
    envSchema: detail.envSchema,
    install: detail.install
      ? {
          image: detail.install.image,
          script: detail.install.script,
          entrypoint: detail.install.entrypoint,
        }
      : null,
    plugins: detail.plugins,
    minimums: detail.minimums,
  };
}

/**
 * Parse and lightly validate a blueprint JSON string.
 *
 * Only the shape needed to populate the review form is checked here; the
 * backend re-validates in full on save, so this favours friendly, early errors
 * over exhaustiveness.
 */
export function parseBlueprintFile(text: string): BlueprintFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Expected a JSON object describing one blueprint.");
  }

  const obj = raw as Record<string, unknown>;
  const requireStr = (field: string): string => {
    const value = obj[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`"${field}" is required and must be a string.`);
    }
    return value;
  };

  requireStr("key");
  requireStr("name");
  requireStr("dockerImage");

  if (!Array.isArray(obj.defaultPorts) || obj.defaultPorts.length === 0) {
    throw new Error('"defaultPorts" must be a non-empty array.');
  }
  if (
    obj.expectedResourceProfile !== undefined &&
    !RESOURCE_PROFILES.includes(obj.expectedResourceProfile as BlueprintResourceProfile)
  ) {
    throw new Error(
      `"expectedResourceProfile" must be one of: ${RESOURCE_PROFILES.join(", ")}.`,
    );
  }
  if (typeof obj.minimums !== "object" || obj.minimums === null) {
    throw new Error('"minimums" is required (cpuLimit, memoryLimitMb, diskLimitMb).');
  }
  if (
    obj.plugins !== undefined &&
    obj.plugins !== null &&
    (typeof obj.plugins !== "object" || Array.isArray(obj.plugins))
  ) {
    throw new Error('"plugins" must be an object.');
  }

  return raw as BlueprintFile;
}
