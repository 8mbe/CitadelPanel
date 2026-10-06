/**
 * Generic Bun application blueprint.
 *
 * Bun can run JavaScript or TypeScript directly. The starter uses a TypeScript
 * entry point, which owners may replace with their own `server.ts` and package
 * files in the server data directory.
 */

import type { Blueprint } from "../types";

const installScript = `set -eu
cd /app
if [ ! -f server.ts ]; then
  cat > server.ts <<'TS'
const port = Number(process.env.PORT || 3000);
Bun.serve({
  port,
  fetch() {
    return new Response("CitadelPanel Bun server\\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});
console.log("Bun server listening on " + port);
TS
fi
`;

export const bunjs: Blueprint = {
  key: "bunjs",
  name: "Bun.js",
  description:
    "Generic Bun JavaScript and TypeScript runtime. Edit server.ts or upload your application files to /app.",
  dockerImage: "oven/bun:1",

  defaultPorts: [{ container: 3000, primary: true }],
  primaryPortEnv: "PORT",

  envSchema: {
    NODE_ENV: {
      required: false,
      default: "production",
      description: "Node-compatible environment mode.",
      editable: true,
    },
  },

  startupCommand: "exec bun run server.ts",

  install: {
    image: "oven/bun:1",
    script: installScript,
  },

  user: "1000:1000",
  expectedResourceProfile: "steady-low",
  dataPath: "/app",

  minimums: {
    cpuLimit: 0.25,
    memoryLimitMb: 256,
    diskLimitMb: 512,
  },

  supportsReadOnlyRoot: false,
};

/** Short alias retained for callers that use the runtime name as an identifier. */
export const bun = bunjs;
