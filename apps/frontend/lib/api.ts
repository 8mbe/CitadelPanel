/**
 * Browser client for the panel's same-origin Next.js API.
 *
 * Next.js acts as the backend-for-frontend and is the only public HTTP service.
 * It forwards authenticated control-plane requests to the internal Bun service;
 * the browser never receives or needs that service's address.
 */

import { initials } from "./format";
import type {
  DirectoryListing,
  NodeAbuseSummary,
  NodeAllocation,
  NodeDetail,
  NodePortPoolEntry,
  NodeServerView,
  NodeView,
  BlueprintPluginsSpec,
  BlueprintView,
  PluginSearchResult,
  PluginVersionView,
  ServerPluginList,
  ServerStatus,
  ServerView,
  SubuserView,
  SuspiciousActivityView,
} from "./types";


export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      0,
      "The panel service is unavailable. Please try again shortly.",
    );
  }

  // A success response may carry no body — notably 204 No Content (used by the
  // server delete endpoint). An empty body on a 2xx is valid, not an error: the
  // callers of such endpoints expect void.
  if (response.ok && response.status === 204) {
    return undefined as T;
  }

  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;

  if (!response.ok || data === null) {
    throw new ApiError(
      response.status,
      data?.error ?? `Request failed with status ${response.status}`,
    );
  }

  return data;
}

/**
 * Fetch helper for Better Auth's own `/api/auth/*` endpoints.
 *
 * Better Auth reports failures as `{ message, code }` (or `{ error }` on some
 * paths), not the `{ error }` shape the panel's own routes use, so it needs its
 * own reader. The session cookie travels automatically via `credentials`.
 * Returns the parsed JSON body on success; throws `ApiError` with Better Auth's
 * message on failure.
 */
export async function authRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      0,
      "The panel service is unavailable. Please try again shortly.",
    );
  }

  const data = (await response.json().catch(() => null)) as
    | (T & { message?: string; error?: string; code?: string })
    | null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.message ?? data?.error ?? `Request failed with status ${response.status}`,
    );
  }

  // Some auth endpoints (sign-out, delete-user) return a body; others return
  // null. Accept either.
  return (data ?? ({} as T)) as T;
}

// --- First-time setup ---------------------------------------------------------

/** Captcha providers the backend can verify. Mirrors services/settings.ts. */
export type CaptchaProvider =
  | "cloudflare-turnstile"
  | "google-recaptcha"
  | "cap";

/** Captcha config safe for a browser: site key only, never the secret. */
export interface PublicCaptchaSettings {
  enabled: boolean;
  provider: CaptchaProvider | null;
  siteKey: string | null;
  /** Self-hosted verification base URL. Only set for `cap`. */
  apiEndpoint: string | null;
}

export interface SetupStatus {
  needsSetup: boolean;
  completedAt: string | null;
  adminCount: number;
  userCount: number;
  nodeCount: number;
  timezone: string;
  captcha: PublicCaptchaSettings;
  /** False once an admin exists — the first-admin step must then be skipped. */
  canCreateAdmin: boolean;
}

/**
 * GET /api/setup/status — unauthenticated.
 *
 * Drives both the wizard and the redirect that sends a fresh install there.
 */
export function getSetupStatus(): Promise<SetupStatus> {
  return request<SetupStatus>("/api/setup/status");
}

/**
 * POST /api/setup/admin — claim the first admin account.
 *
 * The response carries a session cookie, so the caller is signed in afterwards
 * and the remaining wizard steps authenticate normally.
 */
