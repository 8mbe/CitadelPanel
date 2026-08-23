/**
 * Server file-manager routes.
 *
 * Thin proxies onto the node agent's file endpoints. The panel's job here is
 * authorization and auditing; containment (path traversal, symlink escape, size
 * caps) is enforced node-side in `apps/backend/src/paths.ts`, because that is
 * where the filesystem actually is.
 *
 * All of these require the `files` permission, which is a distinct subuser
 * grant from `console`. Read/write access to a server's disk is a meaningfully
 * different capability from being able to see its output.
 */

import { requireServerPermission } from "../auth/middleware";
import { env } from "../config/env";
import { sql } from "../db/client";
import {
  badRequest,
  json,
  noContent,
  parseJsonBody,
  payloadTooLarge,
  requireUuidParam,
} from "../lib/http";
import { isBlockedUrlResolved } from "../lib/ssrf";
import {
  copyServerFile,
  createServerDirectory,
  deleteServerFiles,
  downloadServerFile,
  listServerFiles,
  pullServerFileFromUrl,
  readServerFile,
  renameServerFile,
  uploadServerFile,
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

/** GET /api/servers/:id/files?path=. Lists a directory. */
export async function handleListFiles(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");

  const path = new URL(request.url).searchParams.get("path") ?? "/";
  return json(await listServerFiles(await nodeIdFor(id), id, path));
}

/** GET /api/servers/:id/files/content?path=. Reads a file. */
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
 * PUT /api/servers/:id/files/content. Writes a file.
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

/**
 * POST /api/servers/:id/files/delete. Deletes files/directory trees.
 *
 * One request for a whole selection; the file manager used to fire one DELETE
 * per file. The agent validates every path through containment before removing
 * anything, so a bad entry fails the batch rather than half-deleting it.
 *
 * Audited as a single entry with the full path list.
 */
export async function handleDeleteFiles(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (
    !Array.isArray(body.paths) ||
    body.paths.length === 0 ||
    body.paths.some((path: unknown) => typeof path !== "string")
  ) {
    throw badRequest('"paths" must be a non-empty array of paths');
  }

  await deleteServerFiles(await nodeIdFor(id), id, body.paths);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.file.delete",
    targetType: "server",
    targetId: id,
    metadata: { paths: body.paths },
  });

  return noContent();
}

/** POST /api/servers/:id/files/directory. Creates a directory. */
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

/**
 * POST /api/servers/:id/files/rename. Renames or moves a file/directory.
 *
 * Audited with both the source and destination paths, so a move into a
 * different folder leaves a trace of where the file came from and went.
 */
export async function handleRenameFile(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (typeof body.from !== "string") throw badRequest('"from" is required');
  if (typeof body.to !== "string") throw badRequest('"to" is required');

  await renameServerFile(await nodeIdFor(id), id, body.from, body.to);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.file.rename",
    targetType: "server",
    targetId: id,
    metadata: { from: body.from, to: body.to },
  });

  return noContent();
}

/**
 * POST /api/servers/:id/files/copy. Copies a file/directory tree.
 *
 * Audited with both paths. The destination is a full path, not a directory to
 * copy into, and the agent rejects a name collision with a 409.
 */
export async function handleCopyFile(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (typeof body.from !== "string") throw badRequest('"from" is required');
  if (typeof body.to !== "string") throw badRequest('"to" is required');

  await copyServerFile(await nodeIdFor(id), id, body.from, body.to);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.file.copy",
    targetType: "server",
    targetId: id,
    metadata: { from: body.from, to: body.to },
  });

  return noContent();
}

/**
 * GET /api/servers/:id/files/download?path=&paths=&download=. Streams a
 * download.
 *
 * A single file streams raw bytes; multiple `paths` (newline-delimited) or a
 * directory stream a zip archive built on the fly by the agent. The panel pipes
 * the agent's response body straight to the browser without buffering, so a
 * multi-GB download never sits in the panel's memory.
 *
 * `download` is an optional suggested filename; the agent sanitises it and owns
 * the final Content-Disposition value (header-injection prevention).
 */
