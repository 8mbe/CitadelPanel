import type { Blueprint } from "../blueprints/types";
import type { CreateContainerRequest, ContainerState } from "./nodeServerApi";
import { nodeRequest } from "./nodeApi";

/** Private panel metadata, kept outside the tenant's mounted directory. */
export interface ServerRecoveryMetadata {
  name: string;
  ownerId: string;
  ownerEmail: string;
  blueprint: Blueprint;
  diskLimitMb: number;
  status?: string;
  suspensionReason?: string | null;
  ports: { hostPort: number; isPrimary: boolean; isAdditional: boolean; label?: string | null }[];
  secretEnvKeys: string[];
}

export interface DiscoveredServer {
  serverId: string;
  containerId: string | null;
  state: ContainerState;
  spec: CreateContainerRequest;
  recovery?: ServerRecoveryMetadata;
  dataPresent: boolean;
  source: "manifest" | "container";
}

export interface NodeDiscovery {
  servers: DiscoveredServer[];
  warnings: string[];
}

export function discoverNodeServers(nodeId: string): Promise<NodeDiscovery> {
  return nodeRequest(nodeId, "/v1/servers/discovery", { timeoutMs: 30_000 });
}

export async function rememberServerOnNode(
  nodeId: string,
  serverId: string,
  recovery: ServerRecoveryMetadata,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/recovery`, {
    method: "PUT",
    body: { recovery },
  });
}
