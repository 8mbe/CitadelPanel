/**
 * Static mining indicators (plan.md section 9.1).
 *
 * Intentionally NOT a host blocklist. A domain list is trivially defeated —
 * a miner proxies stratum through a host it controls and the list never
 * matches — so maintaining one costs real effort while catching only the
 * laziest abuse. What remains here are the indicators that survive that
 * objection:
 *
 *  - Stratum PORTS, which are a property of the protocol rather than of any
 *    particular pool operator.
 *  - Miner BINARY names, observed inside the container where a proxy in front
 *    of the pool makes no difference.
 *
 * Both are static, so this module has no database dependency.
 */

/**
 * Ports conventionally used by stratum mining.
 *
 * Note the deliberate omission of 8080: it is listed in plan.md section 9.1 but
 * is far too common for legitimate HTTP traffic (plugin update checks,
 * Modrinth/CurseForge APIs) to be usable as a signal. Including it would
 * generate constant false positives, which is worse than missing a miner that
 * chose a common port.
 *
 * 7777 is retained per the plan, but it is also a common game-server port
 * (Terraria, Unturned, some Rust setups), so it is treated as a WEAKER signal
 * than the unambiguous stratum ports — see `heuristics.ts`.
 */
export const MINING_POOL_PORTS: readonly number[] = [
  3333, 4444, 5555, 7777, 14444, 45700, 3357, 9999,
];

/** Stratum ports with essentially no legitimate game-hosting use. */
export const UNAMBIGUOUS_MINING_PORTS: readonly number[] = [
  3333, 4444, 5555, 14444, 45700, 3357,
];

/** Ports intentionally NOT treated as mining indicators, with the reason. */
export const EXCLUDED_AMBIGUOUS_PORTS: Readonly<Record<number, string>> = {
  80: "Standard HTTP — used by plugin/mod update checks",
  443: "Standard HTTPS — used by plugin/mod update checks",
  8080: "Common HTTP alternate — too many legitimate uses",
  25565: "Minecraft Java default port",
  19132: "Minecraft Bedrock default port",
};

export function isMiningPort(port: number): boolean {
  return MINING_POOL_PORTS.includes(port);
}

/** Whether a port is a stratum port with no plausible legitimate game use. */
export function isUnambiguousMiningPort(port: number): boolean {
  return UNAMBIGUOUS_MINING_PORTS.includes(port);
}

/** Known miner process/binary names, for the medium-weight process signal. */
export const KNOWN_MINER_BINARIES: readonly string[] = [
  "xmrig",
  "minerd",
  "cpuminer",
  "cgminer",
  "bfgminer",
  "ethminer",
  "nbminer",
  "phoenixminer",
  "t-rex",
  "lolminer",
  "xmr-stak",
  "nheqminer",
  "srbminer",
  "teamredminer",
];

/**
 * Match a process command line against known miner binary names.
 *
 * Word-boundary matched to avoid flagging an unrelated path that merely
 * contains a miner name as a substring.
 */
export function matchesKnownMiner(commandLine: string): string | null {
  const normalized = commandLine.toLowerCase();

  for (const binary of KNOWN_MINER_BINARIES) {
    const pattern = new RegExp(`(^|[\\s/\\\\])${binary}([\\s]|$|\\.)`, "i");
    if (pattern.test(normalized)) return binary;
  }
  return null;
}
