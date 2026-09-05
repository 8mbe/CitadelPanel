/**
 * Moving a server from one node to another (see `docs/server-migration.md`).
 *
 * The governing rule, and the reason every phase below is ordered the way it
 * is: **a migration is a copy, and the source keeps everything until the
 * destination has proved itself.** The source's container, its data directory
 * and its published ports are all still there and still claimed for the entire
 * run. The panel's record of which node owns the server, `servers.node_id`, is
 * the last thing that moves, and the source's copy is deleted only after the
 * destination has answered as a working server.
 *
 * That is what makes the failure story sayable in one sentence: if anything
 * goes wrong, the server is still on the node it started on. It is also why
 * this cannot be a "move" in any step. There is no point in the run at which
 * the server's files exist in exactly one place and the panel is between two
 * records of where that is.
 *
 * The phases, and what each one is allowed to break:
 *
 *   preflight        Nothing exists yet. Every refusal an operator can act on
 *                    happens here, while the server is still running.
 *   backup           A restic snapshot, so a migration that corrupts something
 *                    nobody notices for a week is still recoverable.
 *   stopping         The source container is stopped. Reversible: start it.
 *   transferring     The destination gets a copy. The source is only read.
 *   allocating_ports Numbers are chosen and verified on the destination. No
 *                    rows are written; the source keeps its claim.
 *   building         The destination's container is created. Nothing runs yet.
 *   verifying        The copy and the container are checked before anything is
 *                    believed.
 *   cutover          One transaction moves node_id and the port rows. This is
 *                    the only irreversible-ish step, and it is a single
 *                    statement group with no network calls inside it.
 *   cleanup          The source's container and files are removed. A failure
 *                    here is reported, not fatal: the migration succeeded.
 *
 * A failure before cutover runs `rollback`, which removes what the destination
 * built and restores the source to exactly the state it was found in, running
 * or stopped. A failure *after* cutover puts `node_id` back too: the source
 * still has everything, precisely because cleanup had not run yet.
 *
 * Like provisioning, the run is detached from the request that started it and
 * reports through its row and its log. Unlike provisioning, the row is the
 * durable record of an operation an admin will walk away from, so
 * `failInterruptedMigrations` closes out anything a panel restart abandoned.
 */

import { sql } from "../db/client";
import { badRequest, conflict, HttpError, notFound } from "../lib/http";
import { getBlueprintByKey, getBlueprintKeyById } from "../blueprints/registry";
import { checkNodeHealth, assertNodeReadyToProvision } from "../nodes/nodeApi";
import { getNodeWithSecrets } from "../nodes/nodeRegistry";
import { allocateHostPort, loadNodeCapacity, withFreeCapacity } from "../nodes/scheduler";
import { expandNodePortPool } from "../nodes/portPool";
import { checkPortNumbersFree } from "../nodes/nodePortsApi";
import {
  measureServerData,
  transferServerData,
} from "../nodes/nodeTransferApi";
import {
  deleteServerContainer,
  getServerState,
  startServerContainer,
  stopServerContainer,
} from "../nodes/nodeServerApi";
import {
  buildServerContainerOn,
  setStatus,
  storeEnv,
  type ServerStatus,
} from "./serverManager";
import { rewireServerLinks } from "./serverLinks";
import { getBackupSettings } from "./settings";
import { getServerBackup, startServerBackup } from "./serverBackups";
import { runBackupTick } from "../nodes/backupScheduler";
import { recordAudit } from "./auditLog";
import {
  changedPorts,
  formatBytes,
  keepablePorts,
  poolHasRoom,
  requiredFreeBytes,
  transferIsComplete,
} from "./migrationPlan";

// --- Types --------------------------------------------------------------------

export type MigrationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export type MigrationPhase =
  | "queued"
  | "preflight"
  | "backup"
  | "stopping"
  | "transferring"
  | "allocating_ports"
  | "building"
  | "verifying"
  | "cutover"
  | "cleanup"
  | "rollback"
  | "finished";

/** What a rollback managed to put back. See the migration table's comment. */
export type MigrationRollback = "not_needed" | "restored" | "partial";

/** One published port, before and after. The migration's receipt. */
export interface MigratedPort {
  port: number;
  isPrimary: boolean;
  isAdditional: boolean;
  label: string | null;
}

