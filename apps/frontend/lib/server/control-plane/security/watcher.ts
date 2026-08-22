/**
 * Abuse watcher (plan.md section 9).
 *
 * Periodically sweeps every active node, samples each managed container, and
 * maintains a rolling observation window per server. When the accumulated score
 * crosses the flag threshold a `suspicious_activity` row is written for admin
 * review — never a silent deletion.
 *
 * Node-aware from the first pass, as required by the plan: an unreachable node is
 * logged and skipped rather than aborting the whole sweep.
 */

import { sql } from "../db/client";
import { env } from "../config/env";
import { getResourceProfileById } from "../blueprints/registry";
import type { ResourceProfile } from "../blueprints/types";
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
 * once per server on every sweep — a map lookup each time, but one awaited
 * promise per server regardless. One entry per distinct blueprint turns the
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
 * *sum* of node latencies. Errors are still contained here — an unreachable
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
    );
    result.nodesScanned += 1;
  } catch (error) {
    result.nodesUnreachable += 1;
    console.error(`[watcher] cannot reach agent on node ${node.name}:`, error);
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
          `Automatic suspension: score ${scored.totalScore} — ${scored.summary}`,
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
 * Run one full detection pass across every active node.
 *
 * Nodes are sampled concurrently, up to {@link MAX_NODE_CONCURRENCY} at a
 * time. Errors are contained per node and per container: one bad node must not
 * stop the sweep, because that would be an easy way to blind the whole watcher.
 */
export async function runSweep(): Promise<SweepResult> {
  const result: SweepResult = {
    nodesScanned: 0,
    nodesUnreachable: 0,
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

  const work = nodes
    .map((node) => ({ node, nodeServers: serversByNode.get(node.id) ?? [] }))
    .filter(({ nodeServers }) => nodeServers.length > 0);

  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_NODE_CONCURRENCY, work.length) },
    async () => {
      while (next < work.length) {
        const job = work[next++];
        await sampleAndScoreNode(job.node, job.nodeServers, profiles, result);
      }
    },
  );
  await Promise.all(workers);

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
 * runs are skipped rather than queued — otherwise a slow node would cause sweeps
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
      if (result.serversFlagged > 0 || result.nodesUnreachable > 0) {
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

/** Exposed for tests: clear all in-memory observation state. */
export function resetObservations(): void {
  observations.clear();
}
