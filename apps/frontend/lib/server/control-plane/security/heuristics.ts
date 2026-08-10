/**
 * Abuse / cryptomining heuristics (plan.md section 9.1).
 *
 * Scope, which drives every weight in this file:
 *
 *   This detects abuse of the NODE — stolen compute, principally cryptomining.
 *   It deliberately does NOT police what happens inside a game: griefing, op
 *   abuse, plugin crash-loops and similar are the server owner's problem, not
 *   the platform's, and flagging them buries the signals that actually matter.
 *
 * Detection is imperfect and outbound traffic is intentionally allowed, so this
 * scores BEHAVIOUR and produces evidence for a human to review. It never decides
 * on its own that a user is guilty.
 *
 * False positives have a real cost (a legitimate modpack server under load looks
 * busy), so single signals are deliberately not enough to cross the default
 * flag threshold. Corroborating signals are what push a score over the line.
 *
 * Every function here is pure so the whole detection policy is unit-testable.
 */

import type { ResourceProfile } from "../blueprints/types";
import {
  isMiningPort,
  isUnambiguousMiningPort,
  matchesKnownMiner,
} from "./mining-indicators";

/** Signal weights. Named so scores are explainable in the admin UI. */
export const WEIGHTS = {
  sustainedHighCpu: 25,
  cpuWithoutIo: 30,
  unambiguousMiningPort: 40,
  ambiguousMiningPort: 15,
  minerBinaryName: 20,
  excessiveConnections: 15,
} as const;

export interface Signal {
  /** Stable identifier for the rule that fired. */
  rule: keyof typeof WEIGHTS;
  score: number;
  /** Human-readable explanation shown to the reviewing admin. */
  reason: string;
  detail?: Record<string, unknown>;
}

/** A rolling window of observations for one container. */
export interface ObservationWindow {
  /** CPU percent samples, oldest first. */
  cpuSamples: number[];
  /** Seconds covered by the samples. */
  windowSeconds: number;
  /** Bytes of disk I/O across the window. */
  diskIoBytes: number;
  /** Bytes of network traffic across the window. */
  networkBytes: number;
  /** Distinct remote hosts contacted in the window. */
  distinctRemoteHosts: number;
  /** Remote endpoints observed, when connection inspection is available. */
  connections: { host: string; port: number }[];
  /** Process command lines, when process inspection is available. */
  processCommandLines: string[];
}

export interface ScoringContext {
  /** The preset's expected behaviour, used to calibrate the CPU signals. */
  resourceProfile: ResourceProfile;
}

export function emptyWindow(): ObservationWindow {
  return {
    cpuSamples: [],
    windowSeconds: 0,
    diskIoBytes: 0,
    networkBytes: 0,
    distinctRemoteHosts: 0,
    connections: [],
    processCommandLines: [],
  };
}

/** Minimum window before CPU-based signals are trusted (plan says >15 min). */
export const MIN_CPU_WINDOW_SECONDS = 15 * 60;

/**
 * CPU threshold above which usage counts as "sustained high", calibrated to the
 * game's expected profile.
 *
 * A "steady-high" game legitimately runs hot, so the bar is raised to near
 * saturation; a "steady-low" game running at 85% is far more suspicious.
 */
