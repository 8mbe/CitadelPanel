import type { Blueprint } from "../blueprints/types";
import type { DiscoveredServer } from "../nodes/nodeRecoveryApi";
import { createHash } from "node:crypto";

/** Stable functional comparison; object key order and descriptive copy are irrelevant. */
export function recoveryBlueprintSignature(blueprint: Blueprint): string {
  const definition = Object.fromEntries(Object.entries(blueprint)
    .filter(([name]) => !["key", "name", "description"].includes(name)));
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => [name, normalize(entry)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(normalize({ ...definition,
    tty: Boolean(blueprint.tty), supportsReadOnlyRoot: Boolean(blueprint.supportsReadOnlyRoot) }))).digest("hex");
}

/** Recovery never changes an existing container's port configuration. */
export function recoveryPorts(server: DiscoveredServer) {
  const ports = new Map<number, Set<string>>();
  for (const binding of server.spec.ports) {
    if (!Number.isInteger(binding.hostPort) || binding.hostPort < 1 || binding.hostPort > 65535 || binding.containerPort !== binding.hostPort) {
      throw new Error("The container has port mappings this panel cannot preserve");
    }
    const protocols = ports.get(binding.hostPort) ?? new Set<string>();
    protocols.add(binding.protocol);
    ports.set(binding.hostPort, protocols);
  }
  if (ports.size === 0) throw new Error("The server has no published ports to recover");
  if ([...ports.values()].some((protocols) => !protocols.has("tcp") || !protocols.has("udp"))) {
    throw new Error("The container does not publish each port on both TCP and UDP");
  }
  const remembered = server.recovery?.ports ?? [];
  if (remembered.length && (remembered.length !== ports.size || remembered.some((p) => !ports.has(p.hostPort)))) {
    throw new Error("The saved ports do not match the container configuration");
  }
  const primary = remembered.find((p) => p.isPrimary)?.hostPort ?? ports.keys().next().value;
  return [...ports.keys()].map((port) => {
    const saved = remembered.find((p) => p.hostPort === port);
    return { hostPort: port, isPrimary: port === primary, isAdditional: saved?.isAdditional ?? false, label: saved?.label ?? null };
  });
}

/** A legacy container has runtime facts but no reusable install recipe. */
export function legacyRecoveryBlueprint(server: DiscoveredServer): Blueprint {
  const ports = recoveryPorts(server);
  const command = server.spec.command;
  // Split literal template openers between shell quotes so panel interpolation
  // cannot replace bytes that were already part of Docker's concrete argv.
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''").replace(/\{\{/g, "{''{")}'`;
  return {
    key: `recovered-${server.serverId}`,
    name: `Recovered ${server.spec.image}`.slice(0, 128),
    description: "Recovered from an existing node container. No install step is available.",
    dockerImage: server.spec.image,
    dataPath: server.spec.containerDataPath,
    defaultPorts: ports.map((p) => ({ container: p.hostPort, primary: p.isPrimary })),
    envSchema: Object.fromEntries(Object.keys(server.spec.env).map((key) => [key, { required: false, secret: true }])),
    startupCommand: command?.length ? command.map(quote).join(" ") : undefined,
    user: server.spec.user,
    tty: server.spec.tty,
    supportsReadOnlyRoot: server.spec.readOnlyRootFilesystem,
    expectedResourceProfile: "bursty",
    minimums: { cpuLimit: Math.max(0.1, server.spec.cpuLimit), memoryLimitMb: Math.max(128, server.spec.memoryLimitMb), diskLimitMb: 1024 },
  };
}

export function recoveryStatus(server: DiscoveredServer): "running" | "stopped" | "suspended" | "error" {
  if (server.recovery?.status === "suspended") return "suspended";
  if (!server.dataPresent || server.state === "dead") return "error";
  return server.state === "running" || server.state === "restarting" ? "running" : "stopped";
}
