/**
 * Generic Java application blueprint.
 *
 * The first provision creates a tiny HTTP JAR when `server.jar` is absent, so
 * the blueprint can be tested immediately. Replacing that file with an
 * application's JAR is all that is needed for a normal Java service.
 */

import type { Blueprint } from "../types";

const installScript = `set -eu
cd /app
if [ ! -f server.jar ]; then
  cat > Main.java <<'JAVA'
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;

public final class Main {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
    server.createContext("/", Main::handle);
    server.start();
    System.out.println("Java server listening on " + port);
  }

  private static void handle(HttpExchange exchange) throws IOException {
    byte[] body = "CitadelPanel Java server\\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
    exchange.sendResponseHeaders(200, body.length);
    try (OutputStream output = exchange.getResponseBody()) {
      output.write(body);
    }
  }
}
JAVA
  javac --add-modules jdk.httpserver Main.java
  printf 'Main-Class: Main\\n' > MANIFEST.MF
  jar cfm server.jar MANIFEST.MF Main.class
  rm -f Main.java Main.class MANIFEST.MF
fi
`;

export const java: Blueprint = {
  key: "java",
  name: "Java",
  description:
    "Generic Java application runtime. Upload a JAR as server.jar or replace the starter JAR in /app.",
  dockerImage: "eclipse-temurin:21-jre",

  defaultPorts: [{ container: 8080, primary: true }],
  primaryPortEnv: "PORT",

  envSchema: {
    JAVA_TOOL_OPTIONS: {
      required: false,
      description: "Additional JVM options applied by the Java runtime.",
      editable: true,
    },
  },

  startupCommand: "exec java --add-modules jdk.httpserver -jar server.jar",

  install: {
    image: "eclipse-temurin:21-jdk",
    script: installScript,
  },

  user: "1000:1000",
  expectedResourceProfile: "steady-low",
  dataPath: "/app",

  minimums: {
    cpuLimit: 0.25,
    memoryLimitMb: 384,
    diskLimitMb: 512,
  },

  supportsReadOnlyRoot: false,
};
