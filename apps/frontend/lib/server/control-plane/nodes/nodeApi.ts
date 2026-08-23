/**
 * Per-node agent API client (plan.md section 7).
 *
 * Replaces the old per-node `dockerode` instance. The panel no longer speaks the
 * Docker protocol at all: it makes authenticated HTTP calls to the agent running
 * on each node, and that agent owns the daemon and the server data.
 *
 * Why this indirection exists:
 *   - the panel never needs root-equivalent Docker access over the network;
 *   - server data directories are created on the machine that actually runs the
 *     container, which the old design got wrong for any remote node;
 *   - streaming consoles and file access have somewhere to live.
 *
 * The agent token is decrypted here and nowhere else in the request path.
 */

import { env } from "../config/env";
import { HttpError } from "../lib/http";
import {
  getNodeWithSecrets,
  invalidateNode,
  type NodeWithSecrets,
} from "./nodeRegistry";

/**
 * Cache of resolved connection details, keyed by node id.
 *
 * Saves a database round-trip and a decrypt per call. The fingerprint means
 * re-registering a node with a new URL or token invalidates the stale entry
 * instead of silently reusing it.
 */
interface CachedConnection {
  baseUrl: string;
  token: string | null;
  fingerprint: string;
}

const connectionCache = new Map<string, CachedConnection>();

/** Cheap identity for "has this node's connection config changed?". */
function connectionFingerprint(node: NodeWithSecrets): string {
  return `${node.apiUrl}|${node.apiToken?.length ?? 0}`;
}

/** Normalise a stored agent URL into a base without a trailing slash. */
export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid agent URL: ${apiUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Agent URL must be http:// or https://, got "${url.protocol}"`,
    );
  }
  return trimmed;
}

function toConnection(node: NodeWithSecrets): CachedConnection {
  const fingerprint = connectionFingerprint(node);
  const cached = connectionCache.get(node.id);

  if (cached && cached.fingerprint === fingerprint) return cached;

  const connection: CachedConnection = {
    baseUrl: normalizeApiUrl(node.apiUrl),
    token: node.apiToken,
    fingerprint,
  };
  connectionCache.set(node.id, connection);
  return connection;
}

/**
 * Drop everything cached about a node, after it is deleted or reconfigured.
 *
 * Covers the registry's credential cache as well as the resolved connection —
 * the two are refreshed together or not at all, and callers should not have to
 * know there are two.
 */
export function invalidateNodeConnection(nodeId: string): void {
  connectionCache.delete(nodeId);
  invalidateNode(nodeId);
}

export interface NodeRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** JSON-serialisable request body. */
  body?: unknown;
  /**
   * A raw body to send unmodified, for streaming endpoints (file uploads)
   * where the body must not be JSON-stringified or buffered. When set, this
   * takes precedence over `body` and the `content-type` header should be set
   * by the caller (defaults to `application/octet-stream`).
   */
  rawBody?: ReadableStream<Uint8Array> | BodyInit;
  /** Extra headers beyond the auth + content-type defaults. */
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Override the default timeout, for calls that are legitimately slow. */
  timeoutMs?: number;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: NodeRequestOptions["query"],
): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Call a node's agent for an already-loaded node.
 *
 * Failure modes are mapped deliberately:
 *   - the agent answered with an error  -> that status and message pass through,
 *     so a 404 for a missing container stays a 404 rather than becoming a 500;
 *   - the agent could not be reached    -> 502, because an unreachable node is
 *     an upstream failure, not the API caller's fault.
 */
