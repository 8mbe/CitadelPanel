/**
 * Client-side port-spec validation.
 *
 * Mirrors the server parser in
 * `lib/server/control-plane/nodes/portSpec.ts` so the Add-port form can give
 * immediate feedback without a round-trip. The server parser remains the source
 * of truth; this only reduces wasted POSTs and improves UX. Keep the two in
 * sync, so accepted forms and error messages match.
 */

export class PortSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortSpecError";
  }
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

function parsePort(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new PortSpecError(`"${raw}" is not a valid port number.`);
  }
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new PortSpecError(
      `Port ${port} is out of range (must be ${MIN_PORT}-${MAX_PORT}).`,
    );
  }
  return port;
}

/** Expand a comma-separated port spec into a sorted, de-duplicated list. */
export function parsePortSpec(input: string): number[] {
  const spec = input.trim();
  if (spec.length === 0) {
    throw new PortSpecError("Port spec cannot be empty.");
  }

  const ports: number[] = [];
  const seen = new Set<number>();

  for (const segment of spec.split(",")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      throw new PortSpecError("Port spec has an empty segment.");
    }

    const dash = trimmed.indexOf("-");
    if (dash === -1) {
      addPort(ports, seen, parsePort(trimmed));
      continue;
    }

    const startRaw = trimmed.slice(0, dash);
    const endRaw = trimmed.slice(dash + 1);
    if (endRaw.includes("-")) {
      throw new PortSpecError(`"${trimmed}" is not a valid port range.`);
    }

    const start = parsePort(startRaw);
    const end = parsePort(endRaw);
    if (end < start) {
      throw new PortSpecError(
        `Range "${trimmed}" is reversed (end must be >= start).`,
      );
    }

    for (let port = start; port <= end; port += 1) {
      addPort(ports, seen, port);
    }
  }

  return ports.sort((a, b) => a - b);
}

function addPort(ports: number[], seen: Set<number>, port: number): void {
  if (seen.has(port)) {
    throw new PortSpecError(`Port ${port} appears more than once in the spec.`);
  }
  seen.add(port);
  ports.push(port);
}

/** Collapse a list of ports back into "start-end, N" compact form. */
export function formatPortsCompact(ports: number[]): string {
  if (ports.length === 0) return "";
  const sorted = [...ports].sort((a, b) => a - b);
  const parts: string[] = [];
  let runStart = sorted[0]!;
  let prev = sorted[0]!;

  for (let i = 1; i < sorted.length; i += 1) {
    const port = sorted[i]!;
    if (port === prev + 1) {
      prev = port;
      continue;
    }
    parts.push(runStart === prev ? `${runStart}` : `${runStart}-${prev}`);
    runStart = port;
    prev = port;
  }
  parts.push(runStart === prev ? `${runStart}` : `${runStart}-${prev}`);
  return parts.join(", ");
}
