/**
 * Abuse watcher (plan.md section 9).
 *
 * Periodically sweeps every active node, samples each managed container, and
 * maintains a rolling observation window per server. When the accumulated score
 * crosses the flag threshold a `suspicious_activity` row is written for admin
 * review, never a silent deletion.
 *
 * Node-aware from the first pass, as required by the plan: an unreachable node is
 * logged and skipped rather than aborting the whole sweep. It is also put in
 * backoff (`nodes/nodeReachability.ts`), because "skipped" only holds for the
 * sweep that failed: retrying a dead node at full timeout on every tick made
 * sweeps outlive their own interval, and a skipped sweep looks at nobody.
 */

import { sql } from "../db/client";
import { env } from "../config/env";
import { getResourceProfileById } from "../blueprints/registry";
import type { ResourceProfile } from "../blueprints/types";
import { rotate, runWithBudget } from "../lib/boundedWork";
import {
  isNodeInBackoff,
  noteNodeReachable,
  noteNodeUnreachable,
} from "../nodes/nodeReachability";
import { listActiveNodesWithSecrets } from "../nodes/nodeRegistry";
import {
  sampleNodeServers,
  type ContainerStats,
} from "../nodes/nodeServerApi";
import { suspendServer } from "../services/serverManager";
import {
  emptyWindow,
  scoreObservation,
  shouldAutoSuspend,
  shouldFlag,
  type ObservationWindow,
} from "./heuristics";
import { recordFlag } from "./suspiciousList";

/** How much history to retain per server, in samples. */
const MAX_SAMPLES = 30;

/** Rolling per-server state held in memory between sweeps. */
interface ServerObservation {
  serverId: string;
  containerId: string;
  cpuSamples: number[];
  firstSampleAt: number;
  lastSampleAt: number;
  /** Cumulative counters from the previous sample, to compute deltas. */
  previousNetworkBytes: number | null;
  previousBlockBytes: number | null;
  /** Deltas accumulated across the retained window. */
  networkBytesInWindow: number;
  diskBytesInWindow: number;
}

const observations = new Map<string, ServerObservation>();

function getOrCreateObservation(
  serverId: string,
  containerId: string,
): ServerObservation {
  const existing = observations.get(serverId);

  // A new container id means the server was rebuilt; start a fresh window so we
  // never blame a new container for its predecessor's behaviour.
  if (existing && existing.containerId === containerId) return existing;

  const fresh: ServerObservation = {
    serverId,
    containerId,
    cpuSamples: [],
    firstSampleAt: Date.now(),
    lastSampleAt: Date.now(),
    previousNetworkBytes: null,
    previousBlockBytes: null,
    networkBytesInWindow: 0,
    diskBytesInWindow: 0,
  };

  observations.set(serverId, fresh);
  return fresh;
}

/**
 * Fold a new stats sample into a server's rolling window.
 *
 * The node's network/block counters are cumulative for the container's
 * lifetime, so only the delta between samples describes activity in this
 * window. A counter that decreases means the container restarted, so the window
 * resets.
 */
export function applySample(
  observation: ServerObservation,
  stats: ContainerStats,
): void {
  observation.cpuSamples.push(stats.cpuPercent);
  if (observation.cpuSamples.length > MAX_SAMPLES) {
    observation.cpuSamples.shift();
  }

  const networkTotal = stats.networkRxBytes + stats.networkTxBytes;
  const blockTotal = stats.blockReadBytes + stats.blockWriteBytes;

  if (observation.previousNetworkBytes !== null) {
    const delta = networkTotal - observation.previousNetworkBytes;
    if (delta >= 0) {
      observation.networkBytesInWindow += delta;
    } else {
      // Counter reset => the container restarted; start the window over.
      observation.networkBytesInWindow = 0;
    }
  }

  if (observation.previousBlockBytes !== null) {
    const delta = blockTotal - observation.previousBlockBytes;
    if (delta >= 0) observation.diskBytesInWindow += delta;
    else observation.diskBytesInWindow = 0;
  }

  observation.previousNetworkBytes = networkTotal;
  observation.previousBlockBytes = blockTotal;
  observation.lastSampleAt = Date.now();
}

