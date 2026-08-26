/**
 * Creating a node's database *before* the node exists.
 *
 * The register-node form offers "set it up for me" inside its shared-database
 * switch, and at that moment there is no node row to address: the four database
 * fields are part of the create-node request that has not been sent yet. So
 * these two routes take the agent's URL and token straight from the form, the
 * way the pre-registration health probe already does.
 *
 * Split from `nodeDatabase.ts` (which owns the node-id lifecycle: status, setup,
 * start, stop) because the addressing is the whole difference. Everything here
 * has to work without a stored node, which also means nothing here persists
 * anything.
 */

import { requireAdmin } from "../auth/middleware";
import {
  badRequest,
  conflict,
  json,
  parseJsonBody,
  requireString,
} from "../lib/http";
import { normalizeApiUrl } from "../nodes/nodeApi";
import { listNodes } from "../nodes/nodeRegistry";
import {
  getNodeDbStatusUnregistered,
  setUpNodeDbUnregistered,
} from "../nodes/nodeServerApi";
import { recordAuditFromRequest } from "../services/auditLog";
import { mintAdmin } from "./nodeDatabase";

/**
 * POST /api/admin/nodes/database/provision
 *
 * The register-node form's "set it up for me": create the database on an agent
 * that has **no node row yet**, and hand the connection details back so the form
 * can fill its own fields.
 *
 * Why this is a separate endpoint rather than the one below: the four database
 * fields are part of the create-node request, so at the moment the operator wants
 * them filled there is nothing to address by node id. The connection details come
 * from the form, exactly as the pre-registration health probe already works.
 *
 * This is the one path where a database credential is **returned** to the
 * browser. It has to be: the value's destination is a form field that will be
 * posted straight back to `POST /api/admin/nodes`, which stores it encrypted.
 * The alternative (stash it server-side and have create-node pick it up) means
 * inventing a second place to keep a root-equivalent secret, which is strictly
 * worse than a value that lives in one admin's page for one minute. Admin-only,
 * like everything else here.
 *
 * Nothing is persisted by this call. An operator who provisions and then
 * abandons the form leaves a running database on the node and no credential in
 * the panel; the node page's setup then reports the container exists but does
 * not accept the panel's credentials, with the commands to clear it.
 */
export async function handleProvisionNodeDatabase(
  request: Request,
): Promise<Response> {
  const actor = await requireAdmin(request);
  const body = await parseJsonBody(request);

  const apiUrl = requireString(body, "apiUrl", { max: 512 });
  if (!/^https?:\/\//.test(apiUrl)) {
    throw badRequest('"apiUrl" must start with http:// or https://.');
  }
  // As with the probe: an agent call needs a token, and the generate-one-for-me
  // path cannot be used until that token is set on the agent.
  const token = requireString(body, "token", { min: 1, max: 512 });

  // Check before minting anything. A machine that already has a database cannot
  // accept a freshly generated account (only whoever holds the existing
  // credential can), so without this the operator waits out an image pull and a
  // first boot only to be told the container was already there. Same answer, one
  // second instead of one minute.
  const existing = await getNodeDbStatusUnregistered(apiUrl, token);
  if (existing.exists) {
    throw conflict(await alreadyHasDatabaseMessage(apiUrl, existing.containerName));
  }

  const credential = mintAdmin();
  const status = await setUpNodeDbUnregistered(apiUrl, token, credential);

  if (!status.host) {
    throw conflict(
      `The database container started but has no address on ` +
        `"${status.networkName}". Check the network with ` +
        `"docker network inspect ${status.networkName}" on the node.`,
    );
  }

  // Audited without a node id: there is no node yet. The agent URL is what
  // identifies the machine a database was just created on.
  await recordAuditFromRequest(request, {
    userId: actor.id,
    action: "node.database.setup",
    targetType: "node",
    metadata: {
      apiUrl,
      containerName: status.containerName,
      image: status.image,
      preRegistration: true,
    },
  });

  return json({
    host: status.host,
    port: status.port,
    user: credential.user,
    password: credential.password,
  });
}

/**
 * POST /api/admin/nodes/database/status
 *
 * The same status read, addressed by raw connection details. The register form
 * uses it twice: to know whether to offer creation at all, and to poll what a
 * creation in flight is actually doing (see `lib/node-database-progress.ts`).
 *
 * No credential is involved, so `ready` is always false here. Existence and
 * container state are what the form needs.
 */
export async function handleUnregisteredNodeDatabaseStatus(
  request: Request,
): Promise<Response> {
  await requireAdmin(request);
  const body = await parseJsonBody(request);

  const apiUrl = requireString(body, "apiUrl", { max: 512 });
  const token = requireString(body, "token", { min: 1, max: 512 });

  try {
    const status = await getNodeDbStatusUnregistered(apiUrl, token);
    return json({
      reachable: true,
      status,
      error: null,
      // Named so the form can say *which* node owns the database it found,
      // instead of the operator guessing which install put it there.
      registeredAs: status.exists ? await nodeNameForApiUrl(apiUrl) : null,
    });
  } catch (error) {
    // A polled endpoint must not turn an unreachable agent into a failed
    // request: the caller is mid-setup and just wants the next phase.
    return json({
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : "The node did not answer.",
      registeredAs: null,
    });
  }
}

/**
 * The name of the node already registered against this agent URL, if any.
 *
 * Fleets are small, so a scan beats another index. Compared through
 * `normalizeApiUrl` because `http://host:8081` and `http://host:8081/` are the
 * same agent and an operator will type either.
 */
async function nodeNameForApiUrl(apiUrl: string): Promise<string | null> {
  let target: string;
  try {
    target = normalizeApiUrl(apiUrl);
  } catch {
    return null;
  }
  for (const node of await listNodes()) {
    try {
      if (normalizeApiUrl(node.apiUrl) === target) return node.name;
    } catch {
      // A stored URL that no longer parses cannot be the match.
    }
  }
  return null;
}

/**
 * Why a database that already exists cannot be adopted by a new credential, and
 * what to do instead.
 *
 * The honest answer depends on whether this panel already knows the machine.
 * When it does, the operator is registering the same agent twice and the
 * database they are looking for is on that node's page. When it does not, the
 * container is from somewhere else and only its own credential can open it.
 */
async function alreadyHasDatabaseMessage(
  apiUrl: string,
  containerName: string,
): Promise<string> {
  const nodeName = await nodeNameForApiUrl(apiUrl);

  if (nodeName) {
    return (
      `This agent is already registered as node "${nodeName}", and it already ` +
      `runs a database ("${containerName}"). Manage it from that node's page ` +
      `rather than setting it up again here. If you are deliberately ` +
      `registering this machine a second time, leave the database switch off: ` +
      `only the credential stored on "${nodeName}" can open that database.`
    );
  }

  return (
    `This machine already runs a database container ("${containerName}"), so a ` +
    `newly generated account cannot be added to it: only whoever holds its ` +
    `existing credential can. Either enter that credential in the fields below, ` +
    `or remove the container on the node ("docker rm -f ${containerName}") and ` +
    `set it up again. Its data volume is kept either way, so an existing ` +
    `database is not lost by removing the container.`
  );
}

