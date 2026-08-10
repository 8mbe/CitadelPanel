/**
 * Server file-manager routes.
 *
 * Thin proxies onto the node agent's file endpoints. The panel's job here is
 * authorization and auditing; containment (path traversal, symlink escape, size
 * caps) is enforced node-side in `apps/backend/src/paths.ts`, because that is
 * where the filesystem actually is.
 *
 * All of these require the `files` permission, which is a distinct subuser
 * grant from `console` — read/write access to a server's disk is a meaningfully
 * different capability from being able to see its output.
 */

import { requireServerPermission } from "../auth/middleware";
import { sql } from "../db/client";
import {
  badRequest,
  json,
  noContent,
  parseJsonBody,
  requireUuidParam,
} from "../lib/http";
import {
  createServerDirectory,
  deleteServerFile,
  listServerFiles,
  readServerFile,
  writeServerFile,
} from "../nodes/nodeServerApi";
import { recordAuditFromRequest } from "../services/auditLog";

/** Resolve which node a server lives on. */
async function nodeIdFor(serverId: string): Promise<string> {
  const rows = (await sql`
    SELECT node_id FROM servers WHERE id = ${serverId}
  `) as { node_id: string }[];

  const nodeId = rows[0]?.node_id;
  if (!nodeId) throw badRequest("Server not found");
  return nodeId;
}

/** Read a required `path` query parameter. */
function pathParam(request: Request): string {
  const path = new URL(request.url).searchParams.get("path");
  if (!path) throw badRequest('"path" query parameter is required');
  return path;
}

/** GET /api/servers/:id/files?path= — list a directory. */
export async function handleListFiles(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");

  const path = new URL(request.url).searchParams.get("path") ?? "/";
  return json(await listServerFiles(await nodeIdFor(id), id, path));
}

/** GET /api/servers/:id/files/content?path= — read a file. */
export async function handleReadFile(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");

  const path = pathParam(request);
  return json({ path, contents: await readServerFile(await nodeIdFor(id), id, path) });
}

/**
 * PUT /api/servers/:id/files/content — write a file.
 *
 * Audited by path only: file contents can be large and can contain secrets
 * (an `ops.json`, a plugin's database config), neither of which belongs in an
 * audit row.
 */
export async function handleWriteFile(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (typeof body.path !== "string") throw badRequest('"path" is required');
  if (typeof body.contents !== "string") {
    throw badRequest('"contents" must be a string');
  }

  await writeServerFile(await nodeIdFor(id), id, body.path, body.contents);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.file.write",
    targetType: "server",
    targetId: id,
    metadata: { path: body.path },
  });

  return json({
    path: body.path,
    note: "Changes take effect the next time the server is restarted.",
  });
}

/** DELETE /api/servers/:id/files?path= — delete a file or directory. */
export async function handleDeleteFile(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const path = pathParam(request);
  await deleteServerFile(await nodeIdFor(id), id, path);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.file.delete",
    targetType: "server",
    targetId: id,
    metadata: { path },
  });

  return noContent();
}

/** POST /api/servers/:id/files/directory — create a directory. */
export async function handleCreateDirectory(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (typeof body.path !== "string") throw badRequest('"path" is required');

  await createServerDirectory(await nodeIdFor(id), id, body.path);
  return noContent();
}
