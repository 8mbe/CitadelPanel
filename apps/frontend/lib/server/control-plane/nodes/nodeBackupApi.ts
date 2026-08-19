/**
 * Typed wrappers over the node agent's backup endpoints.
 *
 * Same role as `nodeServerApi.ts`: the agent's wire format for backups lives in
 * one place, and every call is addressed by server id.
 *
 * Note that these all POST, including the reads. That is deliberate: the S3
 * credentials and the server's repository password travel in the body, and a
 * query string ends up in the access log of every proxy between the panel and
 * the node. The cost is that a snapshot listing is not cacheable, which nothing
 * here wanted anyway.
 */

import { nodeRequest } from "./nodeApi";

/** S3 destination, as the agent expects it. Endpoint is a bare host, no scheme. */
export interface AgentS3Target {
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The repository block every backup call carries. */
export interface AgentRepoTarget {
  s3: AgentS3Target;
  password: string;
}

/** One database's own scoped credentials, for the dump. */
export interface AgentDatabaseCredential {
  name: string;
  user: string;
  password: string;
}

export interface AgentRetention {
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export type AgentJobPhase =
  | "starting"
  | "dumping_databases"
  | "preparing_repository"
  | "uploading"
  | "restoring_files"
  | "importing_databases"
  | "applying_retention"
  | "finished";

export interface AgentJobLogLine {
  seq: number;
  level: "info" | "warn" | "error";
  message: string;
  at: string;
}

export interface AgentJobSnapshot {
  id: string;
  serverId: string;
  kind: "backup" | "restore";
  status: "running" | "succeeded" | "failed";
  phase: AgentJobPhase;
  percent: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: {
    snapshotId?: string;
    bytesProcessed?: number;
    bytesAdded?: number;
    databases?: string[];
  };
  logs: AgentJobLogLine[];
  latestSeq: number;
  droppedLines: number;
}

/**
 * Start a backup. Returns as soon as the agent has registered the job.
 *
 * The short timeout is the point: this call only has to survive long enough for
 * the agent to allocate a job id, and holding a request open for the length of
 * an actual backup is exactly what the job registry exists to avoid.
 */
export async function startNodeBackup(
  nodeId: string,
  serverId: string,
  request: {
    repo: AgentRepoTarget;
    databases: AgentDatabaseCredential[];
    retention: AgentRetention;
    reason: "manual" | "scheduled";
    exclude: string[];
  },
): Promise<{ jobId: string }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/backups`, {
    method: "POST",
    body: request,
  });
}

/**
 * Poll a job, draining only log lines newer than `afterSeq`.
 *
 * The cursor is in the query string rather than the body because it is not
 * secret and it makes the call idempotent in the obvious way — the same cursor
 * always returns the same window.
 */
export async function readNodeBackupJob(
  nodeId: string,
  serverId: string,
  jobId: string,
  afterSeq: number,
): Promise<AgentJobSnapshot> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/backups/jobs/${jobId}`, {
    query: { afterSeq },
  });
}

/** Start a restore. The caller stops the server first and starts it after. */
export async function startNodeRestore(
  nodeId: string,
  serverId: string,
  request: {
    repo: AgentRepoTarget;
    snapshotId: string;
    databases: AgentDatabaseCredential[];
  },
): Promise<{ jobId: string }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/backups/restore`, {
    method: "POST",
    body: request,
  });
}

export interface AgentSnapshot {
  id: string;
  time: string;
  tags: string[];
}

/** List the snapshots actually present in the server's repository. */
export async function listNodeSnapshots(
  nodeId: string,
  serverId: string,
  repo: AgentRepoTarget,
): Promise<AgentSnapshot[]> {
  const result = await nodeRequest<{ snapshots: AgentSnapshot[] }>(
    nodeId,
    `/v1/servers/${serverId}/backups/snapshots`,
    { method: "POST", body: { repo }, timeoutMs: 5 * 60_000 },
  );
  return result.snapshots;
}

/**
 * Delete one snapshot and reclaim its data.
 *
 * Generous timeout: `forget --prune` rewrites the pack files the snapshot
 * uniquely referenced, which is an S3 round trip per pack.
 */
export async function forgetNodeSnapshot(
  nodeId: string,
  serverId: string,
  repo: AgentRepoTarget,
  snapshotId: string,
): Promise<void> {
  await nodeRequest(nodeId, `/v1/servers/${serverId}/backups/forget`, {
    method: "POST",
    body: { repo, snapshotId },
    timeoutMs: 30 * 60_000,
  });
}

/** Verify the S3 destination from a node, for the admin settings page. */
export async function checkNodeBackupRepository(
  nodeId: string,
  serverId: string,
  repo: AgentRepoTarget,
): Promise<{ reachable: boolean; initialised: boolean; detail: string }> {
  return nodeRequest(nodeId, `/v1/servers/${serverId}/backups/check`, {
    method: "POST",
    body: { repo },
    timeoutMs: 2 * 60_000,
  });
}
