import { getBlueprintById } from "../blueprints/registry";
import { sql } from "../db/client";
import { discoverNodeServers, rememberServerOnNode, type ServerRecoveryMetadata } from "../nodes/nodeRecoveryApi";

/** Build a recovery record from authoritative panel rows, including owner email. */
export async function loadServerRecoveryMetadata(serverId: string): Promise<ServerRecoveryMetadata> {
  const [server] = await sql<{
    name: string; owner_id: string; email: string; blueprint_id: string;
    disk_limit_mb: number; status: string; suspension_reason: string | null;
  }[]>`
    SELECT s.name, s.owner_id, u.email, s.blueprint_id, s.disk_limit_mb,
           s.status, s.suspension_reason
    FROM servers s JOIN "user" u ON u.id = s.owner_id WHERE s.id = ${serverId}
  `;
  if (!server) throw new Error("Server recovery metadata is unavailable");
  const [blueprint, ports, secretKeys] = await Promise.all([
    getBlueprintById(server.blueprint_id),
    sql<{ host_port: number; is_primary: boolean; is_additional: boolean; label: string | null }[]>`
      SELECT host_port, is_primary, is_additional, label FROM server_ports
      WHERE server_id = ${serverId} ORDER BY is_primary DESC, host_port
    `,
    sql<{ key: string }[]>`SELECT key FROM server_env WHERE server_id = ${serverId} AND is_secret`,
  ]);
  if (!blueprint) throw new Error("Server recovery blueprint is unavailable");
  return {
    name: server.name, ownerId: server.owner_id, ownerEmail: server.email,
    blueprint, diskLimitMb: server.disk_limit_mb, status: server.status,
    suspensionReason: server.suspension_reason,
    ports: ports.map((p) => ({ hostPort: p.host_port, isPrimary: p.is_primary, isAdditional: p.is_additional, label: p.label })),
    secretEnvKeys: secretKeys.map((entry) => entry.key),
  };
}

/** Node upgrades are independent; an older/unreachable agent must not break a power action. */
export async function syncServerRecoveryMetadata(serverId: string): Promise<void> {
  try {
    const [server] = await sql<{ node_id: string; container_id: string | null; status: string }[]>`
      SELECT node_id, container_id, status FROM servers WHERE id = ${serverId}
    `;
    if (!server?.container_id || ["deleting", "migrating", "archiving", "archived", "restoring"].includes(server.status)) return;
    const next = await loadServerRecoveryMetadata(serverId);
    // A blueprint may have been edited since this container was built. Status
    // changes must not replace the manifest's functional definition and make a
    // later rebuild silently use the edited recipe.
    const discovered = await discoverNodeServers(server.node_id);
    const existing = discovered.servers.find((entry) => entry.serverId === serverId)?.recovery;
    if (existing) next.blueprint = existing.blueprint;
    await rememberServerOnNode(server.node_id, serverId, next);
  } catch {
    // Best effort for existing nodes. Fresh container creation writes its record synchronously.
  }
}
