/** NanoLimbo lightweight Minecraft fallback server. */
import type { Blueprint } from "../types";

const installScript = `set -eu
cd /server

# Download the latest release jar into the mounted data directory. The Docker
# image is deliberately a plain JRE: mounting /server hides files baked into an
# image at that path, so using a dedicated installer keeps rebuilds working.
# Alpine's built-in wget is used because install containers run as the data
# owner and cannot install packages after startup.
asset=$(wget -qO- https://api.github.com/repos/Nan1t/NanoLimbo/releases/latest \\
  | sed -nE 's/.*"browser_download_url": "([^"]+\\.jar)".*/\\1/p' | head -n 1)
if [ -z "$asset" ]; then
  echo "NanoLimbo release has no downloadable jar" >&2
  exit 1
fi
wget -qO NanoLimbo.jar "$asset"

# The upstream default binds to localhost. Seed a public bind and let the
# panel-owned PORT value keep the listener in step with identity allocation.
if [ ! -f settings.yml ]; then
  cat > settings.yml <<'YAML'
bind:
  ip: ''
  port: \${PORT:-25565}
YAML
fi
`;

export const nanolimbo: Blueprint = {
  key: "nanolimbo",
  name: "NanoLimbo",
  description:
    "Lightweight Minecraft limbo server for proxy fallbacks and maintenance queues.",
  // Keep the runtime image free of application files so the panel's /server
  // bind mount does not hide the jar. The install step downloads the release.
  dockerImage: "eclipse-temurin:21-jre",
  defaultPorts: [{ container: 25565, primary: true }],
  primaryPortEnv: "PORT",
  envSchema: {},
  startupCommand:
    "sed -i -E 's/^  port: .*/  port: {{PORT}}/' settings.yml; exec java -jar NanoLimbo.jar",
  install: {
    image: "alpine:3.20",
    script: installScript,
  },
  stopCommand: "stop",
  user: "1000:1000",
  expectedResourceProfile: "steady-low",
  dataPath: "/server",
  minimums: {
    cpuLimit: 0.25,
    memoryLimitMb: 256,
    diskLimitMb: 512,
  },
  supportsReadOnlyRoot: false,
  tty: true,
};
