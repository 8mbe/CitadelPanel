/**
 * The Modrinth provider fetch spec, as blueprint data.
 *
 * Shared by the built-in minecraft-java blueprint (server) and the blueprint
 * form's "Modrinth preset" button (client), so there is exactly one copy of
 * the endpoint/mapping declaration. Isomorphic by construction: types only,
 * no server or browser dependencies.
 *
 * Endpoint and field names follow https://docs.modrinth.com/ — search facets
 * are AND-ed groups (`project_type`, `categories` for loaders, `versions` for
 * game versions); version lists are filtered with the `loaders` /
 * `game_versions` query params and return newest-first.
 */

import type { BlueprintPluginsSpec } from "./types";

export const MODRINTH_PROVIDER_SPEC: BlueprintPluginsSpec["provider"] = {
  id: "modrinth",
  baseUrl: "https://api.modrinth.com",
  downloadHosts: ["cdn.modrinth.com"],
  // The site (not the API) plus the shape of a project page, so the plugins
  // tab can offer "open on Modrinth". Modrinth canonicalises the type segment
  // itself, so a plugin project reached as /mod/... simply redirects.
  siteUrl: "https://modrinth.com",
  projectPath: "/{projectType}/{slug}",
  facets: [
    { source: "projectType", prefix: "project_type:" },
    { source: "loaders", prefix: "categories:" },
    { source: "gameVersion", prefix: "versions:" },
  ],
  search: {
    path: "/v2/search",
    query: {
      query: "{query}",
      facets: "{facets}",
      index: "relevance",
      offset: "{offset}",
      limit: "{limit}",
    },
    root: "hits",
    total: "total_hits",
    fields: {
      projectId: "project_id",
      slug: "slug",
      title: "title",
      description: "description",
      author: "author",
      iconUrl: "icon_url",
      downloads: "downloads",
      categories: "categories",
      gameVersions: "versions",
    },
  },
  project: {
    path: "/v2/project/{projectId}",
    fields: {
      projectId: "id",
      slug: "slug",
      title: "title",
      iconUrl: "icon_url",
      description: "description",
    },
  },
  versions: {
    path: "/v2/project/{projectId}/version",
    query: {
      loaders: "{loaders}",
      game_versions: "{gameVersions}",
    },
    fields: {
      versionId: "id",
      projectId: "project_id",
      name: "name",
      versionNumber: "version_number",
      channel: "version_type",
      gameVersions: "game_versions",
      loaders: "loaders",
      datePublished: "date_published",
      files: {
        path: "files",
        fields: {
          url: "url",
          filename: "filename",
          sizeBytes: "size",
          primary: "primary",
        },
      },
    },
  },
  version: {
    path: "/v2/version/{versionId}",
    fields: {
      versionId: "id",
      projectId: "project_id",
      name: "name",
      versionNumber: "version_number",
      channel: "version_type",
      gameVersions: "game_versions",
      loaders: "loaders",
      datePublished: "date_published",
      files: {
        path: "files",
        fields: {
          url: "url",
          filename: "filename",
          sizeBytes: "size",
          primary: "primary",
        },
      },
    },
  },
};
