import type { BlueprintPluginProviderSpec } from "./types";

/** Hangar's public GET API. Only files uploaded directly to Hangar are mapped. */
export function hangarProviderSpec(
  platform: "PAPER" | "VELOCITY" = "PAPER",
): BlueprintPluginProviderSpec {
  const fields: BlueprintPluginProviderSpec["versions"]["fields"] = {
    versionId: "id",
    projectId: "projectId",
    versionNumber: "name",
    channel: "channel.name",
    ...(platform === "PAPER"
      ? { gameVersions: `platformDependencies.${platform}` }
      : {}),
    datePublished: "createdAt",
    files: {
      path: `downloads.${platform}`,
      single: true,
      fields: {
        url: "downloadUrl",
        filename: "fileInfo.name",
        sizeBytes: "fileInfo.sizeBytes",
      },
    },
  };
  return {
    id: "hangar",
    baseUrl: "https://hangar.papermc.io",
    downloadHosts: ["hangarcdn.papermc.io"],
    releaseChannels: ["Release"],
    siteUrl: "https://hangar.papermc.io",
    projectPath: "/{author}/{slug}",
    search: {
      path: "/api/v1/projects",
      query: {
        q: "{query}",
        offset: "{offset}",
        limit: "{limit}",
        platform,
        ...(platform === "PAPER" ? { version: "{gameVersion}" } : {}),
        sort: "downloads",
      },
      root: "result",
      total: "pagination.count",
      fields: {
        projectId: "id",
        slug: "namespace.slug",
        title: "name",
        description: "description",
        author: "namespace.owner",
        iconUrl: "avatarUrl",
        downloads: "stats.downloads",
        ...(platform === "PAPER"
          ? { gameVersions: `supportedPlatforms.${platform}` }
          : {}),
      },
    },
    project: {
      path: "/api/v1/projects/{projectId}",
      fields: {
        projectId: "id",
        slug: "namespace.slug",
        author: "namespace.owner",
        title: "name",
        description: "description",
        iconUrl: "avatarUrl",
      },
    },
    versions: {
      path: "/api/v1/projects/{projectId}/versions",
      query: {
        platform,
        ...(platform === "PAPER" ? { platformVersion: "{gameVersion}" } : {}),
        limit: "25",
        includeHiddenChannels: "false",
      },
      root: "result",
      fields,
    },
    version: { path: "/api/v1/versions/{versionId}", fields },
  };
}

export const HANGAR_PROVIDER_SPEC = hangarProviderSpec();
