/**
 * Typed wrappers over the node agent's backup endpoints.
 *
 * Same role as `nodeServerApi.ts`: the agent's wire format for backups lives in
 * one place.
 *
 * Note that these all POST, including the reads. That is deliberate: the S3
 * credentials and the repository password travel in the body, and a query string
 * ends up in the access log of every proxy between the panel and the node. The
 * cost is that a snapshot listing is not cacheable, which nothing here wanted.
 */

import { nodeRequest } from "./nodeApi";

/** S3 destination, as the agent expects it. Endpoint is a bare host, no scheme. */
export interface AgentS3Target {
  /** Bare host with optional port. The scheme comes from `useTls`. */
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** false for a self-hosted endpoint without a certificate. */
  useTls: boolean;
}

/**
 * The repository block every backup call carries.
 *
 * No scope or id: the agent takes those from the route and the surrounding body,
 * so a request cannot talk one route into writing into another scope's repository.
 */
export interface AgentRepoTarget {
  s3: AgentS3Target;
  password: string;
}

/** The node's MariaDB admin credential. Only the database routes accept one. */
export interface AgentDbAdmin {
  user: string;
  password: string;
}

export type AgentJobPhase =
  | "starting"
  | "preparing_repository"
  | "enforcing_limit"
  | "dumping_databases"
  | "uploading"
  | "restoring_files"
  | "importing_databases"
  | "measuring"
  | "finished";

export interface AgentJobLogLine {
  seq: number;
  level: "info" | "warn" | "error";
  message: string;
  at: string;
}

export interface AgentJobSnapshot {
  id: string;
  /** `server:<uuid>` or `node:databases`. */
  subject: string;
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
    failedDatabases?: { name: string; error: string }[];
    /** Snapshot ids the quota deleted, so the panel can drop the matching rows. */
    forgotten?: string[];
    /** Deduplicated repository size after the run; null when unmeasurable. */
    repoSizeBytes?: number | null;
  };
  logs: AgentJobLogLine[];
  latestSeq: number;
  droppedLines: number;
}

/**
 * Start a backup of a server's files. Returns once the agent has a job id.
 *
 * The short default timeout is the point: this call only has to survive long
 * enough for the agent to allocate a job id, and holding a request open for the
 * length of an actual backup is what the job registry exists to avoid.
 */
export async function startNodeServerBackup(
  nodeId: string,
  serverId: string,
  request: {
    repo: AgentRepoTarget;
    keepMax: number;
    reason: "manual" | "scheduled";
    exclude: string[];
  },
): Promise<{ jobId: string }> {
  return nodeRequest(nodeId, `/v1/backups/servers/${serverId}`, {
    method: "POST",
    body: request,
  });
}

/** Start a restore of a server's files. The caller stops/starts the server. */
export async function startNodeServerRestore(
  nodeId: string,
  serverId: string,
  request: { repo: AgentRepoTarget; snapshotId: string },
): Promise<{ jobId: string }> {
  return nodeRequest(nodeId, `/v1/backups/servers/${serverId}/restore`, {
    method: "POST",
    body: request,
  });
}

/**
 * Start a backup of every database on a node.
 *
 * `nodeId` travels in the body as well as being the routing target: the agent does
 * not know its own node id (that identity belongs to the panel's registry) but
 * needs it to address the repository.
 */
export async function startNodeDatabaseBackup(
  nodeId: string,
  request: {
    repo: AgentRepoTarget;
    databases: string[];
    admin: AgentDbAdmin;
    keepMax: number;
    reason: "manual" | "scheduled";
  },
): Promise<{ jobId: string }> {
  return nodeRequest(nodeId, "/v1/backups/databases", {
    method: "POST",
    body: { ...request, nodeId },
  });
}

/** Start a restore of a node's databases from one snapshot. */
export async function startNodeDatabaseRestore(
  nodeId: string,
  request: {
    repo: AgentRepoTarget;
    snapshotId: string;
    databases: string[];
    admin: AgentDbAdmin;
  },
): Promise<{ jobId: string }> {
  return nodeRequest(nodeId, "/v1/backups/databases/restore", {
    method: "POST",
    body: { ...request, nodeId },
  });
}

/**
 * Poll a job of either scope, draining only log lines newer than `afterSeq`.
 *
 * The cursor is in the query string rather than the body because it is not secret
 * and it makes the call idempotent in the obvious way. The same cursor always
 * returns the same window.
 */
export async function readNodeBackupJob(
  nodeId: string,
  jobId: string,
  afterSeq: number,
): Promise<AgentJobSnapshot> {
  return nodeRequest(nodeId, `/v1/backups/jobs/${jobId}`, { query: { afterSeq } });
}

export interface AgentSnapshot {
  id: string;
  time: string;
  tags: string[];
}

/** The scope + id pair the metadata routes address a repository by. */
export interface AgentSubject {
  scope: "server" | "node";
  id: string;
}

/** List the snapshots actually present in a repository. */
export async function listNodeSnapshots(
  nodeId: string,
  subject: AgentSubject,
  repo: AgentRepoTarget,
): Promise<AgentSnapshot[]> {
  const result = await nodeRequest<{ snapshots: AgentSnapshot[] }>(
    nodeId,
    "/v1/backups/snapshots",
    { method: "POST", body: { ...subject, repo }, timeoutMs: 5 * 60_000 },
  );
  return result.snapshots;
}

/**
 * Delete one snapshot and reclaim its data.
 *
 * Generous timeout: `forget --prune` rewrites the pack files the snapshot uniquely
 * referenced, which is an S3 round trip per pack.
 */
export async function forgetNodeSnapshot(
  nodeId: string,
  subject: AgentSubject,
  repo: AgentRepoTarget,
  snapshotId: string,
): Promise<void> {
  await nodeRequest(nodeId, "/v1/backups/forget", {
    method: "POST",
    body: { ...subject, repo, snapshotId },
    timeoutMs: 30 * 60_000,
  });
}

/** Measure a repository on demand. `null` means unmeasurable, not empty. */
export async function readNodeRepositorySize(
  nodeId: string,
  subject: AgentSubject,
  repo: AgentRepoTarget,
): Promise<number | null> {
  const result = await nodeRequest<{ sizeBytes: number | null }>(
    nodeId,
    "/v1/backups/size",
    { method: "POST", body: { ...subject, repo }, timeoutMs: 5 * 60_000 },
  );
  return result.sizeBytes;
}

/** Verify the S3 destination from a node, for the admin settings page. */
export async function checkNodeBackupRepository(
  nodeId: string,
  subject: AgentSubject,
  repo: AgentRepoTarget,
): Promise<{ reachable: boolean; initialised: boolean; detail: string }> {
  return nodeRequest(nodeId, "/v1/backups/check", {
    method: "POST",
    body: { ...subject, repo },
    timeoutMs: 2 * 60_000,
  });
}
