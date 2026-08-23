/**
 * Blueprint-declared plugin/mod support.
 *
 * A blueprint that can install plugins/mods declares the whole thing as data:
 * how the tab is called, where files land, which search facets apply — and the
 * provider definition itself (the fetch spec): the catalog's API base URL, its
 * endpoint paths and query templates, how responses map onto the fields the
 * panel needs, and which hosts files may download from. Because it is data,
 * provider support travels with the blueprint through export/import like any
 * other section: "shareable like blueprints".
 *
 * Safety model. The fetch spec is interpreted, never executed: the panel
 * interpolates a fixed vocabulary of template variables (`{query}`,
 * `{projectId}`, `{loaders}`, …) into path/query strings and reads responses
 * through declared dot-path field mappings. There are no scripts, no
 * expression evaluation and no free-form URL fields beyond the validated
 * endpoints. Validation (`parsePluginSupport`) enforces: https-only hosts that
 * pass the SSRF guardrail (no loopback/private networks — a shared blueprint
 * cannot aim the panel or its auto-updater at internal infrastructure), exact
 * hostname pins for downloads (`downloadHosts`, re-checked against every file
 * URL at install time), a fixed set of endpoints (search/project/versions/
 * version, GET only), and size caps. Files themselves land as inert `.jar`
 * writes through the node agent's contained, size-capped `files/pull`.
 *
 * The one URL the browser ever sees is the optional project-page link
 * (`siteUrl` + `projectPath`): still declared data, still validated as a
 * public https origin here, and still composed by the panel — a blueprint
 * cannot hand the UI an arbitrary href.
 */

import type { Blueprint, BlueprintEnvField } from "./types";

/** What a fetch-spec template variable may be. Anything else is an error. */
const TEMPLATE_VARIABLES = [
  "query",
  "offset",
  "limit",
  "projectId",
  "versionId",
  "loaders",
  "gameVersions",
  "facets",
] as const;

/**
 * What a project-page URL template (`projectPath`) may reference. Separate
 * from `TEMPLATE_VARIABLES` on purpose: this composes a link for a human to
 * click on the catalog's *site*, not a request the panel makes to its API, so
 * it has its own (smaller) vocabulary.
 */
const PROJECT_PAGE_VARIABLES = ["projectId", "slug", "projectType"] as const;

/** Where a search facet group draws its values from. */
export type FacetSource = "projectType" | "loaders" | "gameVersion";

export interface FacetSpec {
  source: FacetSource;
  /** e.g. "project_type:", "categories:", "versions:" — Modrinth's grammar. */
  prefix: string;
}

/** Dot-path into an endpoint's JSON response. */
type FieldPath = string;

export interface SearchEndpointSpec {
  path: string;
  query?: Record<string, string>;
  /** Where the result array lives (e.g. "hits"). Default: the response root. */
  root?: FieldPath;
  /** Where the total result count lives (e.g. "total_hits"). */
  total?: FieldPath;
  fields: {
    projectId: FieldPath;
    slug?: FieldPath;
    title: FieldPath;
    description?: FieldPath;
    author?: FieldPath;
    iconUrl?: FieldPath;
    downloads?: FieldPath;
    categories?: FieldPath;
    gameVersions?: FieldPath;
  };
}

export interface ProjectEndpointSpec {
  path: string;
  fields: {
    projectId: FieldPath;
    slug?: FieldPath;
    title: FieldPath;
    iconUrl?: FieldPath;
    description?: FieldPath;
  };
}

export interface VersionFileMapping {
  /** Where the file array lives within a version object (usually "files"). */
  path: FieldPath;
  fields: {
    url: FieldPath;
    filename: FieldPath;
    sizeBytes?: FieldPath;
    primary?: FieldPath;
  };
}

export interface VersionEndpointSpec {
  path: string;
  query?: Record<string, string>;
  /** Where the version array lives. Default: the response root. */
  root?: FieldPath;
  fields: {
    versionId: FieldPath;
    projectId?: FieldPath;
    name?: FieldPath;
    versionNumber: FieldPath;
    channel?: FieldPath;
    gameVersions?: FieldPath;
    loaders?: FieldPath;
    datePublished?: FieldPath;
    files: VersionFileMapping;
  };
}

/**
 * The provider definition: everything the panel needs to search a catalog,
 * inspect a project, list versions and pick download files. Hostnames are
 * pinned here and enforced at every fetch.
 */
