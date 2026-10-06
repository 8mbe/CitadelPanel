/**
 * Generic Python application blueprint.
 *
 * The image is intentionally a plain Python runtime rather than a framework
 * image. A small starter app is written on first provision when the owner has
 * not uploaded one yet; replacing `main.py` in Files turns this into any
 * Python service without changing the blueprint.
 */

import type { Blueprint } from "../types";

const installScript = `set -eu
cd /app
if [ ! -f main.py ]; then
  cat > main.py <<'PY'
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"CitadelPanel Python server\\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(format % args, flush=True)

port = int(os.environ.get("PORT", "8000"))
ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
PY
fi
`;

export const python: Blueprint = {
  key: "python",
  name: "Python",
  description:
    "Generic Python application runtime. Edit main.py or upload your application files to /app.",
  dockerImage: "python:3.12-slim",

  defaultPorts: [{ container: 8000, primary: true }],
  primaryPortEnv: "PORT",

  envSchema: {
    PYTHONUNBUFFERED: {
      required: false,
      default: "1",
      description: "Flush Python output immediately for live panel logs.",
    },
  },

  startupCommand: "exec python3 main.py",

  install: {
    image: "python:3.12-slim",
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
