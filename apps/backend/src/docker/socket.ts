/**
 * Reachability of the local Docker socket.
 *
 * Everything this agent does — power actions, stats sampling, backups, the
 * orphan sweep at boot — is a call on `config.dockerSocket`. When the agent
 * cannot open that socket it stays up and answers requests, but every one of
 * those operations fails, and the original symptom was a dockerode stack trace
 * per sampled server:
 *
 *     [agent] failed to sample server <id>: connect EACCES /var/run/docker.sock
 *
 * which says what failed and nothing about the fix. The fix is almost always
 * one of two things, and they are distinguishable from the socket's own inode
 * plus the process's credentials — so the agent works it out and prints it.
 *
 * The check has the same shape as `dataRoot.ts`, for the same reasons:
 *   - probed at boot and logged with the exact command that fixes it;
 *   - reported by `/v1/health`, so a node whose Docker is unusable reads as
 *     "degraded, here's why" instead of "Internal agent error";
 *   - re-probed per call rather than cached, so starting the daemon (or fixing
 *     the permissions) takes effect without restarting the agent.
 *
 * The probe pings the daemon rather than calling `access` on the socket: the
 * permission bits are only one way a socket can be unusable (a stopped daemon
 * leaves a perfectly readable path behind, and LSM policy is invisible to
 * `access`), and the ping is the operation that actually matters.
 */

import { readFile, stat } from "node:fs/promises";
import { config } from "../config";
import { docker } from "./client";

/** Whether this node's Docker daemon is usable right now. */
export interface DockerSocketStatus {
  path: string;
  reachable: boolean;
  /** Operator-facing cause plus remediation. Only set when unreachable. */
  error?: string;
}

/**
 * The credentials and socket ownership that decide which fix applies.
 *
 * Passed in rather than read inside {@link explainDockerSocketError} so the
 * explanation is a pure function of facts a test can state.
 */
export interface SocketContext {
  uid: number;
  /** The process's supplementary groups, as the kernel sees them *now*. */
  groups: number[];
  /** Group that owns the socket. Absent when the socket could not be stat'd. */
  socketGid?: number;
  /** That group's name, when it resolves. `docker` on most hosts. */
  socketGroupName?: string;
}

const currentUid = (): number => process.getuid?.() ?? 0;

/** Resolve a gid to its name via `/etc/group`, or undefined if it does not resolve. */
async function groupName(gid: number): Promise<string | undefined> {
  try {
    const contents = await readFile("/etc/group", "utf8");
    for (const line of contents.split("\n")) {
      const [name, , id] = line.split(":");
      if (name && id && Number.parseInt(id, 10) === gid) return name;
    }
  } catch {
    // No /etc/group (or unreadable): fall back to the numeric gid in messages.
  }
  return undefined;
}

/** Gather the facts about this process and the socket file. */
export async function readSocketContext(path: string): Promise<SocketContext> {
  const context: SocketContext = {
    uid: currentUid(),
    groups: process.getgroups?.() ?? [],
  };

  try {
    const info = await stat(path);
    context.socketGid = info.gid;
    context.socketGroupName = await groupName(info.gid);
  } catch {
    // Missing socket is itself a diagnosis; ENOENT handling covers it.
  }

  return context;
}

/**
 * Turn a Docker connection error into something an admin can act on.
 *
 * The distinctions matter because the fixes differ: a permission problem is a
 * group membership (and, more often than not, a *login session* — see below), a
 * missing socket is a daemon that was never installed or a wrong
 * `DOCKER_SOCKET`, and a refused connection is a daemon that is not running.
 */
export function explainDockerSocketError(
  error: unknown,
  path: string,
  context: SocketContext,
): string {
  const err = error as { code?: string; message?: string };
  const { uid, groups, socketGid, socketGroupName } = context;
  const group = socketGroupName ?? (socketGid === undefined ? "docker" : String(socketGid));

  switch (err.code) {
    case "EACCES":
    case "EPERM": {
      // The common case, and the one that looks like a bug: the user *is* in
      // the docker group, `id` on a new shell proves it, and the agent still
      // gets EACCES. Supplementary groups are fixed when a process starts, so
      // an agent launched before `usermod -aG` never sees the new group — no
      // amount of re-running usermod helps, only a new login session does.
      const missingGroup = socketGid !== undefined && !groups.includes(socketGid);
      const detail = missingGroup
        ? `the socket is owned by group ${group} (gid ${socketGid}) and this ` +
          `process's groups (${groups.join(", ") || "none"}) do not include it`
        : "the socket rejected this process even though its group matches — " +
          "AppArmor/SELinux policy or a sandbox is the usual cause";

      return (
        `The node agent (uid ${uid}) may not use ${path}: ${detail}. ` +
        `Add the agent's user to the group and start a NEW login session ` +
        `(a running process keeps the groups it started with, so restarting the ` +
        `agent from an old shell changes nothing): ` +
        `sudo usermod -aG ${group} $(id -un) && newgrp ${group}. ` +
        `To grant it without a re-login: sudo setfacl -m u:$(id -un):rw ${path} ` +
        `(resets when the daemon restarts).`
      );
    }
    case "ENOENT":
      return (
        `${path} does not exist. Docker is not installed on this node, or its ` +
        `socket is elsewhere — set DOCKER_SOCKET to the right path. ` +
        `Check with: sudo systemctl status docker`
      );
    case "ECONNREFUSED":
      return (
        `${path} exists but nothing is listening: the Docker daemon is not ` +
        `running. Start it with: sudo systemctl start docker`
      );
    default:
      return `${path} could not be reached: ${err.message ?? String(error)}`;
  }
}

/**
 * Check that the agent can talk to its Docker daemon.
 *
 * Never throws: an unusable daemon is a state the panel needs to display, not
 * an exception to propagate out of a health check.
 */
export async function probeDockerSocket(): Promise<DockerSocketStatus> {
  const path = config.dockerSocket;

  try {
    await docker.ping();
    return { path, reachable: true };
  } catch (error) {
    return {
      path,
      reachable: false,
      error: explainDockerSocketError(error, path, await readSocketContext(path)),
    };
  }
}

/**
 * Log the Docker socket's state at boot.
 *
 * Deliberately does not exit on failure — the same call as `dataRoot.ts` makes.
 * A process that refuses to start reads to the panel as "node unreachable",
 * which sends an operator after a networking problem when the actual fault is a
 * group membership on this host. Staying up means `/v1/health` can say so.
 */
export async function reportDockerSocketAtBoot(): Promise<void> {
  const status = await probeDockerSocket();

  if (status.reachable) {
    console.log(`[agent] docker socket: ${status.path} (reachable)`);
    return;
  }

  console.error(`[agent] docker socket: ${status.path} (UNREACHABLE)`);
  console.error(`[agent] ${status.error}`);
  console.error(
    "[agent] every container operation on this node will fail until it is fixed.",
  );
}
