// ---------------------------------------------------------------------------
// Display formatting helpers
//
// Pure functions shared across the panel UI. No data, no side effects — just
// the presentation logic for bytes, durations, timestamps and abuse scores.
// ---------------------------------------------------------------------------

export function formatMb(mb: number): string {
  if (mb >= 1024 * 100) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * Format a CPU core count for display.
 *
 * Live docker-stats samples are fractions of a core that can be tiny (e.g.
 * 0.0048 cores) or several cores; showing the full float is unreadable. Whole
 * counts have no decimal; fractions keep two places.
 */
export function formatCores(cores: number): string {
  if (cores >= 100) return `${Math.round(cores)}`;
  if (Number.isInteger(cores)) return `${cores}`;
  return `${cores.toFixed(2)}`;
}

/**
 * Format a used/total pair for a narrow column.
 *
 * Prints the unit once ("4.5/8 GB") instead of twice ("4.50 GB / 8.00 GB"),
 * which is what made these values wrap and orphan the unit onto its own line in
 * the server tiles. Precision is dropped to whatever reads cleanly at a glance —
 * an exact byte count belongs on the server page, not a summary card.
 */
export function formatMbPair(usedMb: number, totalMb: number): string {
  const compact = (mb: number, unit: "GB" | "MB") => {
    const value = unit === "GB" ? mb / 1024 : mb;
    // Avoid "8.0"; show a decimal only when it carries information.
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  };

  const unit: "GB" | "MB" = totalMb >= 1024 ? "GB" : "MB";
  return `${compact(usedMb, unit)}/${compact(totalMb, unit)} ${unit}`;
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * A node is "online" if its agent has answered a probe recently, "stale" if the
 * last heartbeat is older than this window, and "never" if it has no heartbeat.
 *
 * Heartbeats come from explicit probes (the per-node health check) or the
 * list-page sweep; the agent does not push them, so a quiet node goes stale
 * rather than being reported online indefinitely.
 */
const NODE_STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function nodeReachability(
  lastHeartbeatAt: string | null,
): "online" | "stale" | "never" {
  if (!lastHeartbeatAt) return "never";
  const then = new Date(lastHeartbeatAt).getTime();
  return Date.now() - then < NODE_STALE_THRESHOLD_MS ? "online" : "stale";
}

/**
 * Badge tone for a heuristic score, on the backend's scale (flag threshold 60,
 * maximum 130). "destructive" is reserved for scores that include corroborating
 * evidence rather than a single behavioural signal.
 */
export function scoreTone(score: number): "destructive" | "secondary" | "outline" {
  if (score >= 100) return "destructive";
  if (score >= 60) return "secondary";
  return "outline";
}

/** Format a throughput sample in bits per second for compact display. */
export function formatNet(bps: number): string {
  if (bps <= 0) return "0";
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(bps)} bps`;
}

/** Initials for an avatar fallback. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
