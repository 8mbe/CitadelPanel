/** NanoLimbo lightweight Minecraft fallback server. */
import type { Blueprint } from "../types";

const installScript = `set -eu
cd /server

# Download the latest release jar into the mounted data directory. The Docker
# image is deliberately a plain JRE: mounting /server hides files baked into an
# image at that path, so using a dedicated installer keeps rebuilds working.
asset=$(wget -qO- https://api.github.com/repos/Nan1t/NanoLimbo/releases/latest \\
  | sed -nE 's/.*"browser_download_url": "([^"]+\\.jar)".*/\\1/p' \\
  | head -n 1)
if [ -z "$asset" ]; then
  echo "NanoLimbo release has no downloadable jar" >&2
  exit 1
fi
wget -qO NanoLimbo.jar "$asset"

# Seed the complete upstream config once, then pin only bind.port to the
# panel-allocated identity port. Existing owner edits survive reinstall.
if [ ! -f settings.yml ]; then
  wget -qO settings.yml https://raw.githubusercontent.com/Nan1t/NanoLimbo/main/src/main/resources/settings.yml
fi
sed -i -E 's/^([[:space:]]+port:).*/\\1 '"$PORT"'/' settings.yml
`;

export const nanolimbo: Blueprint = {
  key: "nanolimbo",
  name: "NanoLimbo",
  description:
    "Lightweight Minecraft limbo server for proxy fallbacks and maintenance queues.",
  dockerImage: "eclipse-temurin:21-jre",
  // 25565 is the familiar Minecraft port; the installer and startup command
  // rewrite NanoLimbo's upstream 65535 default to the allocated identity port.
  defaultPorts: [{ container: 25565, primary: true }],
  primaryPortEnv: "PORT",
  envSchema: {},
  startupCommand:
    "if [ -f settings.yml ]; then sed -i -E 's/^([[:space:]]+port:).*/\\1 {{PORT}}/' settings.yml; fi; exec java -jar NanoLimbo.jar",
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