/** Convert accumulated state into the shape the heuristics consume. */
export function toObservationWindow(
  observation: ServerObservation,
): ObservationWindow {
  return {
    ...emptyWindow(),
    cpuSamples: [...observation.cpuSamples],
    windowSeconds: Math.max(
      0,
      Math.round((observation.lastSampleAt - observation.firstSampleAt) / 1000),
    ),
    diskIoBytes: observation.diskBytesInWindow,
    networkBytes: observation.networkBytesInWindow,
    // Connection- and process-level inspection is not implemented in this phase.
    // The heuristics degrade gracefully: resource-behaviour signals still score,
    // and the network/process rules simply do not fire. See plan.md 9.1.
    distinctRemoteHosts: 0,
    connections: [],
    processCommandLines: [],
  };
}

interface RunningServerRow {
  id: string;
  container_id: string;
  node_id: string;
  blueprint_id: string;
  status: string;
}

/** Servers the watcher should be sampling: provisioned and not suspended. */
async function loadWatchableServers(): Promise<RunningServerRow[]> {
  return (await sql`
    SELECT id, container_id, node_id, blueprint_id, status
    FROM servers
    WHERE container_id IS NOT NULL
      AND status NOT IN ('suspended', 'deleting', 'creating')
  `) as RunningServerRow[];
}

/**
 * Resolve every distinct blueprint's profile once, before scoring.
 *
 * Each server's scoring needs its blueprint's expected resource profile, and
 * awaiting that inside the sample loop re-read the same handful of blueprints
 * once per server on every sweep. That is a map lookup each time, but one
 * awaited promise per server regardless. One entry per distinct blueprint turns the
 * per-server cost back into what it looks like: a synchronous read.
 */
async function resolveResourceProfiles(
  servers: RunningServerRow[],
): Promise<Map<string, ResourceProfile>> {
  const profiles = new Map<string, ResourceProfile>();
  for (const blueprintId of new Set(servers.map((server) => server.blueprint_id))) {
    profiles.set(blueprintId, await getResourceProfileById(blueprintId));
  }
  return profiles;
}

export interface SweepResult {
  nodesScanned: number;
  nodesUnreachable: number;
  /**
   * Nodes this pass deliberately did not ask: in backoff after recent failures,
   * or left for the next sweep because this one ran out of its time budget.
   * Distinct from `nodesUnreachable`, which cost a request and a timeout.
   */
  nodesSkipped: number;
  containersSampled: number;
  serversFlagged: number;
  serversAutoSuspended: number;
}

/**
 * Sample and score every server on one node.
 *
 * Extracted from the sweep's serial loop so nodes can run concurrently: each
 * node's agent is an independent machine, and waiting for one slow (or dead,
 * up to its timeout) node before even asking the next stretched a sweep by the
 * *sum* of node latencies. Errors are still contained here. An unreachable
 * node logs and returns, and a server whose scoring throws costs only itself.
 */
