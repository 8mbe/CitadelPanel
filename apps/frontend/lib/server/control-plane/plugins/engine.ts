/**
 * Plugin fetch engine — the generic interpreter for a blueprint's provider
 * fetch spec (`PluginFetchSpec`).
 *
 * There are no per-provider modules: a blueprint declares its catalog's
 * endpoints, query templates and response field mappings as data, and this
 * engine executes that declaration with fixed semantics. The security model
 * lives here as much as in validation (`blueprints/plugins.ts`):
 *
 *   - GET-only requests to the spec's validated https origin, with the SSRF
 *     blocklist re-checked at fetch time (protects against DB tampering) and
 *     against the host a redirect actually landed on;
 *   - templates are interpolated from a fixed variable vocabulary — never
 *     evaluated — and values the profile can't supply resolve to empty query
 *     params, which are omitted;
 *   - responses are size-capped, JSON-only, and read exclusively through the
 *     spec's dot-path field mappings, with every mapped string/array trimmed;
 *   - download URLs must be https, exactly match a declared `downloadHosts`
 *     entry and pass the blocklist before the agent is ever asked to fetch.
 *
 * Nothing a catalog returns reaches a command line, a container or anything
 * executable — the only side effect downstream is an inert `.jar` file write
 * through the agent's contained `files/pull`.
 */

import type {
  PluginFetchSpec,
  ResolvedPluginSupport,
  FacetSpec,
} from "../blueprints/plugins";
import { badRequest } from "../lib/http";
import { isBlockedHost } from "../lib/ssrf";

// --- Normalized results --------------------------------------------------------

export interface ProviderSearchResult {
  projectId: string;
  slug?: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  /** Loader/category tags, for display. */
  categories: string[];
  /** Game versions the project supports (trimmed). */
  gameVersions: string[];
}

export interface ProviderVersionFile {
  url: string;
  filename: string;
  sizeBytes: number;
  /** The file the provider recommends for this version. */
  primary: boolean;
}

/** Catalog metadata for a project, recorded on install. */
export interface ProviderProject {
  projectId: string;
  slug?: string;
  title: string;
  iconUrl?: string;
  description?: string;
}

export interface ProviderVersion {
  versionId: string;
  projectId: string;
  name: string;
  versionNumber: string;
  channel: "release" | "beta" | "alpha";
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
  files: ProviderVersionFile[];
}

// --- Fetch ---------------------------------------------------------------------

const USER_AGENT = "CitadelPanel (self-hosted game-server control panel)";
const REQUEST_TIMEOUT_MS = 8_000;
/** Metadata responses are lists of strings and numbers; 1 MB is generous. */
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SEARCH_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** Read a dot-path ("a.b") out of a JSON value; missing keys read as undefined. */
function pick(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>(
    (acc, key) => (isRecord(acc) ? acc[key] : undefined),
    source,
  );
}

/** Substitute `{var}` templates. Unknown names are left empty by construction:
 *  validation only admits the fixed vocabulary, and `vars` always defines it. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => vars[name] ?? "");
}

/**
 * The values every template may reference. `loaders`/`gameVersions` are JSON
 * arrays ("" when the profile has none, so the param is omitted); `facets` is
 * the composed facet grammar. Deliberately no env values — no secret-leakage
 * channel from servers into catalog queries.
 */
function templateVars(
  spec: PluginFetchSpec,
  profile: ResolvedPluginSupport,
  extra: { text?: string; offset?: number; limit?: number; projectId?: string; versionId?: string },
): Record<string, string> {
  const groups: string[][] = [];
  for (const group of spec.facets ?? []) {
    if (group.source === "projectType") {
      groups.push([`${group.prefix}${profile.projectType}`]);
    } else if (group.source === "loaders" && profile.loaders.length > 0) {
      groups.push(profile.loaders.map((l) => `${group.prefix}${l}`));
    } else if (group.source === "gameVersion" && profile.gameVersion) {
      groups.push([`${group.prefix}${profile.gameVersion}`]);
    }
  }

  return {
    query: extra.text ?? "",
    offset: String(extra.offset ?? 0),
    limit: String(extra.limit ?? 10),
    projectId: extra.projectId ?? "",
    versionId: extra.versionId ?? "",
    loaders: profile.loaders.length > 0 ? JSON.stringify(profile.loaders) : "",
    gameVersions: profile.gameVersion
      ? JSON.stringify([profile.gameVersion])
      : "",
    facets: groups.length > 0 ? JSON.stringify(groups) : "",
  };
}

/**
 * Fetch and parse one endpoint's JSON. Returns null on 404 (callers decide
 * whether that means "unknown project" or an error). Everything else — network
 * failure, redirect to a blocked host, oversized or non-JSON body — is a
 * 400-shaped error naming the provider id, never a stack trace.
 */
