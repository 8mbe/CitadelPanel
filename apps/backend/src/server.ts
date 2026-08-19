/**
 * Agent HTTP + WebSocket entrypoint.
 *
 * Runs on every node, next to the Docker socket it drives. The panel is the only
 * caller of the lifecycle routes and authenticates with a bearer token; there are
 * no users, sessions or permissions on those routes because authorization already
 * happened panel-side.
 *
 * The one exception is the direct-console WebSocket (`/v1/sessions/:token/console`),
 * which a *browser* opens after the panel mints it a short-lived, single-use
 * capability token. The agent validates that token (and the per-command audit it
 * implies) by calling back to the panel — see `consoleAudit.ts`. The token, not
 * the long-lived bearer, is what authorizes that one path.
 *
 * Routes are keyed by **server id**, never container id or host path — see
 * `servers.ts` for why that indirection is load-bearing.
 */

import { requireAuth } from "./auth";
import { config } from "./config";
import { validateConsoleSession, recordConsoleCommand } from "./consoleAudit";
import { probeDataRoot, reportDataRootAtBoot } from "./dataRoot";
import { readDaemonInfo } from "./docker/client";
import { probePorts, type PortProtocol } from "./docker/ports";
import {
  getNodeDbInfo,
  provisionServerDatabase,
  dropServerDatabase,
  runServerDatabaseSql,
} from "./docker/database";
import { createSftpServer } from "./sftp";
import {
  copyPath,
  createDirectory,
  deletePath,
  deletePaths,
  listDirectory,
  pullFromUrl,
  readFile,
  renamePath,
  resolveForDownload,
  uploadFile,
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
  getServerInstallLogs,
  getServerLogs,
  getServerState,
  getServerStats,
  installServer,
  killServerContainer,
  linkServerContainers,
  restartServerContainer,
  sampleServers,
  sendServerCommand,
  startServerContainer,
  stopServerContainer,
  streamServerLogs,
  unlinkServerContainers,
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

/**
 * Pick a safe filename for a Content-Disposition header.
 *
 * The panel may suggest a name, but the agent owns the final value to prevent
 * header injection (a `\r\n` in the name could split headers). Falls back to the
 * entry's real name, then to a generic `download`. Strips path separators and
 * control chars and caps the length.
 */
function sanitizeDownloadName(suggested: string | null, fallback: string): string {
  const raw = suggested && suggested.trim().length > 0 ? suggested : fallback;
  // Remove anything that isn't a printable ASCII char, dot, dash, underscore, or
  // space — and strip path separators so the name can't escape the attachment.
  const cleaned = raw.replace(/[^\w .-]/g, "").replace(/\s+/g, " ").trim();
  const name = cleaned.length > 0 ? cleaned : "download";
  return name.slice(0, 200);
}

/**
 * How many trailing log lines to replay over the console WebSocket on open, so a
 * freshly opened console shows recent history before live output. Mirrors the
 * tail depth the SSE console used (`MAX_LINES` in `console-panel.tsx`).
 */
const MAX_HISTORY_LINES = 100;

/**
 * Per-input character cap, matching the HTTP `/command` route's 4096 limit — a
 * single WS frame longer than this is almost certainly a client bug, not a
 * command, and is dropped rather than written to stdin.
 */
const MAX_INPUT_CHARS = 4_096;

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

  // Extra networks (e.g. node_db_net) are optional. Only strings survive — the
  // agent validates each is a plausible Docker network name.
  const extraNetworks = Array.isArray(body.extraNetworks)
    ? body.extraNetworks.map((entry) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw badRequest('"extraNetworks" must be an array of non-empty strings.');
        }
        return entry;
      })
    : undefined;

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
    extraNetworks,
    tty: body.tty === true,
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
 * when the socket closes, with no keyed cleanup to get wrong. `userId` and
 * `token` come from the panel's session-validation response and ride the socket
 * only so per-command audit callbacks can attribute input — they are never
 * re-read for authorization (that was settled at the WS handshake).
 */
