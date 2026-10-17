import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

function getBuildCommit(): string {
  const supplied = process.env.PANEL_BUILD_COMMIT?.trim();
  if (supplied) return supplied;

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  // Inline the revision into both server and client bundles at build time.
  env: { NEXT_PUBLIC_BUILD_COMMIT: getBuildCommit() },
};

export default nextConfig;
