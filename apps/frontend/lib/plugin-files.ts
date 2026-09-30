import type { PluginVersionView, ServerPluginList } from "./types";
import { isContentFilename, pickContentFile } from "./server/control-plane/plugins/files";

type ProjectType = ServerPluginList["support"]["projectType"];

/** Plain catalog filenames only; the agent still contains the final path. */
export function isPluginFilename(filename: string, projectType: ProjectType): boolean {
  return isContentFilename(filename, projectType);
}

/** A primary file can belong to a different content type on a mixed project. */
export function selectPluginVersionFile(
  version: Pick<PluginVersionView, "files">,
  projectType: ProjectType,
): PluginVersionView["files"][number] | undefined {
  return pickContentFile(
    version.files.filter((file) => file.url !== ""),
    projectType,
  );
}
