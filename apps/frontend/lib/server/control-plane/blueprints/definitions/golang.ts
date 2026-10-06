/**
 * Generic Go application blueprint.
 *
 * Go is run from source with `go run`, which keeps the blueprint useful for a
 * freshly-created server and lets an owner edit main.go without a build step.
 */

import type { Blueprint } from "../types";

const installScript = `set -eu
cd /app
if [ ! -f go.mod ]; then
  cat > go.mod <<'MOD'
module citadelpanel-server

go 1.23
MOD
fi
if [ ! -f main.go ]; then
  cat > main.go <<'GO'
package main

import (
  "fmt"
  "net/http"
  "os"
)

func main() {
  port := os.Getenv("PORT")
  if port == "" {
    port = "8080"
  }
  http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
    w.Header().Set("Content-Type", "text/plain; charset=utf-8")
    fmt.Fprintln(w, "CitadelPanel Go server")
  })
  fmt.Println("Go server listening on " + port)
  if err := http.ListenAndServe("0.0.0.0:"+port, nil); err != nil {
    panic(err)
  }
}
GO
fi
`;

export const golang: Blueprint = {
  key: "golang",
  name: "Go",
  description:
    "Generic Go application runtime. Edit main.go or upload your application files to /app.",
  dockerImage: "golang:1.23-alpine",

  defaultPorts: [{ container: 8080, primary: true }],
  primaryPortEnv: "PORT",

  envSchema: {
    CGO_ENABLED: {
      required: false,
      default: "0",
      options: ["0", "1"],
      description: "Enable cgo when the application needs native libraries.",
      editable: true,
    },
    GOCACHE: {
      required: false,
      default: "/tmp/go-build",
      description: "Writable build cache for the unprivileged runtime user.",
    },
    GOPATH: {
      required: false,
      default: "/tmp/go",
      description: "Writable module and package cache for the runtime user.",
    },
  },

  startupCommand: "exec go run main.go",

  install: {
    image: "golang:1.23-alpine",
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
