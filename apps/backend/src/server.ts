/**
 * Agent HTTP + WebSocket entrypoint.
 *
 * Runs on every node, next to the Docker socket it drives. The panel is the only
 * caller and authenticates with a bearer token; there are no users, sessions or
 * permissions here because authorization already happened panel-side.
 *
 * Routes are keyed by **server id**, never container id or host path — see
 * `servers.ts` for why that indirection is load-bearing.
 */

import { requireAuth, isAuthorized } from "./auth";
import { config } from "./config";
import { probeDataRoot, reportDataRootAtBoot } from "./dataRoot";
import { readDaemonInfo } from "./docker/client";
import { probePorts, type PortProtocol } from "./docker/ports";
import {
  createDirectory,
  deletePath,
  listDirectory,
  readFile,
  writeFile,
} from "./files";
import {
  badRequest,
  json,
  noContent,
  parseJsonBody,
  requireServerId,
  toErrorResponse,
  SSE_HEADERS,
  sseWrap,
  sseFromEvents,
  HttpError,
} from "./http";
import {
  attachToServer,
  createServerContainer,
  deleteServerContainer,
  getServerLogs,
  getServerState,
  getServerStats,
  installServer,
  killServerContainer,
  restartServerContainer,
  sampleServers,
  sendServerCommand,
  startServerContainer,
  stopServerContainer,
  streamServerLogs,
  type CreateContainerRequest,
  type InstallRequest,
} from "./servers";
import type { Attachment } from "./docker/attach";
import type { PortBinding } from "./docker/hardening";

/** Wrap a handler so thrown `HttpError`s become responses. */
function route<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    try {
      requireAuth(request);
      return await handler(request, ...args);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** Bun passes matched path params on `request.params`. */
type ParamRequest<K extends string> = Request & { params: Record<K, string> };

const serverIdOf = (request: Request): string =>
  requireServerId((request as ParamRequest<"id">).params.id);

const queryOf = (request: Request) => new URL(request.url).searchParams;

// --- Body validation ----------------------------------------------------------

/**
 * Validate a container-create body.
 *
 * Strict because these values become Docker resource limits and bind mounts.
 * `hostDataPath` and `name` are deliberately absent from the accepted shape —
 * the agent derives both, so a caller cannot influence what gets mounted.
 */
function parseCreateRequest(body: Record<string, unknown>): CreateContainerRequest {
  const image = body.image;
  if (typeof image !== "string" || image.length === 0) {
    throw badRequest('"image" is required.');
  }

  const containerDataPath = body.containerDataPath;
  if (typeof containerDataPath !== "string" || !containerDataPath.startsWith("/")) {
    throw badRequest('"containerDataPath" must be an absolute path.');
  }

  const cpuLimit = Number(body.cpuLimit);
  const memoryLimitMb = Number(body.memoryLimitMb);
  if (!Number.isFinite(cpuLimit) || cpuLimit <= 0) {
    throw badRequest('"cpuLimit" must be a positive number.');
  }
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb <= 0) {
    throw badRequest('"memoryLimitMb" must be a positive number.');
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.env ?? {})) {
    if (typeof value !== "string") {
      throw badRequest(`env value for "${key}" must be a string.`);
    }
    env[key] = value;
  }

  if (!Array.isArray(body.ports)) {
    throw badRequest('"ports" must be an array.');
  }
  const ports: PortBinding[] = body.ports.map((entry) => {
    const port = entry as Record<string, unknown>;
    const hostPort = Number(port.hostPort);
    const containerPort = Number(port.containerPort);
    const protocol = port.protocol;

    if (!Number.isInteger(hostPort) || !Number.isInteger(containerPort)) {
      throw badRequest("Each port needs integer hostPort and containerPort.");
    }
    if (protocol !== "tcp" && protocol !== "udp") {
      throw badRequest('Port protocol must be "tcp" or "udp".');
    }
    return { hostPort, containerPort, protocol };
  });

  const command = Array.isArray(body.command)
    ? body.command.map((part) => {
        if (typeof part !== "string") {
          throw badRequest('"command" must be an array of strings.');
        }
        return part;
      })
    : undefined;

  // A uid or uid:gid only — never a username. The panel is trusted, but this is
  // a privilege pin, so a name like "root" here would defeat the purpose of
  // running the container non-root.
  const user =
    typeof body.user === "string" && body.user.length > 0 ? body.user : undefined;
  if (user !== undefined && !/^\d+(:\d+)?$/.test(user)) {
    throw badRequest('"user" must be a "uid" or "uid:gid" of digits only.');
  }

  return {
    image,
    containerDataPath,
    env,
    ports,
    cpuLimit,
    memoryLimitMb,
    readOnlyRootFilesystem: body.readOnlyRootFilesystem === true,
    command,
    user,
  };
}

