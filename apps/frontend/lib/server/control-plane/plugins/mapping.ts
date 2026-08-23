/**
 * Pure response mapping for the plugin fetch engine: reading declared
 * dot-paths out of a catalog's JSON, coercing what they point at, and
 * composing the one provider URL that reaches the browser (a project's page).
 *
 * Split from `engine.ts` because none of this touches the network, the panel's
 * env or the database. It is the part of the provider spec's semantics worth
 * testing directly (`mapping.test.ts`), and the part a wrong cap or a missing
 * `encodeURIComponent` silently breaks.
 */

import type { PluginFetchSpec, PluginProjectType } from "../blueprints/plugins";
import { isBlockedHost } from "../lib/ssrf";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** Read a dot-path ("a.b") out of a JSON value; missing keys read as undefined. */
export function pick(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>(
    (acc, key) => (isRecord(acc) ? acc[key] : undefined),
    source,
  );
}

/** Substitute `{var}` templates. Unknown names are left empty by construction:
 *  validation only admits the fixed vocabulary, and `vars` always defines it. */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => vars[name] ?? "");
}

// --- Coercion of mapped fields ---------------------------------------------------

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function asStringList(value: unknown, cap: number): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").slice(0, cap)
    : [];
}

/**
 * Game-version lists are the one mapped array that must arrive **whole**, with
 * no cap at all. Compatibility is decided by `includes(currentVersion)`, and
 * catalogs return these lists oldest-first (Modrinth's search index does), so
 * *any* cap cuts off the newest entries, exactly the ones a current server
 * runs. A long-lived project easily passes 250 supported versions, and a
 * truncated list made the panel claim "Not for 26.2" about a project whose
 * every recent release supports 26.2. The engine's response size cap is what
 * bounds pathological payloads here.
 */
export function asGameVersionList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export function asChannel(value: unknown): "release" | "beta" | "alpha" {
  return value === "beta" || value === "alpha" ? value : "release";
}

// --- Project page link -----------------------------------------------------------

/**
 * The catalog's human-facing page for a project. This is the only provider URL
 * that reaches the browser, so the panel composes it rather than letting the UI
 * assemble one from spec fields. Undefined when the spec declares no site, and
 * re-validated at compose time (https, not a blocked host) for the same reason
 * the engine re-checks `baseUrl` before every fetch: the spec lives in a
 * database row.
 *
 * The slug is preferred where a catalog has one, but the project id is a
 * working fallback (Modrinth redirects `/mod/<id>` to the canonical page), so
 * a plugin installed before slugs were recorded still links somewhere useful.
 */
export function providerProjectUrl(
  spec: PluginFetchSpec,
  project: {
    projectId: string;
    slug?: string | null;
    projectType: PluginProjectType;
  },
): string | undefined {
  if (!spec.siteUrl || !spec.projectPath) return undefined;
  let site: URL;
  try {
    site = new URL(spec.siteUrl);
  } catch {
    return undefined;
  }
  if (site.protocol !== "https:" || isBlockedHost(site.hostname)) {
    return undefined;
  }
  const vars: Record<string, string> = {
    projectId: project.projectId,
    slug: project.slug || project.projectId,
    projectType: project.projectType,
  };
  const path = spec.projectPath.replace(
    /\{([A-Za-z]+)\}/g,
    (_, name: string) => encodeURIComponent(vars[name] ?? ""),
  );
  return new URL(path, site).toString();
}
