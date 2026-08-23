/**
 * Legal document routes for the operator-authored terms of service and privacy
 * policy.
 *
 * Two audiences, two shapes. Admins read and write the Markdown source through
 * `/api/admin/legal`; everyone else reads the rendered page at `/terms` and
 * `/privacy`, which are server components that call the settings service
 * directly rather than looping back through HTTP.
 *
 * Writes are audited like any other settings change, but the document *body* is
 * never written to the audit log, only its length. An audit entry is a
 * different retention class from a published page, and copying a full policy
 * revision into it would be a surprising place for that text to live.
 */

import { requireAdmin } from "../auth/middleware";
import { badRequest, json, notFound, parseJsonBody } from "../lib/http";
import { recordAuditFromRequest } from "../services/auditLog";
import {
  getLegalSettings,
  isLegalDocumentKey,
  LEGAL_DOCUMENTS,
  setLegalDocument,
} from "../services/settings";

/**
 * GET /api/admin/legal. Returns both documents' Markdown source. Admin only.
 *
 * The source, not the rendered output: this feeds an editor.
 */
export async function handleGetLegal(request: Request): Promise<Response> {
  await requireAdmin(request);
  return json(await getLegalSettings());
}

/**
 * PUT /api/admin/legal/:document. Replaces one document. Admin only.
 *
 * A whole-document replace rather than a patch, because that is what the editor
 * holds: the buffer is the document. Saving an empty body unpublishes the page
 * (the public route then 404s) which is the only way to withdraw one.
 */
export async function handleUpdateLegal(
  request: Request,
  document: string,
): Promise<Response> {
  const admin = await requireAdmin(request);

  if (!isLegalDocumentKey(document)) {
    throw notFound(
      `Unknown legal document "${document}". Expected one of: ${LEGAL_DOCUMENTS.join(", ")}`,
    );
  }

  const body = await parseJsonBody(request);
  if (typeof body.content !== "string") {
    throw badRequest('"content" must be a string (send "" to unpublish)');
  }

  let settings;
  try {
    settings = await setLegalDocument(document, body.content, admin.id);
  } catch (error) {
    throw badRequest(
      error instanceof Error ? error.message : "Could not save the document",
    );
  }

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "settings.legal.update",
    targetType: "settings",
    targetId: document,
    // Length and publication state only, never the document text itself.
    metadata: {
      document,
      characters: settings[document].content.length,
      published: settings[document].content.length > 0,
    },
  });

  return json(settings);
}