/**
 * Validate a one-time install body.
 *
 * Same posture as `parseCreateRequest`: `hostDataPath`/`name` are derived
 * agent-side, and the script's target is the server's own data directory only.
 */
function parseInstallRequest(body: Record<string, unknown>): InstallRequest {
  const image = body.image;
  if (typeof image !== "string" || image.length === 0) {
    throw badRequest('"image" is required.');
  }

  const script = body.script;
  if (typeof script !== "string" || script.trim().length === 0) {
    throw badRequest('"script" is required.');
  }

  const containerDataPath = body.containerDataPath;
  if (typeof containerDataPath !== "string" || !containerDataPath.startsWith("/")) {
    throw badRequest('"containerDataPath" must be an absolute path.');
  }

  const cpuLimit = Number(body.cpuLimit);
  const memoryLimitMb = Number(body.memoryLimitMb);
  if (!Number.isFinite(cpuLimit) || cpuLimit <= 0) {
    throw badRequest('"cpuLimit" must be a positive number.');
  }
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb <= 0) {
    throw badRequest('"memoryLimitMb" must be a positive number.');
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.env ?? {})) {
    if (typeof value !== "string") {
      throw badRequest(`env value for "${key}" must be a string.`);
    }
    env[key] = value;
  }

  const entrypoint = Array.isArray(body.entrypoint)
    ? body.entrypoint.map((part) => {
        if (typeof part !== "string") {
          throw badRequest('"entrypoint" must be an array of strings.');
        }
        return part;
      })
    : undefined;

  return { image, script, entrypoint, containerDataPath, env, cpuLimit, memoryLimitMb };
}

/** Read an optional stop/restart grace period. */
function timeoutOf(body: Record<string, unknown>): number | undefined {
  if (body.timeoutSeconds === undefined) return undefined;
  const seconds = Number(body.timeoutSeconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
    throw badRequest('"timeoutSeconds" must be between 0 and 600.');
  }
  return seconds;
}
// --- Console WebSocket --------------------------------------------------------

/**
 * Per-socket state for an attached console.
 *
 * The attachment is held here rather than in a module map so it is released
 * when the socket closes, with no keyed cleanup to get wrong.
 */
interface ConsoleSocket {
  serverId: string;
  attachment: Attachment | null;
}