export function cpuThresholdFor(profile: ResourceProfile): number {
  switch (profile) {
    case "steady-high":
      return 97;
    case "steady-low":
      return 75;
    case "bursty":
    default:
      return 90;
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Signal: CPU pegged for the whole window.
 *
 * Requires EVERY sample above the threshold, not just the average — a spike
 * during chunk generation should not qualify, only genuinely continuous load.
 */
export function scoreSustainedHighCpu(
  window: ObservationWindow,
  context: ScoringContext,
): Signal | null {
  if (window.windowSeconds < MIN_CPU_WINDOW_SECONDS) return null;
  if (window.cpuSamples.length < 3) return null;

  const threshold = cpuThresholdFor(context.resourceProfile);
  if (!window.cpuSamples.every((sample) => sample >= threshold)) return null;

  const average = mean(window.cpuSamples);
  return {
    rule: "sustainedHighCpu",
    score: WEIGHTS.sustainedHighCpu,
    reason: `CPU stayed above ${threshold}% for the entire ${Math.round(
      window.windowSeconds / 60,
    )} minute window (avg ${average.toFixed(1)}%)`,
    detail: { threshold, averageCpuPercent: average, samples: window.cpuSamples.length },
  };
}

/** I/O below this across the window counts as "near-zero". */
export const NEAR_ZERO_IO_BYTES = 1024 * 1024; // 1 MB

/**
 * Signal: high CPU with almost no I/O.
 *
 * This is the strongest behavioural discriminator available. A real game server
 * under sustained load is constantly doing I/O — world saves, chunk reads,
 * player packets. A miner computes and reports results occasionally.
 */
export function scoreCpuWithoutIo(
  window: ObservationWindow,
  context: ScoringContext,
): Signal | null {
  if (window.windowSeconds < MIN_CPU_WINDOW_SECONDS) return null;
  if (window.cpuSamples.length < 3) return null;

  const threshold = cpuThresholdFor(context.resourceProfile);
  const averageCpu = mean(window.cpuSamples);
  if (averageCpu < threshold) return null;

  const totalIo = window.diskIoBytes + window.networkBytes;
  if (totalIo >= NEAR_ZERO_IO_BYTES) return null;

  return {
    rule: "cpuWithoutIo",
    score: WEIGHTS.cpuWithoutIo,
    reason: `Sustained ${averageCpu.toFixed(
      1,
    )}% CPU with near-zero disk and network I/O (${totalIo} bytes) — atypical for a game server under load`,
    detail: {
      averageCpuPercent: averageCpu,
      diskIoBytes: window.diskIoBytes,
      networkBytes: window.networkBytes,
    },
  };
}

/** Signal: outbound connections on conventional stratum ports. */
export function scoreMiningPorts(window: ObservationWindow): Signal | null {
  const unambiguous = window.connections.filter((c) =>
    isUnambiguousMiningPort(c.port),
  );
  const ambiguous = window.connections.filter(
    (c) => isMiningPort(c.port) && !isUnambiguousMiningPort(c.port),
  );

  if (unambiguous.length > 0) {
    const ports = [...new Set(unambiguous.map((c) => c.port))];
    return {
      rule: "unambiguousMiningPort",
      score: WEIGHTS.unambiguousMiningPort,
      reason: `Outbound connections to known stratum mining port(s): ${ports.join(", ")}`,
      detail: { ports, connectionCount: unambiguous.length },
    };
  }

  if (ambiguous.length > 0) {
    const ports = [...new Set(ambiguous.map((c) => c.port))];
    return {
      rule: "ambiguousMiningPort",
      score: WEIGHTS.ambiguousMiningPort,
      reason: `Outbound connections to port(s) sometimes used for mining: ${ports.join(
        ", ",
      )} (also used by some games)`,
      detail: { ports, connectionCount: ambiguous.length },
    };
  }

  return null;
}

/** Signal: a process whose name matches a known miner binary. */
export function scoreMinerBinaries(window: ObservationWindow): Signal | null {
  const found: string[] = [];

  for (const commandLine of window.processCommandLines) {
    const match = matchesKnownMiner(commandLine);
    if (match) found.push(match);
  }

  if (found.length === 0) return null;

  const unique = [...new Set(found)];
  return {
    rule: "minerBinaryName",
    score: WEIGHTS.minerBinaryName,
    reason: `Process name(s) matching known miners: ${unique.join(", ")}`,
    detail: { binaries: unique },
  };
}

/** Distinct remote hosts above this is unusual for a game server. */
export const CONNECTION_VOLUME_THRESHOLD = 150;

/**
 * Signal: unusually many distinct outbound peers.
 *
 * Plugin update checks are occasional and hit a handful of well-known APIs.
 * Persistent high-frequency traffic to many peers fits mining or proxy abuse.
 */
export function scoreConnectionVolume(window: ObservationWindow): Signal | null {
  if (window.distinctRemoteHosts < CONNECTION_VOLUME_THRESHOLD) return null;

  return {
    rule: "excessiveConnections",
    score: WEIGHTS.excessiveConnections,
    reason: `Contacted ${window.distinctRemoteHosts} distinct remote hosts, well above the normal profile for a game server`,
    detail: { distinctRemoteHosts: window.distinctRemoteHosts },
  };
}

export interface ScoreResult {
  totalScore: number;
  signals: Signal[];
  /** One-line summary suitable for the `suspicious_activity.reason` column. */
  summary: string;
}

/** Every rule, applied in order. */
const RULES: ((
  window: ObservationWindow,
  context: ScoringContext,
) => Signal | null)[] = [
  scoreSustainedHighCpu,
  scoreCpuWithoutIo,
  (window) => scoreMiningPorts(window),
  (window) => scoreMinerBinaries(window),
  (window) => scoreConnectionVolume(window),
];

/**
 * Run every heuristic and accumulate a score.
 *
 * Returns the evidence alongside the number so the admin UI can explain exactly
 * why something was flagged — an unexplained score is not actionable.
 */
export function scoreObservation(
  window: ObservationWindow,
  context: ScoringContext,
): ScoreResult {
  const signals: Signal[] = [];

  for (const rule of RULES) {
    const signal = rule(window, context);
    if (signal) signals.push(signal);
  }

  const totalScore = signals.reduce((sum, signal) => sum + signal.score, 0);
  const summary =
    signals.length === 0
      ? "No suspicious signals detected"
      : signals.map((signal) => signal.reason).join("; ");

  return { totalScore, signals, summary };
}

/** Whether a score crosses the configured flag threshold. */
export function shouldFlag(score: number, threshold: number): boolean {
  return score >= threshold;
}

/**
 * Whether a score crosses the emergency auto-suspend threshold.
 *
 * Requires BOTH a very high score AND a confirmed high-confidence signal (an
 * unambiguous stratum port). Behavioural signals alone must never auto-suspend,
 * because a heavy modpack can look computationally busy.
 */
export function shouldAutoSuspend(
  result: ScoreResult,
  threshold: number,
): boolean {
  if (result.totalScore < threshold) return false;

  return result.signals.some(
    (signal) => signal.rule === "unambiguousMiningPort",
  );
}
