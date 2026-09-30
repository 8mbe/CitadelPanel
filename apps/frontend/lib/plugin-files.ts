import type { PluginVersionView, ServerPluginList } from "./types";

type ProjectType = ServerPluginList["support"]["projectType"];

/** Plain catalog filenames only; the agent still contains the final path. */
export function isPluginFilename(filename: string, projectType: ProjectType): boolean {
  const pattern = projectType === "datapack"
    ? /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,120}\.zip$/
    : /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,120}\.jar$/;
  return pattern.test(filename);
}

/** A primary file can belong to a different content type on a mixed project. */
export function selectPluginVersionFile(
  version: Pick<PluginVersionView, "files">,
  projectType: ProjectType,
): PluginVersionView["files"][number] | undefined {
  const files = version.files.filter((file) =>
    file.url !== "" && isPluginFilename(file.filename, projectType),
  );
  return files.find((file) => file.primary) ?? files[0];
}
