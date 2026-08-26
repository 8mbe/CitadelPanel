/**
 * The node's shared database, as an admin operation instead of an SSH session.
 *
 * A node agent already holds the Docker socket, which is everything needed to
 * run a MariaDB container next to the game servers. So the whole "run
 * `bun run setup-db` on the node, copy the printed password, paste it into the
 * register-node form" ritual was never a technical requirement: it was a missing
 * button. These four routes are that button, plus start and stop.
 *
 * Admin-only, without exception. The database's admin credential is
 * root-equivalent on every tenant database on the node.
 *
 * The register form's pre-registration variant (no node row yet) lives in
 * `nodeDatabaseSetup.ts`.
 *
 * Where the secret lives: the panel generates the MariaDB root password, stores
 * it encrypted on the node row, and hands it to the agent per request. The agent
 * never persists it. That is the same split as per-server database provisioning
 * (see `docs/database-explorer.md`), and it is why setup is safe to retry: the
 * password exists panel-side before the container does.
 */

import { requireAdmin } from "../auth/middleware";
import { sql } from "../db/client";
import {
  conflict,
  json,
  notFound,
  parseJsonBody,
  requireUuidParam,
} from "../lib/http";
import { randomBytes } from "node:crypto";
import { generateStrongPassword } from "../lib/crypto";
import {
  getNodeDbStatus,
  setUpNodeDb,
  startNodeDb,
  stopNodeDb,
  type NodeDbAdmin,
  type NodeDbStatus,
} from "../nodes/nodeServerApi";
import {
  getNodeWithSecrets,
  setNodeDbEndpoint,
  stageNodeDbCredentials,
} from "../nodes/nodeRegistry";
import { recordAuditFromRequest } from "../services/auditLog";

/**
 * Mint the account the panel will use on a node's database.
 *
 * Not `root`: the agent creates this account inside MariaDB and forgets the
 * image's root password, so the panel's own credential is the only one anyone
 * holds. The random suffix means two nodes never share an account name, so a
 * credential leaked from one node's row is recognisably not another's.
 *
 * The privileges are necessarily broad (it creates databases and users per
 * server), so this is not least privilege; it is a credential the panel owns,
 * can rotate by recreating, and never asks an operator to type.
 */
export function mintAdmin(): NodeDbAdmin {
  return {
    user: `citadel_${randomBytes(4).toString("hex")}`,
    password: generateStrongPassword(32),
  };
}

/**
 * What the admin card renders.
 *
 * `reachable: false` is a normal answer, not an error: a node whose agent is
 * down should show "cannot tell" rather than an empty card, exactly as the
 * health endpoints do.
 */
interface NodeDatabaseView {
  reachable: boolean;
  /** The agent's report; null when it could not be asked. */
  status: NodeDbStatus | null;
  /** Why the agent could not be asked. */
  error: string | null;
  /** True once the panel holds an admin credential for this node's database. */
  hasCredentials: boolean;
  /**
   * The address the panel is configured to provision against, when there is one.
   *
   * Normally the container the agent reports. It can also be a database this
   * panel did not create, entered on the register-node form; that is the case the
   * setup button must not silently overwrite, so the UI needs to see it.
   */
  configured: { host: string; port: number } | null;
  /** Server databases provisioned here. What a Stop takes offline. */
  databaseCount: number;
}