interface ConsoleSocket {
  serverId: string;
  userId: string;
  token: string;
  attachment: Attachment | null;
}

const server = Bun.serve<ConsoleSocket, never>({
  port: config.port,

  // Optional TLS. When both cert + key paths are set the agent serves HTTPS/WSS,
  // which the browser-direct console requires whenever the panel is itself HTTPS
  // (a `ws://` URL from an `https://` page is blocked as mixed content). Left off
  // for plain-HTTP homelab deploys. `Bun.file` is lazy, so this is cheap to build.
  ...(config.tlsCert && config.tlsKey
    ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } }
    : {}),

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

    // --- Database provisioning ------------------------------------------------
    //
    // The panel calls these to create/drop per-server databases on the shared
    // node MariaDB. The admin credentials arrive in the request body (the panel
    // decrypts them from `nodes.db_admin_password_encrypted`); the agent never
    // stores them. SQL is executed by `docker exec`-ing the mariadb client
    // inside the node DB container — see `docker/database.ts`.

    /**
     * GET /v1/database/info — report the node DB container's IP and port.
     *
     * The panel uses this to show the host address when a server owner creates
     * a database, and to verify the node DB is set up before offering the
     * option. `host` is null when the container does not exist.
     */
    "/v1/database/info": {
      GET: route(async () => {
        const info = await getNodeDbInfo();
        return json({
          host: info.host,
          port: info.port,
          networkName: info.networkName,
          containerName: info.containerName,
        });
      }),
    },

    /**
     * POST /v1/servers/:id/database — create a database + scoped user.
     *
     * Body: { adminUser, adminPassword, dbPassword }
     *
     * Creates `db_<serverId>` and `u_<serverId>` on the node MariaDB, grants
     * the user ALL on that one database, and attaches the server's container to
     * `node_db_net` so the game can reach it. Returns the connection details the
     * panel stores and surfaces to the owner.
     */
    "/v1/servers/:id/database": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);

        const adminUser = body.adminUser;
        if (typeof adminUser !== "string" || adminUser.length === 0) {
          throw badRequest('"adminUser" is required.');
        }
        const adminPassword = body.adminPassword;
        if (typeof adminPassword !== "string" || adminPassword.length === 0) {
          throw badRequest('"adminPassword" is required.');
        }
        const dbPassword = body.dbPassword;
        if (typeof dbPassword !== "string" || dbPassword.length < 16) {
          throw badRequest('"dbPassword" must be at least 16 characters.');
        }
        const dbName = body.dbName;
        if (typeof dbName !== "string" || dbName.length === 0) {
          throw badRequest('"dbName" is required.');
        }
        const dbUser = body.dbUser;
        if (typeof dbUser !== "string" || dbUser.length === 0) {
          throw badRequest('"dbUser" is required.');
        }

        const result = await provisionServerDatabase(
          serverId,
          dbName,
          dbUser,
          adminUser,
          adminPassword,
          dbPassword,
        );
        return json(result, 201);
      }),
      DELETE: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);

        const adminUser = body.adminUser;
        if (typeof adminUser !== "string" || adminUser.length === 0) {
          throw badRequest('"adminUser" is required.');
        }
        const adminPassword = body.adminPassword;
        if (typeof adminPassword !== "string" || adminPassword.length === 0) {
          throw badRequest('"adminPassword" is required.');
        }
        const dbName = body.dbName;
        if (typeof dbName !== "string" || dbName.length === 0) {
          throw badRequest('"dbName" is required.');
        }
        const dbUser = body.dbUser;
        if (typeof dbUser !== "string" || dbUser.length === 0) {
          throw badRequest('"dbUser" is required.');
        }

        await dropServerDatabase(serverId, dbName, dbUser, adminUser, adminPassword);
        return noContent();
      }),
    },

    /**
     * POST /v1/servers/:id/database/query — run explorer SQL as the scoped user.
     *
     * Body: { dbName, dbUser, dbPassword, sql }
     *
     * This is the database explorer's only agent dependency. Unlike the routes
     * above it never touches the admin credential: the SQL runs as the
     * per-database user, whose grants cover exactly one database, so MariaDB
     * contains whatever the panel composes. The panel builds every statement
     * from structured explorer operations (validated identifiers, hex-encoded
     * values) — the browser never sends SQL. Results come back as parsed
     * `--xml` output; see `docker/database.ts` for why XML over batch mode.
     */
    "/v1/servers/:id/database/query": {
      POST: route(async (request) => {
        // Route keyed by server id for consistency with the section above; the
        // query itself needs no container lookup, so the id is intentionally
        // unused beyond validating its shape.
        serverIdOf(request);
        const body = await parseJsonBody(request);

        const dbName = body.dbName;
        if (typeof dbName !== "string" || dbName.length === 0) {
          throw badRequest('"dbName" is required.');
        }
        const dbUser = body.dbUser;
        if (typeof dbUser !== "string" || dbUser.length === 0) {
          throw badRequest('"dbUser" is required.');
        }
        const dbPassword = body.dbPassword;
        if (typeof dbPassword !== "string" || dbPassword.length === 0) {
          throw badRequest('"dbPassword" is required.');
        }
        const sqlText = body.sql;
        if (typeof sqlText !== "string" || sqlText.length === 0) {
          throw badRequest('"sql" is required.');
        }

        const results = await runServerDatabaseSql(dbName, dbUser, dbPassword, sqlText);
        return json({ results });
      }),
    },

    // --- Server links ---------------------------------------------------------
    //
    // The panel calls these when a server owner connects two of their servers
    // that live on this node, so one game (a proxy, a plugin) can reach the
    // other by its stable container name instead of a public host:port. The
    // pair gets its own ICC-enabled bridge network — see `docker/hardening.ts`
    // for why links are pairwise, never one shared network per node.

    /**
     * POST /v1/servers/:id/links — attach two linked servers' containers to
     * their pairwise network.
     *
     * Body: { targetId }
     *
     * Both containers must already exist; recreates re-attach automatically
     * because the panel passes the link network via `extraNetworks` at create.
     */
    "/v1/servers/:id/links": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);
        const targetId = requireServerId(
          typeof body.targetId === "string" ? body.targetId : undefined,
        );
        if (targetId === serverId) {
          throw badRequest("A server cannot be linked to itself.");
        }
        const result = await linkServerContainers(serverId, targetId);
        return json(result);
      }),
    },

    /**
     * DELETE /v1/servers/:id/links/:targetId — detach both containers from
     * the pair's network and remove it. Idempotent: a missing container or
     * network is already-unlinked, not an error.
     */
    "/v1/servers/:id/links/:targetId": {
      DELETE: route(async (request) => {
        const serverId = serverIdOf(request);
        const targetId = requireServerId(
          (request as ParamRequest<"targetId">).params.targetId,
        );
        await unlinkServerContainers(serverId, targetId);
        return noContent();
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

    /**
     * The install container's output *while it is still running*.
     *
     * The POST above only answers once the script has exited, which for a
     * blueprint that downloads a server jar can be minutes. The panel polls
     * this so an admin watching the console sees the install as it happens
     * rather than all at once at the end.
     */
    "/v1/servers/:id/install/logs": {
      GET: route(async (request) => {
        const serverId = serverIdOf(request);
        const raw = Number(queryOf(request).get("tail"));
        const tail = Math.min(Math.max(Number.isFinite(raw) ? raw : 200, 1), 2000);
        return json(await getServerInstallLogs(serverId, tail));
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
          // Same tagging as the WebSocket error frame: a `no_container` failure
          // is one the reader can act on, not just read.
          const code = error instanceof HttpError ? error.code : undefined;
          const body = sseFromEvents([{ type: "console", message, code }]);
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

    // POST { paths: [...] } deletes a whole selection in one request. Every
    // path is validated through containment before anything is removed, so a
    // bad entry fails the batch rather than half-deleting it.
    "/v1/servers/:id/files/delete": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);
        if (!Array.isArray(body.paths)) {
          throw badRequest('"paths" must be an array of paths.');
        }
        await deletePaths(serverId, body.paths);
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

    // --- File manager: rename / copy -----------------------------------------
    //
    // Both take { from, to } as POSIX-style paths relative to the server's data
    // directory. Containment, self-into-self, and collision checks happen in
    // files.ts so they are shared with any future caller.
    "/v1/servers/:id/files/rename": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);
        if (typeof body.from !== "string") throw badRequest('"from" is required.');
        if (typeof body.to !== "string") throw badRequest('"to" is required.');
        await renamePath(serverId, body.from, body.to);
        return noContent();
      }),
    },

    "/v1/servers/:id/files/copy": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);
        if (typeof body.from !== "string") throw badRequest('"from" is required.');
        if (typeof body.to !== "string") throw badRequest('"to" is required.');
        await copyPath(serverId, body.from, body.to);
        return noContent();
      }),
    },

    // --- File manager: upload -------------------------------------------------
    //
    // POST ?path=<target> with an `application/octet-stream` body streams the
    // raw bytes into the server's data directory. One file per request: the
    // panel sequences multiple uploads client-side, which keeps each request's
    // failure isolated and lets the browser show per-file progress.
    //
    // The body is never buffered whole — `uploadFile` pumps it chunk by chunk
    // into a sibling temp file, then `rename`s it into place, so a partial
    // upload never surfaces as a truncated file to the game server. The size
    // cap is enforced both up front (via content-length) and during the stream
    // (via a running total), so a client that lies about the length is still
    // cut off.
    "/v1/servers/:id/files/upload": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const path = queryOf(request).get("path");
        if (!path) throw badRequest('"path" query parameter is required.');

        if (!request.body) throw badRequest("Request body is required.");
        const contentLength = Number(request.headers.get("content-length") ?? "");
        const result = await uploadFile(
          serverId,
          path,
          request.body,
          Number.isFinite(contentLength) ? contentLength : null,
        );
        return json(result, 201);
      }),
    },

    // --- File manager: pull from URL -----------------------------------------
    //
    // POST { path, url } fetches `url` agent-side and writes it to `path`. The
    // agent does the fetch so the bytes travel once, directly to disk; the
    // panel has already applied its own SSRF guardrail and size cap before
    // forwarding. Same staged-write posture as upload.
    "/v1/servers/:id/files/pull": {
      POST: route(async (request) => {
        const serverId = serverIdOf(request);
        const body = await parseJsonBody(request);
        if (typeof body.path !== "string") throw badRequest('"path" is required.');
        if (typeof body.url !== "string") throw badRequest('"url" is required.');

        let url: URL;
        try {
          url = new URL(body.url);
        } catch {
          throw badRequest('"url" must be a valid URL.');
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw badRequest('"url" must be an http(s) URL.');
        }

        const result = await pullFromUrl(serverId, body.path, body.url);
        return json(result, 201);
      }),
    },

    // --- File manager: download ----------------------------------------------
    //
    // GET ?path= streams a single file's raw bytes, or — for a directory or
    // multiple paths—a zip archive. The `paths` query parameter is a
    // newline-delimited list for the multi-select case; a single `path` is the
    // common case. The panel proxies the response body straight through, so
    // large downloads never buffer in the panel's memory.
    //
    // `download=...` sets the Content-Disposition filename; the panel passes the
    // browser-suggested name but the agent owns the final value to prevent
    // header injection.
    "/v1/servers/:id/files/download": {
      GET: route(async (request) => {
        const serverId = serverIdOf(request);
        const query = queryOf(request);
        // `paths` is newline-delimited; fall back to `path` for the single case.
        const pathsParam = query.get("paths");
        const paths = pathsParam
          ? pathsParam.split("\n").filter((p) => p.length > 0)
          : query.get("path")
            ? [query.get("path")!]
            : [];
        if (paths.length === 0) throw badRequest('"path" or "paths" is required.');

        // Resolve every requested path through containment before touching the
        // filesystem, so a single bad entry fails before any bytes stream.
        const resolved = await Promise.all(
          paths.map(async (p) => {
            const r = await resolveForDownload(serverId, p);
            return { ...r, userPath: p };
          }),
        );

        // --- Single file: stream raw bytes ---
        if (resolved.length === 1 && !resolved[0]!.info.isDirectory) {
          const { absPath, info, userPath } = resolved[0]!;
          const name = sanitizeDownloadName(query.get("download"), info.name);
          return new Response(Bun.file(absPath).stream(), {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${name}"`,
              "content-length": String(info.size),
            },
          });
        }

        // --- Directory or multiple paths: stream a zip ---
        const archiveName = sanitizeDownloadName(
          query.get("download"),
          resolved.length === 1 ? resolved[0]!.info.name : "download",
        );

        const { ZipArchive } = await import("archiver");
        const archive = new ZipArchive({ zlib: { level: 5 } });
        for (const entry of resolved) {
          // `archive.directory` only works on directories — it calls scandir
          // internally, which throws ENOTDIR on a file. Use `archive.file` for
          // files and `archive.directory` for folders, naming each entry with
          // its basename so the zip's top level isn't a single nested dir.
          if (entry.info.isDirectory) {
            archive.directory(entry.absPath, entry.info.name);
          } else {
            archive.file(entry.absPath, { name: entry.info.name });
          }
        }
        archive.finalize();

        // archiver is a Node Readable; bridge it to a web ReadableStream so the
        // Response body can stream without buffering the whole archive.
        const webStream = new ReadableStream<Uint8Array>({
          start(controller) {
            archive.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            archive.on("end", () => controller.close());
            archive.on("error", (err: unknown) => controller.error(err));
          },
          cancel() {
            archive.abort();
          },
        });

        return new Response(webStream, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${archiveName}.zip"`,
            "cache-control": "no-store",
          },
        });
      }),
    },
  },

  /**
   * Console upgrade and 404s.
   *
   * The WebSocket handshake cannot use the `routes` table because it needs the
   * raw `server.upgrade` call, so it is matched here. The browser opens
   * `/v1/sessions/:token/console` with a capability token the panel minted.
   *
   * The upgrade happens synchronously (Bun's `server.upgrade` must run before
   * the fetch Response is committed), carrying the token in `ws.data`. The token
   * is then validated against the panel in the `open` handler — before any
   * container attach — and the socket is closed if the panel rejects it. This
   * keeps the upgrade on the documented synchronous path while still enforcing
   * validation before any access. The long-lived bearer is NOT used here: the
   * capability token is the sole credential, which is what lets a browser (which
   * cannot set handshake headers) open directly.
   */
  fetch(request, srv) {
    const url = new URL(request.url);
    const match = /^\/v1\/sessions\/([^/]+)\/console$/.exec(url.pathname);

    if (match) {
      // Without a panel to call back to, the agent cannot validate the token.
      // 503 (not 401): nothing is wrong with the request, the node just isn't
      // configured for direct consoles.
      if (!config.panelUrl) {
        return json(
          { error: "Direct console requires PANEL_URL to be configured." },
          503,
        );
      }

      const token = match[1]!;
      // `serverId`/`userId` are unknown until `open` validates the token; they
      // are placeholders here and overwritten before use.
      if (
        srv.upgrade(request, {
          data: { serverId: "", userId: "", token, attachment: null },
        })
      ) {
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
        // Validate the capability token against the panel before anything else.
        // This atomically marks it consumed (so a replayed token cannot open a
        // second console) and resolves the serverId/userId the socket needs.
        // A rejection closes the socket; the browser re-mints on reconnect.
        const { serverId, userId } = await validateConsoleSession(ws.data.token);
        ws.data.serverId = serverId;
        ws.data.userId = userId;

        // Replay recent history so a freshly opened console isn't blank. The
        // browser clears its buffer on connect, so these lines populate a clean
        // view before live output begins. Best-effort: a container that has no
        // logs yet (or none retrievable) just yields an empty history.
        try {
          const history = await getServerLogs(serverId, MAX_HISTORY_LINES);
          for (const line of history.split("\n")) {
            if (line.length === 0) continue;
            // Trailing \n keeps history frames line-aligned with live output
            // chunks, so the frontend can split on newlines uniformly across
            // both (an ANSI sequence never straddles a history/live boundary).
            ws.send(JSON.stringify({ type: "output", data: line + "\n" }));
          }
        } catch {
          // Non-fatal: the attach below will surface a real failure if the
          // container is genuinely unreachable.
        }

        ws.data.attachment = await attachToServer(serverId, {
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
              `[agent] console stream error for ${serverId}:`,
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
        // The code travels with the message so the browser can say something
        // useful about a known failure (a missing container is about to be
        // rebuilt) instead of echoing the agent's wording.
        const code = error instanceof HttpError ? error.code : undefined;
        ws.send(JSON.stringify({ type: "error", message, code }));
        ws.close();
      }
    },

    /**
     * Forward a command to the container's stdin.
     *
     * The capability token was validated at `open`, so the caller is authorized
     * for this server; the per-command audit is recorded via the panel callback
     * (`recordConsoleCommand`) — fire-and-forget, so input latency never depends
     * on the audit trail.
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
      if (parsed.data.length > MAX_INPUT_CHARS) return; // mirrors the /command cap

      // Game server consoles are line-oriented; ensure the newline that commits
      // the command is present exactly once.
      const line = parsed.data.endsWith("\n") ? parsed.data : `${parsed.data}\n`;

      // Attribute the command to the token's user via the panel's audit table.
      // `void`: a console command must never block on (or fail because of) the
      // audit trail — the callback swallows its own errors (see consoleAudit.ts).
      void recordConsoleCommand(ws.data.token, ws.data.serverId, line);

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

const scheme = config.tlsCert && config.tlsKey ? "https" : "http";
console.log(`[agent] CitadelPanel node agent listening on ${scheme}://0.0.0.0:${server.port}`);
console.log(`[agent] docker socket: ${config.dockerSocket}`);

// Prints the data root and, when it is not writable, the command that fixes it.
// Runs after `Bun.serve` so a slow or broken filesystem cannot delay the agent
// accepting requests (see `dataRoot.ts` on why this does not exit).
await reportDataRootAtBoot();

// --- SFTP server ------------------------------------------------------------
//
// Starts on its own TCP port (default 8022), in this same process. Auth is
// delegated to the panel via `sftpAuth.ts` — the same callback posture the
// direct console uses — so `PANEL_URL` is required. Without it the SFTP server
// still starts but every auth attempt is rejected (the panel cannot be reached
// to validate the credential), and we log that clearly so an operator knows
// why connections fail.
if (config.sftpPort > 0) {
  if (!config.panelUrl) {
    console.warn(
      `[agent] SFTP server will start on port ${config.sftpPort} but PANEL_URL is not set — ` +
        "all SFTP logins will be rejected. Set PANEL_URL to enable SFTP auth.",
    );
  }
  try {
    const sftpServer = await createSftpServer();
    sftpServer.listen(config.sftpPort, "0.0.0.0");
    console.log(`[agent] SFTP server listening on 0.0.0.0:${config.sftpPort}`);
  } catch (error) {
    // A failure to start the SFTP server (host-key generation, port in use)
    // must not take down the HTTP/WS agent — lifecycle routes still work.
    console.error(
      "[agent] SFTP server failed to start:",
      error instanceof Error ? error.message : error,
    );
  }
}
