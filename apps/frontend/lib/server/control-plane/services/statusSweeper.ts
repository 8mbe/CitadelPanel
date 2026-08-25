/**
 * Fleet-wide status sweeper.
 *
 * `servers.status` is a record of what the panel last observed or intended, not
 * an observation (see `docs/server-lifecycle.md`). Something has to go and look,
 * or the record drifts from the node and stays drifted. Until this existed, the
 * only thing that looked was the server detail endpoint, which meant the truth
 * arrived one server at a time and only for a server somebody happened to open.
 *
 * The case that makes this load-bearing is a restart. Game containers are
 * created with `RestartPolicy: "no"` (`hardening.ts`), deliberately: the panel
 * decides what runs, not the Docker daemon. So a node that reboots comes back
 * with every container stopped, and every row still saying `running`. The
 * dashboard reads the row, so it showed a fleet of running servers that were
 * all down, with no way to notice short of opening each one.
 *
 * Two passes, one rule:
 *   - once at boot, because a panel restart is exactly when the record is most
 *     likely to have gone stale while nobody was watching;
 *   - then on a timer, because a node can reboot (or a game can crash) while
 *     the panel is up, and that is the same staleness with a different cause.
 *
 * Cost is one request per node per pass, and one UPDATE per server that
 * actually drifted, which on a healthy panel is none. A node that fails is put
 * in backoff (`nodes/nodeReachability.ts`) so an outage costs one request every
 * few minutes instead of one every 30 seconds, forever. The decision itself is
 * `statusReconcile.ts`, shared with the detail endpoint so the two can never
 * disagree and fight over a row.
 */

import { sql } from "../db/client";
import {
  isNodeInBackoff,
  noteNodeReachable,
  noteNodeUnreachable,
} from "../nodes/nodeReachability";
import { listActiveNodesWithSecrets } from "../nodes/nodeRegistry";
import { getNodeServerStates } from "../nodes/nodeServerApi";
import {
  statusCorrections,
  type ReconcilableServer,
  type StatusCorrection,
} from "./statusReconcile";
import type { ServerStatus } from "./serverManager";

/**
 * How often the fleet is re-checked.
 *
 * Not configurable on purpose: this is a correctness backstop rather than a
 * knob, and the only thing tuning it trades is how long a crashed server keeps
 * claiming to be up. Long enough that the sweep is invisible next to the stats
 * polling an open dashboard already does, short enough that a stale status is a
 * blip rather than the state of the panel.
 */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * How many nodes are asked at once. Matches the abuse watcher's bound and for
 * the same reason: a sweep must not arrive at the fleet as one burst.
 */
const MAX_NODE_CONCURRENCY = 4;

interface SweepableRow extends ReconcilableServer {
  nodeId: string;
}

export interface StatusSweepResult {
  nodesScanned: number;
  nodesUnreachable: number;
  /** Nodes left alone this pass because they are in backoff after failing. */
  nodesSkipped: number;
  serversChecked: number;
  statusesCorrected: number;
}

/**
 * Servers whose status is worth checking against their node.
 *
 * Three exclusions, each for its own reason:
 *   - no `container_id`: there is nothing on the node to ask about, which is the
 *     same guard `reconcileRowStatus` applies;
 *   - `suspended`: an administrative decision, never overwritten by an
 *     observation;
 *   - `creating`/`installing`/`deleting`: a task in this process owns the row
 *     and is mid-way through changing the node to match it. Anything left over
 *     from a *previous* process is already handled at boot by
 *     `failInterruptedProvisions`.
 */
async function loadSweepableServers(): Promise<SweepableRow[]> {
  const rows = (await sql`
    SELECT id, status, updated_at, node_id
    FROM servers
    WHERE container_id IS NOT NULL
      AND status NOT IN ('suspended', 'creating', 'installing', 'deleting')
  `) as {
    id: string;
    status: ServerStatus;
    updated_at: Date;
    node_id: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    updatedAt: new Date(row.updated_at),
    nodeId: row.node_id,
  }));
}

/**
 * Write one correction, but only if the row still says what we saw.
 *
 * The observation is already a few hundred milliseconds old by the time it is
 * written, and in that window an owner may have pressed Start or Stop. That
 * action knows more than this sweep does, so the guard lets it win: a row that
 * moved on is simply not corrected, and the next sweep looks again.
 */
