import type { PluginProjectType } from "../blueprints/plugins";
import type { ProviderVersionFile } from "./engine";

const CONTENT_FILENAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,120}\.(jar|zip)$/;

/** A datapack project can offer both a ZIP and a primary mod-wrapped JAR. */
export function pickContentFile(
  files: ProviderVersionFile[],
  projectType: PluginProjectType,
): ProviderVersionFile | undefined {
  const extension = projectType === "datapack" ? ".zip" : ".jar";
  const eligible = files.filter(
    (file) =>
      CONTENT_FILENAME.test(file.filename) && file.filename.endsWith(extension),
  );
  return eligible.find((file) => file.primary) ?? eligible[0];
}

export function isContentFilename(
  filename: string,
  projectType: PluginProjectType,
): boolean {
  return (
    CONTENT_FILENAME.test(filename) &&
    filename.endsWith(projectType === "datapack" ? ".zip" : ".jar")
  );
}
