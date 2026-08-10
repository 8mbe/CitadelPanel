import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load the repository-root `.env` into `process.env` when running from a
 * workspace subdirectory or through tools like `bunx`/`jiti` that do not inherit
 * Bun's normal `.env` loading behavior.
 *
 * Existing environment variables always win.
 */
export function loadRepositoryEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", "..", ".env"),
  ];
  const path = candidates.find(existsSync);
  if (!path) return;

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