async function applyCorrection(correction: StatusCorrection): Promise<boolean> {
  const rows = (await sql`
    UPDATE servers
    SET status = ${correction.to}, updated_at = now()
    WHERE id = ${correction.id} AND status = ${correction.from}
    RETURNING id
  `) as { id: string }[];

  return rows.length > 0;
}

/** Check every server on one node, and correct the rows that drifted. */
async function sweepNode(
  nodeId: string,
  nodeName: string,
  servers: SweepableRow[],
  result: StatusSweepResult,
): Promise<void> {
  let states;
  try {
    states = await getNodeServerStates(
      nodeId,
      servers.map((server) => server.id),
    );
    result.nodesScanned += 1;
    noteNodeReachable("status-sweeper", nodeId, nodeName);
  } catch (error) {
    // A node that cannot be reached is not evidence that its containers
    // stopped, so its servers keep the status they have. It is also put in
    // backoff: this pass repeats every 30s, and a node that is down for an
    // afternoon should not cost a timeout and a log line every 30s of it.
    result.nodesUnreachable += 1;
    noteNodeUnreachable("status-sweeper", nodeId, nodeName, error);
    return;
  }

  result.serversChecked += servers.length;

  for (const correction of statusCorrections(servers, states)) {
    try {
      if (await applyCorrection(correction)) {
        result.statusesCorrected += 1;
        console.log(
          `[status-sweeper] ${correction.id}: ${correction.from} -> ${correction.to} ` +
            `(node ${nodeName} says otherwise)`,
        );
      }
    } catch (error) {
      console.error(
        `[status-sweeper] could not correct ${correction.id}:`,
        error,
      );
    }
  }
}

/**
 * Run one pass over every active node.
 *
 * Errors are contained per node: one unreachable agent must not cost the rest
 * of the fleet its correction.
 */
export async function runStatusSweep(): Promise<StatusSweepResult> {
  const result: StatusSweepResult = {
    nodesScanned: 0,
    nodesUnreachable: 0,
    nodesSkipped: 0,
    serversChecked: 0,
    statusesCorrected: 0,
  };

  const [nodes, servers] = await Promise.all([
    listActiveNodesWithSecrets(),
    loadSweepableServers(),
  ]);

  const serversByNode = new Map<string, SweepableRow[]>();
  for (const server of servers) {
    const list = serversByNode.get(server.nodeId) ?? [];
    list.push(server);
    serversByNode.set(server.nodeId, list);
  }

  const work = nodes
    .map((node) => ({ node, nodeServers: serversByNode.get(node.id) ?? [] }))
    .filter(({ nodeServers }) => nodeServers.length > 0);

  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_NODE_CONCURRENCY, work.length) },
    async () => {
      while (next < work.length) {
        const job = work[next++];
        if (isNodeInBackoff(job.node.id)) {
          result.nodesSkipped += 1;
          continue;
        }
        await sweepNode(job.node.id, job.node.name, job.nodeServers, result);
      }
    },
  );
  await Promise.all(workers);

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

async function sweepOnce(): Promise<void> {
  if (sweepInFlight) return;

  sweepInFlight = true;
  try {
    const result = await runStatusSweep();
    // Corrections only. An unreachable node announces itself once, in one line,
    // when it goes away and again when it returns (`nodeReachability.ts`).
    if (result.statusesCorrected > 0) {
      console.log("[status-sweeper] sweep complete:", result);
    }
  } catch (error) {
    console.error("[status-sweeper] sweep failed:", error);
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Start the sweeper, beginning with an immediate pass.
 *
 * The first pass is the point of the boot call and is deliberately not awaited
 * by the caller: it talks to every node, and a node that is down would
 * otherwise hold the panel's startup open for its whole timeout before the
 * first page could be served. Correcting the record a moment after boot is what
 * this is for; delaying boot to do it is not.
 */
export function startStatusSweeper(): void {
  if (timer) return;

  timer = setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS);
  void sweepOnce();

  console.log(
    `[status-sweeper] started, reconciling server statuses every ` +
      `${SWEEP_INTERVAL_MS / 1000}s`,
  );
}

export function stopStatusSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("[status-sweeper] stopped");
}
