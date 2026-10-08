import { requireAdmin } from "../auth/middleware";
import { badRequest, forbidden, json, payloadTooLarge } from "../lib/http";
import { recordAuditFromRequest } from "../services/auditLog";
import { exportPanelSnapshot, importPanelSnapshot, previewPanelImport } from "../services/panelSnapshot";
import { SnapshotError, validateSnapshotPassphrase } from "../services/panelSnapshotFormat";

const MAX_REQUEST_BYTES = 70 * 1024 * 1024;

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_REQUEST_BYTES) throw payloadTooLarge("Panel import requests cannot exceed 70 MB.");
  const reader = request.body?.getReader();
  if (!reader) throw badRequest("Request body must be valid JSON.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw payloadTooLarge("Panel import requests cannot exceed 70 MB.");
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) throw error;
    throw badRequest("Request body must be a JSON object.");
  } finally {
    reader.releaseLock();
  }
}

async function snapshotAdmin(request: Request) {
  // An archive contains every user's credentials and all node root tokens.
  // No individual API-key resource scope grants that combined authority.
  if (request.headers.has("x-api-key") || request.headers.get("authorization")?.toLowerCase().startsWith("bearer ")) {
    throw forbidden("Sign in as an administrator to export or import the panel. API keys cannot access panel snapshots.");
  }
  return requireAdmin(request);
}

async function snapshotErrors<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof SnapshotError) throw badRequest(error.message);
    throw error;
  }
}

export async function handlePanelExport(request: Request): Promise<Response> {
  const user = await snapshotAdmin(request);
  const body = await requestBody(request);
  return snapshotErrors(async () => {
    validateSnapshotPassphrase(body.passphrase);
    const archive = await exportPanelSnapshot(body.passphrase);
    void recordAuditFromRequest(request, { userId: user.id, action: "panel.export", targetType: "settings" });
    return json(archive, 200, {
      "content-disposition": `attachment; filename="citadel-panel-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    });
  });
}

export async function handlePanelImportPreview(request: Request): Promise<Response> {
  await snapshotAdmin(request);
  const body = await requestBody(request);
  return snapshotErrors(async () => {
    validateSnapshotPassphrase(body.passphrase);
    return json(await previewPanelImport(body.archive, body.passphrase), 200, { "cache-control": "no-store" });
  });
}

export async function handlePanelImport(request: Request): Promise<Response> {
  const user = await snapshotAdmin(request);
  const body = await requestBody(request);
  if (body.confirmation !== "REPLACE PANEL") throw badRequest('Type "REPLACE PANEL" to confirm the import.');
  return snapshotErrors(async () => {
    validateSnapshotPassphrase(body.passphrase);
    const preview = await importPanelSnapshot(body.archive, body.passphrase);
    // The importer may not exist in the replaced user table. The action still
    // names them without attaching a foreign key to a different account.
    void recordAuditFromRequest(request, {
      userId: null, action: "panel.import", targetType: "settings",
      metadata: { importedById: user.id, importedByEmail: user.email, exportedAt: preview.createdAt, counts: preview.counts },
    });
    return json({ success: true, requiresSignIn: true, counts: preview.counts }, 200, { "cache-control": "no-store" });
  });
}