async function sampleAndScoreNode(
  node: Awaited<ReturnType<typeof listActiveNodesWithSecrets>>[number],
  nodeServers: RunningServerRow[],
  profilesByBlueprintId: Map<string, ResourceProfile>,
  result: SweepResult,
): Promise<void> {
  // One request per node, not per container: sweep cost must not scale with
  // fleet size, or a large node would stretch a sweep past its own interval.
  let samples;
  try {
    samples = await sampleNodeServers(
      node.id,
      nodeServers.map((server) => server.id),
      SAMPLE_TIMEOUT_MS,
    );
    result.nodesScanned += 1;
    noteNodeReachable("watcher", node.id, node.name);
  } catch (error) {
    // An unreachable node is an operational state, not a defect: it is
    // reported as one line and put in backoff, rather than a stack trace on
    // every tick for as long as the node is down. See `nodeReachability.ts`.
    result.nodesUnreachable += 1;
    noteNodeUnreachable("watcher", node.id, node.name, error);
    return;
  }

  const serverById = new Map(nodeServers.map((server) => [server.id, server]));

  for (const stats of samples) {
    const server = serverById.get(stats.serverId);
    // A sample for a server we did not ask about should be impossible; skip
    // rather than trust it.
    if (!server) continue;

    try {
      result.containersSampled += 1;

      const observation = getOrCreateObservation(server.id, server.container_id);
      applySample(observation, stats);

      const resourceProfile =
        profilesByBlueprintId.get(server.blueprint_id) ?? "bursty";
      const scored = scoreObservation(toObservationWindow(observation), {
        resourceProfile,
      });

      if (!shouldFlag(scored.totalScore, env.security.flagThreshold)) continue;

      const flagged = await recordFlag({
        serverId: server.id,
        reason: scored.summary,
        score: scored.totalScore,
        signals: scored.signals,
        observation: {
          nodeId: node.id,
          nodeName: node.name,
          containerId: server.container_id,
          cpuPercent: stats.cpuPercent,
          memoryUsageMb: stats.memoryUsageMb,
        },
      });

      if (flagged) result.serversFlagged += 1;

      // Opt-in emergency action, off by default (plan.md 9.2).
      if (
        env.security.autoSuspendEnabled &&
        shouldAutoSuspend(scored, env.security.autoSuspendThreshold)
      ) {
        await suspendServer(
          server.id,
          null,
          `Automatic suspension: score ${scored.totalScore}. ${scored.summary}`,
        );
        result.serversAutoSuspended += 1;
      }
    } catch (error) {
      console.error(`[watcher] error scoring server ${server.id}:`, error);
    }
  }
}

/**
 * How many nodes one sweep samples at once. Small on purpose: each in-flight
 * request holds a full stats batch on the agent, so this bounds the burst any
 * one sweep puts on the fleet's agents without serialising the whole pass.
 */
const MAX_NODE_CONCURRENCY = 4;

/**
 * How long one node's stats batch may take.
 *
 * Derived from the sweep interval rather than fixed, because the failure this
 * bounds is a node that does not answer at all: that costs the *whole* timeout,
 * and the old fixed 60s happened to equal the default interval, so a single
 * dead node guaranteed the sweep outlived its own tick and the next one was
 * skipped ("previous sweep still running"). Half the interval leaves room for
 * the nodes either side of a dead one, and the floor keeps a deliberately tiny
 * interval from timing out healthy agents mid-answer.
 */
const SAMPLE_TIMEOUT_MS = Math.max(
  5_000,
  Math.round((env.security.watcherIntervalSeconds * 1000) / 2),
);

/**
 * How long into its interval a sweep may still *start* asking a new node.
 *
 * Past this point the remaining nodes are left for the next sweep. Concurrency
 * bounds how many nodes are in flight, not how long the queue behind them
 * takes, so on a fleet where several nodes are slow the pass could still run
 * past its own tick and lose the next one. Stopping early costs freshness for
 * some nodes; not stopping costs whole sweeps, which is worse. The rotation in
 * {@link runSweep} is what keeps the deferred nodes from being the same ones
 * every time.
 */
const START_DEADLINE_MS = Math.max(
  SAMPLE_TIMEOUT_MS,
  env.security.watcherIntervalSeconds * 1000 - SAMPLE_TIMEOUT_MS,
);

/**
 * Where the next sweep starts in the node list.
 *
 * A sweep that gives up on its remaining nodes must not give up on the *same*
 * nodes forever: that is a permanent blind spot, and picking which servers the
 * watcher never looks at is exactly the capability an abuser would want. Each
 * pass resumes where the last one stopped.
 */
let sweepCursor = 0;

/**
 * Run one full detection pass across every active node.
 *
 * Nodes are sampled concurrently, up to {@link MAX_NODE_CONCURRENCY} at a
 * time. Errors are contained per node and per container: one bad node must not
 * stop the sweep, because that would be an easy way to blind the whole watcher.
 *
 * A scheduled pass also protects the *next* pass: nodes in backoff are not
 * asked, and once {@link START_DEADLINE_MS} is spent the rest are left for the
 * following sweep. `force` turns both off, for the admin's Scan-now button,
 * where somebody is waiting for the answer and asked for it deliberately.
 */
