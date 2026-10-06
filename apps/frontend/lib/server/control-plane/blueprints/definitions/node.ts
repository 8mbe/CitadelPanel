/**
 * Generic Node.js application blueprint.
 *
 * The first provision seeds a tiny HTTP app so a new server has a useful
 * running default. Owners can replace `server.js` and add dependencies under
 * `/app` with the file editor or SFTP.
 */

import type { Blueprint } from "../types";

const installScript = `set -eu
cd /app
if [ ! -f server.js ]; then
  cat > server.js <<'JS'
const http = require("node:http");
const port = Number(process.env.PORT || 3000);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("CitadelPanel Node.js server\\n");
});
server.listen(port, "0.0.0.0", () => {
  console.log("Node.js server listening on " + port);
});
JS
fi
`;

export const nodejs: Blueprint = {
  key: "nodejs",
  name: "Node.js",
  description:
    "Generic Node.js application runtime. Edit server.js or upload your application files to /app.",
  dockerImage: "node:22-bookworm-slim",

  defaultPorts: [{ container: 3000, primary: true }],
  primaryPortEnv: "PORT",

  envSchema: {
    NODE_ENV: {
      required: false,
      default: "production",
      description: "Node.js environment mode.",
      editable: true,
    },
  },

  startupCommand: "exec node server.js",

  install: {
    image: "node:22-bookworm-slim",
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
export const node = nodejs;
