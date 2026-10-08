import { getBlueprintByKey, invalidateBlueprintCache } from "../blueprints/registry";
import type { Blueprint } from "../blueprints/types";
import { sql } from "../db/client";
import { encryptSecret } from "../lib/crypto";
import { discoverNodeServers, rememberServerOnNode, type DiscoveredServer } from "../nodes/nodeRecoveryApi";
import { recordAudit } from "./auditLog";
import { loadServerRecoveryMetadata } from "./nodeRecoveryMetadata";
import { legacyRecoveryBlueprint, recoveryBlueprintSignature, recoveryPorts, recoveryStatus } from "./nodeRecoveryPlan";

export interface NodeRecoveryResult {
  discovered: number;
  restored: number;
  existing: number;
  skipped: { serverId: string; reason: string }[];
  warning?: string;
}

function sameBlueprint(a: Blueprint, b: Blueprint): boolean {
  return recoveryBlueprintSignature(a) === recoveryBlueprintSignature(b);
}

async function restoreDiscoveredServer(nodeId: string, actorId: string, server: DiscoveredServer): Promise<{ kind: "existing" | "restored"; reassigned: boolean }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(server.serverId)) {
    throw new Error("The node did not report a valid server ID");
  }
  const ports = recoveryPorts(server);
  if (!server.dataPresent) throw new Error("The server's data directory is missing");
  if (!server.spec.image || !server.spec.containerDataPath.startsWith("/")) throw new Error("The saved runtime configuration is incomplete");
  let blueprint = server.recovery?.blueprint ?? legacyRecoveryBlueprint(server);
  // A changed blueprint on a replacement panel must not change an adopted container on its next rebuild.
  const current = await getBlueprintByKey(blueprint.key);
  if (current && !sameBlueprint(current, blueprint)) blueprint = { ...blueprint,
    key: `recovered-${server.serverId}-${recoveryBlueprintSignature(blueprint).slice(0, 12)}` };
  const secretKeys = new Set(server.recovery?.secretEnvKeys ?? Object.keys(server.spec.env));
  const envRows = Object.entries(server.spec.env).map(([key, value]) => ({
    server_id: server.serverId, key, value: secretKeys.has(key) ? encryptSecret(value) : value, is_secret: secretKeys.has(key),
  }));
  const outcome = await sql.begin(async (tx) => {
    // Serialize rescans of the same identity even if two registrations race.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${server.serverId}, 0))`;
    const [existing] = await tx<{ node_id: string }[]>`SELECT node_id FROM servers WHERE id = ${server.serverId}`;
    if (existing) {
      if (existing.node_id !== nodeId) throw new Error("This server is already assigned to another node");
      return { kind: "existing" as const, reassigned: false };
    }
    const [owner] = server.recovery?.ownerEmail
      ? await tx<{ id: string }[]>`
          SELECT id FROM "user" WHERE lower(email) = ${server.recovery.ownerEmail.toLowerCase()}
            AND (id = ${server.recovery.ownerId} OR "emailVerified" = TRUE)
          ORDER BY (id = ${server.recovery.ownerId}) DESC LIMIT 1
        `
      : [];
    const ownerId = owner?.id ?? actorId;
    const [bp] = await tx<{ id: string }[]>`
      INSERT INTO blueprints (
        key, name, description, docker_image, default_ports, env_schema,
        primary_port_env, startup_command, stop_command, install_image, install_script,
        install_entrypoint, data_path, min_cpu, min_memory_mb, min_disk_mb,
        supports_readonly_root, expected_resource_profile, run_as, tty, plugins, is_builtin
      ) VALUES (
        ${blueprint.key}, ${blueprint.name}, ${blueprint.description ?? null}, ${blueprint.dockerImage},
        ${tx.json(blueprint.defaultPorts as never)}, ${tx.json(blueprint.envSchema as never)},
        ${blueprint.primaryPortEnv ?? null}, ${blueprint.startupCommand ?? null}, ${blueprint.stopCommand ?? null},
        ${blueprint.install?.image ?? null}, ${blueprint.install?.script ?? null},
        ${blueprint.install?.entrypoint ? tx.json(blueprint.install.entrypoint) : null},
        ${blueprint.dataPath}, ${blueprint.minimums.cpuLimit}, ${blueprint.minimums.memoryLimitMb}, ${blueprint.minimums.diskLimitMb},
        ${blueprint.supportsReadOnlyRoot === true}, ${blueprint.expectedResourceProfile}, ${blueprint.user ?? null},
        ${blueprint.tty === true}, ${blueprint.plugins ? tx.json(blueprint.plugins as never) : null}, FALSE
      ) ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
      WHERE blueprints.docker_image = EXCLUDED.docker_image
        AND blueprints.default_ports = EXCLUDED.default_ports
        AND blueprints.env_schema = EXCLUDED.env_schema
        AND blueprints.primary_port_env IS NOT DISTINCT FROM EXCLUDED.primary_port_env
        AND blueprints.startup_command IS NOT DISTINCT FROM EXCLUDED.startup_command
        AND blueprints.stop_command IS NOT DISTINCT FROM EXCLUDED.stop_command
        AND blueprints.install_image IS NOT DISTINCT FROM EXCLUDED.install_image
        AND blueprints.install_script IS NOT DISTINCT FROM EXCLUDED.install_script
        AND blueprints.install_entrypoint IS NOT DISTINCT FROM EXCLUDED.install_entrypoint
        AND blueprints.data_path = EXCLUDED.data_path
        AND blueprints.min_cpu = EXCLUDED.min_cpu
        AND blueprints.min_memory_mb = EXCLUDED.min_memory_mb
        AND blueprints.min_disk_mb = EXCLUDED.min_disk_mb
        AND blueprints.supports_readonly_root = EXCLUDED.supports_readonly_root
        AND blueprints.expected_resource_profile = EXCLUDED.expected_resource_profile
        AND blueprints.run_as IS NOT DISTINCT FROM EXCLUDED.run_as
        AND blueprints.tty = EXCLUDED.tty
        AND blueprints.plugins IS NOT DISTINCT FROM EXCLUDED.plugins
      RETURNING id
    `;
    const blueprintId = bp?.id;
    if (!blueprintId) throw new Error("An existing blueprint conflicts with the saved server definition. Retry the scan to recover it separately.");
    await tx`
      INSERT INTO servers (id, name, owner_id, node_id, blueprint_id, container_id, status,
                           cpu_limit, memory_limit_mb, disk_limit_mb, suspension_reason, suspended_at)
      VALUES (${server.serverId}, ${server.recovery?.name ?? `Recovered ${server.serverId.slice(0, 8)}`},
              ${ownerId}, ${nodeId}, ${blueprintId}, ${server.containerId}, ${recoveryStatus(server)},
              ${server.spec.cpuLimit}, ${server.spec.memoryLimitMb}, ${server.recovery?.diskLimitMb ?? 1024},
              ${server.recovery?.status === "suspended" ? server.recovery.suspensionReason ?? "Recovered suspended server" : null},
              ${server.recovery?.status === "suspended" ? new Date() : null})
    `;
    const portRows = ports.map((p) => ({ server_id: server.serverId, node_id: nodeId,
      host_port: p.hostPort, container_port: p.hostPort, is_primary: p.isPrimary, is_additional: p.isAdditional, label: p.label }));
    await tx`INSERT INTO server_ports ${tx(portRows)}`;
    if (envRows.length) await tx`INSERT INTO server_env ${tx(envRows)}`;
    return { kind: "restored" as const, reassigned: !owner };
  });
  if (outcome.kind === "restored") {
    invalidateBlueprintCache();
    await recordAudit({ userId: actorId, action: "server.recover", targetType: "server", targetId: server.serverId,
      metadata: { nodeId, source: server.source, ownerAssignedToAdmin: outcome.reassigned } });
  }
  return outcome;
}

