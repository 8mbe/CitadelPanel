// ---------------------------------------------------------------------------
// Shared display types
//
// These mirror the backend's real shapes (serverManager.ServerStatus,
// nodeRegistry.PublicNode, the games preset registry) as the UI needs them.
// They are the display contract every page renders against; lib/api.ts maps
// backend responses into these before they reach a component.
// ---------------------------------------------------------------------------

// Matches apps/backend/src/services/serverManager.ts `ServerStatus`.
export type ServerStatus =
  | "creating"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "suspended"
  | "error"
  | "deleting";

// Matches apps/backend/src/nodes/nodeRegistry.ts `PublicNode`.
export interface NodeView {
  id: string;
  name: string;
  hostname: string;
  apiUrl: string;
  /** Public browser URL for the direct console WS, or null to derive from apiUrl. */
  consoleUrl: string | null;
  cpuTotal: number;
  memoryTotalMb: number;
  diskTotalMb: number;
  /** Share of CPU (0-95) the scheduler must leave free. */
  cpuReservePct: number;
  /** Share of memory (0-95) the scheduler must leave free. */
  memoryReservePct: number;
  /** Share of disk (0-95) the scheduler must leave free. */
  diskReservePct: number;
  /** When true, the scheduler ignores the reserves and allocates the full total. */
  allowOvercommit: boolean;
  hasDatabaseServer: boolean;
  isActive: boolean;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

/** Per-node allocation snapshot used for capacity bars. */
export interface NodeAllocation {
  cpuAllocated: number;
  memoryAllocatedMb: number;
  diskAllocatedMb: number;
}

/**
 * A server on a node, as the node detail page renders it.
 *
 * Extends the server view with admin context (owner email) and a live usage
 * sample. Live fields are `null` — not 0 — when the node is unreachable, so the
 * UI can show "—" rather than a misleading 0%.
 */
export type NodeServerView = Omit<
  ServerView,
  "cpuPercent" | "memoryUsedMb"
> & {
  ownerEmail: string;
  cpuPercent: number | null;
  memoryUsageMb: number | null;
  diskUsageMb: number | null;
};

/** A recent abuse flag on a node's servers, trimmed for the detail card. */
export interface NodeAbuseFlag {
  id: string;
  serverId: string;
  serverName: string | null;
  score: number;
  reason: string;
  reviewed: boolean;
  detectedAt: string;
}

/** Aggregate abuse picture for one node. */
export interface NodeAbuseSummary {
  openCount: number;
  reviewedCount: number;
  maxScore: number;
  recent: NodeAbuseFlag[];
}

/** A reserved port-pool entry on a node, as the admin manages it. */
export interface NodePortPoolEntry {
  id: string;
  nodeId: string;
  /** Raw entry as the admin typed it, e.g. "25565-25570" or "25565,25578". */
  spec: string;
  protocol: "tcp" | "udp";
  /** Expanded individual ports the spec resolves to. */
  ports: number[];
  createdAt: string;
}

/** The full node detail response, one round-trip for the whole page. */
export interface NodeDetail {
  node: NodeView;
  allocation: NodeAllocation | null;
  servers: NodeServerView[];
  abuse: NodeAbuseSummary;
  /** Reserved port-pool entries; new servers draw from this set. */
  portPool: NodePortPoolEntry[];
}

/**
 * A port published on a node, flattened across servers for the allocation view.
 * Derived client-side from `servers[].ports` so no second endpoint is needed.
 */
export interface NodePortAllocation {
  port: number;
  protocol: string;
  isPrimary: boolean;
  serverId: string;
  serverName: string;
}

/** A published port on a server, as the UI displays it. */
export interface ServerPortView {
  /** The published port — identity mapping: host and container side are this number. */
  port: number;
  protocol: string;
  isPrimary: boolean;
  /** True for owner-added ports (removable); false for blueprint ports. */
  isAdditional: boolean;
  /** Optional owner note, e.g. "Metrics". Null when none was set. */
  label: string | null;
}

/**
 * The per-server permission flags a subuser can be granted. Mirrors
 * `SUBUSER_PERMISSIONS` on the backend; only the UI-facing copy lives here so
 * client code never imports server modules.
 */
export type ServerPermission =
  | "console"
  | "files"
  | "start_stop"
  | "settings"
  | "backups"
  | "database";

/**
 * What the current caller can do on a server, as reported by the server
 * detail endpoint. Owners and admins implicitly hold every permission (their
 * `permissions` set is empty); a subuser holds only the granted flags.
 */
export interface ServerViewerAccess {
  kind: "admin" | "owner" | "subuser";
  permissions: Partial<Record<ServerPermission, boolean>>;
}

/** A game server as the UI displays it. */
export interface ServerView {
  id: string;
  name: string;
  blueprintKey: string;
  status: ServerStatus;
  nodeId: string;
  /** The node's hostname: the address players connect to (node, not agent). */
  nodeHostname: string | null;
  ownerId: string;
  primaryPort: number;
  // Every published port; `primaryPort` is the primary one's number.
  ports: ServerPortView[];
  // Live resource samples while running. Zero until the stats feed fills them.
  cpuPercent: number;
  memoryUsedMb: number;
  diskUsedMb: number;
  // Admin-allocated ceilings. Set at provisioning, editable only by an admin.
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
  uptimeSeconds: number;
  createdAt: string;
   * information" — see `lib/permissions.ts` for how the UI treats that.
   */
  viewer?: ServerViewerAccess;
  /**
   * Plugin/mod support resolved from the blueprint for this server, when it
   * declares any: what the tab is called and which provider serves it. Null
   * or undefined means no plugins tab. Only set by the detail endpoint.
   */
  pluginSupport?: {
    label: string;
    providerId: string;
    directory: string;
  } | null;
}

// --- Plugins --------------------------------------------------------------------

/** One installed plugin, as the plugins tab displays it. */
export interface InstalledPluginView {
  id: string;
  projectId: string;
  slug: string | null;
  title: string;
  iconUrl: string | null;
  versionId: string;
  versionNumber: string;
  channel: string;
  filename: string;
  fileSizeBytes: number | null;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  /** Reconciled against the directory listing: enabled | disabled | missing. */
  status: "enabled" | "disabled" | "missing";
}

export interface ServerPluginList {
  support: {
    label: string;
    directory: string;
    projectType: string;
    gameVersion?: string;
    /** Shown in the tab so the content source is never hidden. */
    provider: { id: string; baseUrl: string; downloadHosts: string[] };
  };
  autoUpdate: boolean;
  /** False when the directory listing failed (node down): DB state only. */
  reconciled: boolean;
  plugins: InstalledPluginView[];
  untracked: string[];
}

/** A catalog search hit. */
export interface PluginSearchResult {
  projectId: string;
  slug?: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  categories: string[];
  gameVersions: string[];
}

/** A catalog version offered for install. */
export interface PluginVersionView {
  versionId: string;
  projectId: string;
  name: string;
  versionNumber: string;
  channel: "release" | "beta" | "alpha";
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
  files: {
    url: string;
    filename: string;
    sizeBytes: number;
    primary: boolean;
  }[];
}

// --- Blueprint plugins section (wire shape) ---------------------------------------
//
// Mirrors the server's `BlueprintPluginSupport` (control-plane module
// `blueprints/plugins.ts`, which validates it strictly). Duplicated here
// because client code never imports server modules — keep the two in sync.

export interface BlueprintPluginProfileSpec {
  label?: string;
  directory: string;
  projectType: "mod" | "plugin" | "datapack";
  loaders?: string[];
  gameVersionEnv?: string;
}

interface BlueprintVersionEndpointSpec {
  path: string;
  query?: Record<string, string>;
  root?: string;
  fields: {
    versionId: string;
    versionNumber: string;
    projectId?: string;
    name?: string;
    channel?: string;
    gameVersions?: string;
    loaders?: string;
    datePublished?: string;
    files: {
      path: string;
      fields: {
        url: string;
        filename: string;
        sizeBytes?: string;
        primary?: string;
      };
    };
  };
}

export interface BlueprintPluginProviderSpec {
  id: string;
  baseUrl: string;
  downloadHosts: string[];
  facets?: { source: "projectType" | "loaders" | "gameVersion"; prefix: string }[];
  search: {
    path: string;
    query?: Record<string, string>;
    root?: string;
    total?: string;
    fields: {
      projectId: string;
      title: string;
      slug?: string;
      description?: string;
      author?: string;
      iconUrl?: string;
      downloads?: string;
      categories?: string;
      gameVersions?: string;
    };
  };
  project?: {
    path: string;
    fields: {
      projectId: string;
      title: string;
      slug?: string;
      iconUrl?: string;
      description?: string;
    };
  };
  versions: BlueprintVersionEndpointSpec;
  version?: BlueprintVersionEndpointSpec;
}

export interface BlueprintPluginsSpec {
  label?: string;
  envField?: string;
  variants?: Record<string, BlueprintPluginProfileSpec>;
  default?: BlueprintPluginProfileSpec;
  provider: BlueprintPluginProviderSpec;
}

/** A per-server delegated user. */
export interface SubuserView {
  userId: string;
  name: string;
  email: string;
  permissions: string[];
  createdAt: string | null;
}

/** A single line of console output. */
export interface ConsoleLine {
  id: number;
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
}

/**
 * A resource-abuse flag as the security queue renders it. Mirrors the backend's
 * suspicious_activity row joined with server/owner context.
 */
export interface SuspiciousActivityView {
  id: string;
  serverId: string;
  serverName: string | null;
  ownerId: string | null;
  ownerEmail: string | null;
  /** Cumulative heuristic score (flag threshold 60, single-observation max 130). */
  score: number;
  reason: string;
  /** Per-signal evidence, flattened for the evidence table. */
  evidence: { field: string; value: string }[];
  reviewed: boolean;
  detectedAt: string;
}

/** A blueprint the provisioning form offers. */
export interface BlueprintView {
  key: string;
  name: string;
  description: string | null;
  minimums: { cpuLimit: number; memoryLimitMb: number; diskLimitMb: number };
}

// --- File manager -------------------------------------------------------------

/** A file or folder entry in a server data directory listing. */
export interface FileEntry {
  name: string;
  /** POSIX-style path relative to the server's data root, e.g. "/plugins/foo". */
  path: string;
  type: "file" | "directory" | "other";
  sizeBytes: number;
  /** ISO timestamp of the last modification. */
  modifiedAt: string;
}

/** The shape returned by a directory listing endpoint. */
export interface DirectoryListing {
  path: string;
  entries: FileEntry[];
}