/** How many per-server databases live on this node. */
async function countServerDatabases(nodeId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM server_databases WHERE node_id = ${nodeId}
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/**
 * Load the node with its decrypted credentials, or 404.
 *
 * Every route here needs the stored root password (to prove ownership of the
 * container to the agent), so they all start the same way.
 */
async function requireNodeWithSecrets(nodeId: string) {
  const node = await getNodeWithSecrets(nodeId);
  if (!node) throw notFound("Node not found");
  return node;
}

/**
 * GET /api/admin/nodes/:id/database
 *
 * Deliberately *not* folded into `handleGetNode`: it costs an agent round trip
 * plus (when a password is stored) a `docker exec` ping inside the container, so
 * putting it on the node page's critical path would slow down the page for the
 * one card that can load itself. Same reasoning as the port pool's standalone
 * endpoint, one cost tier up.
 */
export async function handleGetNodeDatabase(
  request: Request,
  nodeId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const node = await requireNodeWithSecrets(id);
  const hasCredentials = Boolean(node.db.user && node.db.password);
  const configured = configuredEndpoint(node);
  const databaseCount = await countServerDatabases(id);

  try {
    const status = await getNodeDbStatus(id, storedAdmin(node));
    return json({
      reachable: true,
      status,
      error: null,
      hasCredentials,
      configured,
      databaseCount,
    } satisfies NodeDatabaseView);
  } catch (error) {
    return json({
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : "The node did not answer.",
      hasCredentials,
      configured,
      databaseCount,
    } satisfies NodeDatabaseView);
  }
}

/** The stored credential, or undefined when the panel holds none. */
function storedAdmin(node: {
  db: { user?: string | null; password?: string | null };
}): NodeDbAdmin | undefined {
  return node.db.user && node.db.password
    ? { user: node.db.user, password: node.db.password }
    : undefined;
}

/** The stored provisioning address, or null when the node has none. */
function configuredEndpoint(node: {
  db: { host?: string | null; port?: number | null };
}): { host: string; port: number } | null {
  return node.db.host ? { host: node.db.host, port: node.db.port ?? 3306 } : null;
}

/**
 * POST /api/admin/nodes/:id/database/setup
 *
 * Creates the network, the data volume and the MariaDB container on the node,
 * then records where it answers, which is what enables database provisioning for
 * every server on that node.
 *
 * The password is generated here on first run and **reused** on any subsequent
 * one. Reuse is the whole reason a retry works: this call can take minutes on a
 * cold node (image pull, then MariaDB's first-boot initialisation), and if it
 * times out the container may already exist. Presenting the same password lets
 * the agent recognise its own container instead of the panel stranding a running
 * database it can no longer authenticate to.
 *
 * A container that exists but rejects the stored password is the agent's 409,
 * passed through: it means another panel install (or a hand-run of the script)
 * owns this node's database. Recreating it would destroy every tenant's data, so
 * this refuses and says what to do.
 */
export async function handleSetUpNodeDatabase(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const node = await requireNodeWithSecrets(id);
  const body = await parseJsonBody(request).catch(() => ({}) as Record<string, unknown>);
  const replaceEndpoint = body.replaceEndpoint === true;

  // Guard the one case where creating a container is the wrong answer: the node
  // is already pointed at a database this agent does not run. That happens when
  // the register-node form was given an existing MariaDB's credentials. Creating
  // a container here would take the stored credential, use it for a brand new
  // empty database, and overwrite the address, quietly cutting every server on
  // the node off from the database it was actually using.
  //
  // The same state also covers "our container was removed", which is a real
  // thing to want to fix, so this is a confirmation rather than a refusal: the
  // UI shows the configured address and asks before sending `replaceEndpoint`.
  if (node.db.host && !replaceEndpoint) {
    const status = await getNodeDbStatus(id, storedAdmin(node));
    if (!status.exists) {
      throw conflict(
        `This node is already configured to use a database at ` +
          `${node.db.host}:${node.db.port ?? 3306}, which this agent does not ` +
          `run (no "${status.containerName}" container here). Creating one would ` +
          `point the node at a new, empty database instead. Confirm the ` +
          `replacement if that is what you want.`,
      );
    }
  }

  // Reuse the stored credential when there is one; only mint an account the
  // first time. See the note above on why this must not be regenerated.
  const stored =
    node.db.user && node.db.password
      ? { user: node.db.user, password: node.db.password }
      : null;
  const credential = stored ?? mintAdmin();
  const created = stored === null;

  // Written before the agent is called, so a timeout leaves recoverable state.
  await stageNodeDbCredentials(id, credential.user, credential.password);

  const status = await setUpNodeDb(id, credential);

  if (!status.host) {
    throw conflict(
      `The node's database container started but has no address on ` +
        `"${status.networkName}". Check the network with ` +
        `"docker network inspect ${status.networkName}" on the node.`,
    );
  }

  await setNodeDbEndpoint(id, status.host, status.port);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "node.database.setup",
    targetType: "node",
    targetId: id,
    metadata: {
      nodeName: node.name,
      containerName: status.containerName,
      image: status.image,
      // Whether this run minted the credential or reused the stored one. Never
      // the credential itself.
      credentialCreated: created,
      ...(replaceEndpoint ? { replacedEndpoint: true } : {}),
    },
  });

  return json(await viewAfterAction(id, status));
}

/**
 * POST /api/admin/nodes/:id/database/start
 *
 * Also re-records the endpoint: Docker assigns the container's IP at start, so a
 * container that was stopped and started may answer on a different address than
 * the one stored at setup. Skipping this is how a node quietly stops being able
 * to provision databases after a reboot.
 */
export async function handleStartNodeDatabase(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const node = await requireNodeWithSecrets(id);
  const status = await startNodeDb(id, storedAdmin(node));

  if (status.host) await setNodeDbEndpoint(id, status.host, status.port);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "node.database.start",
    targetType: "node",
    targetId: id,
    metadata: { nodeName: node.name, containerName: status.containerName },
  });

  return json(await viewAfterAction(id, status));
}

/**
 * POST /api/admin/nodes/:id/database/stop
 *
 * Every server database on the node goes unreachable until it is started again.
 * That is a legitimate thing for an admin to want (maintenance, a restore), so
 * it is not blocked; the audit row records how many databases it affected, and
 * the UI warns before the click.
 *
 * The stored endpoint is left alone: the container keeps its address while it is
 * merely stopped, and clearing it would turn "the database is down" into "this
 * node never had a database".
 */
export async function handleStopNodeDatabase(
  request: Request,
  nodeId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(nodeId, "nodeId");

  const node = await requireNodeWithSecrets(id);
  const status = await stopNodeDb(id);
  const databaseCount = await countServerDatabases(id);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "node.database.stop",
    targetType: "node",
    targetId: id,
    metadata: {
      nodeName: node.name,
      containerName: status.containerName,
      databasesAffected: databaseCount,
    },
  });

  return json(await viewAfterAction(id, status));
}

/**
 * Wrap a fresh agent status in the same view the GET returns, so the client can
 * replace its state from any response instead of re-fetching after every action.
 */
async function viewAfterAction(
  nodeId: string,
  status: NodeDbStatus,
): Promise<NodeDatabaseView> {
  const node = await getNodeWithSecrets(nodeId);
  return {
    reachable: true,
    status,
    error: null,
    hasCredentials: Boolean(node?.db.user && node?.db.password),
    configured: node ? configuredEndpoint(node) : null,
    databaseCount: await countServerDatabases(nodeId),
  };
}