export async function runSweep(
  { force = false }: { force?: boolean } = {},
): Promise<SweepResult> {
  const startedAt = Date.now();
  const result: SweepResult = {
    nodesScanned: 0,
    nodesUnreachable: 0,
    nodesSkipped: 0,
    containersSampled: 0,
    serversFlagged: 0,
    serversAutoSuspended: 0,
  };

  const [nodes, servers] = await Promise.all([
    listActiveNodesWithSecrets(),
    loadWatchableServers(),
  ]);
  // One profile per distinct blueprint, resolved before scoring so the sample
  // loop never awaits a lookup. Reads from the blueprint cache: effectively free.
  const profiles = await resolveResourceProfiles(servers);

  // Group by node so each node's client is built once per sweep.
  const serversByNode = new Map<string, RunningServerRow[]>();
  for (const server of servers) {
    const list = serversByNode.get(server.node_id) ?? [];
    list.push(server);
    serversByNode.set(server.node_id, list);
  }

  const candidates = nodes
    .map((node) => ({ node, nodeServers: serversByNode.get(node.id) ?? [] }))
    .filter(({ nodeServers }) => nodeServers.length > 0);

  // Rotate so the nodes a previous pass ran out of time for are asked first.
  const offset = candidates.length ? sweepCursor % candidates.length : 0;
  const work = rotate(candidates, offset);

  const resumeAt = await runWithBudget(work, {
    concurrency: MAX_NODE_CONCURRENCY,
    startDeadlineAt: force ? Infinity : startedAt + START_DEADLINE_MS,
    onDeferred: (count) => {
      result.nodesSkipped += count;
    },
    run: async (job) => {
      // Checked here rather than when the work list is built, because the
      // window can expire while an earlier node is still being sampled.
      if (!force && isNodeInBackoff(job.node.id)) {
        result.nodesSkipped += 1;
        return;
      }
      await sampleAndScoreNode(job.node, job.nodeServers, profiles, result);
    },
  });

  // Resume where this pass stopped. A pass that finished wraps back to where it
  // began, so a healthy fleet keeps a stable order.
  if (candidates.length) {
    sweepCursor = (offset + resumeAt) % candidates.length;
  }

  // Drop state for servers that no longer exist, so the map cannot grow forever.
  const liveIds = new Set(servers.map((server) => server.id));
  for (const serverId of observations.keys()) {
    if (!liveIds.has(serverId)) observations.delete(serverId);
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/**
 * Start the periodic watcher.
 *
 * A sweep can take longer than the interval on a large cluster, so overlapping
 * runs are skipped rather than queued. Otherwise a slow node would cause sweeps
 * to pile up and hammer every agent.
 */
export function startWatcher(): void {
  if (timer) return;

  const intervalMs = env.security.watcherIntervalSeconds * 1000;

  timer = setInterval(async () => {
    if (sweepInFlight) {
      console.warn("[watcher] previous sweep still running, skipping this tick");
      return;
    }

    sweepInFlight = true;
    try {
      const result = await runSweep();
      // Only findings. An unreachable node already announced itself once, in
      // one line, and re-printing the whole result every minute for as long as
      // it stays down is the noise `nodeReachability.ts` exists to stop.
      if (result.serversFlagged > 0 || result.serversAutoSuspended > 0) {
        console.log("[watcher] sweep complete:", result);
      }
    } catch (error) {
      console.error("[watcher] sweep failed:", error);
    } finally {
      sweepInFlight = false;
    }
  }, intervalMs);

  console.log(
    `[watcher] started, scanning every ${env.security.watcherIntervalSeconds}s ` +
      `(flag threshold ${env.security.flagThreshold}, ` +
      `auto-suspend ${env.security.autoSuspendEnabled ? "ON" : "OFF"})`,
  );
}

export function stopWatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("[watcher] stopped");
}

/** Exposed for tests: clear all in-memory sweep state. */
export function resetObservations(): void {
  observations.clear();
  sweepCursor = 0;
}
