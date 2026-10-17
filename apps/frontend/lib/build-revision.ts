import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function commitHash(value: string): string | undefined {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ? value : undefined;
}

/** Read the checkout's revision without Git or its object database. */
export function readGitRevision(gitDirectory: string): string | undefined {
  const head = readText(resolve(gitDirectory, "HEAD"));
  const detached = commitHash(head);
  if (detached) return detached;

  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
  if (!ref) return undefined;
  const refPath = resolve(gitDirectory, ref);
  if (!refPath.startsWith(resolve(gitDirectory) + sep)) return undefined;

  const loose = commitHash(readText(refPath));
  if (loose) return loose;

  // Packed refs are common in fresh clones and after Git maintenance.
  for (const line of readText(resolve(gitDirectory, "packed-refs")).split("\n")) {
    const [hash, name] = line.split(" ");
    if (name === ref) return commitHash(hash);
  }
  return undefined;
}