export async function handleDownloadFile(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  await requireServerPermission(request, id, "files");

  const url = new URL(request.url);
  const pathsParam = url.searchParams.get("paths");
  const paths = pathsParam
    ? pathsParam.split("\n").filter((p) => p.length > 0)
    : url.searchParams.get("path")
      ? [url.searchParams.get("path")!]
      : [];
  if (paths.length === 0) throw badRequest('"path" or "paths" is required');

  const download = url.searchParams.get("download") ?? undefined;
  const upstream = await downloadServerFile(await nodeIdFor(id), id, paths, download);

  // Forward the streaming body and the agent's headers (content-type,
  // content-disposition, content-length) verbatim. The body is a live stream,
  // so `new Response(body, ...)` pipes it through without buffering.
  const headers = new Headers();
  for (const key of [
    "content-type",
    "content-disposition",
    "content-length",
  ]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  // Prevent intermediaries from buffering a long download.
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * POST /api/servers/:id/files/upload?path=. Streams a file upload to the node.
 *
 * The browser sends the raw file body as `application/octet-stream` (one file
 * per request); the panel streams it straight through to the agent, so a large
 * upload is never buffered in the panel's memory. The panel enforces its own
 * size cap up front via `content-length`, a cheap rejection before any bytes
 * are forwarded, and the agent enforces it again during the stream for a
 * client that lies about the length.
 *
 * Audited by path only; file contents can be large and can contain secrets.
 */
export async function handleUploadFile(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const path = new URL(request.url).searchParams.get("path");
  if (!path) throw badRequest('"path" query parameter is required');

  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > env.uploadMaxBytes) {
    throw payloadTooLarge(
      `Upload is ${contentLength} bytes, which exceeds the ${env.uploadMaxBytes}-byte limit.`,
    );
  }

  if (!request.body) throw badRequest("Request body is required.");

  const result = await uploadServerFile(
    await nodeIdFor(id),
    id,
    path,
    request.body,
    Number.isFinite(contentLength) ? contentLength : undefined,
  );

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.file.upload",
    targetType: "server",
    targetId: id,
    metadata: { path, sizeBytes: result.sizeBytes },
  });

  return json(result, 201);
}

/**
 * POST /api/servers/:id/files/pull. Fetches a URL into the server's data dir.
 *
 * The panel validates the URL and applies its SSRF guardrail before forwarding
 * to the agent, which performs the actual fetch (so the bytes travel once,
 * directly to disk). The panel caps the destination size via the agent's upload
 * limit; a declared `content-length` over the cap is rejected up front.
 *
 * Audited with the destination path and source URL (the URL is operator-visible
 * context, not a secret).
 */
export async function handlePullFromUrl(
  request: Request,
  serverId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const { user } = await requireServerPermission(request, id, "files");

  const body = await parseJsonBody(request);
  if (typeof body.path !== "string") throw badRequest('"path" is required');
  if (typeof body.url !== "string") throw badRequest('"url" is required');

  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    throw badRequest('"url" must be a valid URL');
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest('"url" must be an http(s) URL');
  }
  // Resolve the host and reject it if it (or anything it resolves to) is
  // internal. The caller here is a server owner/subuser, not an admin, so the
  // literal-only check is not enough. The agent re-checks the host and every
  // redirect hop when it performs the fetch.
  if (await isBlockedUrlResolved(url.hostname)) {
    throw badRequest("That host is not allowed.");
  }

  const result = await pullServerFileFromUrl(await nodeIdFor(id), id, body.path, body.url);

  await recordAuditFromRequest(request, {
    userId: user.id,
    action: "server.file.pull",
    targetType: "server",
    targetId: id,
    metadata: { path: body.path, url: body.url, sizeBytes: result.sizeBytes },
  });

  return json(result, 201);
}
