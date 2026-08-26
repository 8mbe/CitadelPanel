/**
 * Audit logging (plan.md section 4).
 *
 * Every state-changing action gets a row. Audit writes must never break the
 * operation they are recording, so failures are logged and swallowed rather
 * than propagated. A lost log line is preferable to a failed server start.
 */

import { sql } from "../db/client";
import { clientIp } from "../lib/http";

/** Canonical action names. Kept as a union so typos fail at compile time. */
export type AuditAction =
  | "server.create"
  | "server.start"
  | "server.stop"
  | "server.restart"
  | "server.kill"
  | "server.reinstall"
  | "server.delete"
  | "server.suspend"
  | "server.unsuspend"
  | "server.env.update"
  | "server.resources.update"
  | "server.port.add"
  | "server.port.remove"
  | "server.link.add"
  | "server.link.remove"
  | "server.database.add"
  | "server.database.remove"
  | "server.database.reset_password"
  | "server.database.explorer.create_table"
  | "server.database.explorer.drop_table"
  | "server.database.explorer.add_column"
  | "server.database.explorer.change_column"
  | "server.database.explorer.drop_column"
  | "server.database.explorer.insert_row"
  | "server.database.explorer.update_row"
  | "server.database.explorer.delete_row"
  | "server.console.command"
  | "server.ai.helper"
  | "server.file.write"
  | "server.file.delete"
  | "server.file.rename"
  | "server.file.copy"
  | "server.file.upload"
  | "server.file.pull"
  | "server.plugin.install"
  | "server.plugin.remove"
  | "server.plugin.toggle"
  | "server.plugin.settings"
  | "server.plugin.auto-update"
  | "server.backup.create"
  | "server.backup.restore"
  | "server.backup.delete"
  | "server.backup.settings"
  | "node.database.backup"
  | "node.database.restore"
  | "node.database.backup.delete"
  // The node's shared MariaDB itself, not its backups: created, started and
  // stopped from the node's admin page (see routes/nodeDatabase.ts).
  | "node.database.setup"
  | "node.database.start"
  | "node.database.stop"
  | "server.sftp.auth"
  | "server.sftp.credential.create"
  | "server.sftp.credential.regenerate"
  | "server.sftp.credential.delete"
  | "subuser.invite"
  | "subuser.update"
  | "subuser.remove"
  | "database.create"
  | "database.delete"
  | "node.create"
  | "node.update"
  | "node.delete"
  | "node.drain"
  | "node.portpool.add"
  | "node.portpool.delete"
  | "blueprint.create"
  | "blueprint.update"
  | "blueprint.delete"
  | "blueprint.plugins.update"
  | "suspicious.review"
  | "suspicious.flag"
  | "user.create"
  | "user.role.update"
  | "user.ban"
  | "user.unban"
  | "user.delete"
  | "apikey.create"
  | "apikey.update"
  | "apikey.delete"
  | "setup.admin.create"
  | "setup.complete"
  | "settings.update"
  | "settings.legal.update";

export type AuditTargetType =
  | "server"
  | "node"
  | "user"
  | "subuser"
  | "database"
  | "blueprint"
  | "suspicious_activity"
  | "api_key"
  | "settings";

export interface AuditEntry {
  userId?: string | null;
  action: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit row.
 *
 * Metadata should describe *what changed*, never *secret values*. Callers must
 * not put passwords, tokens or TLS keys in here.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_logs (user_id, action, target_type, target_id, ip, metadata)
      VALUES (
        ${entry.userId ?? null},
        ${entry.action},
        ${entry.targetType ?? null},
        ${entry.targetId ?? null},
        ${entry.ip ?? null},
        ${sql.json((entry.metadata ?? {}) as never)}
      )
    `;
  } catch (error) {
    console.error("[audit] failed to write audit entry:", entry.action, error);
  }
}

/** Convenience wrapper that extracts the client IP from a request. */
export async function recordAuditFromRequest(
  request: Request,
  entry: Omit<AuditEntry, "ip">,
): Promise<void> {
  await recordAudit({ ...entry, ip: clientIp(request), metadata: withApiKeyAttribution(request, entry.metadata) });
}

/**
 * When the request was authenticated with an API key (either header
 * convention, see `middleware.withApiKeyHeaderAlias`), stamp the entry's
 * metadata so the audit trail distinguishes "the admin clicked this" from "a
 * script holding the admin's key did". `viaKeyPrefix` records the first 8
 * chars of the credential actually used, which is distinct from a
 * handler-supplied `keyPrefix` naming the key being *acted on* (the two are
 * often different keys). Never the key material itself is recorded. Requests
 * from the panel UI never carry these headers, and a request bearing an invalid
 * key is rejected 401 before any audited handler runs, so header presence at
 * this point means the key authenticated.
 */
function withApiKeyAttribution(
  request: Request,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;
  const raw = request.headers.get("x-api-key") ?? bearer;
  if (!raw) return metadata ?? {};

  return {
    ...(metadata ?? {}),
    viaApiKey: true,
    viaKeyPrefix: raw.slice(0, 8),
  };
}

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** Read recent audit entries, optionally filtered to one target. */
export async function listAuditLogs(options: {
  limit?: number;
  targetType?: AuditTargetType;
  targetId?: string;
}): Promise<AuditLogRow[]> {
  const limit = Math.min(options.limit ?? 100, 500);

  if (options.targetType && options.targetId) {
    return (await sql`
      SELECT * FROM audit_logs
      WHERE target_type = ${options.targetType} AND target_id = ${options.targetId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `) as AuditLogRow[];
  }

  return (await sql`
    SELECT * FROM audit_logs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as AuditLogRow[];
}