export function setupCreateAdmin(payload: {
  name: string;
  email: string;
  password: string;
}): Promise<{ user: { id: string; email: string; name: string; role: string } }> {
  return request("/api/setup/admin", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface CaptchaSettingsInput {
  enabled: boolean;
  provider?: CaptchaProvider | null;
  siteKey?: string | null;
  /** Omit to keep the stored secret — it is never readable back. */
  secretKey?: string | null;
  apiEndpoint?: string | null;
  minScore?: number;
}

/** PATCH /api/setup/settings — timezone and/or captcha. Requires admin. */
export function updateSetupSettings(payload: {
  timezone?: string;
  captcha?: CaptchaSettingsInput;
}): Promise<{ timezone: string }> {
  return request("/api/setup/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/** POST /api/setup/complete — close the setup window. Idempotent. */
export function completeSetup(): Promise<{
  completedAt: string;
  alreadyComplete: boolean;
}> {
  return request("/api/setup/complete", { method: "POST" });
}

/**
 * GET /api/settings/public — unauthenticated panel-wide settings.
 *
 * Surfaces the captcha config (for the sign-in form) and the upload size cap
 * (so the file manager can pre-validate uploads client-side). The upload cap is
 * the only file-manager-relevant field here; captcha is consumed by the widget.
 */
export async function getPublicSettings(): Promise<{
  captcha: PublicCaptchaSettings;
  uploadMaxBytes: number;
}> {
  return request<{
    captcha: PublicCaptchaSettings;
    uploadMaxBytes: number;
  }>("/api/settings/public");
}

/** POST /api/admin/nodes — register a node. Returns a generated token once. */
export function adminCreateNode(payload: {
  name: string;
  hostname: string;
  apiUrl: string;
  token?: string;
  /** Public browser WS URL for the direct console; omit to derive from apiUrl. */
  consoleUrl?: string;
  diskTotalMb: number;
  cpuTotal?: number;
  memoryTotalMb?: number;
  /** Share of CPU (0-95) the scheduler must leave free. */
  cpuReservePct?: number;
  /** Share of memory (0-95) the scheduler must leave free. */
  memoryReservePct?: number;
  /** Share of disk (0-95) the scheduler must leave free. */
  diskReservePct?: number;
  /** When true, ignore the reserves and allocate the full total. */
  allowOvercommit?: boolean;
  /** Node DB admin host (the MariaDB container IP from setup-db). Optional. */
  dbAdminHost?: string;
  /** Node DB admin port (default 3306 when host is given). */
  dbAdminPort?: number;
  /** Node DB admin username (typically "root"). */
  dbAdminUser?: string;
  /** Node DB admin password (from setup-db output). */
  dbAdminPassword?: string;
}): Promise<{
  node: ApiNode;
  health: { reachable: boolean; error?: string };
  /** Present only when the backend generated the token. Shown once. */
  token?: string;
  warning?: string;
}> {
  return request("/api/admin/nodes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// --- Servers ------------------------------------------------------------------

// Mirrors the backend's server summary shape (serverManager.ServerSummary).
// `createdAt` arrives as an ISO string once serialized over JSON.
export interface ApiServerSummary {
  id: string;
  name: string;
  ownerId: string;
  nodeId: string;
  /** The node's hostname: the address players connect to (node, not agent). */
  nodeHostname: string | null;
  blueprintKey: string | null;
  status: string;
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
  ports: {
    port: number;
    protocol: string;
    isPrimary: boolean;
    isAdditional: boolean;
    label: string | null;
  }[];
  createdAt: string;
  /** Why the server was suspended, shown to the owner. Null when not suspended. */
  suspensionReason: string | null;
  /** When the server was last suspended (ISO string). Null when not suspended. */
  suspendedAt: string | null;
  /** Present on detail responses only: resolved plugin/mod support, if any. */
  pluginSupport?: {
    label: string;
    providerId: string;
    directory: string;
  } | null;
}

export interface CreateServerPayload {
  name: string;
  ownerId: string;
  blueprintKey: string;
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
  /** Optional explicit node; the scheduler picks one when omitted. */
  nodeId?: string;
  preferredPort?: number;
}

/** POST /api/admin/servers — provision a server for a user (admin only). */
export function adminCreateServer(
  payload: CreateServerPayload,
): Promise<ApiServerSummary> {
  return request<{ server: ApiServerSummary }>("/api/admin/servers", {
    method: "POST",
    body: JSON.stringify(payload),
  }).then((data) => data.server);
}

/**
 * Map a backend server summary into the display shape used across the UI.
 *
 * Live samples (CPU, memory, disk, uptime) come from the stats feed
 * (`getServerStats`) rather than the summary, so they start at zero and are
 * filled in by the page that polls for them.
 */
export function toServerView(summary: ApiServerSummary): ServerView {
  const primary = summary.ports.find((p) => p.isPrimary) ?? summary.ports[0];
  return {
    id: summary.id,
    name: summary.name,
    blueprintKey: summary.blueprintKey ?? "unknown",
    status: summary.status as ServerStatus,
    nodeId: summary.nodeId,
    nodeHostname: summary.nodeHostname ?? null,
    ownerId: summary.ownerId,
    primaryPort: primary?.port ?? 0,
    ports: summary.ports,
    cpuPercent: 0,
    memoryUsedMb: 0,
    diskUsedMb: 0,
    cpuLimit: summary.cpuLimit,
    memoryLimitMb: summary.memoryLimitMb,
    diskLimitMb: summary.diskLimitMb,
    uptimeSeconds: 0,
    createdAt: summary.createdAt,
    suspensionReason: summary.suspensionReason ?? null,
    suspendedAt: summary.suspendedAt ?? null,
    pluginSupport: summary.pluginSupport ?? null,
  };
}

/**
 * GET /api/servers — servers visible to the caller: owned plus any the caller
 * is a subuser on. Fleet-wide listings live on the admin endpoints.
 */
export function listServers(): Promise<ServerView[]> {
  return request<{ servers: ApiServerSummary[] }>("/api/servers").then((data) =>
    data.servers.map(toServerView),
  );
}

/**
 * GET /api/servers/:id — one server's detail. Returns null on 404. The
 * response also carries the caller's access (`viewer`), which the server page
 * uses to hide sections the caller holds no permission for.
 */
export async function getServer(id: string): Promise<ServerView | null> {
  try {
    const data = await request<{
      server: ApiServerSummary | null;
      viewer: ServerView["viewer"];
    }>(`/api/servers/${id}`);
    return data.server
      ? { ...toServerView(data.server), viewer: data.viewer }
      : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * DELETE /api/servers/:id — remove a server. Owner-or-admin only. When
 * `deleteData` is true the node also wipes the server's data directory;
 * otherwise the files are left on disk. Node cleanup is best-effort — an
 * unreachable node does not block removal of the panel record.
 */
export async function deleteServer(
  id: string,
  deleteData = false,
): Promise<void> {
  const query = deleteData ? "?deleteData=true" : "";
  await request(`/api/servers/${id}${query}`, { method: "DELETE" });
}

/** A live resource sample from the node agent. */
export interface ServerStats {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
  pids: number;
  diskUsageMb: number;
  sampledAt: string;
}

/** GET /api/servers/:id/stats — a live sample, or null when not running. */
export async function getServerStats(id: string): Promise<ServerStats | null> {
  const data = await request<{ stats: ServerStats | null }>(
    `/api/servers/${id}/stats`,
  );
  return data.stats;
}

/** GET /api/servers/:id/logs — recent console output as one string. */
export async function getServerLogs(id: string, tail = 200): Promise<string> {
  const data = await request<{ logs: string }>(
    `/api/servers/${id}/logs?tail=${tail}`,
  );
  return data.logs;
}

/**
 * An environment variable the server owner may view and edit. Only keys the
 * blueprint marks `editable` are returned; secret values arrive masked.
 */
export interface ServerEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
  description: string | null;
  /** Allowed values, when the field is constrained to a fixed set. */
  options: string[] | null;
}

/** GET /api/servers/:id/env — the editable env vars for a server. */
export async function getServerEnv(id: string): Promise<ServerEnvVar[]> {
  const data = await request<{ env: ServerEnvVar[] }>(
    `/api/servers/${id}/env`,
  );
  return data.env;
}

/**
 * PATCH /api/servers/:id/env — update one or more editable env vars.
 *
 * Send only the keys that changed. Returns the full refreshed set and a note
 * that changes take effect on the next restart.
 */
export async function updateServerEnv(
  id: string,
  updates: Record<string, string>,
): Promise<{ env: ServerEnvVar[]; note: string }> {
  return request<{ env: ServerEnvVar[]; note: string }>(
    `/api/servers/${id}/env`,
    { method: "PATCH", body: JSON.stringify({ env: updates }) },
  );
}

// --- Additional port assignment ------------------------------------------------

/** A published port on a server, as the ports card renders it. */
export interface ServerPort {
  /** The published port — identity mapping: host and container side are this number. */
  port: number;
  protocol: "tcp" | "udp";
  isPrimary: boolean;
  /** True for owner-added ports (removable); false for blueprint ports. */
  isAdditional: boolean;
  /** Optional owner note, e.g. "Metrics". Null when none was set. */
  label: string | null;
}

/** GET /api/servers/:id/ports — the server's published ports. */
export async function getServerPorts(id: string): Promise<ServerPort[]> {
  const data = await request<{ ports: ServerPort[] }>(
    `/api/servers/${id}/ports`,
  );
  return data.ports;
}

/**
 * POST /api/servers/:id/ports — publish an additional port.
 *
 * The port is an identity mapping (host N → container N) and must be available:
 * in the node's port pool, unallocated, and free on the host. The container is
 * recreated to apply the new binding, so a running server is briefly restarted.
 * Returns the updated server summary.
 *
 * @param label Optional note shown in the ports card, e.g. "Metrics".
 */
export async function addServerPort(
  id: string,
  payload: {
    port: number;
    protocol: "tcp" | "udp";
    label?: string;
  },
): Promise<ApiServerSummary> {
  const data = await request<{ server: ApiServerSummary }>(
    `/api/servers/${id}/ports`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return data.server;
}

/**
 * DELETE /api/servers/:id/ports?port=&protocol= — remove an additional port.
 *
 * Only owner-added (additional) ports are removable; blueprint ports are
 * rejected. The container is recreated to release the binding. Returns the
 * updated server summary.
 */
export async function removeServerPort(
  id: string,
  port: number,
  protocol: "tcp" | "udp",
): Promise<ApiServerSummary> {
  const data = await request<{ server: ApiServerSummary }>(
    `/api/servers/${id}/ports?port=${port}&protocol=${protocol}`,
    { method: "DELETE" },
  );
  return data.server;
}

// --- Server links ----------------------------------------------------------------

/**
 * A connection between this server and another of the owner's servers, as the
 * settings card renders it.
 */
export interface ServerLink {
  id: string;
  /** The linked peer. */
  target: {
    id: string;
    name: string;
    status: ServerStatus;
    nodeHostname: string | null;
  };
  /** "internal" = private Docker network (same node); "external" = public address. */
  mode: "internal" | "external";
  /** The hostname this server reaches the peer at. */
  host: string;
  /** The peer's primary published port; null before one is allocated. */
  port: number | null;
  createdAt: string;
}

/** GET /api/servers/:id/links — this server's connections to other servers. */
export async function getServerLinks(serverId: string): Promise<ServerLink[]> {
  const data = await request<{ links: ServerLink[] }>(
    `/api/servers/${serverId}/links`,
  );
  return data.links;
}

/**
 * POST /api/servers/:id/links — connect this server to another of the caller's
 * servers. Requires owner (or admin) access to both; same-node pairs get a
 * private Docker network, cross-node pairs ride the public address.
 */
export async function createServerLink(
  serverId: string,
  targetId: string,
): Promise<ServerLink> {
  const data = await request<{ link: ServerLink }>(
    `/api/servers/${serverId}/links`,
    { method: "POST", body: JSON.stringify({ targetId }) },
  );
  return data.link;
}

/** DELETE /api/servers/:id/links/:linkId — remove a connection. */
export async function removeServerLink(
  serverId: string,
  linkId: string,
): Promise<void> {
  await request(`/api/servers/${serverId}/links/${linkId}`, {
    method: "DELETE",
  });
}

// --- Databases ----------------------------------------------------------------

/** A database provisioned for a server, as the UI displays it. */
export interface ServerDatabase {
  id: string;
  name: string;
  user: string;
  /** The host address the game server connects to (the DB container's IP). */
  host: string;
  port: number;
  /**
   * Plaintext password — only present at creation or password reset. Null when
   * listing; the stored value is encrypted and never decrypted for display.
   */
  password: string | null;
  createdAt: string;
}

/** GET /api/servers/:id/databases — the server's provisioned databases. */
export async function getServerDatabases(
  serverId: string,
): Promise<ServerDatabase[]> {
  const data = await request<{ databases: ServerDatabase[] }>(
    `/api/servers/${serverId}/databases`,
  );
  return data.databases;
}

/**
 * POST /api/servers/:id/databases — provision a database.
 *
 * The database name, user, and host are generated server-side. The password is
 * generated, stored encrypted, and returned **once** — the caller must show it
 * immediately because it can never be retrieved again.
 */
export async function addServerDatabase(
  serverId: string,
): Promise<ServerDatabase> {
  const data = await request<{ database: ServerDatabase }>(
    `/api/servers/${serverId}/databases`,
    { method: "POST" },
  );
  return data.database;
}

/** DELETE /api/servers/:id/databases/:databaseId — drop a database. */
export async function removeServerDatabase(
  serverId: string,
  databaseId: string,
): Promise<void> {
  await request(`/api/servers/${serverId}/databases/${databaseId}`, {
    method: "DELETE",
  });
}

/**
 * POST /api/servers/:id/databases/:databaseId/reset-password — generate a new
 * password for the database user.
 *
 * Returns the new plaintext password once; the old one is unrecoverable.
 */
export async function resetServerDatabasePassword(
  serverId: string,
  databaseId: string,
): Promise<{ password: string }> {
  return request<{ password: string }>(
    `/api/servers/${serverId}/databases/${databaseId}/reset-password`,
    { method: "POST" },
  );
}

/**
 * POST /api/servers/:id/console/session — mint a direct-console capability token.
 *
 * Returns the one-time token and the agent WebSocket URL the browser should
 * open. The token is single-use and short-lived; a new one is minted on each
 * (re)connection.
 */
export async function requestConsoleSession(
  id: string,
): Promise<{ token: string; url: string; tty: boolean }> {
  return request<{ token: string; url: string; tty: boolean }>(
    `/api/servers/${id}/console/session`,
    { method: "POST" },
  );
}

/**
 * POST /api/servers/:id/console/revoke — give up a console session token.
 *
 * Fire-and-forget: this is called from a `pagehide` / unmount path where the
 * page may be torn down before the response arrives, so it uses `keepalive`
 * (the browser will flush the request even as the tab closes) and never awaits.
 * Errors are swallowed — a failed revoke is not worth surfacing to the user,
 * and the token is single-use + short-lived anyway, so the worst case is a
 * dangling row that expires on its own.
 */
export function revokeConsoleSession(id: string, token: string): void {
  void fetch(`/api/servers/${id}/console/revoke`, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => {
    /* page is leaving; nothing to do */
  });
}

// --- File manager --------------------------------------------------------------

/**
 * GET /api/servers/:id/files?path= — list a directory.
 *
 * Entries are server-relative POSIX paths. Directories sort first, then
 * alphabetically (the agent's ordering).
 */
export async function listServerFiles(
  serverId: string,
  path = "/",
): Promise<DirectoryListing> {
  return request<DirectoryListing>(
    `/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`,
  );
}

/** GET /api/servers/:id/files/content?path= — read a text file's contents. */
export async function readServerFile(
  serverId: string,
  path: string,
): Promise<string> {
  const data = await request<{ path: string; contents: string }>(
    `/api/servers/${serverId}/files/content?path=${encodeURIComponent(path)}`,
  );
  return data.contents;
}

/**
 * PUT /api/servers/:id/files/content — write a text file.
 *
 * Creates parent directories as needed. Binary files are not supported through
 * this endpoint (contents must be a UTF-8 string); large files are capped
 * agent-side at `AGENT_MAX_FILE_BYTES`.
 */
export async function writeServerFile(
  serverId: string,
  path: string,
  contents: string,
): Promise<void> {
  await request(`/api/servers/${serverId}/files/content`, {
    method: "PUT",
    body: JSON.stringify({ path, contents }),
  });
}

/**
 * POST /api/servers/:id/files/delete — delete files/directory trees.
 *
 * One request for a whole selection. The node validates every path through
 * containment before removing anything, so a bad entry fails the batch rather
 * than half-deleting it.
 */
export async function deleteServerFiles(
  serverId: string,
  paths: string[],
): Promise<void> {
  await request(`/api/servers/${serverId}/files/delete`, {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
}

/** POST /api/servers/:id/files/directory — create a directory. */
export async function createServerDirectory(
  serverId: string,
  path: string,
): Promise<void> {
  await request(`/api/servers/${serverId}/files/directory`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/**
 * POST /api/servers/:id/files/rename — rename or move a file/directory.
 *
 * `to` is the full destination path (not a folder to move into). The agent
 * rejects a name collision with a 409 and refuses to move a path into its own
 * descendant.
 */
export async function renameServerFile(
  serverId: string,
  from: string,
  to: string,
): Promise<void> {
  await request(`/api/servers/${serverId}/files/rename`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

/**
 * POST /api/servers/:id/files/copy — copy a file or directory tree.
 *
 * Directories are copied recursively. `to` is the full destination path; a name
 * collision is rejected with a 409.
 */
export async function copyServerFile(
  serverId: string,
  from: string,
  to: string,
): Promise<void> {
  await request(`/api/servers/${serverId}/files/copy`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

/**
 * GET /api/servers/:id/files/download — download one or more files/folders.
 *
 * A single file downloads raw; multiple `paths` (or a directory) download as a
 * zip archive built on the fly. Returns a blob the caller can turn into a
 * download link. The Content-Disposition filename is set agent-side.
 */
export async function downloadServerFiles(
  serverId: string,
  paths: string[],
  downloadName?: string,
): Promise<Blob> {
  const params = new URLSearchParams();
  if (paths.length === 1) {
    params.set("path", paths[0]!);
  } else {
    params.set("paths", paths.join("\n"));
  }
  if (downloadName) params.set("download", downloadName);

  const response = await fetch(
    `/api/servers/${serverId}/files/download?${params.toString()}`,
    { credentials: "include" },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(
      response.status,
      data?.error ?? `Download failed with status ${response.status}`,
    );
  }
  return response.blob();
}

/**
 * POST /api/servers/:id/files/upload?path= — upload a single file.
 *
 * Uses XMLHttpRequest rather than `fetch` so the browser can report upload
 * progress via `progress` events, which `fetch` cannot do. The file body is
 * sent as raw `application/octet-stream` (one file per request); the caller
 * sequences multiple files and updates per-file progress from `onProgress`.
 *
 * The upload limit is enforced server-side, but the caller should pre-validate
 * with {@link getPublicSettings} so an oversized file is rejected before any
 * bytes are sent.
 *
 * Returns the agent's `{ path, sizeBytes }` result.
 */
export function uploadServerFile(
  serverId: string,
  path: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ path: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/servers/${serverId}/files/upload?path=${encodeURIComponent(path)}`,
    );
    xhr.withCredentials = true;
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as { path: string; sizeBytes: number });
      } else {
        const message =
          (xhr.response as { error?: string } | null)?.error ??
          `Upload failed with status ${xhr.status}`;
        reject(new ApiError(xhr.status, message));
      }
    };

    xhr.onerror = () => {
      reject(new ApiError(0, "The upload could not be completed. Please try again."));
    };

    xhr.send(file);
  });
}

/**
 * POST /api/servers/:id/files/pull — fetch a URL into the server's data dir.
 *
 * The panel validates the URL (http(s) only, SSRF guardrail) and the agent
 * performs the fetch. Returns the agent's `{ path, sizeBytes }` result. Unlike
 * an upload there is no progress event: the remote fetch is opaque to the
 * browser until it completes.
 */
export async function pullServerFileFromUrl(
  serverId: string,
  path: string,
  url: string,
): Promise<{ path: string; sizeBytes: number }> {
  return request<{ path: string; sizeBytes: number }>(
    `/api/servers/${serverId}/files/pull`,
    { method: "POST", body: JSON.stringify({ path, url }) },
  );
}

// --- Plugins --------------------------------------------------------------

/**
 * GET /api/servers/:id/plugins — installed plugins reconciled against the
 * actual directory, plus the resolved support (label, directory, provider
 * hosts) and the auto-update setting.
 */
export function getServerPlugins(serverId: string): Promise<ServerPluginList> {
  return request<ServerPluginList>(`/api/servers/${serverId}/plugins`);
}

/** GET /api/servers/:id/plugins/search?q= — catalog search, proxied by the panel. */
export function searchServerPlugins(
  serverId: string,
  q: string,
  offset = 0,
): Promise<{ total: number; results: PluginSearchResult[] }> {
  const params = new URLSearchParams({ q, offset: String(offset) });
  return request<{ total: number; results: PluginSearchResult[] }>(
    `/api/servers/${serverId}/plugins/search?${params}`,
  );
}

/** GET /api/servers/:id/plugins/versions/:projectId — installable versions. */
export async function getServerPluginVersions(
  serverId: string,
  projectId: string,
): Promise<PluginVersionView[]> {
  const data = await request<{ versions: PluginVersionView[] }>(
    `/api/servers/${serverId}/plugins/versions/${encodeURIComponent(projectId)}`,
  );
  return data.versions;
}

/**
 * POST /api/servers/:id/plugins/install — install (or update) a plugin to a
 * specific catalog version. The panel re-resolves the version and pins the
 * download URL before the agent fetches it.
 */
export function installServerPlugin(
  serverId: string,
  projectId: string,
  versionId: string,
): Promise<{ installed: boolean }> {
  return request(`/api/servers/${serverId}/plugins/install`, {
    method: "POST",
    body: JSON.stringify({ projectId, versionId }),
  });
}

/** POST /api/servers/:id/plugins/:pluginId/toggle — enable or disable. */
export function toggleServerPlugin(
  serverId: string,
  pluginId: string,
): Promise<void> {
  return request(`/api/servers/${serverId}/plugins/${pluginId}/toggle`, {
    method: "POST",
  });
}

/** DELETE /api/servers/:id/plugins/:pluginId — remove the file and row. */
export function removeServerPlugin(
  serverId: string,
  pluginId: string,
): Promise<void> {
  return request(`/api/servers/${serverId}/plugins/${pluginId}`, {
    method: "DELETE",
  });
}

/** PATCH /api/servers/:id/plugins — per-server plugin settings. */
export function updateServerPluginSettings(
  serverId: string,
  autoUpdate: boolean,
): Promise<{ autoUpdate: boolean }> {
  return request(`/api/servers/${serverId}/plugins`, {
    method: "PATCH",
    body: JSON.stringify({ autoUpdate }),
  });
}

/** Power actions. Each returns the updated summary. */
export function startServer(id: string): Promise<ApiServerSummary> {
  return request<{ server: ApiServerSummary }>(`/api/servers/${id}/start`, {
    method: "POST",
  }).then((d) => d.server);
}

export function stopServer(id: string): Promise<ApiServerSummary> {
  return request<{ server: ApiServerSummary }>(`/api/servers/${id}/stop`, {
    method: "POST",
  }).then((d) => d.server);
}

export function restartServer(id: string): Promise<ApiServerSummary> {
  return request<{ server: ApiServerSummary }>(`/api/servers/${id}/restart`, {
    method: "POST",
  }).then((d) => d.server);
}

/**
 * POST /api/servers/:id/kill — force-stop with SIGKILL.
 *
 * The escape hatch for a container stuck in a graceful stop/restart: no grace
 * period, no chance to save. Returns the updated summary (status `stopped`).
 */
export function killServer(id: string): Promise<ApiServerSummary> {
  return request<{ server: ApiServerSummary }>(`/api/servers/${id}/kill`, {
    method: "POST",
  }).then((d) => d.server);
}

// --- SFTP credentials --------------------------------------------------------

/** A credential whose plaintext password was just revealed (creation/regenerate). */
export interface SftpCredential {
  id: string;
  serverId: string;
  userId: string;
  username: string;
  /** Plaintext password — returned only on create/regenerate, never on list. */
  password: string;
  createdAt: string;
  updatedAt: string;
}

/** A credential in a list — no password, ever. */
export interface SftpCredentialSummary {
  id: string;
  serverId: string;
  userId: string;
  username: string;
  userEmail: string;
  createdAt: string;
  updatedAt: string;
}

/** Connection details for configuring an SFTP client. */
export interface SftpConnection {
  hostname: string;
  port: number;
  username: string | null;
  hasCredential: boolean;
}

/** GET /api/servers/:id/sftp/connection — host/port/username for an SFTP client. */
export function getSftpConnection(serverId: string): Promise<SftpConnection> {
  return request<SftpConnection>(`/api/servers/${serverId}/sftp/connection`);
}

/** GET /api/servers/:id/sftp/credentials — list credentials (no passwords). */
export async function listSftpCredentials(
  serverId: string,
): Promise<SftpCredentialSummary[]> {
  const data = await request<{ credentials: SftpCredentialSummary[] }>(
    `/api/servers/${serverId}/sftp/credentials`,
  );
  return data.credentials;
}

/** POST /api/servers/:id/sftp/credentials — mint (or rotate) the caller's credential. */
export function createSftpCredential(serverId: string): Promise<SftpCredential> {
  return request<SftpCredential>(`/api/servers/${serverId}/sftp/credentials`, {
    method: "POST",
  });
}

/** POST /api/servers/:id/sftp/credentials/regenerate — rotate the password. */
export function regenerateSftpCredential(serverId: string): Promise<SftpCredential> {
  return request<SftpCredential>(
    `/api/servers/${serverId}/sftp/credentials/regenerate`,
    { method: "POST" },
  );
}

/** DELETE /api/servers/:id/sftp/credentials/:credentialId — revoke a credential. */
export function deleteSftpCredential(
  serverId: string,
  credentialId: string,
): Promise<void> {
  return request<void>(
    `/api/servers/${serverId}/sftp/credentials/${credentialId}`,
    { method: "DELETE" },
  );
}

// --- Blueprints ---------------------------------------------------------------

/** GET /api/blueprints — the blueprints a server can be provisioned with. */
export function listBlueprints(): Promise<BlueprintView[]> {
  return request<{
    blueprints: {
      key: string;
      name: string;
      description: string | null;
      minimums: { cpuLimit: number; memoryLimitMb: number; diskLimitMb: number };
    }[];
  }>("/api/blueprints").then((data) =>
    data.blueprints.map((b) => ({
      key: b.key,
      name: b.name,
      description: b.description ?? null,
      minimums: b.minimums,
    })),
  );
}

// --- Subusers -----------------------------------------------------------------

/** GET /api/servers/:id/subusers — delegated users on a server. */
export async function listSubusers(serverId: string): Promise<SubuserView[]> {
  const data = await request<{
    subusers: {
      userId: string;
      email: string;
      name: string | null;
      permissions: Record<string, boolean>;
      createdAt: string | null;
    }[];
  }>(`/api/servers/${serverId}/subusers`);

  return data.subusers.map((s) => ({
    userId: s.userId,
    name: s.name ?? s.email,
    email: s.email,
    // The backend stores permissions as a flag map; the UI shows the granted keys.
    permissions: Object.entries(s.permissions)
      .filter(([, granted]) => granted)
      .map(([key]) => key),
    createdAt: s.createdAt,
  }));
}

/** POST /api/servers/:id/subusers — invite an existing account. */
export async function inviteSubuser(
  serverId: string,
  email: string,
  permissions: Record<string, boolean>,
): Promise<void> {
  await request(`/api/servers/${serverId}/subusers`, {
    method: "POST",
    body: JSON.stringify({ email, permissions }),
  });
}

/** DELETE /api/servers/:id/subusers/:userId — revoke access. */
export async function removeSubuser(
  serverId: string,
  userId: string,
): Promise<void> {
  await request(`/api/servers/${serverId}/subusers/${userId}`, {
    method: "DELETE",
  });
}

// --- Users --------------------------------------------------------------------

/** A panel account as listed by the admin users endpoint. */
export interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  avatarSeed: string;
  serverCount: number;
  createdAt: string | null;
  /** True when the account is currently banned (an expired ban is treated as false). */
  banned: boolean;
  banReason: string | null;
  /** ISO timestamp when the ban lapses, or null for a permanent ban. */
  banExpires: string | null;
}

/**
 * GET /api/admin/users — every account on the panel (admin only).
 *
 * @param q Optional search term, matched case-insensitively against email/name.
 */
export async function adminListUsers(q?: string): Promise<ApiUser[]> {
  const query = q && q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : "";
  const data = await request<{
    users: {
      id: string;
      email: string;
      name: string | null;
      role: string | null;
      // This endpoint returns raw DB rows, hence snake_case here.
      server_count?: number;
      created_at?: string | null;
      banned?: boolean | null;
      ban_reason?: string | null;
      ban_expires?: string | null;
    }[];
  }>(`/api/admin/users${query}`);

  return data.users.map((user) => {
    const name = user.name ?? user.email;
    const banExpires = user.ban_expires ?? null;
    const expired =
      banExpires !== null && new Date(banExpires).getTime() < Date.now();
    return {
      id: user.id,
      name,
      email: user.email,
      role: user.role === "admin" ? "admin" : "user",
      avatarSeed: initials(name),
      serverCount: user.server_count ?? 0,
      createdAt: user.created_at ?? null,
      // An expired ban reads as not-banned; the backend clears it lazily on the
      // next session attempt, but the UI should not show a stale "banned" badge.
      banned: Boolean(user.banned) && !expired,
      banReason: expired ? null : user.ban_reason ?? null,
      banExpires: expired ? null : banExpires,
    };
  });
}

/**
 * PATCH /api/admin/users/:id/role — promote or demote an account.
 *
 * The backend refuses to let an admin change their own role or to demote the
 * last remaining admin; both come back as 409 with a readable message.
 */
export async function adminUpdateUserRole(
  userId: string,
  role: "admin" | "user",
): Promise<void> {
  await request(`/api/admin/users/${userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/**
 * POST /api/admin/users/:id/ban — ban a user and suspend their servers.
 *
 * The backend revokes all the user's sessions (so they are signed out
 * everywhere) and suspends every server they own. An admin cannot ban
 * themselves (409). Returns the count of servers suspended.
 */
export async function adminBanUser(
  userId: string,
  options?: { reason?: string; banExpiresInSeconds?: number },
): Promise<{ serversSuspended: number }> {
  const data = await request<{ serversSuspended: number }>(
    `/api/admin/users/${userId}/ban`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: options?.reason,
        banExpiresInSeconds: options?.banExpiresInSeconds,
      }),
    },
  );
  return data;
}

/**
 * POST /api/admin/users/:id/unban — lift a ban.
 *
 * Servers are NOT unsuspended automatically; the admin re-enables them
 * individually. The UI makes this explicit.
 */
export async function adminUnbanUser(userId: string): Promise<void> {
  await request(`/api/admin/users/${userId}/unban`, { method: "POST" });
}

/**
 * A single account with its owned servers, for the admin user-detail page.
 * Mirrors {@link ApiUser} but carries the raw Better Auth row fields plus the
 * server list (returned in snake_case by the handler, normalized here).
 */
/** The signed-in account, as returned by GET /api/me. */
export interface ApiMe {
  id: string;
  email: string;
  /** Display name from the Better Auth user row; null if never set. */
  name: string | null;
  role: "admin" | "user";
  ownedServers: number;
  subuserServers: number;
  pendingReviews?: number;
}

/** GET /api/me — the caller's own account and counts. */
export async function getMe(): Promise<ApiMe> {
  const data = await request<{
    user: {
      id: string;
      email: string;
      name: string | null;
      role: string | null;
      ownedServers?: number;
      subuserServers?: number;
      pendingReviews?: number;
    };
  }>("/api/me");

  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name ?? null,
    role: data.user.role === "admin" ? "admin" : "user",
    ownedServers: data.user.ownedServers ?? 0,
    subuserServers: data.user.subuserServers ?? 0,
    pendingReviews: data.user.pendingReviews,
  };
}

// --- Nodes --------------------------------------------------------------------

/** A node entry as listed by the admin nodes endpoint. */
export interface ApiNode {
  id: string;
  name: string;
  hostname: string;
  cpuReservePct: number;
  memoryReservePct: number;
  diskReservePct: number;
  allowOvercommit: boolean;
  isActive: boolean;
}

/**
 * GET /api/admin/nodes/health — health of every active node.
 *
 * Probes all active nodes in parallel and records a heartbeat for each that
 * answers. Used by the nodes list page's "check on visit" sweep, so the
 * reachability badges reflect reality without a manual probe per card.
 *
 * Best-effort by design: a node that does not answer is reported as
 * `reachable: false` rather than throwing, so one dead node cannot fail the
 * whole sweep.
 */
export async function adminHeartbeatAllNodes(): Promise<
  ({ nodeId: string; nodeName: string } & NodeHealthResult)[]
> {
  const data = await request<{
    nodes: ({ nodeId: string; nodeName: string } & NodeHealthResult)[];
  }>("/api/admin/nodes/health");
  return data.nodes;
}

/**
 * GET /api/admin/nodes/:id — one node's full detail (admin only).
 *
 * Aggregates the node, its allocation, the servers on it (with owner emails and
 * a live usage sample), and an abuse summary. Server rows are mapped through
 * {@link toServerView} and then overlaid with the admin-only live fields, which
 * stay `null` when the node was unreachable.
 */
export async function adminGetNode(nodeId: string): Promise<NodeDetail> {
  const data = await request<{
    node: NodeView;
    allocation: NodeAllocation | null;
    servers: (ApiServerSummary & {
      ownerEmail: string;
      cpuPercent: number | null;
      memoryUsageMb: number | null;
      diskUsageMb: number | null;
    })[];
    abuse: NodeAbuseSummary;
    portPool: NodePortPoolEntry[];
  }>(`/api/admin/nodes/${nodeId}`);

  return {
    node: data.node,
    allocation: data.allocation,
    abuse: data.abuse,
    portPool: data.portPool,
    servers: data.servers.map((raw) => {
      const view = toServerView(raw);
      return {
        ...view,
        ownerEmail: raw.ownerEmail,
        cpuPercent: raw.cpuPercent,
        memoryUsageMb: raw.memoryUsageMb,
        diskUsageMb: raw.diskUsageMb,
      } satisfies NodeServerView;
    }),
  };
}

/**
 * PATCH /api/admin/nodes/:id — drain (isActive=false) or activate a node.
 *
 * Draining stops new servers being scheduled onto the node but leaves existing
 * containers running, so it is reversible. Returns the updated public node.
 */
export async function adminUpdateNode(
  nodeId: string,
  isActive: boolean,
): Promise<NodeView> {
  const data = await request<{ node: NodeView }>(
    `/api/admin/nodes/${nodeId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ isActive }),
    },
  );
  return data.node;
}

/** Editable connection details and reservations for a node. Every field is optional. */
export interface NodeDetailsUpdate {
  name?: string;
  hostname?: string;
  apiUrl?: string;
  /** Omit to keep the stored token. */
  apiToken?: string;
  /** Public browser WS URL; omit to keep current. */
  consoleUrl?: string;
  /** Share of CPU (0-95) the scheduler must leave free. Omit to keep current. */
  cpuReservePct?: number;
  /** Share of memory (0-95) the scheduler must leave free. Omit to keep current. */
  memoryReservePct?: number;
  /** Share of disk (0-95) the scheduler must leave free. Omit to keep current. */
  diskReservePct?: number;
  /** When true, ignore the reserves. Omit to keep current. */
  allowOvercommit?: boolean;
}

/**
 * PATCH /api/admin/nodes/:id — correct a node's connection details.
 *
 * For fixing a mistyped hostname, agent URL or token without deleting and
 * re-registering the node (which is blocked while servers reference it). Only
 * the supplied fields change. Returns the updated public node.
 */
export async function adminUpdateNodeDetails(
  nodeId: string,
  details: NodeDetailsUpdate,
): Promise<NodeView> {
  const data = await request<{ node: NodeView }>(
    `/api/admin/nodes/${nodeId}`,
    {
      method: "PATCH",
      body: JSON.stringify(details),
    },
  );
  return data.node;
}

/**
 * DELETE /api/admin/nodes/:id — remove a node.
 *
 * Two gates, each returning a 409 with an actionable message:
 * 1. The node must be drained (`isActive = false`) first.
 * 2. It must host no servers — the `servers.node_id` FK is ON DELETE RESTRICT,
 *    so running containers are never orphaned.
 *
 * An empty, drained node deletes cleanly.
 */
export async function adminDeleteNode(nodeId: string): Promise<void> {
  await request(`/api/admin/nodes/${nodeId}`, { method: "DELETE" });
}

// --- Node port pool ----------------------------------------------------------

/**
 * GET /api/admin/nodes/:id/ports — the node's reserved port-pool entries.
 *
 * Folded into `adminGetNode` for the initial page load; this standalone fetch
 * refreshes just the pool after an add/delete without re-fetching the node.
 */
export async function adminListNodePortPool(
  nodeId: string,
): Promise<NodePortPoolEntry[]> {
  const data = await request<{ entries: NodePortPoolEntry[] }>(
    `/api/admin/nodes/${nodeId}/ports`,
  );
  return data.entries;
}

/**
 * POST /api/admin/nodes/:id/ports — reserve a port-pool entry.
 *
 * The backend parses the spec, rejects overlaps, and verifies every port is
 * free on the host via the agent. A 409 names the offending (in-use or
 * overlapping) ports in the message; a 502 means the node could not be reached.
 */
export async function adminAddNodePortPoolEntry(
  nodeId: string,
  spec: string,
  protocol: "tcp" | "udp" = "tcp",
): Promise<NodePortPoolEntry> {
  const data = await request<{ entry: NodePortPoolEntry }>(
    `/api/admin/nodes/${nodeId}/ports`,
    { method: "POST", body: JSON.stringify({ spec, protocol }) },
  );
  return data.entry;
}

/**
 * DELETE /api/admin/nodes/ports/:entryId — remove a pool entry.
 *
 * Existing server bindings are grandfathered; only future allocations change.
 */
export async function adminDeleteNodePortPoolEntry(
  entryId: string,
): Promise<void> {
  await request(`/api/admin/nodes/ports/${entryId}`, { method: "DELETE" });
}

/**
 * GET /api/admin/nodes — registered nodes with capacity and allocation.
 *
 * The list endpoint returns the full public node shape plus an `allocation`
 * block per node; both are mapped into the UI's display types here.
 */
export async function adminListNodes(): Promise<
  { node: NodeView; allocation: NodeAllocation | null }[]
> {
  const data = await request<{
    nodes: (NodeView & {
      allocation:
        | { cpuAllocated: number; memoryAllocatedMb: number; diskAllocatedMb: number }
        | null;
    })[];
  }>("/api/admin/nodes");

  return data.nodes.map(({ allocation, ...node }) => ({
    node: {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      apiUrl: node.apiUrl,
      consoleUrl: node.consoleUrl,
      cpuTotal: node.cpuTotal,
      memoryTotalMb: node.memoryTotalMb,
      diskTotalMb: node.diskTotalMb,
      cpuReservePct: node.cpuReservePct,
      memoryReservePct: node.memoryReservePct,
      diskReservePct: node.diskReservePct,
      allowOvercommit: node.allowOvercommit,
      hasDatabaseServer: node.hasDatabaseServer,
      isActive: node.isActive,
      lastHeartbeatAt: node.lastHeartbeatAt,
      createdAt: node.createdAt,
    },
    allocation: allocation
      ? {
          cpuAllocated: allocation.cpuAllocated,
          memoryAllocatedMb: allocation.memoryAllocatedMb,
          diskAllocatedMb: allocation.diskAllocatedMb,
        }
      : null,
  }));
}

/**
 * The result of probing a node's agent. Mirrors the BFF's `NodeHealth` shape.
 *
 * `reachable` is the only field guaranteed on every response: when the agent
 * cannot be reached the BFF still answers 200 with `reachable: false` and an
 * `error` string, so a failed probe is an expected result here — not an
 * `ApiError`. `ApiError` is reserved for transport/permission failures.
 */
export interface NodeHealthResult {
  reachable: boolean;
  dockerVersion?: string;
  containersRunning?: number;
  capacity?: { ncpu: number; memTotalMb: number };
  /**
   * Whether the node can write server data. A reachable agent whose data root is
   * unwritable will refuse every provision, so this is shown alongside
   * reachability rather than waiting for a failed server creation to reveal it.
   * Absent when the agent does not report it.
   */
  dataRoot?: NodeDataRootStatus;
  /** Present when the agent was probed but did not answer successfully. */
  error?: string;
  /**
   * The agent refused the token (401/403). True only when `reachable` is false:
   * the host responded, the credential did not match.
   */
  unauthorized?: boolean;
}

/** The agent's report on its own data root, including how to fix it. */
export interface NodeDataRootStatus {
  path: string;
  writable: boolean;
  error?: string;
}

/**
 * GET /api/admin/nodes/:id/health — live reachability check (admin only).
 *
 * Probes the node's agent from the control plane and records a heartbeat when
 * it answers. Used by the "Test connection" button on a node card.
 */
export async function adminTestNodeConnection(
  nodeId: string,
): Promise<NodeHealthResult> {
  const data = await request<{ health: NodeHealthResult }>(
    `/api/admin/nodes/${nodeId}/health`,
  );
  return data.health;
}

/**
 * POST /api/admin/nodes/probe — check connection details before registering.
 *
 * Takes raw `apiUrl` + `token` (no node id yet) and pings the agent without
 * persisting anything. The register dialog's "Test connection" button uses
 * this to validate a URL/token pair at entry time. As with
 * `adminTestNodeConnection`, a failed probe is a 200 with `reachable: false`,
 * not an `ApiError`.
 */
export async function adminProbeNodeConnection(payload: {
  apiUrl: string;
  token: string;
}): Promise<NodeHealthResult> {
  const data = await request<{ health: NodeHealthResult }>(
    "/api/admin/nodes/probe",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return data.health;
}

/** Summary row enriched by the admin listing with owner and live usage. */
export interface AdminServerSummary extends ApiServerSummary {
  ownerEmail: string;
  /** Owner's display name, or null when the account never set one. */
  ownerName: string | null;
  cpuPercent: number | null;
  memoryUsageMb: number | null;
}

/** GET /api/admin/servers — every server on the panel (admin only). */
export function adminListServers(): Promise<AdminServerSummary[]> {
  return request<{ servers: AdminServerSummary[] }>("/api/admin/servers").then(
    (data) => data.servers,
  );
}

// --- Admin enforcement -------------------------------------------------------

export async function adminSuspendServer(
  serverId: string,
  reason: string,
): Promise<void> {
  await request(`/api/admin/servers/${serverId}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function adminUnsuspendServer(serverId: string): Promise<void> {
  await request(`/api/admin/servers/${serverId}/unsuspend`, { method: "POST" });
}

export async function adminUpdateServerResources(
  serverId: string,
  payload: { cpuLimit?: number; memoryLimitMb?: number; diskLimitMb?: number },
): Promise<void> {
  await request(`/api/admin/servers/${serverId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// --- Blueprints (admin CRUD) --------------------------------------------------

export type BlueprintResourceProfile = "bursty" | "steady-low" | "steady-high";

export interface BlueprintPortSpec {
  container: number;
  protocol: "tcp" | "udp";
  primary?: boolean;
}

export interface BlueprintEnvField {
  required: boolean;
  default?: string;
  description?: string;
  options?: string[];
  secret?: boolean;
  /** When true, the server owner may override this value after creation. */
  editable?: boolean;
}

export interface BlueprintInstallSpec {
  image: string;
  script: string;
  entrypoint: string[] | null;
}

/** A row in the admin blueprint list. */
export interface AdminBlueprintSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  dockerImage: string;
  expectedResourceProfile: BlueprintResourceProfile;
  hasInstall: boolean;
  isBuiltin: boolean;
  serverCount: number;
}

/** A blueprint's full detail, as loaded into the edit form. */
export interface AdminBlueprintDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  dockerImage: string;
  defaultPorts: BlueprintPortSpec[];
  envSchema: Record<string, BlueprintEnvField>;
  startupCommand: string | null;
  stopCommand: string | null;
  install: BlueprintInstallSpec | null;
  plugins: BlueprintPluginsSpec | null;
  dataPath: string;
  minimums: { cpuLimit: number; memoryLimitMb: number; diskLimitMb: number };
  supportsReadOnlyRoot: boolean;
  expectedResourceProfile: BlueprintResourceProfile;
  isBuiltin: boolean;
  serverCount: number;
}

/** The write payload the create/update endpoints accept. */
export interface BlueprintPayload {
  key: string;
  name: string;
  description?: string | null;
  dockerImage: string;
  dataPath?: string;
  expectedResourceProfile: BlueprintResourceProfile;
  supportsReadOnlyRoot?: boolean;
  startupCommand?: string | null;
  stopCommand?: string | null;
  ports: BlueprintPortSpec[];
  // Sent as a flat array; the backend keys it into the stored env schema.
  envFields: {
    key: string;
    required?: boolean;
    secret?: boolean;
    editable?: boolean;
    default?: string;
    description?: string;
    options?: string[];
  }[];
  install?: { image: string; script: string; entrypoint?: string[] | null } | null;
  plugins?: BlueprintPluginsSpec | null;
  minimums: { cpuLimit: number; memoryLimitMb: number; diskLimitMb: number };
}

/** GET /api/admin/blueprints — every blueprint with its server count. */
export async function adminListBlueprints(): Promise<AdminBlueprintSummary[]> {
  const data = await request<{ blueprints: AdminBlueprintSummary[] }>(
    "/api/admin/blueprints",
  );
  return data.blueprints;
}

/** GET /api/admin/blueprints/:id — full detail for the edit form. */
export async function adminGetBlueprint(id: string): Promise<AdminBlueprintDetail> {
  const data = await request<{ blueprint: AdminBlueprintDetail }>(
    `/api/admin/blueprints/${id}`,
  );
  return data.blueprint;
}

/** POST /api/admin/blueprints — create a custom blueprint. */
export async function adminCreateBlueprint(
  payload: BlueprintPayload,
): Promise<AdminBlueprintDetail> {
  const data = await request<{ blueprint: AdminBlueprintDetail }>(
    "/api/admin/blueprints",
    { method: "POST", body: JSON.stringify(payload) },
  );
  return data.blueprint;
}

/** PATCH /api/admin/blueprints/:id — update a custom blueprint. */
export async function adminUpdateBlueprint(
  id: string,
  payload: BlueprintPayload,
): Promise<AdminBlueprintDetail> {
  const data = await request<{ blueprint: AdminBlueprintDetail }>(
    `/api/admin/blueprints/${id}`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
  return data.blueprint;
}

/** DELETE /api/admin/blueprints/:id — remove a custom, unused blueprint. */
export async function adminDeleteBlueprint(id: string): Promise<void> {
  await request(`/api/admin/blueprints/${id}`, { method: "DELETE" });
}

/**
 * POST /api/admin/blueprints/import-url — server-side fetch of a blueprint JSON
 * file from a link (avoids browser CORS). Returns the raw parsed object; the
 * caller validates it before opening the review form.
 */
export async function adminImportBlueprintFromUrl(
  url: string,
): Promise<Record<string, unknown>> {
  const data = await request<{ file: Record<string, unknown> }>(
    "/api/admin/blueprints/import-url",
    { method: "POST", body: JSON.stringify({ url }) },
  );
  return data.file;
}

// --- Security / suspicious activity ------------------------------------------

/**
 * GET /api/admin/suspicious-activity — the abuse review queue.
 *
 * The backend joins each flag with server/owner context and stores per-signal
 * detail in a JSON `detail` column; this flattens that detail into the
 * evidence rows the queue renders.
 */
export async function adminListSuspicious(
  includeReviewed = false,
): Promise<{ activity: SuspiciousActivityView[]; pendingCount: number }> {
  const data = await request<{
    activity: {
      id: string;
      server_id: string;
      server_name: string | null;
      owner_id: string | null;
      owner_email: string | null;
      reason: string;
      score: number;
      detail: {
        signals?: { rule: string; reason: string; detail?: Record<string, unknown> }[];
        observation?: Record<string, unknown>;
      };
      reviewed: boolean;
      detected_at: string;
    }[];
    pendingCount: number;
  }>(
    `/api/admin/suspicious-activity${includeReviewed ? "?includeReviewed=true" : ""}`,
  );

  return {
    pendingCount: data.pendingCount,
    activity: data.activity.map((row) => {
      // Flatten the observation map plus each signal's detail into flat rows.
      const evidence: { field: string; value: string }[] = [];
      for (const [field, value] of Object.entries(row.detail?.observation ?? {})) {
        evidence.push({ field, value: String(value) });
      }
      for (const signal of row.detail?.signals ?? []) {
        for (const [field, value] of Object.entries(signal.detail ?? {})) {
          evidence.push({ field: `${signal.rule}.${field}`, value: String(value) });
        }
      }

      return {
        id: row.id,
        serverId: row.server_id,
        serverName: row.server_name,
        ownerId: row.owner_id,
        ownerEmail: row.owner_email,
        score: row.score,
        reason: row.reason,
        evidence,
        reviewed: row.reviewed,
        detectedAt: row.detected_at,
      };
    }),
  };
}

/** POST /api/admin/suspicious-activity/:id/review — mark reviewed/dismissed. */
export async function adminReviewSuspicious(
  id: string,
  reviewed = true,
): Promise<void> {
  await request(`/api/admin/suspicious-activity/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ reviewed }),
  });
}

// --- Admin audit -------------------------------------------------------------

// NOTE: this endpoint returns raw DB rows in snake_case, unlike the camelCase
// server/node endpoints. Normalize at the client boundary. The handler also
// batch-resolves actor identity and target names server-side so the UI can show
// "who" and "what" without a second round-trip per row.

export interface AdminAuditEntry {
  id: string;
  userId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
  /** Actor's email (null for system actions or deleted accounts). */
  actorEmail: string | null;
  /** Actor's display name (null for system actions or deleted accounts). */
  actorName: string | null;
  /** Human-readable target name (null when the target has no name or was deleted). */
  targetName: string | null;
}

export async function adminListAuditLogs(limit = 100): Promise<AdminAuditEntry[]> {
  const data = await request<{
    logs: {
      id: string;
      user_id: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      ip: string | null;
      metadata: Record<string, unknown> | null;
      created_at: string;
      actor_email: string | null;
      actor_name: string | null;
      target_name: string | null;
    }[];
  }>(`/api/admin/audit-logs?limit=${limit}`);

  return data.logs.map((row) => ({
    id: row.id,
    userId: row.user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    ip: row.ip,
    createdAt: row.created_at,
    metadata: row.metadata ?? {},
    actorEmail: row.actor_email,
    actorName: row.actor_name,
    targetName: row.target_name,
  }));
}

 * A single audit entry scoped to one server. Mirrors {@link AdminAuditEntry}
// --- Admin general settings ---------------------------------------------------

/** Mail providers the panel can send through. Mirrors services/settings.ts. */
export type MailProvider = "smtp" | "resend";

/** Captcha config as the admin settings form sees it (secret is a boolean). */
export interface AdminCaptchaSettings {
  enabled: boolean;
  provider: CaptchaProvider | null;
  siteKey: string | null;
  apiEndpoint: string | null;
  minScore: number;
  hasSecretKey: boolean;
}

/** Mail config as the admin form sees it: no secrets, just "is one stored?". */
export interface AdminMailSettings {
  enabled: boolean;
  provider: MailProvider | null;
  fromName: string | null;
  fromEmail: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean;
  hasSmtpPassword: boolean;
  hasResendApiKey: boolean;
}

export interface AdminSettings {
  timezone: string;
  captcha: AdminCaptchaSettings;
  mail: AdminMailSettings;
  verification: { requireVerifiedSignIn: boolean };
  serverLimits: { maxAdditionalPortsPerServer: number; maxDatabasesPerServer: number };
}

/** GET /api/admin/settings — current general settings (admin only). */
export async function getAdminSettings(): Promise<AdminSettings> {
  return request<AdminSettings>("/api/admin/settings");
}

/** Shape of a partial settings update; every field is optional. */
export interface AdminSettingsUpdate {
  timezone?: string;
  captcha?: CaptchaSettingsInput;
  mail?: {
    enabled: boolean;
    provider?: MailProvider | null;
    fromName?: string | null;
    fromEmail?: string | null;
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpUser?: string | null;
    /** Plaintext; omit to keep the stored secret. */
    smtpPassword?: string | null;
    smtpSecure?: boolean;
    /** Plaintext; omit to keep the stored secret. */
    resendApiKey?: string | null;
  };
  verification?: { requireVerifiedSignIn: boolean };
  serverLimits?: { maxAdditionalPortsPerServer?: number; maxDatabasesPerServer?: number };
}

/**
 * PATCH /api/admin/settings — update one or more settings groups. Returns the
 * resulting public view of whatever was changed (admin only).
 */
export async function updateAdminSettings(
  update: AdminSettingsUpdate,
): Promise<AdminSettings> {
  return request<AdminSettings>("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

/** POST /api/admin/settings/test-email — send a test message (admin only). */
export async function sendTestEmail(to: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/admin/settings/test-email", {
    method: "POST",
    body: JSON.stringify({ to }),
  });
}

// Re-export initials for callers that import it from the api module.
export { initials };