export interface PluginFetchSpec {
  /** Display identity (audit rows, UI "via …" notes), e.g. "modrinth". */
  id: string;
  /** Catalog API origin, https only. */
  baseUrl: string;
  /** The only hosts version files may download from. */
  downloadHosts: string[];
  /**
   * The catalog's human-facing site origin (e.g. "https://modrinth.com"),
   * https only — distinct from `baseUrl`, which is its API. Set together with
   * `projectPath` to give the plugins tab an "open the project page" link;
   * omit both and the tab simply shows no link.
   */
  siteUrl?: string;
  /**
   * Path template to a project's page on `siteUrl`, e.g.
   * "/{projectType}/{slug}". Interpolated from `PROJECT_PAGE_VARIABLES` only.
   */
  projectPath?: string;
  search: SearchEndpointSpec;
  project?: ProjectEndpointSpec;
  versions: VersionEndpointSpec;
  /** Single-version lookup, used to re-resolve a version id at install time. */
  version?: VersionEndpointSpec;
  /** How to compose search facet groups out of the profile. */
  facets?: FacetSpec[];
}

export type PluginProjectType = "mod" | "plugin" | "datapack";

export interface BlueprintPluginProfile {
  /** Tab label for this profile (e.g. "Plugins", "Mods"). */
  label?: string;
  /**
   * Directory inside the server's data directory where provider files are
   * installed (e.g. "plugins", "mods", "world/datapacks"). Relative and
   * validated; the agent's path containment is the final backstop.
   */
  directory: string;
  /** Catalog project-type facet value. */
  projectType: PluginProjectType;
  /**
   * Loader facets, OR-ed together (e.g. ["paper"], ["purpur", "paper",
   * "spigot"] — Purpur runs Paper/Spigot plugins, and many projects only tag
   * one of the compatible loaders).
   */
  loaders?: string[];
  /**
   * Env key holding the game version (e.g. "VERSION"). This is the user-set
   * source of truth: a concrete value ("1.21.1") filters search results,
   * version lists and auto-update selection by compatibility, while sentinel
   * values like "LATEST" don't filter — the plugins tab asks the user to set
   * a concrete version in Settings instead of guessing one.
   */
  gameVersionEnv?: string;
}

export interface BlueprintPluginSupport {
  /** Fallback tab label for profiles that don't set one. */
  label?: string;
  /**
   * When set, the active profile is selected by the resolved value of this env
   * field (e.g. "TYPE"). Values without a variant entry — and no `default` —
   * mean the server has no plugin support (e.g. vanilla Minecraft).
   */
  envField?: string;
  /** Env value → profile. */
  variants?: Record<string, BlueprintPluginProfile>;
  /** Profile used when `envField` is unset, or its value has no variant. */
  default?: BlueprintPluginProfile;
  /** The provider definition (fetch spec). */
  provider: PluginFetchSpec;
}

/**
 * A blueprint's plugin support after resolving it against a server's env —
 * what the UI, the plugin routes and the fetch engine work with.
 */
export interface ResolvedPluginSupport {
  /** What the tab is called for this server. */
  label: string;
  directory: string;
  projectType: PluginProjectType;
  loaders: string[];
  /** Concrete game version from `gameVersionEnv`, when there is one. */
  gameVersion?: string;
  /** The blueprint's provider definition. */
  provider: PluginFetchSpec;
}

const DIRECTORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const LOADER = /^[a-z0-9-]{1,32}$/;
const ENV_VALUE = /^[\w .-]{1,64}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOSTNAME = /^[a-z0-9][a-z0-9.-]{0,253}$/;
const ENDPOINT_PATH = /^\/[A-Za-z0-9/._{}-]{0,128}$/;
const QUERY_KEY = /^[A-Za-z0-9_]{1,32}$/;
const FIELD_PATH = /^[A-Za-z0-9_.]{1,64}$/;
const FACET_PREFIX = /^[a-z_]{1,16}:$/;
/** Concrete "1.20.4"-style versions; sentinels like LATEST don't filter. */
const CONCRETE_GAME_VERSION = /^\d+\.\d+(\.\d+)?$/;
const MAX_SECTION_BYTES = 16_384;