export async function nodeRequestFor<T>(
  node: NodeWithSecrets,
  path: string,
  options: NodeRequestOptions = {},
): Promise<T> {
  const connection = toConnection(node);
  const url = buildUrl(connection.baseUrl, path, options.query);

  const headers: Record<string, string> = {};
  if (connection.token) {
    headers.authorization = `Bearer ${connection.token}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? env.nodeApiTimeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      502,
      `Node "${node.name}" is unreachable: ${reason}`,
    );
  }

  if (!response.ok) {
    // Surface the agent's own message; it is written for an operator to read.
    let message = `Node "${node.name}" returned ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = `${message}: ${payload.error}`;
    } catch {
      // Non-JSON error body — the status alone will have to do.
    }
    throw new HttpError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Call a node's agent by node id. */
export async function nodeRequest<T>(
  nodeId: string,
  path: string,
  options: NodeRequestOptions = {},
): Promise<T> {
  const node = await getNodeWithSecrets(nodeId);
  if (!node) throw new HttpError(404, `Unknown node: ${nodeId}`);
  return nodeRequestFor<T>(node, path, options);
}

/**
 * Call a node's agent and return the raw `Response` — for streaming endpoints
 * (file downloads) where the body must not be buffered into memory.
 *
 * Same auth and failure-mode mapping as {@link nodeRequestFor}, but does not
 * parse the body. A non-2xx response throws an `HttpError` with the agent's
 * message; a 2xx returns the live `Response` for the caller to pipe through.
 */
export async function nodeRequestRaw(
  nodeId: string,
  path: string,
  options: NodeRequestOptions = {},
): Promise<Response> {
  const node = await getNodeWithSecrets(nodeId);
  if (!node) throw new HttpError(404, `Unknown node: ${nodeId}`);

  const connection = toConnection(node);
  const url = buildUrl(connection.baseUrl, path, options.query);

  const headers: Record<string, string> = {};
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  // A raw body (file upload) is sent unmodified; otherwise a JSON body is
  // stringified. The two are mutually exclusive.
  if (options.rawBody !== undefined) {
    headers["content-type"] = "application/octet-stream";
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  Object.assign(headers, options.headers);

  let response: Response;
  try {
    // Build the fetch init. When forwarding a streaming body (a file upload),
    // Node's fetch requires `duplex: "half"` — it refuses to send a
    // ReadableStream body without it. The option is a Node extension to
    // RequestInit (not in the DOM spec), so it is only set for the streaming
    // path and cast through to satisfy the TS lib type.
    const init: RequestInit & { duplex?: "half" } = {
      method: options.method ?? "GET",
      headers,
      body:
        options.rawBody !== undefined
          ? options.rawBody
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      // Downloads and uploads can legitimately take a long time for large
      // files; the caller overrides this when it knows the size class.
      signal: AbortSignal.timeout(options.timeoutMs ?? env.nodeApiTimeoutMs),
    };
    if (options.rawBody !== undefined) {
      init.duplex = "half";
    }
    response = await fetch(url, init);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `Node "${node.name}" is unreachable: ${reason}`);
  }

  if (!response.ok) {
    let message = `Node "${node.name}" returned ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = `${message}: ${payload.error}`;
    } catch {
      // Non-JSON error body.
    }
    throw new HttpError(response.status, message);
  }

  return response;
}

export interface NodeHealth {
  reachable: boolean;
  dockerVersion?: string;
  containersRunning?: number;
  /** Host capacity, used to auto-fill a node's totals at registration. */
  capacity?: { ncpu: number; memTotalMb: number };
  /**
   * Whether the node can store server data. A reachable node with an unwritable
   * data root looks perfectly healthy until the first provision fails at `mkdir`,
   * so the agent reports it and the panel checks it before placing a server.
   * Absent when the agent predates this field.
   */
  dataRoot?: NodeDataRootStatus;
  /**
   * Whether the agent can reach its Docker daemon. Same reasoning as
   * `dataRoot`: the agent answers HTTP perfectly well while every container
   * operation on the node fails, so it reports the socket's state (and the fix)
   * rather than letting the panel discover it as a failed power action. Absent
   * when the agent predates this field.
   */
  dockerSocket?: NodeDockerSocketStatus;
  error?: string;
  /**
   * The agent rejected the bearer token (401/403). Distinct from `reachable`
   * so a wrong token is not reported as "unreachable" — the host is there, the
   * credential is not. Only ever true when `reachable` is false.
   */
  unauthorized?: boolean;
}

/** The agent's verdict on its own data root, with the fix when it is broken. */
export interface NodeDataRootStatus {
  path: string;
  writable: boolean;
  /** Cause plus remediation, written for an operator to act on. */
  error?: string;
}

/** The agent's verdict on its own Docker socket, with the fix when it is broken. */
export interface NodeDockerSocketStatus {
  path: string;
  reachable: boolean;
  /** Cause plus remediation, written for an operator to act on. */
  error?: string;
}

interface AgentHealthResponse {
  status: string;
  dockerVersion?: string;
  containersRunning?: number;
  capacity?: { ncpu: number; memTotalMb: number };
  dataRoot?: NodeDataRootStatus;
  dockerSocket?: NodeDockerSocketStatus;
}

/**
 * Ping a node's agent.
 *
 * Never throws: an unreachable node is an expected operational state that the
 * admin UI needs to display, not an exception to propagate.
 */
export async function checkNodeHealth(node: NodeWithSecrets): Promise<NodeHealth> {
  try {
    const health = await nodeRequestFor<AgentHealthResponse>(node, "/v1/health", {
      // Health is polled for every node on the admin page; a slow node must not
      // hold that request open for the full default timeout.
      timeoutMs: 5000,
    });

    return {
      reachable: true,
      dockerVersion: health.dockerVersion,
      containersRunning: health.containersRunning,
      capacity: health.capacity,
      dataRoot: health.dataRoot,
      dockerSocket: health.dockerSocket,
    };
  } catch (error) {
    // The agent answered but refused the token: the host is reachable, the
    // credential is wrong. Surfacing this distinctly saves an operator from
    // chasing a networking problem that is really a token mismatch.
    const unauthorized =
      error instanceof HttpError && (error.status === 401 || error.status === 403);
    return {
      reachable: false,
      unauthorized,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Health-check an agent that is not yet registered.
 *
 * Registration flows need to probe before writing a row, so this takes raw
 * connection details rather than a stored node.
 */
export async function probeAgent(
  apiUrl: string,
  apiToken: string,
): Promise<NodeHealth> {
  return checkNodeHealth({
    id: "probe",
    name: apiUrl,
    hostname: apiUrl,
    apiUrl,
    apiToken,
    consoleUrl: null,
    cpuTotal: 0,
    memoryTotalMb: 0,
    diskTotalMb: 0,
    cpuReservePct: 0,
    memoryReservePct: 0,
    diskReservePct: 0,
    allowOvercommit: false,
    db: { host: null, port: null, user: null, password: null },
    isActive: true,
    lastHeartbeatAt: null,
  });
}

/**
 * Refuse to provision on a node that cannot host a server, before any state is
 * written.
 *
 * Without this, an unwritable data root is only discovered part-way through
 * `createServer`: ports are reserved, a row exists, and the admin gets a generic
 * failure with a server stuck in `error`. Checking first turns that into one
 * actionable message and no wreckage.
 *
 * Deliberately not silent about a missing `dataRoot` field — an older agent that
 * does not report it is allowed through, because the alternative is refusing to
 * provision on a node that may be perfectly fine.
 */
export async function assertNodeReadyToProvision(nodeId: string): Promise<void> {
  const node = await getNodeWithSecrets(nodeId);
  if (!node) throw new HttpError(404, `Unknown node: ${nodeId}`);

  const health = await checkNodeHealth(node);

  if (!health.reachable) {
    throw new HttpError(
      503,
      `Node "${node.name}" is not ready to host a server: ` +
        `${health.error ?? "its agent did not respond"}.`,
    );
  }

  // Checked before the data root: an agent that cannot reach Docker cannot
  // create the container either, and its message names the actual fault.
  if (health.dockerSocket && !health.dockerSocket.reachable) {
    throw new HttpError(
      503,
      `Node "${node.name}" cannot run containers. ` +
        (health.dockerSocket.error ??
          `Its agent cannot reach the Docker socket at ${health.dockerSocket.path}.`),
    );
  }

  if (health.dataRoot && !health.dataRoot.writable) {
    throw new HttpError(
      503,
      `Node "${node.name}" cannot store server data. ` +
        (health.dataRoot.error ??
          `Its data root ${health.dataRoot.path} is not writable by the agent.`),
    );
  }
}