/** Restore records only. Discovery never installs, recreates, starts or stops a container. */
export async function recoverNodeServers(nodeId: string, actorId: string): Promise<NodeRecoveryResult> {
  const result: NodeRecoveryResult = { discovered: 0, restored: 0, existing: 0, skipped: [] };
  let discovery;
  try {
    discovery = await discoverNodeServers(nodeId);
  } catch {
    return { ...result, warning: "Server discovery was unavailable. Upgrade the node agent if necessary, then use Scan for servers on the node page." };
  }
  const warnings = [...discovery.warnings];
  result.discovered = discovery.servers.length;
  for (const server of discovery.servers) {
    try {
      const outcome = await restoreDiscoveredServer(nodeId, actorId, server);
      result[outcome.kind] += 1;
      if (outcome.kind === "restored" && server.spec.extraNetworks?.length) warnings.push(`Server ${server.serverId}'s database and link relationships require a panel export. A future container rebuild cannot preserve relationships missing from the panel.`);
      if (outcome.kind === "restored" && !server.recovery) warnings.push(`Server ${server.serverId} was recovered with a runtime-only blueprint and assigned to you.`);
      else if (outcome.kind === "restored" && outcome.reassigned) warnings.push(`Server ${server.serverId}'s former owner could not be verified. It has been assigned to you.`);
      try {
        await rememberServerOnNode(nodeId, server.serverId, await loadServerRecoveryMetadata(server.serverId));
      } catch {
        warnings.push(`Server ${server.serverId} was found, but its recovery record could not be updated. Retry the scan.`);
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      result.skipped.push({ serverId: server.serverId,
        reason: code === "23505" ? "A published port or server identity conflicts with an existing record"
          : code ? "The saved server configuration is incompatible with this panel"
          : error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  if (warnings.length) result.warning = warnings.join(" ");
  await recordAudit({ userId: actorId, action: "node.recover", targetType: "node", targetId: nodeId,
    metadata: { discovered: result.discovered, restored: result.restored, existing: result.existing, skipped: result.skipped.length } });
  return result;
}
