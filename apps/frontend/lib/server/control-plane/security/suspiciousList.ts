/**
 * Suspicious activity list (plan.md section 9.2).
 *
 * The panel FLAGS and RECORDS; a human decides. Rows here are evidence for
 * admin review, never an automatic verdict.
 */

import { sql } from "../db/client";
import { recordAudit } from "../services/auditLog";
import type { Signal } from "./heuristics";

export interface SuspiciousActivityRow {
  id: string;
  server_id: string;
  reason: string;
  score: number;
  detail: Record<string, unknown>;
  detected_at: Date;
  reviewed: boolean;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

/** A flag row joined with the context an admin needs to judge it. */
export interface SuspiciousActivityWithContext extends SuspiciousActivityRow {
  server_name: string | null;
  owner_id: string | null;
  owner_email: string | null;
  node_id: string | null;
  node_name: string | null;
  server_status: string | null;
}

/**
 * Suppression window: do not re-flag the same server while an unreviewed flag
 * already exists and is younger than this.
 *
 * Without this, a miner running for a day would generate hundreds of rows and
 * bury everything else in the admin's queue.
 */
export const FLAG_SUPPRESSION_MINUTES = 60;

/**
 * Whether a fresh, unreviewed flag already exists for this server.
 * Prevents duplicate noise from consecutive watcher passes.
 */
export async function hasRecentUnreviewedFlag(serverId: string): Promise<boolean> {
  // The cutoff is computed in application code so the query needs no interval
  // string construction (which would not be a plain bindable parameter).
  const cutoff = new Date(Date.now() - FLAG_SUPPRESSION_MINUTES * 60 * 1000);

  const rows = await sql<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM suspicious_activity
    WHERE server_id = ${serverId}
      AND reviewed = FALSE
      AND detected_at > ${cutoff}
    LIMIT 1
  `;

  return rows.length > 0;
}

export interface FlagInput {
  serverId: string;
  reason: string;
  score: number;
  signals: Signal[];
  /** Extra context: node, container, sampled metrics. */
  observation?: Record<string, unknown>;
}

/**
 * Record a suspicious activity flag.
 *
 * Returns the created row, or null when suppressed as a duplicate.
 */
export async function recordFlag(
  input: FlagInput,
): Promise<SuspiciousActivityRow | null> {
  if (await hasRecentUnreviewedFlag(input.serverId)) {
    return null;
  }

  const detail = {
    signals: input.signals.map((signal) => ({
      rule: signal.rule,
      score: signal.score,
      reason: signal.reason,
      detail: signal.detail ?? {},
    })),
    observation: input.observation ?? {},
  };

  const rows = (await sql`
    INSERT INTO suspicious_activity (server_id, reason, score, detail)
    VALUES (
      ${input.serverId}, ${input.reason}, ${input.score},
      ${sql.json(detail as never)}
    )
    RETURNING *
  `) as SuspiciousActivityRow[];

  const row = rows[0]!;

  await recordAudit({
    userId: null, // system-generated
    action: "suspicious.flag",
    targetType: "suspicious_activity",
    targetId: row.id,
    metadata: {
      serverId: input.serverId,
      score: input.score,
      rules: input.signals.map((signal) => signal.rule),
    },
  });

  console.warn(
    `[security] flagged server ${input.serverId} with score ${input.score}: ${input.reason}`,
  );

  return row;
}

/**
 * List flags for admin review, unreviewed first and newest first within that.
 * That ordering puts the actionable queue at the top by default.
 */
export async function listSuspiciousActivity(options: {
  includeReviewed?: boolean;
  limit?: number;
} = {}): Promise<SuspiciousActivityWithContext[]> {
  const limit = Math.min(options.limit ?? 100, 500);

  if (options.includeReviewed) {
    return (await sql`
      SELECT
        sa.*,
        s.name    AS server_name,
        s.status  AS server_status,
        s.owner_id,
        u.email   AS owner_email,
        n.id      AS node_id,
        n.name    AS node_name
      FROM suspicious_activity sa
      LEFT JOIN servers s ON s.id = sa.server_id
      LEFT JOIN "user" u  ON u.id = s.owner_id
      LEFT JOIN nodes n   ON n.id = s.node_id
      ORDER BY sa.reviewed ASC, sa.detected_at DESC
      LIMIT ${limit}
    `) as SuspiciousActivityWithContext[];
  }

  return (await sql`
    SELECT
      sa.*,
      s.name    AS server_name,
      s.status  AS server_status,
      s.owner_id,
      u.email   AS owner_email,
      n.id      AS node_id,
      n.name    AS node_name
    FROM suspicious_activity sa
    LEFT JOIN servers s ON s.id = sa.server_id
    LEFT JOIN "user" u  ON u.id = s.owner_id
    LEFT JOIN nodes n   ON n.id = s.node_id
    WHERE sa.reviewed = FALSE
    ORDER BY sa.detected_at DESC
    LIMIT ${limit}
  `) as SuspiciousActivityWithContext[];
}

export async function getSuspiciousActivity(
  id: string,
): Promise<SuspiciousActivityRow | null> {
  const rows = (await sql`
    SELECT * FROM suspicious_activity WHERE id = ${id}
  `) as SuspiciousActivityRow[];
  return rows[0] ?? null;
}

/**
 * Mark a flag reviewed (or un-reviewed).
 *
 * Reviewing is intentionally decoupled from any enforcement action: an admin can
 * dismiss a false positive without touching the server, or suspend the server
 * and mark it reviewed as two separate, individually audited decisions.
 */
export async function setReviewed(
  id: string,
  reviewedBy: string,
  reviewed = true,
): Promise<SuspiciousActivityRow | null> {
  // Timestamp is computed here rather than with a nested `now()` fragment so the
  // whole statement stays a single plain parameterised query.
  const reviewedAt = reviewed ? new Date() : null;

  const rows = (await sql`
    UPDATE suspicious_activity
    SET reviewed    = ${reviewed},
        reviewed_by = ${reviewed ? reviewedBy : null},
        reviewed_at = ${reviewedAt}
    WHERE id = ${id}
    RETURNING *
  `) as SuspiciousActivityRow[];

  const row = rows[0];
  if (!row) return null;

  await recordAudit({
    userId: reviewedBy,
    action: "suspicious.review",
    targetType: "suspicious_activity",
    targetId: id,
    metadata: { reviewed, serverId: row.server_id },
  });

  return row;
}

/** Count of pending flags, for an admin dashboard badge. */
export async function countUnreviewed(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM suspicious_activity WHERE reviewed = FALSE
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/**
 * A per-server flag row trimmed to what the node detail page needs.
 *
 * The full evidence breakdown lives on the security review dialog; here we just
 * want enough to list recent flags and link into the queue.
 */
export interface NodeAbuseFlag {
  id: string;
  serverId: string;
  serverName: string | null;
  score: number;
  reason: string;
  reviewed: boolean;
  detectedAt: string;
}

/** Aggregate abuse picture for one node, for its detail page. */
export interface NodeAbuseSummary {
  openCount: number;
  reviewedCount: number;
  /** Highest flag score on this node's servers (0 when there are none). */
  maxScore: number;
  /** Newest flags first, capped for the detail card. */
  recent: NodeAbuseFlag[];
}

/**
 * Summarise abuse flags for a single node's servers.
 *
 * INNER JOINs `servers`: deleting a server does not cascade `suspicious_activity`
 * (only ports/env/subusers/databases), so a flag can outlive its server. Those
 * orphans belong to no node and are excluded here automatically — they are
 * still visible in the global review queue.
 */
export async function getNodeAbuseSummary(
  nodeId: string,
): Promise<NodeAbuseSummary> {
  const [aggregate, recent] = await Promise.all([
    sql`
      SELECT
        COUNT(*) FILTER (WHERE sa.reviewed = FALSE) AS open_count,
        COUNT(*) FILTER (WHERE sa.reviewed = TRUE)  AS reviewed_count,
        COALESCE(MAX(sa.score), 0)                  AS max_score
      FROM suspicious_activity sa
      JOIN servers s ON s.id = sa.server_id
      WHERE s.node_id = ${nodeId}
    ` as Promise<{ open_count: number; reviewed_count: number; max_score: number }[]>,
    sql`
      SELECT
        sa.id, sa.server_id, sa.score, sa.reason, sa.reviewed,
        sa.detected_at,
        s.name AS server_name
      FROM suspicious_activity sa
      JOIN servers s ON s.id = sa.server_id
      WHERE s.node_id = ${nodeId}
      ORDER BY sa.detected_at DESC
      LIMIT 10
    ` as Promise<{
      id: string;
      server_id: string;
      score: number;
      reason: string;
      reviewed: boolean;
      detected_at: Date;
      server_name: string | null;
    }[]>,
  ]);

  const totals = aggregate[0] ?? {
    open_count: 0,
    reviewed_count: 0,
    max_score: 0,
  };

  return {
    openCount: Number(totals.open_count) || 0,
    reviewedCount: Number(totals.reviewed_count) || 0,
    maxScore: Number(totals.max_score) || 0,
    recent: recent.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      score: row.score,
      reason: row.reason,
      reviewed: row.reviewed,
      detectedAt: row.detected_at.toISOString(),
    })),
  };
}