const DEFAULT_LABELS: Record<PluginProjectType, string> = {
  plugin: "Plugins",
  mod: "Mods",
  datapack: "Datapacks",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** Hostnames fetch specs may never target, mirrored from the SSRF guard. */
type HostBlocklist = (hostname: string) => boolean;

function parseHttpsOrigin(
  value: unknown,
  where: string,
  isBlockedHost: HostBlocklist,
  errors: string[],
): URL | null {
  if (typeof value !== "string") {
    errors.push(`${where}: must be an https URL string`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${where}: not a valid URL`);
    return null;
  }
  if (url.protocol !== "https:") {
    errors.push(`${where}: must be https`);
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    errors.push(`${where}: must be a bare origin (no path, query, credentials)`);
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    errors.push(`${where}: must be a bare origin (no path)`);
    return null;
  }
  if (isBlockedHost(url.hostname)) {
    errors.push(
      `${where}: "${url.hostname}" is not an allowed catalog host (public https hosts only)`,
    );
    return null;
  }
  return url;
}

/** Verify template strings only reference the engine's fixed vocabulary. */
function parseTemplate(
  value: unknown,
  where: string,
  errors: string[],
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    errors.push(`${where}: must be a 1-200 character string`);
    return null;
  }
  const used = [...value.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
  for (const name of used) {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      errors.push(
        `${where}: unknown template variable "{${name}}" (available: ${TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(", ")})`,
      );
      return null;
    }
  }
  return value;
}

function parseQuery(
  value: unknown,
  where: string,
  errors: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > 8) errors.push(`${where}: at most 8 query parameters`);
  const query: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!QUERY_KEY.test(key)) {
      errors.push(`${where}: invalid query key "${key}"`);
      continue;
    }
    const template = parseTemplate(raw, `${where}.${key}`, errors);
    if (template !== null) query[key] = template;
  }
  return query;
}

function parseFieldPath(
  value: unknown,
  where: string,
  errors: string[],
): string | null {
  if (typeof value !== "string" || !FIELD_PATH.test(value)) {
    errors.push(`${where}: must be a dot-path like "version_number"`);
    return null;
  }
  return value;
}

function parseOptionalFieldPath(
  value: unknown,
  where: string,
  errors: string[],
): string | undefined {
  if (value === undefined) return undefined;
  return parseFieldPath(value, where, errors) ?? undefined;
}

function parseFetchSpec(
  value: unknown,
  isBlockedHost: HostBlocklist,
  errors: string[],
): PluginFetchSpec {
  const empty: PluginFetchSpec = {
    id: "",
    baseUrl: "",
    downloadHosts: [],
    search: { path: "", fields: { projectId: "", title: "" } },
    versions: {
      path: "",
      fields: { versionId: "", versionNumber: "", files: { path: "", fields: { url: "", filename: "" } } },
    },
  };
  if (!isRecord(value)) {
    errors.push("plugins.provider: expected an object");
    return empty;
  }

  const id = typeof value.id === "string" ? value.id : "";
  if (!PROVIDER_ID.test(id)) {
    errors.push('plugins.provider: "id" must be [a-z0-9-]{1,32}, e.g. "modrinth"');
  }
  parseHttpsOrigin(value.baseUrl, "plugins.provider.baseUrl", isBlockedHost, errors);

  if (
    !Array.isArray(value.downloadHosts) ||
    value.downloadHosts.length < 1 ||
    value.downloadHosts.length > 4 ||
    value.downloadHosts.some((h) => typeof h !== "string" || !HOSTNAME.test(h))
  ) {
    errors.push(
      'plugins.provider: "downloadHosts" must be 1-4 exact hostnames (e.g. ["cdn.modrinth.com"])',
    );
  } else {
    for (const host of value.downloadHosts as string[]) {
      if (isBlockedHost(host)) {
        errors.push(`plugins.provider: download host "${host}" is not allowed`);
      }
    }
  }

  // --- site + project page (optional, both or neither) ---
  let siteUrl: string | undefined;
  let projectPath: string | undefined;
  if (value.siteUrl !== undefined || value.projectPath !== undefined) {
    if (value.siteUrl === undefined || value.projectPath === undefined) {
      errors.push(
        'plugins.provider: "siteUrl" and "projectPath" go together (an origin with no path has no page to open, and a path needs a site)',
      );
    }
    if (value.siteUrl !== undefined) {
      const site = parseHttpsOrigin(
        value.siteUrl,
        "plugins.provider.siteUrl",
        isBlockedHost,
        errors,
      );
      if (site) siteUrl = value.siteUrl as string;
    }
    if (value.projectPath !== undefined) {
      if (
        typeof value.projectPath !== "string" ||
        !ENDPOINT_PATH.test(value.projectPath)
      ) {
        errors.push(
          'plugins.provider.projectPath: must start with "/" (e.g. "/{projectType}/{slug}")',
        );
      } else {
        const unknown = [...value.projectPath.matchAll(/\{([A-Za-z]+)\}/g)]
          .map((m) => m[1])
          .filter(
            (name) =>
              !(PROJECT_PAGE_VARIABLES as readonly string[]).includes(name),
          );
        if (unknown.length > 0) {
          errors.push(
            `plugins.provider.projectPath: unknown template variable "{${unknown[0]}}" (available: ${PROJECT_PAGE_VARIABLES.map((v) => `{${v}}`).join(", ")})`,
          );
        } else {
          projectPath = value.projectPath;
        }
      }
    }
  }

  const parseEndpointPath = (raw: unknown, where: string): string | null => {
    if (typeof raw !== "string" || !ENDPOINT_PATH.test(raw)) {
      errors.push(`${where}: "path" must start with "/" (templates like {projectId} allowed)`);
      return null;
    }
    return parseTemplate(raw, `${where}.path`, errors);
  };

  // --- search ---
  const search = isRecord(value.search) ? value.search : {};
  const searchPath = parseEndpointPath(search.path, "plugins.provider.search");
  const searchQuery = parseQuery(search.query, "plugins.provider.search.query", errors);
  const searchRoot = parseOptionalFieldPath(search.root, "plugins.provider.search.root", errors);
  const searchTotal = parseOptionalFieldPath(search.total, "plugins.provider.search.total", errors);
  const searchFields = isRecord(search.fields) ? search.fields : {};
  const searchProjectId = parseFieldPath(searchFields.projectId, "plugins.provider.search.fields.projectId", errors);
  const searchTitle = parseFieldPath(searchFields.title, "plugins.provider.search.fields.title", errors);

  // --- project (optional) ---
  let project: ProjectEndpointSpec | undefined;
  if (value.project !== undefined) {
    const p = isRecord(value.project) ? value.project : {};
    const pPath = parseEndpointPath(p.path, "plugins.provider.project");
    const pFields = isRecord(p.fields) ? p.fields : {};
    project = {
      path: pPath ?? "",
      fields: {
        projectId: parseFieldPath(pFields.projectId, "plugins.provider.project.fields.projectId", errors) ?? "",
        title: parseFieldPath(pFields.title, "plugins.provider.project.fields.title", errors) ?? "",
        slug: parseOptionalFieldPath(pFields.slug, "plugins.provider.project.fields.slug", errors),
        iconUrl: parseOptionalFieldPath(pFields.iconUrl, "plugins.provider.project.fields.iconUrl", errors),
        description: parseOptionalFieldPath(pFields.description, "plugins.provider.project.fields.description", errors),
      },
    };
  }

  // --- versions + version (same shape) ---
  const parseVersionEndpoint = (
    raw: unknown,
    where: string,
  ): VersionEndpointSpec | null => {
    const v = isRecord(raw) ? raw : {};
    const path = parseEndpointPath(v.path, where);
    const query = parseQuery(v.query, `${where}.query`, errors);
    const root = parseOptionalFieldPath(v.root, `${where}.root`, errors);
    const f = isRecord(v.fields) ? v.fields : {};
    const files = isRecord(f.files) ? f.files : {};
    const fileFields = isRecord(files.fields) ? files.fields : {};
    return {
      path: path ?? "",
      ...(query ? { query } : {}),
      ...(root ? { root } : {}),
      fields: {
        versionId: parseFieldPath(f.versionId, `${where}.fields.versionId`, errors) ?? "",
        versionNumber:
          parseFieldPath(f.versionNumber, `${where}.fields.versionNumber`, errors) ?? "",
        projectId: parseOptionalFieldPath(f.projectId, `${where}.fields.projectId`, errors),
        name: parseOptionalFieldPath(f.name, `${where}.fields.name`, errors),
        channel: parseOptionalFieldPath(f.channel, `${where}.fields.channel`, errors),
        gameVersions: parseOptionalFieldPath(f.gameVersions, `${where}.fields.gameVersions`, errors),
        loaders: parseOptionalFieldPath(f.loaders, `${where}.fields.loaders`, errors),
        datePublished: parseOptionalFieldPath(f.datePublished, `${where}.fields.datePublished`, errors),
        files: {
          path: parseFieldPath(files.path, `${where}.fields.files.path`, errors) ?? "",
          fields: {
            url: parseFieldPath(fileFields.url, `${where}.fields.files.fields.url`, errors) ?? "",
            filename: parseFieldPath(fileFields.filename, `${where}.fields.files.fields.filename`, errors) ?? "",
            sizeBytes: parseOptionalFieldPath(fileFields.sizeBytes, `${where}.fields.files.fields.sizeBytes`, errors),
            primary: parseOptionalFieldPath(fileFields.primary, `${where}.fields.files.fields.primary`, errors),
          },
        },
      },
    };
  };

  const versions = parseVersionEndpoint(value.versions, "plugins.provider.versions");
  let version: VersionEndpointSpec | undefined;
  if (value.version !== undefined) {
    version = parseVersionEndpoint(value.version, "plugins.provider.version") ?? undefined;
  }

  // --- facets ---
  let facets: FacetSpec[] | undefined;
  if (value.facets !== undefined) {
    if (
      !Array.isArray(value.facets) ||
      value.facets.length > 3 ||
      value.facets.some((f) => !isRecord(f))
    ) {
      errors.push("plugins.provider.facets: at most 3 facet groups");
    } else {
      const parsed: FacetSpec[] = [];
      for (const group of value.facets as Record<string, unknown>[]) {
        const source = group.source;
        const prefix = group.prefix;
        if (
          source !== "projectType" &&
          source !== "loaders" &&
          source !== "gameVersion"
        ) {
          errors.push('plugins.provider.facets: "source" must be projectType, loaders or gameVersion');
          continue;
        }
        if (typeof prefix !== "string" || !FACET_PREFIX.test(prefix)) {
          errors.push('plugins.provider.facets: "prefix" must look like "categories:"');
          continue;
        }
        parsed.push({ source, prefix });
      }
      if (parsed.length > 0) facets = parsed;
    }
  }

  return {
    id: PROVIDER_ID.test(id) ? id : "",
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    downloadHosts: (Array.isArray(value.downloadHosts)
      ? (value.downloadHosts as unknown[])
      : []
    ).filter((h): h is string => typeof h === "string"),
    ...(siteUrl && projectPath ? { siteUrl, projectPath } : {}),
    search: {
      path: searchPath ?? "",
      ...(searchQuery ? { query: searchQuery } : {}),
      ...(searchRoot ? { root: searchRoot } : {}),
      ...(searchTotal ? { total: searchTotal } : {}),
      fields: {
        projectId: searchProjectId ?? "",
        title: searchTitle ?? "",
        slug: parseOptionalFieldPath(searchFields.slug, "plugins.provider.search.fields.slug", errors),
        description: parseOptionalFieldPath(searchFields.description, "plugins.provider.search.fields.description", errors),
        author: parseOptionalFieldPath(searchFields.author, "plugins.provider.search.fields.author", errors),
        iconUrl: parseOptionalFieldPath(searchFields.iconUrl, "plugins.provider.search.fields.iconUrl", errors),
        downloads: parseOptionalFieldPath(searchFields.downloads, "plugins.provider.search.fields.downloads", errors),
        categories: parseOptionalFieldPath(searchFields.categories, "plugins.provider.search.fields.categories", errors),
        gameVersions: parseOptionalFieldPath(searchFields.gameVersions, "plugins.provider.search.fields.gameVersions", errors),
      },
    },
    ...(project ? { project } : {}),
    versions: versions ?? empty.versions,
    ...(version ? { version } : {}),
    ...(facets ? { facets } : {}),
  };
}

function parseProfile(
  value: unknown,
  envSchema: Record<string, BlueprintEnvField>,
  where: string,
  errors: string[],
): BlueprintPluginProfile {
  if (!isRecord(value)) {
    errors.push(`${where}: expected an object`);
    return { directory: "", projectType: "mod" };
  }

  const profile: BlueprintPluginProfile = {
    directory: "",
    projectType: "mod",
  };

  if (typeof value.label === "string") {
    const label = value.label.trim();
    if (label.length < 1 || label.length > 32) {
      errors.push(`${where}: label must be 1-32 characters`);
    } else {
      profile.label = label;
    }
  }

  const directory =
    typeof value.directory === "string" ? value.directory.trim() : "";
  const segments = directory.split("/");
  if (
    directory.length < 1 ||
    directory.length > 64 ||
    segments.length > 4 ||
    segments.some((s) => !DIRECTORY_SEGMENT.test(s))
  ) {
    errors.push(
      `${where}: directory must be 1-64 chars, 1-4 segments of [A-Za-z0-9 ._-] starting alphanumeric (e.g. "plugins")`,
    );
  } else {
    profile.directory = directory;
  }

  if (
    value.projectType === "mod" ||
    value.projectType === "plugin" ||
    value.projectType === "datapack"
  ) {
    profile.projectType = value.projectType;
  } else {
    errors.push(`${where}: projectType must be one of: mod, plugin, datapack`);
  }

  if (value.loaders !== undefined) {
    if (
      !Array.isArray(value.loaders) ||
      value.loaders.length > 6 ||
      value.loaders.some((l) => typeof l !== "string" || !LOADER.test(l))
    ) {
      errors.push(`${where}: loaders must be up to 6 of [a-z0-9-]{1,32}`);
    } else {
      profile.loaders = value.loaders as string[];
    }
  }

  if (value.gameVersionEnv !== undefined) {
    const key = value.gameVersionEnv;
    const field = typeof key === "string" ? envSchema[key] : undefined;
    if (typeof key !== "string" || !field || field.secret) {
      errors.push(
        `${where}: gameVersionEnv "${String(key)}" is not a non-secret env schema field`,
      );
    } else {
      profile.gameVersionEnv = key;
    }
  }

  return profile;
}

/**
 * Validate an untrusted plugins section (admin write or blueprint import).
 * Throws with all problems joined, in the style of `resolveEnv`.
 */
export function parsePluginSupport(
  value: unknown,
  envSchema: Record<string, BlueprintEnvField>,
  isBlockedHost: HostBlocklist,
): BlueprintPluginSupport {
  if (!isRecord(value)) {
    throw new Error("plugins: expected an object");
  }

  const errors: string[] = [];
  const support: BlueprintPluginSupport = {
    provider: parseFetchSpec(value.provider, isBlockedHost, errors),
  };

  if (typeof value.label === "string") {
    const label = value.label.trim();
    if (label.length < 1 || label.length > 32) {
      errors.push("plugins: label must be 1-32 characters");
    } else {
      support.label = label;
    }
  }

  if (value.envField !== undefined) {
    const field =
      typeof value.envField === "string" ? envSchema[value.envField] : undefined;
    if (typeof value.envField !== "string" || !field || field.secret) {
      errors.push(
        `plugins: envField "${String(value.envField)}" is not a non-secret env schema field`,
      );
    } else {
      support.envField = value.envField;
    }
  }

  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) {
      errors.push("plugins: variants must be an object of env value → profile");
    } else {
      const entries = Object.entries(value.variants);
      if (entries.length > 32) {
        errors.push("plugins: at most 32 variants");
      }
      const variants: Record<string, BlueprintPluginProfile> = {};
      for (const [envValue, profile] of entries) {
        if (!ENV_VALUE.test(envValue)) {
          errors.push(`plugins: invalid variant key "${envValue}"`);
          continue;
        }
        variants[envValue] = parseProfile(
          profile,
          envSchema,
          `plugins: variant "${envValue}"`,
          errors,
        );
      }
      support.variants = variants;
    }
  }

  if (value.default !== undefined) {
    support.default = parseProfile(
      value.default,
      envSchema,
      "plugins: default",
      errors,
    );
  }

  if (
    !support.envField &&
    !support.default &&
    !Object.keys(support.variants ?? {}).length
  ) {
    errors.push(
      "plugins: nothing to resolve — set a default profile or an envField with variants",
    );
  }

  if (JSON.stringify(value).length > MAX_SECTION_BYTES) {
    errors.push("plugins: section too large (max 16 KB)");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return support;
}

/**
 * Resolve a server's active plugin support from its blueprint and resolved
 * env. Null means "no plugins tab" — either the blueprint has no section, or
 * (for env-driven blueprints) the current env value has no profile (vanilla
 * Minecraft).
 */
export function resolvePluginSupport(
  blueprint: Blueprint,
  envValues: Record<string, string>,
): ResolvedPluginSupport | null {
  const support = blueprint.plugins;
  if (!support) return null;

  let profile: BlueprintPluginProfile | undefined;
  if (support.envField) {
    const envValue = envValues[support.envField];
    if (envValue !== undefined) {
      profile = support.variants?.[envValue];
    }
  }
  profile ??= support.default;
  if (!profile) return null;

  const gameVersion = profile.gameVersionEnv
    ? envValues[profile.gameVersionEnv]
    : undefined;

  return {
    label:
      profile.label ??
      support.label ??
      DEFAULT_LABELS[profile.projectType],
    directory: profile.directory,
    projectType: profile.projectType,
    loaders: profile.loaders ?? [],
    ...(gameVersion && CONCRETE_GAME_VERSION.test(gameVersion)
      ? { gameVersion }
      : {}),
    provider: support.provider,
  };
}