const server = Bun.serve<ConsoleSocket, never>({
  port: config.port,

  // A console SSE stream is quiet for as long as the game server is idle, and
  // Bun closes idle connections after ~10s by default — which killed the live
  // console mid-session. `0` disables the idle timeout so an SSE stream stays
  // open until the browser closes it (the abort then propagates to dockerode).
  // The keepalive pings in `sseWrap` still help intermediaries (proxies) that
  // impose their own idle limits.
  idleTimeout: 0,

  routes: {
    // --- Health ---------------------------------------------------------------
    /**
     * Reports daemon reachability plus host capacity, which the panel uses to
     * auto-fill a node's CPU/memory totals at registration.
     *
     * `dataRoot` is re-probed on every call rather than cached: it is how the
     * panel knows this node can actually store server data before it places one
     * here, and an admin who fixes the permissions expects the next probe to say
     * so without restarting the agent.
     */
    "/v1/health": {
      GET: route(async () => {
        const [info, dataRoot] = await Promise.all([
          readDaemonInfo(),
          probeDataRoot(),
        ]);
        return json({
          status: "ok",
          dockerVersion: info.serverVersion,
          containersRunning: info.containersRunning,
          capacity: { ncpu: info.ncpu, memTotalMb: info.memTotalMb },
          serverDataRoot: config.serverDataRoot,
          dataRoot,
        });
      }),
    },

    // --- Batch stats ----------------------------------------------------------
    /**
     * One sample per requested server. The panel's watcher sweeps the whole
     * fleet on a timer, so this keeps that at one request per node rather than
     * one per container.
     */
    "/v1/stats": {
      POST: route(async (request) => {
        const body = await parseJsonBody(request);
        if (!Array.isArray(body.serverIds)) {
          throw badRequest('"serverIds" must be an array.');
        }

        const serverIds = body.serverIds.map((id) =>
          requireServerId(typeof id === "string" ? id : undefined),
        );

        return json({ samples: await sampleServers(serverIds) });
      }),
    },

    // --- Port availability ----------------------------------------------------
    /**
     * Probes whether host ports are bindable right now, for the panel's
     * port-pool reservation and allocation flows. A taken port is a result
     * (`free: false`), never an error — only malformed input 400s.
     */
    "/v1/ports/free": {
      POST: route(async (request) => {
        const body = await parseJsonBody(request);
        if (!Array.isArray(body.ports)) {
          throw badRequest('"ports" must be an array.');
        }

        const probes = body.ports.map((entry, index) => {
          const port = entry as Record<string, unknown>;
          const hostPort = Number(port.hostPort);
          if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
            throw badRequest(`ports[${index}].hostPort must be an integer 1-65535.`);
          }
          const protocol = port.protocol;
          if (protocol !== "tcp" && protocol !== "udp") {
            throw badRequest(`ports[${index}].protocol must be "tcp" or "udp".`);
          }
          return { hostPort, protocol: protocol as PortProtocol };
        });

        return json({ results: await probePorts(probes) });
      }),
    },

    // --- Container lifecycle --------------------------------------------------
    "/v1/servers/:id/container": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const spec = parseCreateRequest(await parseJsonBody(request));
        const created = await createServerContainer(serverId, spec);
        return json(created, 201);
      }),
      DELETE: route(async (request) => {
        const serverId = serverIdOf(request);
        const deleteData = queryOf(request).get("deleteData") === "true";
        await deleteServerContainer(serverId, deleteData);
        return noContent();
      }),
    },

    "/v1/servers/:id/start": {
      POST: route(async (request) => {
        await startServerContainer(serverIdOf(request));
        return noContent();
      }),
    },
    "/v1/servers/:id/install": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const spec = parseInstallRequest(await parseJsonBody(request));
        const result = await installServer(serverId, spec);
        return json(result);
      }),
    },
    "/v1/servers/:id/stop": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        // A stop may legitimately arrive with no body.
        const body = request.headers.get("content-length")
          ? await parseJsonBody(request)
          : {};
        await stopServerContainer(serverId, timeoutOf(body));
        return noContent();
      }),
    },
    "/v1/servers/:id/restart": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = request.headers.get("content-length")
          ? await parseJsonBody(request)
          : {};
        await restartServerContainer(serverId, timeoutOf(body));
        return noContent();
      }),
    },

    // Force-stop (SIGKILL) — the escape hatch for a container stuck in a
    // graceful stop/restart. No body, no grace period.
    "/v1/servers/:id/kill": {
      POST: route(async (request) => {
        await killServerContainer(serverIdOf(request));
        return noContent();
      }),
    },

    "/v1/servers/:id/state": {
      GET: route(async (request) =>
        json({ state: await getServerState(serverIdOf(request)) }),
      ),
    },

    "/v1/servers/:id/logs": {
      GET: route(async (request) => {
        const serverId = serverIdOf(request);
        const raw = Number(queryOf(request).get("tail"));
        const tail = Math.min(Math.max(Number.isFinite(raw) ? raw : 200, 1), 2000);
        return json({ logs: await getServerLogs(serverId, tail) });
      }),
    },

    // --- Live console (SSE) ---------------------------------------------------
    /**
     * A follow-mode log stream as Server-Sent Events.
     *
     * The panel's console Route Handler proxies this straight to the browser,
     * so the live feed flows Browser ← panel ← agent ← Docker without polling.
     * The panel authenticates the caller and holds the bearer token; this route
     * only verifies the agent token, like every other route here.
     *
     * `request.signal` is forwarded to dockerode, so when the browser closes
     * the EventSource the abort propagates back and releases the daemon's log
     * stream — no leaked attach.
     */
    "/v1/servers/:id/logs/stream": {
      GET: route(async (request) => {
        const serverId = serverIdOf(request);
        const raw = Number(queryOf(request).get("tail"));
        const tail = Math.min(Math.max(Number.isFinite(raw) ? raw : 200, 1), 2000);

        try {
          const body = await streamServerLogs(serverId, tail, request.signal);
          return new Response(sseWrap(body), { headers: SSE_HEADERS });
        } catch (error) {
          // No container (404) or an upstream failure: deliver it as a terminal
          // SSE event the browser can display, rather than a bare HTTP error
          // that EventSource swallows. The event is named `console` (not
          // `error`, which EventSource reserves for transport failures).
          const message =
            error instanceof HttpError
              ? error.message
              : "Internal agent error";
          const body = sseFromEvents([{ type: "console", message }]);
          return new Response(body, { headers: SSE_HEADERS });
        }
      }),
    },

    "/v1/servers/:id/stats": {
      GET: route(async (request) =>
        json({ stats: await getServerStats(serverIdOf(request)) }),
      ),
    },

    "/v1/servers/:id/command": {
      POST: route(async (request) => {
        const body = await parseJsonBody(request);
        if (typeof body.command !== "string" || body.command.trim().length === 0) {
          throw badRequest('"command" must be a non-empty string.');
        }
        if (body.command.length > 4_096) {
          throw badRequest('"command" must be at most 4096 characters.');
        }
        await sendServerCommand(serverIdOf(request), body.command);
        return noContent();
      }),
    },

    // --- File manager ---------------------------------------------------------
    "/v1/servers/:id/files": {
      GET: route(async (request) => {
        const serverId = serverIdOf(request);
        const path = queryOf(request).get("path") ?? "/";
        return json({ path, entries: await listDirectory(serverId, path) });
      }),
      DELETE: route(async (request) => {
        const serverId = serverIdOf(request);
        const path = queryOf(request).get("path");
        if (!path) throw badRequest('"path" query parameter is required.');
        await deletePath(serverId, path);
        return noContent();
      }),
    },

    "/v1/servers/:id/files/content": {
      GET: route(async (request) => {
        const serverId = serverIdOf(request);
        const path = queryOf(request).get("path");
        if (!path) throw badRequest('"path" query parameter is required.');
        return json({ path, contents: await readFile(serverId, path) });
      }),
      PUT: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);

        const path = typeof body.path === "string" ? body.path : null;
        if (!path) throw badRequest('"path" is required.');
        if (typeof body.contents !== "string") {
          throw badRequest('"contents" must be a string.');
        }

        await writeFile(serverId, path, body.contents);
        return noContent();
      }),
    },

    "/v1/servers/:id/files/directory": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);
        if (typeof body.path !== "string") throw badRequest('"path" is required.');
        await createDirectory(serverId, body.path);
        return noContent();
      }),
    },
  },

  /**
   * Console upgrade and 404s.
   *
   * The WebSocket handshake cannot use the `routes` table because it needs the
   * raw `server.upgrade` call, so it is matched here.
   */
  fetch(request, srv) {
    const url = new URL(request.url);
    const match = /^\/v1\/servers\/([^/]+)\/console$/.exec(url.pathname);

    if (match) {
      // Browsers cannot set headers on a WebSocket handshake, but the panel is
      // a server-side client and can — so the token is still a header, never a
      // query parameter where it would leak into logs.
      if (!isAuthorized(request)) {
        return json({ error: "A valid bearer token is required." }, 401);
      }

      let serverId: string;
      try {
        serverId = requireServerId(match[1]);
      } catch (error) {
        return toErrorResponse(error);
      }

      if (srv.upgrade(request, { data: { serverId, attachment: null } })) {
        return undefined;
      }
      return json({ error: "WebSocket upgrade failed." }, 400);
    }

    return json({ error: "Not found" }, 404);
  },

  websocket: {
    /**
     * Attach to the container and start piping output.
     *
     * Attach failures are reported to the client and then close the socket:
     * a console that silently shows nothing is worse than one that says why.
     */
    async open(ws) {
      try {
        ws.data.attachment = await attachToServer(ws.data.serverId, {
          // Framing is already stripped by the attach layer, so this is the
          // raw payload the container wrote.
          onData: (chunk) => {
            ws.send(
              JSON.stringify({ type: "output", data: chunk.toString("utf8") }),
            );
          },
          onClose: () => {
            ws.send(JSON.stringify({ type: "closed" }));
            ws.close();
          },
          onError: (error) => {
            console.error(
              `[agent] console stream error for ${ws.data.serverId}:`,
              error,
            );
            ws.close();
          },
        });

        // Wait for Docker to acknowledge the attach upgrade before telling the
        // client the console is ready. Without this, input sent immediately
        // after "ready" races the handshake and loses its first byte.
        await ws.data.attachment.ready;
        ws.send(JSON.stringify({ type: "ready" }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ws.send(JSON.stringify({ type: "error", message }));
        ws.close();
      }
    },

    /**
     * Forward a command to the container's stdin.
     *
     * The panel has already checked the caller's `console` permission and
     * audited the command; the agent only transports it.
     */
    message(ws, message) {
      const attachment = ws.data.attachment;
      if (!attachment) return;

      let parsed: { type?: string; data?: unknown };
      try {
        parsed = JSON.parse(typeof message === "string" ? message : message.toString());
      } catch {
        return; // Malformed frames are ignored rather than killing the console.
      }

      if (parsed.type !== "input" || typeof parsed.data !== "string") return;

      // Game server consoles are line-oriented; ensure the newline that commits
      // the command is present exactly once.
      const line = parsed.data.endsWith("\n") ? parsed.data : `${parsed.data}\n`;
      attachment.write(line);
    },

    close(ws) {
      // Releasing the connection matters: Docker holds it open server-side, and
      // leaking one per console visit would exhaust the daemon.
      ws.data.attachment?.close();
      ws.data.attachment = null;
    },
  },

  error(error: Error) {
    console.error("[agent] unhandled error:", error);
    return json({ error: "Internal agent error" }, 500);
  },
});

console.log(`[agent] CitadelPanel node agent listening on http://0.0.0.0:${server.port}`);
console.log(`[agent] docker socket: ${config.dockerSocket}`);

// Prints the data root and, when it is not writable, the command that fixes it.
// Runs after `Bun.serve` so a slow or broken filesystem cannot delay the agent
// accepting requests (see `dataRoot.ts` on why this does not exit).
await reportDataRootAtBoot();
