/**
 * Server links: explicit, pairwise connectivity grants between two servers
 * (docs/server-links.md).
 *
 * A link is the one sanctioned exception to the rule that a server container
 * can reach no other tenant's container (see `apps/backend/src/docker/
 * hardening.ts`). The pair gets its own ICC-enabled Docker network holding
 * exactly those two containers, so a compromised server can only ever reach
 * servers its owner explicitly linked it to.
 *
 * Addresses are stable by construction: same-node links use the peer's
 * container name (`citadel-<id12>`, resolved by Docker's embedded DNS) rather
 * than its IP, because container IPs change on every recreate. Cross-node
 * links have no shared Docker daemon to bridge, so they ride the peer node's
 * public hostname and published port.
 */

import { sql } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/http";
import {
  linkServerContainers,
  unlinkServerContainers,
} from "../nodes/nodeServerApi";
import { recordAudit } from "./auditLog";
import type { ServerStatus } from "./serverManager";

/**
 * The pairwise link network's name for two servers.
 *
 * Mirrors `linkNetworkName` in `apps/backend/src/docker/hardening.ts` — the
 * agent owns the definition (it creates and removes the networks), but the
 * panel needs the name to re-attach link networks when a container is
 * recreated via `extraNetworks`. Keep the two in sync: a mismatch would attach
 * recreated containers to a network the unlink path never tears down.
 */
export function linkNetworkName(serverIdA: string, serverIdB: string): string {
  const [a, b] = [serverIdA.slice(0, 12), serverIdB.slice(0, 12)].sort();
  return `citadel_link_${a}_${b}`;
}

/** A link as seen from one of its two servers. */
export interface ServerLinkSummary {
  id: string;
  /** The linked peer. */
  target: {
    id: string;
    name: string;
    status: ServerStatus;
    nodeHostname: string | null;
  };
  /** "internal" = pairwise Docker network (same node); "external" = public address. */
  mode: "internal" | "external";
  /** The hostname this server reaches the peer at. */
  host: string;
  /** The peer's primary published port; null before one is allocated. */
  port: number | null;
  createdAt: Date;
}

interface LinkRow {
  id: string;
  created_at: Date;
  peer_id: string;
  peer_name: string;
  peer_status: ServerStatus;
  peer_node_id: string;
  peer_hostname: string | null;
  peer_primary_port: number | null;
}

/**
 * Load every link involving a server, from that server's perspective.
 *
 * Links are stored one-directionally but the connectivity is bidirectional,
 * so both directions are listed: a row someone else created *to* this server
 * is just as much a connection of this server's.
 */
export async function listServerLinks(
  serverId: string,
): Promise<ServerLinkSummary[]> {
  const rows = (await sql`
    SELECT
      sl.id,
      sl.created_at,
      peer.id            AS peer_id,
      peer.name          AS peer_name,
      peer.status        AS peer_status,
      peer.node_id       AS peer_node_id,
      peer_node.hostname AS peer_hostname,
      (
        SELECT sp.host_port FROM server_ports sp
        WHERE sp.server_id = peer.id AND sp.is_primary = TRUE
        ORDER BY sp.host_port ASC LIMIT 1
      ) AS peer_primary_port
    FROM server_links sl
    JOIN servers peer
      ON peer.id = CASE WHEN sl.server_id = ${serverId} THEN sl.target_id ELSE sl.server_id END
    JOIN nodes peer_node ON peer_node.id = peer.node_id
    WHERE sl.server_id = ${serverId} OR sl.target_id = ${serverId}
    ORDER BY sl.created_at ASC
  `) as LinkRow[];

  // The viewing server's own node decides the mode: a peer on the same node
  // shares a Docker daemon (link network), anything else is public-address.
  const ownRows = (await sql`
    SELECT node_id FROM servers WHERE id = ${serverId}
  `) as { node_id: string }[];
  const ownNodeId = ownRows[0]?.node_id ?? null;

  return rows.map((row) => {
    const mode: "internal" | "external" =
      ownNodeId !== null && row.peer_node_id === ownNodeId
        ? "internal"
        : "external";
    return {
      id: row.id,
      target: {
        id: row.peer_id,
        name: row.peer_name,
        status: row.peer_status,
        nodeHostname: row.peer_hostname,
      },
      mode,
      host:
        mode === "internal"
          ? `citadel-${row.peer_id.slice(0, 12)}`
          : (row.peer_hostname ?? ""),
      port: row.peer_primary_port ?? null,
      createdAt: row.created_at,
    };
  });
}

/**
 * The link networks a server's container must be attached to at create time.
 *
 * Recreating a container drops its network attachments, so `serverManager`
 * passes these names via `extraNetworks` and the agent re-attaches — that is
 * how a link survives env edits, port changes and resource updates. Both
 * directions: this server may be the link's source or its target.
 */