async function fetchEndpoint(
  spec: PluginFetchSpec,
  path: string,
  query: Record<string, string> | undefined,
  vars: Record<string, string>,
): Promise<unknown> {
  // Runtime re-check of the origin the spec declares. Validation already
  // enforced this at write time; this guards DB tampering after the fact.
  const base = new URL(spec.baseUrl);
  if (base.protocol !== "https:" || isBlockedHost(base.hostname)) {
    throw badRequest(`Plugin catalog "${spec.id}" has a disallowed host.`);
  }

  const url = new URL(
    path.replace(/\{([A-Za-z]+)\}/g, (_, name: string) =>
      encodeURIComponent(vars[name] ?? ""),
    ),
    base,
  );
  for (const [key, template] of Object.entries(query ?? {})) {
    const value = interpolate(template, vars);
    // An unsatisfiable parameter is omitted, not sent empty: a catalog that
    // can't filter by loaders shouldn't receive `loaders=`.
    if (value !== "") url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw badRequest(
      `Plugin catalog "${spec.id}" is unreachable right now. Try again shortly.`,
    );
  }

  // Followed redirects may only land on public hosts — a catalog 3xx must not
  // turn the panel into an internal-network client.
  if (isBlockedHost(new URL(response.url).hostname)) {
    throw badRequest(`Plugin catalog "${spec.id}" redirected to a blocked host.`);
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw badRequest(
      `Plugin catalog "${spec.id}" request failed (${response.status}). Try again shortly.`,
    );
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw badRequest(`Plugin catalog "${spec.id}" response is too large.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest(`Plugin catalog "${spec.id}" returned an unreadable response.`);
  }
}

// --- Coercion of mapped fields ---------------------------------------------------

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asStringList(value: unknown, cap: number): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").slice(0, cap)
    : [];
}

/**
 * Game-version lists must arrive whole: compatibility checks use
 * `includes(currentVersion)`, and catalogs return these lists in arbitrary
 * (Modrinth's search: oldest-first) order, so a truncation can cut off
 * exactly the version a current server runs. 200 is a sanity bound against
 * pathological payloads, not a meaningful limit.
 */
function asGameVersionList(value: unknown): string[] {
  return asStringList(value, 200);
}

function asChannel(value: unknown): "release" | "beta" | "alpha" {
  return value === "beta" || value === "alpha" ? value : "release";
}

// --- Endpoint operations ---------------------------------------------------------

/** Search the catalog. Results missing id or title are dropped, not shown. */
export async function engineSearch(
  support: ResolvedPluginSupport,
  query: { text: string; offset: number; limit: number },
): Promise<{ total: number; results: ProviderSearchResult[] }> {
  const spec = support.provider;
  const vars = templateVars(spec, support, {
    text: query.text,
    offset: query.offset,
    limit: Math.min(Math.max(1, query.limit), MAX_SEARCH_LIMIT),
  });
  const body = await fetchEndpoint(spec, spec.search.path, spec.search.query, vars);
  if (body === null) {
    throw badRequest(`Plugin catalog "${spec.id}" returned no search result.`);
  }

  const list = spec.search.root ? pick(body, spec.search.root) : body;
  if (!Array.isArray(list)) {
    throw badRequest(`Plugin catalog "${spec.id}" returned an unexpected search response.`);
  }
  const total = spec.search.total
    ? asNumber(pick(body, spec.search.total))
    : list.length;

  const fields = spec.search.fields;
  const results: ProviderSearchResult[] = [];
  for (const hit of list) {
    if (!isRecord(hit)) continue;
    const projectId = asString(pick(hit, fields.projectId));
    const title = asString(pick(hit, fields.title));
    if (!projectId || !title) continue;

    const slug = fields.slug ? asString(pick(hit, fields.slug)) : "";
    const iconUrl = fields.iconUrl ? asString(pick(hit, fields.iconUrl)) : "";
    results.push({
      projectId,
      ...(slug ? { slug } : {}),
      title,
      description: fields.description ? asString(pick(hit, fields.description)) : "",
      author: fields.author ? asString(pick(hit, fields.author)) : "",
      ...(iconUrl ? { iconUrl } : {}),
      downloads: fields.downloads ? asNumber(pick(hit, fields.downloads)) : 0,
      categories: fields.categories ? asStringList(pick(hit, fields.categories), 6) : [],
      gameVersions: fields.gameVersions ? asGameVersionList(pick(hit, fields.gameVersions)) : [],
    });
  }

  return { total, results };
}

/** Catalog metadata for a project, or null when unknown or not configured. */
export async function engineGetProject(
  support: ResolvedPluginSupport,
  projectId: string,
): Promise<ProviderProject | null> {
  const spec = support.provider;
  if (!spec.project) return null;

  const vars = templateVars(spec, support, { projectId });
  const body = await fetchEndpoint(spec, spec.project.path, undefined, vars);
  if (body === null || !isRecord(body)) return null;

  const fields = spec.project.fields;
  const title = asString(pick(body, fields.title));
  const iconUrl = fields.iconUrl ? asString(pick(body, fields.iconUrl)) : "";
  return {
    projectId: asString(pick(body, fields.projectId)) || projectId,
    ...(fields.slug && asString(pick(body, fields.slug))
      ? { slug: asString(pick(body, fields.slug)) }
      : {}),
    title: title || projectId,
    ...(iconUrl ? { iconUrl } : {}),
    ...(fields.description
      ? { description: asString(pick(body, fields.description)) }
      : {}),
  };
}

function mapVersion(
  spec: PluginFetchSpec,
  endpoint: NonNullable<PluginFetchSpec["version"]>,
  raw: unknown,
): ProviderVersion | null {
  if (!isRecord(raw)) return null;
  const f = endpoint.fields;

  const versionId = asString(pick(raw, f.versionId));
  const versionNumber = asString(pick(raw, f.versionNumber));
  if (!versionId || !versionNumber) return null;

  const rawFiles = pick(raw, f.files.path);
  const files: ProviderVersionFile[] = Array.isArray(rawFiles)
    ? rawFiles
        .filter(isRecord)
        .map((file) => ({
          url: asString(pick(file, f.files.fields.url)),
          filename: asString(pick(file, f.files.fields.filename)),
          sizeBytes: f.files.fields.sizeBytes
            ? asNumber(pick(file, f.files.fields.sizeBytes))
            : 0,
          primary: f.files.fields.primary
            ? Boolean(pick(file, f.files.fields.primary))
            : false,
        }))
        .filter((file) => file.url !== "" && file.filename !== "")
    : [];

  return {
    versionId,
    projectId: f.projectId ? asString(pick(raw, f.projectId)) : "",
    name: f.name ? asString(pick(raw, f.name)) : versionNumber,
    versionNumber,
    channel: f.channel ? asChannel(pick(raw, f.channel)) : "release",
    gameVersions: f.gameVersions ? asGameVersionList(pick(raw, f.gameVersions)) : [],
    loaders: f.loaders ? asStringList(pick(raw, f.loaders), 8) : [],
    datePublished: f.datePublished ? asString(pick(raw, f.datePublished)) : "",
    files,
  };
}

/** A project's versions, filtered by the profile where the spec supports it. */
export async function engineListVersions(
  support: ResolvedPluginSupport,
  projectId: string,
): Promise<ProviderVersion[]> {
  const spec = support.provider;
  const vars = templateVars(spec, support, { projectId });
  const body = await fetchEndpoint(spec, spec.versions.path, spec.versions.query, vars);
  if (body === null) {
    throw badRequest("That plugin does not exist in the catalog.");
  }
  const list = spec.versions.root ? pick(body, spec.versions.root) : body;
  if (!Array.isArray(list)) {
    throw badRequest(`Plugin catalog "${spec.id}" returned an unexpected version list.`);
  }
  return list
    .map((raw) => mapVersion(spec, spec.versions, raw))
    .filter((v): v is ProviderVersion => v !== null);
}

/**
 * One version by id: via the spec's single-version endpoint when configured,
 * else by scanning the project's version list (still profile-filtered).
 */
export async function engineGetVersion(
  support: ResolvedPluginSupport,
  projectId: string,
  versionId: string,
): Promise<ProviderVersion | null> {
  const spec = support.provider;
  if (spec.version) {
    const vars = templateVars(spec, support, { versionId });
    const body = await fetchEndpoint(spec, spec.version.path, spec.version.query, vars);
    return body === null ? null : mapVersion(spec, spec.version, body);
  }
  const versions = await engineListVersions(support, projectId);
  return versions.find((v) => v.versionId === versionId) ?? null;
}

// --- Download guards ------------------------------------------------------------

/**
 * Enforce the spec's download-host pin on a file URL. Every install path —
 * manual or auto-update — must pass through this before the agent is asked to
 * pull anything.
 */
export function assertDownloadUrl(spec: PluginFetchSpec, url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("The catalog returned a malformed file URL.");
  }
  if (parsed.protocol !== "https:") {
    throw badRequest("The catalog returned a non-https file URL.");
  }
  if (!spec.downloadHosts.includes(parsed.hostname) || isBlockedHost(parsed.hostname)) {
    // Unreachable for honest catalogs; exists so a compromised or buggy
    // upstream response can't redirect installs anywhere it likes.
    throw badRequest(
      `The catalog returned a file from an unexpected host (${parsed.hostname}).`,
    );
  }
  return parsed;
}

/** The file a version install should write: the primary, else the first. */
export function pickVersionFile(version: ProviderVersion): ProviderVersionFile {
  return version.files.find((file) => file.primary) ?? version.files[0];
}

/** Facet composition, exported for tests. */
export function composeFacets(
  groups: FacetSpec[],
  profile: ResolvedPluginSupport,
): string {
  return templateVars(profile.provider, profile, {}).facets;
}
