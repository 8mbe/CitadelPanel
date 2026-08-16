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
  hostPort: number;
  containerPort: number;
  protocol: string;
  isPrimary: boolean;
  serverId: string;
  serverName: string;
}

/** A published port on a server, as the UI displays it. */
export interface ServerPortView {
  hostPort: number;
  containerPort: number;
  protocol: string;
  isPrimary: boolean;
  | "database";

/**
 * What the current caller can do on a server, as reported by the server
 * detail endpoint. Owners and admins implicitly hold every permission (their
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
  // Every published port; `primaryPort` is the host port of the primary one.
  ports: ServerPortView[];
  // Live resource samples while running. Zero until the stats feed fills them.
  cpuPercent: number;
  memoryUsedMb: number;
  diskUsedMb: number;
  // Admin-allocated ceilings. Set at provisioning, editable only by an admin.
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
  playerCount: number;
  playerMax: number;
  uptimeSeconds: number;
  // Live network throughput samples while running (bits per second).
  networkRxBps: number;
  networkTxBps: number;
  createdAt: string;
}

/** A per-server delegated user. */
export interface SubuserView {
  userId: string;
  name: string;
  email: string;
  permissions: string[];
  createdAt: string | null;
}

/** A currently-connected player. */
export interface PlayerView {
  id: string;
  username: string;
  joinedAt: string;
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