export async function listServerLinkNetworks(
  serverId: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT server_id, target_id FROM server_links
    WHERE server_id = ${serverId} OR target_id = ${serverId}
  `) as { server_id: string; target_id: string }[];

  return rows.map((row) =>
    linkNetworkName(
      row.server_id === serverId ? serverId : row.server_id,
      row.server_id === serverId ? row.target_id : serverId,
    ),
  );
}

export interface CreateServerLinkInput {
  serverId: string;
  targetId: string;
  actorId: string;
}

/**
 * Connect two servers.
 *
 * The route has already established that the actor owns (or admins) both
 * servers; this function owns the rest of the rules: no self-links, one link
 * per pair in either direction (the pair shares one network, so a reverse row
 * would be a second handle to the same connectivity), both containers must
 * exist, and neither server may be suspended.
 *
 * Ordering follows the panel-wide principle — DB row first, then the node —
 * except the row is rolled back if the node refuses: a row whose network was
 * never attached would be a link that does not work but cannot be diagnosed
 * from the node.
 */
export async function createServerLink(
  input: CreateServerLinkInput,
): Promise<ServerLinkSummary> {
  const { serverId, targetId, actorId } = input;
  if (targetId === serverId) {
    throw badRequest("A server cannot be connected to itself.");
  }

  const rows = (await sql`
    SELECT s.id, s.name, s.status, s.node_id, s.container_id
    FROM servers s
    WHERE s.id = ${serverId} OR s.id = ${targetId}
  `) as {
    id: string;
    name: string;
    status: ServerStatus;
    node_id: string;
    container_id: string | null;
  }[];

  const source = rows.find((row) => row.id === serverId);
  const target = rows.find((row) => row.id === targetId);
  if (!source || !target) throw notFound("Server not found");

  for (const server of [source, target]) {
    if (server.status === "suspended") {
      throw conflict(
        `Server "${server.name}" is suspended pending administrator review and cannot be connected.`,
      );
    }
  }

  const sameNode = source.node_id === target.node_id;
  if (sameNode) {
    // The link network is attached to containers; without a container there
    // is nothing to attach and the peer's DNS name would not resolve.
    for (const server of [source, target]) {
      if (!server.container_id) {
        throw conflict(
          `Server "${server.name}" has no container yet — wait for it to finish installing, then connect again.`,
        );
      }
    }
  }

  const existing = (await sql`
    SELECT 1 FROM server_links
    WHERE (server_id = ${serverId} AND target_id = ${targetId})
       OR (server_id = ${targetId} AND target_id = ${serverId})
  `) as { 1: number }[];
  if (existing.length > 0) {
    throw conflict(`Server "${target.name}" is already connected to this server.`);
  }

  const inserted = (await sql`
    INSERT INTO server_links (server_id, target_id, created_by)
    VALUES (${serverId}, ${targetId}, ${actorId})
    RETURNING id
  `) as { id: string }[];

  if (sameNode) {
    try {
      await linkServerContainers(source.node_id, serverId, targetId);
    } catch (error) {
      await sql`DELETE FROM server_links WHERE id = ${inserted[0].id}`;
      throw error;
    }
  }

  await recordAudit({
    userId: actorId,
    action: "server.link.add",
    targetType: "server",
    targetId: serverId,
    metadata: {
      targetId,
      targetName: target.name,
      mode: sameNode ? "internal" : "external",
    },
  });

  const links = await listServerLinks(serverId);
  const link = links.find((candidate) => candidate.target.id === targetId);
  if (!link) throw notFound("Server link not found after creation");
  return link;
}

/**
 * Remove a link by id.
 *
 * The link must involve `serverId`; anyone with owner access to either side
 * can remove it (the route enforces that on the server whose URL was used).
 *
 * Fail-closed ordering for same-node links: the agent detaches first and the
 * row is deleted only afterwards. An unreachable node therefore fails the
 * request with a 502 and the link stays active — never a deleted row with a
 * still-attached network. Cross-node links have no network to tear down, so
 * they are a plain row delete.
 */
export async function removeServerLink(
  serverId: string,
  linkId: string,
  actorId: string,
): Promise<void> {
  const rows = (await sql`
    SELECT sl.id, sl.server_id, sl.target_id,
           src.node_id AS source_node_id, tgt.node_id AS target_node_id
    FROM server_links sl
    JOIN servers src ON src.id = sl.server_id
    JOIN servers tgt ON tgt.id = sl.target_id
    WHERE sl.id = ${linkId}
      AND (sl.server_id = ${serverId} OR sl.target_id = ${serverId})
  `) as {
    id: string;
    server_id: string;
    target_id: string;
    source_node_id: string;
    target_node_id: string;
  }[];

  const link = rows[0];
  if (!link) throw notFound("Server link not found");

  if (link.source_node_id === link.target_node_id) {
    await unlinkServerContainers(link.source_node_id, link.server_id, link.target_id);
  }
  await sql`DELETE FROM server_links WHERE id = ${link.id}`;

  await recordAudit({
    userId: actorId,
    action: "server.link.remove",
    targetType: "server",
    targetId: serverId,
    metadata: {
      removedLinkId: link.id,
      peerId: link.server_id === serverId ? link.target_id : link.server_id,
    },
  });
}

/**
 * Detach every link involving a server, before its container is deleted.
 *
 * Called from `deleteServer`: the link rows cascade away with the server
 * record, but the pair networks on the node would be left holding the peer.
 * Best-effort for the same reason the rest of node cleanup is — an unreachable
 * node must not block the delete. The peer keeps a lone, empty-halved network
 * until its own next recreate/unlink; harmless, and tidied then.
 */
export async function detachAllServerLinks(serverId: string): Promise<void> {
  const rows = (await sql`
    SELECT sl.server_id, sl.target_id,
           src.node_id AS source_node_id, tgt.node_id AS target_node_id
    FROM server_links sl
    JOIN servers src ON src.id = sl.server_id
    JOIN servers tgt ON tgt.id = sl.target_id
    WHERE sl.server_id = ${serverId} OR sl.target_id = ${serverId}
  `) as {
    server_id: string;
    target_id: string;
    source_node_id: string;
    target_node_id: string;
  }[];

  for (const row of rows) {
    if (row.source_node_id !== row.target_node_id) continue;
    try {
      await unlinkServerContainers(
        row.source_node_id,
        row.server_id,
        row.target_id,
      );
    } catch (error) {
      console.error(
        `[serverLinks] unlink during delete failed for ${row.server_id}/${row.target_id} (continuing):`,
        error,
      );
    }
  }
}