export interface MigrationView {
  id: string;
  serverId: string;
  sourceNodeId: string;
  sourceNodeName: string | null;
  destinationNodeId: string;
  destinationNodeName: string | null;
  status: MigrationStatus;
  phase: MigrationPhase;
  percent: number;
  bytesTotal: number | null;
  bytesTransferred: number;
  sourcePorts: MigratedPort[];
  destinationPorts: MigratedPort[];
  wasRunning: boolean;
  backupRunId: string | null;
  error: string | null;
  failedPhase: MigrationPhase | null;
  rollback: MigrationRollback | null;
  requestedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

interface MigrationRow {
  id: string;
  server_id: string;
  source_node_id: string;
  destination_node_id: string;
  status: MigrationStatus;
  phase: MigrationPhase;
  percent: number;
  bytes_total: string | number | null;
  bytes_transferred: string | number;
  source_ports: MigratedPort[];
  destination_ports: MigratedPort[];
  was_running: boolean;
  backup_run_id: string | null;
  error: string | null;
  failed_phase: MigrationPhase | null;
  rollback: MigrationRollback | null;
  requested_by: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  source_node_name?: string | null;
  destination_node_name?: string | null;
}

function toView(row: MigrationRow): MigrationView {
  return {
    id: row.id,
    serverId: row.server_id,
    sourceNodeId: row.source_node_id,
    sourceNodeName: row.source_node_name ?? null,
    destinationNodeId: row.destination_node_id,
    destinationNodeName: row.destination_node_name ?? null,
    status: row.status,
    phase: row.phase,
    percent: row.percent,
    bytesTotal: row.bytes_total === null ? null : Number(row.bytes_total),
    bytesTransferred: Number(row.bytes_transferred),
    sourcePorts: row.source_ports,
    destinationPorts: row.destination_ports,
    wasRunning: row.was_running,
    backupRunId: row.backup_run_id,
    error: row.error,
    failedPhase: row.failed_phase,
    rollback: row.rollback,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

// --- Tuning -------------------------------------------------------------------

/** How long a stopped source container is waited on before the copy starts. */
const STOP_TIMEOUT_SECONDS = 60;

/** How long a safety backup may take before the migration gives up on it. */
const BACKUP_WAIT_MS = 60 * 60_000;

/** How often the safety backup's progress is checked. */
const BACKUP_POLL_MS = 3_000;

/**
 * How often the byte counter is written to the row while data is streaming.
 *
 * The progress callback fires per chunk, which is thousands of times a second.
 * Writing each one would make the migration's database load proportional to the
 * world's size for no gain: the browser polls every two seconds.
 */
const PROGRESS_WRITE_MS = 1_500;

// --- Row helpers ----------------------------------------------------------------

/** The server fields a migration needs, with its node's name, or a 404. */
interface MigrationServer {
  id: string;
  name: string;
  ownerId: string;
  nodeId: string;
  nodeName: string;
  containerId: string | null;
  status: ServerStatus;
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitMb: number;
}

async function loadServer(serverId: string): Promise<MigrationServer> {
  const rows = (await sql`
    SELECT s.id, s.name, s.owner_id, s.node_id, s.container_id, s.status,
           s.cpu_limit, s.memory_limit_mb, s.disk_limit_mb,
           n.name AS node_name
    FROM servers s
    JOIN nodes n ON n.id = s.node_id
    WHERE s.id = ${serverId}
  `) as {
    id: string;
    name: string;
    owner_id: string;
    node_id: string;
    container_id: string | null;
    status: ServerStatus;
    cpu_limit: string | number;
    memory_limit_mb: number;
    disk_limit_mb: number;
    node_name: string;
  }[];

  const row = rows[0];
  if (!row) throw notFound("Server not found.");
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    containerId: row.container_id,
    status: row.status,
    cpuLimit: Number(row.cpu_limit),
    memoryLimitMb: row.memory_limit_mb,
    diskLimitMb: row.disk_limit_mb,
  };
}

/** A server's published ports, in the order the API surfaces them. */
async function loadPorts(serverId: string): Promise<MigratedPort[]> {
  const rows = (await sql`
    SELECT host_port, is_primary, is_additional, label
    FROM server_ports
    WHERE server_id = ${serverId}
    ORDER BY is_primary DESC, is_additional ASC, host_port ASC
  `) as {
    host_port: number;
    is_primary: boolean;
    is_additional: boolean;
    label: string | null;
  }[];

  return rows.map((row) => ({
    port: row.host_port,
    isPrimary: row.is_primary,
    isAdditional: row.is_additional,
    label: row.label,
  }));
}

// --- Log ----------------------------------------------------------------------

export interface MigrationLogLine {
  seq: number;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: Date;
}

/**
 * Append a line to a migration's log.
 *
 * The sequence number is derived from the row's own log inside one statement
 * rather than kept in memory, because the phases that write here are spread
 * across an hour of asynchronous work and a `seq` counter held in a local
 * would not survive a phase that reconnects. `ON CONFLICT DO NOTHING` makes a
 * retried append idempotent rather than an error, matching `backup_run_logs`.
 *
 * Never throws. A log line is how a migration explains itself, and losing the
 * ability to explain must not be able to fail the thing being explained. Same
 * fire-and-forget posture as the audit log.
 */
async function log(
  migrationId: string,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await sql`
      INSERT INTO server_migration_logs (migration_id, seq, level, message)
      SELECT
        ${migrationId},
        COALESCE(MAX(seq), 0) + 1,
        ${level},
        ${message}
      FROM server_migration_logs WHERE migration_id = ${migrationId}
      ON CONFLICT (migration_id, seq) DO NOTHING
    `;
  } catch (error) {
    console.error(`[serverMigration] log append failed for ${migrationId}:`, error);
  }
}

/** A migration's log after `afterSeq`, oldest first. */
export async function listMigrationLogs(
  migrationId: string,
  afterSeq = 0,
): Promise<MigrationLogLine[]> {
  const rows = (await sql`
    SELECT seq, level, message, created_at
    FROM server_migration_logs
    WHERE migration_id = ${migrationId} AND seq > ${afterSeq}
    ORDER BY seq ASC
    LIMIT 500
  `) as { seq: number; level: "info" | "warn" | "error"; message: string; created_at: Date }[];

  return rows.map((row) => ({
    seq: row.seq,
    level: row.level,
    message: row.message,
    createdAt: row.created_at,
  }));
}

// --- Reads ----------------------------------------------------------------------

/**
 * The migration select, with both node names joined in.
 *
 * A function rather than a module-level constant: a `postgres` tagged template
 * is a query object, and reusing one across calls is not something to rely on.
 * Built fresh per read, which costs nothing and cannot go wrong.
 */
const selectMigration = () => sql`
  SELECT m.*, src.name AS source_node_name, dst.name AS destination_node_name
  FROM server_migrations m
  LEFT JOIN nodes src ON src.id = m.source_node_id
  LEFT JOIN nodes dst ON dst.id = m.destination_node_id
`;

/** One migration, verified to belong to the named server, or a 404. */
export async function getServerMigration(
  serverId: string,
  migrationId: string,
): Promise<MigrationView> {
  const rows = (await sql`
    ${selectMigration()} WHERE m.id = ${migrationId} AND m.server_id = ${serverId}
  `) as MigrationRow[];
  const row = rows[0];
  if (!row) throw notFound("Migration not found.");
  return toView(row);
}

/** A server's migration history, newest first. */
export async function listServerMigrations(
  serverId: string,
  limit = 20,
): Promise<MigrationView[]> {
  const rows = (await sql`
    ${selectMigration()}
    WHERE m.server_id = ${serverId}
    ORDER BY m.created_at DESC
    LIMIT ${Math.min(limit, 100)}
  `) as MigrationRow[];
  return rows.map(toView);
}

/** The migration currently in flight for a server, if there is one. */
export async function getActiveMigration(
  serverId: string,
): Promise<MigrationView | null> {
  const rows = (await sql`
    ${selectMigration()}
    WHERE m.server_id = ${serverId}
      AND m.status IN ('pending', 'running', 'cancelling')
    ORDER BY m.created_at DESC
    LIMIT 1
  `) as MigrationRow[];
  return rows[0] ? toView(rows[0]) : null;
}

// --- Progress -------------------------------------------------------------------

async function setPhase(
  migrationId: string,
  phase: MigrationPhase,
  percent: number,
): Promise<void> {
  await sql`
    UPDATE server_migrations
    SET phase = ${phase}, percent = ${percent}, status = 'running', updated_at = now()
    WHERE id = ${migrationId}
  `;
}

/** Whether an admin has asked for this run to stop at its next safe point. */
async function cancelRequested(migrationId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT status FROM server_migrations WHERE id = ${migrationId}
  `) as { status: MigrationStatus }[];
  return rows[0]?.status === "cancelling";
}

/** Thrown to unwind a run an admin cancelled. Not a failure; rollback still runs. */
class MigrationCancelled extends Error {
  constructor() {
    super("The migration was cancelled.");
    this.name = "MigrationCancelled";
  }
}

async function checkpoint(migrationId: string): Promise<void> {
  if (await cancelRequested(migrationId)) throw new MigrationCancelled();
}

// --- Preflight --------------------------------------------------------------------

/** One thing checked before a migration is allowed to start. */
export interface PreflightCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface MigrationPreflight {
  serverId: string;
  serverName: string;
  sourceNodeId: string;
  sourceNodeName: string;
  destinationNodeId: string;
  destinationNodeName: string;
  /** Measured size of the server's data directory. Null when unmeasurable. */
  dataSizeBytes: number | null;
  /** Free bytes on the destination's data root. Null when the agent cannot say. */
  destinationFreeBytes: number | null;
  checks: PreflightCheck[];
  /** No check failed: the migration may be started. */
  canMigrate: boolean;
  /**
   * A backup will not be taken because no destination is configured. The start
   * request must acknowledge this explicitly.
   */
  requiresNoBackupAcknowledgement: boolean;
  /**
   * Numbers the destination can publish for this server, tried in the order
   * "keep what you had". Empty when ports could not be planned.
   */
  plannedPorts: { from: number; to: number }[];
}

/**
 * Everything that can refuse a migration, asked while the server is still up.
 *
 * This runs twice: once for the dialog, so an admin sees the verdict before
 * committing to anything, and once again inside {@link startServerMigration},
 * because the answers are minutes old by the time somebody clicks the button
 * and the node's free disk is not a stable quantity.
 *
 * Every check returns a *result* rather than throwing, so a failed preflight is
 * a readable report with every problem in it rather than whichever one happened
 * to be checked first. An admin fixing three things wants to know about three
 * things.
 */
export async function preflightMigration(
  serverId: string,
  destinationNodeId: string,
): Promise<MigrationPreflight> {
  const server = await loadServer(serverId);
  const checks: PreflightCheck[] = [];

  const destinationRows = (await sql`
    SELECT id, name, is_active FROM nodes WHERE id = ${destinationNodeId}
  `) as { id: string; name: string; is_active: boolean }[];
  const destination = destinationRows[0];
  if (!destination) throw notFound("Destination node not found.");

  if (destination.id === server.nodeId) {
    throw badRequest(`This server is already on "${destination.name}".`);
  }

  const add = (
    id: string,
    label: string,
    status: PreflightCheck["status"],
    detail: string,
  ) => checks.push({ id, label, status, detail });

  // --- The server must be in a state that can be moved -----------------------
  //
  // Every one of these is a server that is mid-something. Migrating it would
  // race whatever is already writing to it: a provision still creating the
  // container, a delete already removing it, a suspension that is an
  // administrative hold rather than a runtime state.
  const movable: ServerStatus[] = ["running", "stopped", "error"];
  if (movable.includes(server.status)) {
    add(
      "status",
      "Server state",
      "ok",
      server.status === "running"
        ? "Running. It will be stopped for the move and started again afterwards."
        : `${server.status}. It will stay stopped after the move.`,
    );
  } else {
    add(
      "status",
      "Server state",
      "fail",
      `A server that is "${server.status}" cannot be migrated. ` +
        (server.status === "suspended"
          ? "Unsuspend it first."
          : "Wait for the operation in progress to finish."),
    );
  }

  if (!server.containerId) {
    add(
      "container",
      "Container",
      "fail",
      "This server has no container on its current node, so there is nothing " +
        "to move. Start it once to have it rebuilt, or delete it.",
    );
  } else {
    add("container", "Container", "ok", `Built on "${server.nodeName}".`);
  }

  if (await getActiveMigration(serverId)) {
    add(
      "concurrency",
      "Other operations",
      "fail",
      "A migration is already running for this server.",
    );
  } else {
    const activeBackups = (await sql`
      SELECT COUNT(*)::int AS count FROM backup_runs
      WHERE server_id = ${serverId} AND status IN ('pending', 'running')
    `) as { count: number }[];
    if ((activeBackups[0]?.count ?? 0) > 0) {
      add(
        "concurrency",
        "Other operations",
        "fail",
        "A backup or restore is running for this server. Wait for it to finish.",
      );
    } else {
      add("concurrency", "Other operations", "ok", "Nothing else is running.");
    }
  }

  // --- Provisioned databases: the one thing that cannot come along -----------
  //
  // A server's database lives on the SOURCE node's shared MariaDB, reachable at
  // that node's internal address and named in config files the panel does not
  // own. Moving the container without it produces a server that starts, looks
  // healthy, and cannot reach its data, which is a worse outcome than a refused
  // migration. Moving it *with* the container is a second feature (a per-server
  // dump, a matching account on the destination's MariaDB, and a config rewrite
  // the panel has no safe way to do), and is deliberately not attempted here.
  const dbRows = (await sql`
    SELECT db_name FROM server_databases WHERE server_id = ${serverId}
  `) as { db_name: string }[];
  if (dbRows.length > 0) {
    add(
      "databases",
      "Databases",
      "fail",
      `This server has ${dbRows.length} database(s) on "${server.nodeName}" ` +
        `(${dbRows.map((row) => row.db_name).join(", ")}). Databases do not ` +
        `move with a server: back them up and remove them from this server ` +
        `first, or migrate a server that has none.`,
    );
  } else {
    add("databases", "Databases", "ok", "None to move.");
  }

  // --- The destination has to be able to host anything at all ---------------
  if (!destination.is_active) {
    add(
      "destination",
      "Destination node",
      "fail",
      `"${destination.name}" is not active. Activate it before migrating to it.`,
    );
  } else {
    try {
      await assertNodeReadyToProvision(destinationNodeId);
      add("destination", "Destination node", "ok", `"${destination.name}" is ready.`);
    } catch (error) {
      add(
        "destination",
        "Destination node",
        "fail",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const destinationHealth = await checkNodeHealth(
    (await getNodeWithSecrets(destinationNodeId))!,
  );

  // The agent shells out to `tar` and `du`; a node without them fails the copy
  // *after* the server has been stopped, which is exactly the discovery this
  // check exists to move earlier.
  if (destinationHealth.transferTools === false) {
    add(
      "tools",
      "Transfer tools",
      "fail",
      `The agent on "${destination.name}" does not have \`tar\` and \`du\`, ` +
        "which a transfer needs. Install them on that node.",
    );
  } else {
    add(
      "tools",
      "Transfer tools",
      "ok",
      destinationHealth.transferTools === true
        ? "Present on the destination."
        : "The destination's agent does not report this; it will be tried anyway.",
    );
  }

  // --- CPU, memory and the scheduler's disk bookkeeping ---------------------
  const capacity = await loadNodeCapacity(destinationNodeId);
  if (!capacity) {
    add("capacity", "CPU / memory", "fail", "The destination node has no capacity record.");
  } else {
    const free = withFreeCapacity(capacity);
    const shortfalls: string[] = [];
    if (free.cpuFree < server.cpuLimit) {
      shortfalls.push(
        `CPU: needs ${server.cpuLimit}, ${free.cpuFree.toFixed(2)} free`,
      );
    }
    if (free.memoryFreeMb < server.memoryLimitMb) {
      shortfalls.push(
        `memory: needs ${server.memoryLimitMb} MB, ${Math.floor(free.memoryFreeMb)} MB free`,
      );
    }
    if (free.diskFreeMb < server.diskLimitMb) {
      shortfalls.push(
        `disk allocation: needs ${server.diskLimitMb} MB, ${Math.floor(free.diskFreeMb)} MB free`,
      );
    }
    if (shortfalls.length > 0) {
      add(
        "capacity",
        "CPU / memory / disk allocation",
        "fail",
        `"${destination.name}" cannot fit this server's limits (${shortfalls.join("; ")}).`,
      );
    } else {
      add(
        "capacity",
        "CPU / memory / disk allocation",
        "ok",
        `${free.cpuFree.toFixed(2)} vCPU and ${Math.floor(free.memoryFreeMb)} MB free ` +
          `after reserves.`,
      );
    }
  }

  // --- Real free space, which the bookkeeping above does not know about ------
  let dataSizeBytes: number | null = null;
  try {
    dataSizeBytes = await measureServerData(server.nodeId, serverId);
  } catch (error) {
    add(
      "size",
      "Data size",
      "fail",
      `The source node could not measure this server's files: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const destinationFreeBytes = destinationHealth.disk?.freeBytes ?? null;

  if (dataSizeBytes !== null) {
    const required = requiredFreeBytes(dataSizeBytes);
    if (destinationFreeBytes === null) {
      add(
        "size",
        "Data size",
        "warn",
        `${formatBytes(dataSizeBytes)} to copy. The destination's agent does not ` +
          "report free space, so this cannot be checked before the copy starts.",
      );
    } else if (destinationFreeBytes < required) {
      add(
        "size",
        "Free space",
        "fail",
        `${formatBytes(dataSizeBytes)} to copy, and "${destination.name}" needs ` +
          `${formatBytes(required)} free (the data plus working headroom) but has ` +
          `${formatBytes(destinationFreeBytes)}.`,
      );
    } else {
      add(
        "size",
        "Free space",
        "ok",
        `${formatBytes(dataSizeBytes)} to copy; ${formatBytes(destinationFreeBytes)} ` +
          `free on "${destination.name}".`,
      );
    }
  }

  // --- Ports: enough of them, and preferably the same numbers ---------------
  const ports = await loadPorts(serverId);
  const plannedPorts: { from: number; to: number }[] = [];

  if (ports.length === 0) {
    add("ports", "Ports", "fail", "This server has no published ports to move.");
  } else {
    try {
      const pool = await expandNodePortPool(destinationNodeId);
      const takenRows = (await sql`
        SELECT host_port FROM server_ports WHERE node_id = ${destinationNodeId}
      `) as { host_port: number }[];
      const taken = new Set(takenRows.map((row) => row.host_port));
      const allocated = [...taken];
      const free = pool.filter((port) => !taken.has(port));

      if (!poolHasRoom(ports.length, pool, allocated)) {
        add(
          "ports",
          "Ports",
          "fail",
          `This server publishes ${ports.length} port(s) and "${destination.name}" ` +
            `has ${free.length} free in its pool. Reserve more ports on that node.`,
        );
      } else {
        // Only the panel's own two checks here: whether the host will actually
        // bind each number is asked of the agent at allocation time, once the
        // move is really happening. Probing every port of every candidate node
        // from a dialog would be a round trip per keystroke for an answer that
        // can change before it is used.
        const keepable = new Set(keepablePorts(ports, pool, allocated, free));
        for (const entry of ports) {
          plannedPorts.push({
            from: entry.port,
            // 0 means "a number from the destination's pool, chosen when the
            // migration runs". It cannot be named now without reserving it.
            to: keepable.has(entry.port) ? entry.port : 0,
          });
        }
        add(
          "ports",
          "Ports",
          "ok",
          keepable.size === ports.length
            ? `All ${ports.length} port(s) are free on "${destination.name}" and ` +
                "will be kept as they are."
            : `${keepable.size} of ${ports.length} port(s) can be kept; the rest ` +
                "will be reassigned from the destination's pool.",
        );
      }
    } catch (error) {
      add(
        "ports",
        "Ports",
        "fail",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // --- The safety backup ----------------------------------------------------
  const backupSettings = await getBackupSettings();
  const backupsUsable =
    backupSettings.enabled &&
    Boolean(backupSettings.bucket) &&
    Boolean(backupSettings.accessKeyId);

  if (backupsUsable) {
    add(
      "backup",
      "Safety backup",
      "ok",
      "A backup will be taken before anything is moved, and the migration is " +
        "abandoned if it fails.",
    );
  } else {
    add(
      "backup",
      "Safety backup",
      "warn",
      "No backup destination is configured, so the migration will run without " +
        "one. The source node's copy is still kept until the destination works, " +
        "but there will be no snapshot to fall back on afterwards.",
    );
  }

  return {
    serverId,
    serverName: server.name,
    sourceNodeId: server.nodeId,
    sourceNodeName: server.nodeName,
    destinationNodeId,
    destinationNodeName: destination.name,
    dataSizeBytes,
    destinationFreeBytes,
    checks,
    canMigrate: !checks.some((check) => check.status === "fail"),
    requiresNoBackupAcknowledgement: !backupsUsable,
    plannedPorts,
  };
}

// --- Starting -------------------------------------------------------------------

export interface StartMigrationInput {
  serverId: string;
  destinationNodeId: string;
  actorId: string;
  /** Required when no backup destination is configured. See the preflight. */
  acknowledgeNoBackup?: boolean;
  /** gzip the transfer. Off by default; see `nodes/nodeTransferApi.ts`. */
  compress?: boolean;
}

/** In-process handles, so a restart can tell an abandoned run from a live one. */
const inFlightMigrations = new Map<string, Promise<void>>();

/**
 * Start a migration.
 *
 * Everything that can refuse it happens here, synchronously, so a rejected
 * request leaves nothing behind and the server has not been touched. Once the
 * row exists the response returns immediately and {@link runMigration} takes
 * over, reporting through the row and its log for the same reason provisioning
 * does: this takes as long as it takes to copy a world, and no HTTP request
 * should be held open across that.
 */
export async function startServerMigration(
  input: StartMigrationInput,
): Promise<MigrationView> {
  const preflight = await preflightMigration(input.serverId, input.destinationNodeId);

  if (!preflight.canMigrate) {
    const failures = preflight.checks.filter((check) => check.status === "fail");
    throw conflict(
      `This server cannot be migrated to "${preflight.destinationNodeName}": ` +
        failures.map((check) => `${check.label} — ${check.detail}`).join(" "),
    );
  }

  // An explicit acknowledgement rather than a silent proceed. Running the whole
  // thing with no snapshot to fall back on is a decision, and it should be one
  // somebody made rather than one the panel made for them.
  if (preflight.requiresNoBackupAcknowledgement && input.acknowledgeNoBackup !== true) {
    throw conflict(
      "No backup destination is configured, so no safety backup can be taken. " +
        "Configure one under Admin → Backups, or confirm the migration without it.",
    );
  }

  const server = await loadServer(input.serverId);
  const ports = await loadPorts(input.serverId);

  const inserted = (await sql`
    INSERT INTO server_migrations (
      server_id, source_node_id, destination_node_id,
      status, phase, source_ports, was_running, requested_by
    ) VALUES (
      ${input.serverId}, ${server.nodeId}, ${input.destinationNodeId},
      'pending', 'queued', ${sql.json(ports as never)}, ${server.status === "running"},
      ${input.actorId}
    )
    RETURNING id
  `) as { id: string }[];

  const migrationId = inserted[0]!.id;

  await log(
    migrationId,
    "info",
    `Migration of "${server.name}" from "${preflight.sourceNodeName}" to ` +
      `"${preflight.destinationNodeName}" accepted. The server stays on ` +
      `"${preflight.sourceNodeName}" until the move has been verified.`,
  );

  // Audited on acceptance, like `server.create`: the decision to move the
  // server is the admin's action and it has happened. Whether the move then
  // succeeded is the migration row's story.
  await recordAudit({
    userId: input.actorId,
    action: "server.migrate",
    targetType: "server",
    targetId: input.serverId,
    metadata: {
      migrationId,
      fromNodeId: server.nodeId,
      toNodeId: input.destinationNodeId,
      dataSizeBytes: preflight.dataSizeBytes,
      withBackup: !preflight.requiresNoBackupAcknowledgement,
    },
  });

  const task = runMigration(migrationId, input).finally(() => {
    inFlightMigrations.delete(migrationId);
  });
  inFlightMigrations.set(migrationId, task);

  return getServerMigration(input.serverId, migrationId);
}

/**
 * Ask a running migration to stop.
 *
 * Cooperative, not a kill: the run checks between phases and unwinds through
 * the same rollback a failure uses, so a cancelled migration leaves the server
 * exactly where a failed one does. Interrupting a `tar` mid-stream and walking
 * away would leave a half-written tree on the destination that nothing owns.
 *
 * Cancellation is refused once the cutover has begun. Past that point the
 * server is on the destination and the honest options are "let it finish" or
 * "migrate it back", not "stop half way".
 */
export async function cancelServerMigration(
  serverId: string,
  migrationId: string,
  actorId: string,
): Promise<MigrationView> {
  const migration = await getServerMigration(serverId, migrationId);

  if (migration.status !== "running" && migration.status !== "pending") {
    throw conflict(`This migration is already ${migration.status}.`);
  }
  if (migration.phase === "cutover" || migration.phase === "cleanup") {
    throw conflict(
      "The cutover has already started; the migration has to finish. Migrate " +
        "the server back afterwards if that is what you want.",
    );
  }

  await sql`
    UPDATE server_migrations
    SET status = 'cancelling', updated_at = now()
    WHERE id = ${migrationId}
  `;
  await log(
    migrationId,
    "warn",
    "Cancellation requested. The migration will stop at the next safe point and " +
      "put the server back the way it was.",
  );
  await recordAudit({
    userId: actorId,
    action: "server.migrate.cancel",
    targetType: "server",
    targetId: serverId,
    metadata: { migrationId, phase: migration.phase },
  });

  return getServerMigration(serverId, migrationId);
}

// --- The run --------------------------------------------------------------------

/**
 * What the run has done so far, so the rollback knows what to undo.
 *
 * Kept as facts rather than a phase number because the rollback's questions are
 * about things, not about progress: is there a container on the destination, is
 * there data there, was the row moved. A phase would have to be mapped back to
 * those answers anyway, and mapped wrongly exactly once.
 */
interface RunState {
  sourceNodeId: string;
  destinationNodeId: string;
  previousStatus: ServerStatus;
  wasRunning: boolean;
  /** Data has been written into the destination's data root. */
  destinationHasData: boolean;
  /** A container exists on the destination. */
  destinationContainerId: string | null;
  /** The row's `node_id` and ports have been moved. */
  cutoverDone: boolean;
  sourcePorts: MigratedPort[];
  sourceContainerId: string | null;
}

async function runMigration(
  migrationId: string,
  input: StartMigrationInput,
): Promise<void> {
  const serverId = input.serverId;
  const server = await loadServer(serverId);
  const sourcePorts = await loadPorts(serverId);

  const state: RunState = {
    sourceNodeId: server.nodeId,
    destinationNodeId: input.destinationNodeId,
    previousStatus: server.status,
    wasRunning: server.status === "running",
    destinationHasData: false,
    destinationContainerId: null,
    cutoverDone: false,
    sourcePorts,
    sourceContainerId: server.containerId,
  };

  let phase: MigrationPhase = "preflight";

  try {
    // --- Safety backup ------------------------------------------------------
    phase = "backup";
    await setPhase(migrationId, phase, 2);
    await takeSafetyBackup(migrationId, serverId, input);
    await checkpoint(migrationId);

    // --- Stop the source ----------------------------------------------------
    phase = "stopping";
    await setPhase(migrationId, phase, 10);
    await stopSourceForMigration(migrationId, state, serverId, server.nodeName);
    await checkpoint(migrationId);

    // --- Copy ---------------------------------------------------------------
    phase = "transferring";
    await setPhase(migrationId, phase, 15);
    await transferPhase(migrationId, state, serverId, input);
    state.destinationHasData = true;
    await checkpoint(migrationId);

    // --- Choose the destination's port numbers ------------------------------
    phase = "allocating_ports";
    await setPhase(migrationId, phase, 72);
    const destinationPorts = await planDestinationPorts(migrationId, state);
    await checkpoint(migrationId);

    // --- Build --------------------------------------------------------------
    phase = "building";
    await setPhase(migrationId, phase, 80);
    const { containerId, portEnv } = await buildDestinationContainer(
      migrationId,
      serverId,
      state,
      destinationPorts,
    );
    state.destinationContainerId = containerId;
    await checkpoint(migrationId);

    // --- Verify -------------------------------------------------------------
    phase = "verifying";
    await setPhase(migrationId, phase, 88);
    await verifyDestination(migrationId, state, serverId);

    // Past here the migration is committed: cancelling would mean undoing a
    // cutover, which is a migration in its own right.
    // --- Cut over -----------------------------------------------------------
    phase = "cutover";
    await setPhase(migrationId, phase, 92);
    await cutOver(migrationId, serverId, state, destinationPorts, containerId, portEnv);
    state.cutoverDone = true;

    // --- Clean up the source ------------------------------------------------
    phase = "cleanup";
    await setPhase(migrationId, phase, 96);
    const leftovers = await cleanUpSource(migrationId, state, serverId);

    await finishSuccessfully(migrationId, serverId, state, destinationPorts, leftovers);
  } catch (error) {
    const cancelled = error instanceof MigrationCancelled;
    const reason = error instanceof Error ? error.message : String(error);

    await log(
      migrationId,
      cancelled ? "warn" : "error",
      cancelled
        ? `Cancelled during ${phase}. Undoing what had been done…`
        : `Failed during ${phase}: ${reason}`,
    );

    const rollback = await rollbackMigration(migrationId, serverId, state);

    await sql`
      UPDATE server_migrations
      SET status = ${cancelled ? "cancelled" : "failed"},
          phase = 'finished',
          failed_phase = ${phase},
          error = ${reason},
          rollback = ${rollback},
          finished_at = now(),
          updated_at = now()
      WHERE id = ${migrationId}
    `;

    if (!cancelled) {
      console.error(`[serverMigration] ${migrationId} failed during ${phase}:`, error);
    }
  }
}

// --- Phases ---------------------------------------------------------------------

/**
 * Take a restic snapshot before anything moves, and refuse to continue without
 * one.
 *
 * The migration keeps the source's copy throughout, so this is not the primary
 * safety net; it is the secondary one, for the failure that is not detected
 * during the run. A world that arrives subtly wrong and is noticed three days
 * later is past every rollback this module can perform, and a snapshot taken
 * immediately before the move is the only thing that answers it.
 *
 * Skipped, loudly, when no destination is configured. The caller has already
 * had to acknowledge that in {@link startServerMigration}.
 */
async function takeSafetyBackup(
  migrationId: string,
  serverId: string,
  input: StartMigrationInput,
): Promise<void> {
  const settings = await getBackupSettings();
  const usable =
    settings.enabled && Boolean(settings.bucket) && Boolean(settings.accessKeyId);

  if (!usable) {
    await log(
      migrationId,
      "warn",
      "No backup destination is configured, so no safety backup was taken " +
        "(acknowledged when the migration was started).",
    );
    return;
  }

  await log(migrationId, "info", "Taking a backup of the server's files first…");

  const run = await startServerBackup({
    serverId,
    actorId: input.actorId,
    trigger: "manual",
  });

  await sql`
    UPDATE server_migrations
    SET backup_run_id = ${run.id}, updated_at = now()
    WHERE id = ${migrationId}
  `;

  const deadline = Date.now() + BACKUP_WAIT_MS;
  for (;;) {
    // The backup scheduler's own tick is what advances a run; forcing one keeps
    // the wait to the backup's real duration rather than the tick interval.
    await runBackupTick().catch(() => undefined);
    const current = await getServerBackup(serverId, run.id);

    if (current.status === "succeeded") {
      await log(
        migrationId,
        "info",
        `Backup complete (snapshot ${current.snapshotId ?? "unknown"}).`,
      );
      return;
    }
    if (current.status === "failed") {
      throw new HttpError(
        502,
        `The safety backup failed (${current.error ?? "no reason given"}), so the ` +
          "migration was not attempted. Nothing has been moved.",
      );
    }
    if (Date.now() > deadline) {
      throw new HttpError(
        504,
        "The safety backup did not finish within an hour, so the migration was " +
          "not attempted. Nothing has been moved.",
      );
    }
    await checkpoint(migrationId);
    await new Promise((resolve) => setTimeout(resolve, BACKUP_POLL_MS));
  }
}

/**
 * Stop the source container and hold the row in `migrating`.
 *
 * The stop is what makes the copy mean anything: `tar`-ing a world the game is
 * still saving into produces an archive of a moment that never existed, with
 * half-written region files. It is the same reasoning that makes a restore stop
 * the server first (`serverBackups.ts`).
 *
 * `migrating` is written *after* the stop rather than before, so the ordinary
 * `stopping` → `stopped` transition still shows up to anyone watching the
 * server page, and the row only enters the status nothing reconciles once the
 * migration genuinely owns it.
 */
async function stopSourceForMigration(
  migrationId: string,
  state: RunState,
  serverId: string,
  sourceNodeName: string,
): Promise<void> {
  if (state.wasRunning) {
    await log(migrationId, "info", "Stopping the server so its files stop changing…");
    await setStatus(serverId, "stopping");
    try {
      await stopServerContainer(state.sourceNodeId, serverId, STOP_TIMEOUT_SECONDS);
    } catch (error) {
      await setStatus(serverId, state.previousStatus);
      throw new HttpError(
        502,
        `The server could not be stopped on "${sourceNodeName}", so nothing ` +
          `was moved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await log(migrationId, "info", "Stopped.");
  } else {
    await log(migrationId, "info", "The server was already stopped.");
  }

  await setStatus(serverId, "migrating");
}

/** Copy the data directory, then check that what arrived is the right size. */
async function transferPhase(
  migrationId: string,
  state: RunState,
  serverId: string,
  input: StartMigrationInput,
): Promise<void> {
  const sourceSize = await measureServerData(state.sourceNodeId, serverId);
  await sql`
    UPDATE server_migrations
    SET bytes_total = ${sourceSize}, bytes_transferred = 0, updated_at = now()
    WHERE id = ${migrationId}
  `;
  await log(
    migrationId,
    "info",
    `Copying ${formatBytes(sourceSize)} to the destination node…`,
  );

  let lastWrite = 0;
  const result = await transferServerData({
    sourceNodeId: state.sourceNodeId,
    destinationNodeId: state.destinationNodeId,
    serverId,
    compress: input.compress,
    onProgress: (bytes) => {
      const now = Date.now();
      if (now - lastWrite < PROGRESS_WRITE_MS) return;
      lastWrite = now;
      // Percent spans 15-70: the transfer is most of the wall clock but not all
      // of the work, and a bar that sits at 100% through a five-minute build is
      // worse than one that never got there.
      const percent =
        sourceSize > 0
          ? 15 + Math.min(55, Math.floor((bytes / sourceSize) * 55))
          : 15;
      void sql`
        UPDATE server_migrations
        SET bytes_transferred = ${bytes}, percent = ${percent}, updated_at = now()
        WHERE id = ${migrationId}
      `.catch(() => undefined);
    },
  });

  await sql`
    UPDATE server_migrations
    SET bytes_transferred = ${result.bytesTransferred}, percent = 70, updated_at = now()
    WHERE id = ${migrationId}
  `;

  // The check a streaming copy needs and a buffered one does not: an archive
  // truncated at a member boundary extracts without complaint, and the only
  // evidence is that the result is smaller than what was sent.
  if (!transferIsComplete(sourceSize, result.destinationSizeBytes)) {
    throw new HttpError(
      502,
      `The copy is incomplete: the source holds ${formatBytes(sourceSize)} but only ` +
        `${formatBytes(result.destinationSizeBytes)} arrived on the destination.`,
    );
  }

  await log(
    migrationId,
    "info",
    `Copied ${formatBytes(result.bytesTransferred)}; the destination holds ` +
      `${formatBytes(result.destinationSizeBytes)}.`,
  );
}

/**
 * Choose the port numbers the server will publish on the destination.
 *
 * Keeps every number it can. A preserved port is a player address that does not
 * change, a config file that does not need touching, and a server-link peer
 * that keeps working; a reassigned one is churn in all three. So the number is
 * only reassigned when the destination genuinely cannot offer it, and the log
 * says which and why.
 *
 * **Nothing is written.** The rows stay with the source until the cutover
 * transaction, which is what keeps the source's claim intact for the whole run.
 * The cost is a window between this check and the cutover in which another
 * server's create could take one of these numbers on the destination; the
 * `UNIQUE (node_id, host_port)` constraint catches that at cutover and the
 * migration fails with the source untouched, which is the correct outcome for a
 * race this rare.
 */
async function planDestinationPorts(
  migrationId: string,
  state: RunState,
): Promise<MigratedPort[]> {
  const pool = await expandNodePortPool(state.destinationNodeId);
  const takenRows = (await sql`
    SELECT host_port FROM server_ports WHERE node_id = ${state.destinationNodeId}
  `) as { host_port: number }[];
  const taken = new Set(takenRows.map((row) => row.host_port));

  // Which of the wanted numbers are in the destination's pool, unallocated, and
  // free on the host right now. One round trip for the whole set.
  const candidates = state.sourcePorts
    .map((entry) => entry.port)
    .filter((port) => pool.includes(port) && !taken.has(port));
  const probes = candidates.length > 0
    ? await checkPortNumbersFree(state.destinationNodeId, candidates)
    : [];
  const freeOnHost = probes.filter((probe) => probe.free).map((p) => p.hostPort);
  const keepable = new Set(
    keepablePorts(state.sourcePorts, pool, [...taken], freeOnHost),
  );

  const planned: MigratedPort[] = [];
  const claimed = new Set<number>();

  for (const entry of state.sourcePorts) {
    if (keepable.has(entry.port) && !claimed.has(entry.port)) {
      claimed.add(entry.port);
      planned.push({ ...entry });
      continue;
    }

    // `allocateHostPort` draws randomly from the pool and verifies against the
    // host, the same way a new server's ports are drawn. Numbers already
    // planned in this loop are not in `server_ports` yet, so they are excluded
    // by hand.
    let candidate: number | null = null;
    for (let attempt = 0; attempt < 8 && candidate === null; attempt += 1) {
      const drawn = await allocateHostPort(state.destinationNodeId);
      if (!claimed.has(drawn)) candidate = drawn;
    }
    if (candidate === null) {
      throw new HttpError(
        409,
        "The destination node could not offer enough distinct free ports.",
      );
    }

    claimed.add(candidate);
    planned.push({ ...entry, port: candidate });
    await log(
      migrationId,
      "warn",
      `Port ${entry.port} is not available on the destination; this server will ` +
        `use ${candidate} instead${entry.isPrimary ? " as its player port" : ""}.`,
    );
  }

  const changes = changedPorts(state.sourcePorts, planned);
  await log(
    migrationId,
    "info",
    changes.length === 0
      ? `All ${planned.length} port(s) kept their numbers.`
      : `${planned.length - changes.length} of ${planned.length} port(s) kept ` +
          "their numbers.",
  );

  return planned;
}

/**
 * Create the container on the destination, with the new port set.
 *
 * The primary port reaches the game through the blueprint's `primaryPortEnv`
 * (see [ports.md]), which is why a reassigned port does not need anybody to
 * edit `server.properties`: the image writes that file from the variable on
 * every boot. The value is passed as an override rather than persisted, because
 * a migration that fails after this must not leave `server_env` describing a
 * port on a node the server is not on. The cutover persists it.
 */
async function buildDestinationContainer(
  migrationId: string,
  serverId: string,
  state: RunState,
  ports: MigratedPort[],
): Promise<{ containerId: string; portEnv: Record<string, string> }> {
  const blueprintKeyRows = (await sql`
    SELECT blueprint_id FROM servers WHERE id = ${serverId}
  `) as { blueprint_id: string }[];
  const blueprintKey = await getBlueprintKeyById(blueprintKeyRows[0]!.blueprint_id);
  const blueprint = blueprintKey ? await getBlueprintByKey(blueprintKey) : null;

  const portEnv: Record<string, string> = {};
  const primary = ports.find((entry) => entry.isPrimary) ?? ports[0]!;
  if (blueprint?.primaryPortEnv) {
    portEnv[blueprint.primaryPortEnv] = String(primary.port);
  }

  await log(
    migrationId,
    "info",
    `Building the container on the destination node, publishing ` +
      `${ports.map((entry) => entry.port).join(", ")}…`,
  );

  const { containerId } = await buildServerContainerOn(
    serverId,
    state.destinationNodeId,
    ports.map((entry) => ({ port: entry.port, isPrimary: entry.isPrimary })),
    portEnv,
  );

  await log(migrationId, "info", "Container created on the destination node.");
  return { containerId, portEnv };
}

/**
 * Check the destination before the record moves.
 *
 * Deliberately does *not* start the game. Booting a Minecraft server takes
 * minutes and writes to the world it has just received, so a
 * start-verify-stop before cutover would double the outage and mutate the very
 * thing being verified. What is checked here is what can be checked cheaply and
 * is what actually goes wrong: the container exists on the destination and
 * Docker is willing to describe it.
 *
 * The real proof is the start that happens immediately after cutover, and the
 * reason it is safe to leave the proof until then is that a failure there
 * *also* rolls back: nothing on the source has been deleted yet.
 */
async function verifyDestination(
  migrationId: string,
  state: RunState,
  serverId: string,
): Promise<void> {
  const observed = await getServerState(state.destinationNodeId, serverId);
  if (observed === "missing") {
    throw new HttpError(
      502,
      "The destination node reports no container for this server immediately " +
        "after creating one.",
    );
  }
  await log(
    migrationId,
    "info",
    `The destination reports the container as "${observed}".`,
  );
}

/**
 * The one moment the server changes hands.
 *
 * A single transaction with no network calls in it: the port rows move from the
 * source node to the destination, `servers.node_id` and `container_id` follow,
 * and the migration's receipt is written. Either all of that happens or none of
 * it does, and the failure case is a server still recorded on the source, whose
 * container is still there.
 *
 * The DELETE-then-INSERT on `server_ports` is what releases the source's claim.
 * It is also where a port that was stolen by a concurrent create between the
 * plan and here surfaces, as a `UNIQUE (node_id, host_port)` violation that
 * rolls the whole thing back.
 */
async function cutOver(
  migrationId: string,
  serverId: string,
  state: RunState,
  ports: MigratedPort[],
  containerId: string,
  portEnv: Record<string, string>,
): Promise<void> {
  await log(migrationId, "info", "Switching the server over to the destination node…");

  await sql.begin(async (tx) => {
    await tx`DELETE FROM server_ports WHERE server_id = ${serverId}`;

    for (const entry of ports) {
      await tx`
        INSERT INTO server_ports (
          server_id, node_id, host_port, container_port,
          is_primary, is_additional, label
        ) VALUES (
          ${serverId}, ${state.destinationNodeId}, ${entry.port}, ${entry.port},
          ${entry.isPrimary}, ${entry.isAdditional}, ${entry.label}
        )
      `;
    }

    await tx`
      UPDATE servers
      SET node_id = ${state.destinationNodeId},
          container_id = ${containerId},
          status = 'stopped',
          updated_at = now()
      WHERE id = ${serverId}
    `;

    await tx`
      UPDATE server_migrations
      SET destination_ports = ${sql.json(ports as never)}, updated_at = now()
      WHERE id = ${migrationId}
    `;
  });

  // Persisted only now that the row agrees the server is on the destination, so
  // `server_env` and `server_ports` can never disagree about which port the
  // game is told to bind.
  if (Object.keys(portEnv).length > 0) {
    await storeEnv(serverId, portEnv, []);
  }

  await log(migrationId, "info", "The panel now records this server on the destination node.");

  // Links are addressed by node: two servers on one node share a private Docker
  // network, two on different nodes reach each other over public addresses.
  // Moving a server changes that answer for every link it has, in both
  // directions, so the pair networks are rebuilt now rather than left describing
  // a topology that no longer exists.
  try {
    const rewired = await rewireServerLinks(serverId, state.sourceNodeId);
    if (rewired.length > 0) {
      await log(
        migrationId,
        "info",
        `Reconnected ${rewired.length} server link(s) for the new node.`,
      );
    }
  } catch (error) {
    await log(
      migrationId,
      "warn",
      "The server moved, but its links to other servers could not all be " +
        `reconnected: ${error instanceof Error ? error.message : String(error)}. ` +
        "Remove and re-add the link from the server's page.",
    );
  }
}

/**
 * Delete the source's container and files.
 *
 * Best-effort *by design*, and the only step here that is. By this point the
 * server is on the destination and working; a source node that has gone
 * unreachable in the last minute must not turn a completed migration into a
 * failed one, because "failed" would imply the server is not where it now is.
 *
 * What it does instead is report. The returned leftovers go into the log, the
 * audit entry and the migration's error field, which is the same receipt a
 * forced delete leaves (`serverManager.deleteServer`): once nothing points at
 * the old node any more, that record is the only thing that knows a container
 * and a world are still sitting on it.
 */
async function cleanUpSource(
  migrationId: string,
  state: RunState,
  serverId: string,
): Promise<string | null> {
  await log(
    migrationId,
    "info",
    "Removing the server's container and files from the original node…",
  );
  try {
    await deleteServerContainer(state.sourceNodeId, serverId, true);
    await log(migrationId, "info", "The original node is clean.");
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await log(
      migrationId,
      "warn",
      `The server is running on its new node, but the old copy could not be ` +
        `removed: ${reason} The container and data directory are still on the ` +
        `original node and must be deleted by hand.`,
    );
    return reason;
  }
}

/** Start the server if it was running, reconcile, and close the row out. */
async function finishSuccessfully(
  migrationId: string,
  serverId: string,
  state: RunState,
  ports: MigratedPort[],
  leftovers: string | null,
): Promise<void> {
  if (state.wasRunning) {
    await log(migrationId, "info", "Starting the server on its new node…");
    try {
      await setStatus(serverId, "starting");
      await startServerContainer(state.destinationNodeId, serverId);
      await setStatus(serverId, "running");
      await log(migrationId, "info", "Started.");
    } catch (error) {
      // The server is migrated; it just did not come back up. Reported as its
      // own thing rather than as a failed migration, for the same reason a
      // failed first start is reported separately from a failed provision: the
      // fix is a retry of the start, not a retry of the move.
      await setStatus(serverId, "error");
      await log(
        migrationId,
        "error",
        "The server was migrated but did not start on its new node: " +
          `${error instanceof Error ? error.message : String(error)}. Its files ` +
          "are in place; start it from the server page to see why.",
      );
    }
  }

  const changed = changedPorts(state.sourcePorts, ports);

  await sql`
    UPDATE server_migrations
    SET status = 'succeeded',
        phase = 'finished',
        percent = 100,
        error = ${leftovers},
        finished_at = now(),
        updated_at = now()
    WHERE id = ${migrationId}
  `;

  await log(
    migrationId,
    "info",
    changed.length === 0
      ? "Migration complete. The server keeps the same address."
      : "Migration complete. Changed port(s): " +
          changed.map((entry) => `${entry.from} → ${entry.to}`).join(", ") +
          ". Tell the owner if the player port is among them.",
  );
}

/**
 * Put everything back.
 *
 * Runs on every failure and every cancellation, and its contract is the
 * feature's promise: **the server ends up on the node it started on, in the
 * state it was found in.** Three things to undo, in the order that leaves the
 * server working soonest:
 *
 *   1. the record, if the cutover got that far. Done first, because until
 *      `node_id` points at the source again nothing else in the panel can act
 *      on the server correctly;
 *   2. whatever the destination built. Its container and its copy of the data,
 *      because a half-migrated server left on a node is the orphan this whole
 *      module is arranged to avoid;
 *   3. the source's own state: the status it had, and a restart if it was
 *      running.
 *
 * Every step is individually guarded. A rollback that throws half way through
 * would leave the worst of both nodes, so a failure in any one step is
 * recorded, downgrades the result to `partial`, and the rest still runs.
 */
async function rollbackMigration(
  migrationId: string,
  serverId: string,
  state: RunState,
): Promise<MigrationRollback> {
  const nothingToUndo =
    !state.destinationHasData &&
    !state.destinationContainerId &&
    !state.cutoverDone &&
    state.previousStatus === (await currentStatus(serverId));

  if (nothingToUndo) return "not_needed";

  await sql`
    UPDATE server_migrations SET phase = 'rollback', updated_at = now()
    WHERE id = ${migrationId}
  `;

  let clean = true;

  // 1. The record. Restores the source's port rows exactly as they were, which
  //    is safe because the source container still holds those numbers on that
  //    host and nothing else can have taken them there.
  if (state.cutoverDone) {
    try {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM server_ports WHERE server_id = ${serverId}`;
        for (const entry of state.sourcePorts) {
          await tx`
            INSERT INTO server_ports (
              server_id, node_id, host_port, container_port,
              is_primary, is_additional, label
            ) VALUES (
              ${serverId}, ${state.sourceNodeId}, ${entry.port}, ${entry.port},
              ${entry.isPrimary}, ${entry.isAdditional}, ${entry.label}
            )
          `;
        }
        await tx`
          UPDATE servers
          SET node_id = ${state.sourceNodeId},
              container_id = ${state.sourceContainerId},
              updated_at = now()
          WHERE id = ${serverId}
        `;
      });
      await log(
        migrationId,
        "info",
        "The panel's record has been moved back to the original node.",
      );
    } catch (error) {
      clean = false;
      await log(
        migrationId,
        "error",
        "The panel could not move its record back to the original node: " +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 2. The destination. Removing the container and the data together is the
  //    same call a delete-with-data makes, and it treats a missing container,
  //    network or directory as already done, so a rollback from an early
  //    failure costs nothing.
  if (state.destinationHasData || state.destinationContainerId) {
    try {
      await deleteServerContainer(state.destinationNodeId, serverId, true);
      await log(
        migrationId,
        "info",
        "Removed the partial copy from the destination node.",
      );
    } catch (error) {
      clean = false;
      await log(
        migrationId,
        "error",
        "The partial copy on the destination node could not be removed: " +
          `${error instanceof Error ? error.message : String(error)}. Delete ` +
          "it by hand before retrying, or the next attempt will refuse to " +
          "extract onto it.",
      );
    }
  }

  // 3. The source, back to exactly how it was found.
  try {
    if (state.wasRunning) {
      await setStatus(serverId, "starting");
      await startServerContainer(state.sourceNodeId, serverId);
      await setStatus(serverId, "running");
      await log(
        migrationId,
        "info",
        "The server has been started again on its original node.",
      );
    } else {
      await setStatus(serverId, state.previousStatus);
      await log(
        migrationId,
        "info",
        `The server is unchanged on its original node (${state.previousStatus}).`,
      );
    }
  } catch (error) {
    clean = false;
    await setStatus(serverId, "error");
    await log(
      migrationId,
      "error",
      "The server could not be started again on its original node: " +
        `${error instanceof Error ? error.message : String(error)}. Its files ` +
        "are intact there; start it from the server page.",
    );
  }

  return clean ? "restored" : "partial";
}

async function currentStatus(serverId: string): Promise<ServerStatus> {
  const rows = (await sql`
    SELECT status FROM servers WHERE id = ${serverId}
  `) as { status: ServerStatus }[];
  return rows[0]?.status ?? "error";
}

// --- Boot recovery ----------------------------------------------------------------

/**
 * Close out migrations the previous panel process abandoned.
 *
 * A migration runs in this process. A restart part-way through leaves a row
 * claiming to be `running` with nobody working on it, and, worse, a server
 * parked in `migrating`, a status deliberately exempt from the fleet sweeper.
 * Nothing would ever move either again.
 *
 * The recovery is deliberately conservative: it does **not** try to resume, and
 * it does not undo anything on either node. It cannot know how far the previous
 * process got, and guessing would risk deleting a copy that is now the only
 * one. What it does is make the situation legible and hand the server back:
 * the row becomes a `failed` migration that says a restart interrupted it, and
 * the server's status is released so the sweeper can work out from the node
 * what is actually running.
 *
 * The one thing this is allowed to assume is the invariant the whole module is
 * built on: unless the row already says `node_id` moved, the server is still on
 * its source node with its files intact.
 */
export async function failInterruptedMigrations(): Promise<void> {
  const rows = (await sql`
    UPDATE server_migrations
    SET status = 'failed',
        phase = 'finished',
        failed_phase = phase,
        rollback = 'partial',
        error = 'The panel restarted while this migration was running, so it ' ||
                'was abandoned part-way. Nothing was deleted from either node. ' ||
                'Check both nodes before retrying.',
        finished_at = now(),
        updated_at = now()
    WHERE status IN ('pending', 'running', 'cancelling')
    RETURNING id, server_id
  `) as { id: string; server_id: string }[];

  if (rows.length === 0) return;

  for (const row of rows) {
    await log(
      row.id,
      "error",
      "The panel restarted while this migration was running. It was not resumed: " +
        "nothing has been deleted from either node, and the server's status has " +
        "been released so the panel can work out from the nodes what is running.",
    );
    // Out of `migrating` so the fleet sweeper can correct it from whichever
    // node the row still names.
    await sql`
      UPDATE servers SET status = 'error', updated_at = now()
      WHERE id = ${row.server_id} AND status = 'migrating'
    `;
  }

  console.warn(
    `[serverMigration] closed out ${rows.length} migration(s) abandoned by a restart`,
  );
}
