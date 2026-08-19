/**
 * Running the agent's own tooling containers (restic, `mariadb-dump`).
 *
 * These are not tenant containers, so they do not go through
 * `docker/hardening.ts`: that module builds a spec for a *game* — one bind
 * mount, published ports, a per-server isolated network — and every one of its
 * invariants is wrong here. A backup container needs several mounts, no ports,
 * and outbound HTTPS to S3.
 *
 * What replaces the hardening layer is a narrower guarantee: these containers
 * live on their own bridge network (`config.backupNetwork`), never a tenant's
 * and never the default bridge. They hold the operator's S3 credentials and a
 * server's database password in their environment, so nothing a tenant controls
 * may share a network with them.
 *
 * Progress is read by polling the log tail rather than by following the log
 * stream. Following would mean a second streaming log implementation alongside
 * `demuxDockerLogStream`, and the thing being watched only emits a line every
 * few seconds — so a poll of the proven one-shot reader is both simpler and
 * sufficient. See `restic.PROGRESS_FPS` for the other half of that trade.
 */

import type Docker from "dockerode";
import { docker } from "../docker/client";
import {
  ensureImage,
  ensureNetwork,
  getContainerLogs,
  removeContainer,
} from "../docker/container";
import { config } from "../config";

/** A host directory to bind into the tool container. */
export interface ToolMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface ToolRunSpec {
  image: string;
  /** Command vector. Overrides the image's CMD, not its ENTRYPOINT. */
  command: string[];
  /** Replace the image's ENTRYPOINT, e.g. to run a shell pipeline. */
  entrypoint?: string[];
  env: Record<string, string>;
  mounts: ToolMount[];
  /**
   * Extra networks to attach after creation — `node_db_net` for a dump
   * container, which must resolve the MariaDB container by name.
   */
  extraNetworks?: string[];
  /** Hard ceiling on wall-clock time. The container is killed when it expires. */
  timeoutMs: number;
  /**
   * Called with the container's full log tail every poll interval, while it
   * runs. Lets the caller publish progress without waiting for the exit.
   */
  onProgress?: (logTail: string) => void;
}

export interface ToolRunResult {
  exitCode: number;
  /** Combined stdout/stderr tail, headers stripped. */
  output: string;
  /** True when the run was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
}

/** How often the log tail is re-read while the container runs. */
const POLL_INTERVAL_MS = 1_500;

/**
 * How many log lines to read per poll.
 *
 * Generous enough to hold the whole progress history of a long backup at
 * `RESTIC_PROGRESS_FPS`, so a caller parsing the tail always sees the final
 * summary line even if it lands between the last poll and the exit.
 */
const LOG_TAIL_LINES = 400;

/**
 * Run a tool container to completion, polling its logs for progress.
 *
 * Always removes the container, including on timeout — a leaked restic holding
 * a repository lock would block every later backup for that server.
 */
export async function runToolContainer(spec: ToolRunSpec): Promise<ToolRunResult> {
  await ensureNetwork(docker, config.backupNetwork);
  await ensureImage(docker, spec.image);

  const container = await docker.createContainer(buildToolConfig(spec));

  for (const networkName of spec.extraNetworks ?? []) {
    await docker.getNetwork(networkName).connect({ Container: container.id });
  }

  let timedOut = false;

  try {
    await container.start();

    // `wait()` resolves on exit; the poll loop runs alongside it and stops as
    // soon as either the container exits or the timeout fires.
    const exit = container.wait() as Promise<{ StatusCode?: number }>;
    const outcome = await Promise.race([
      exit.then((result) => ({ kind: "exited" as const, result })),
      pollUntilSettled(container, exit, spec, () => {
        timedOut = true;
      }).then(() => ({ kind: "timeout" as const, result: undefined })),
    ]);

    if (outcome.kind === "timeout") {
      await container.kill().catch(() => undefined);
      return {
        exitCode: -1,
        output: await readLogs(container),
        timedOut: true,
      };
    }

    return {
      exitCode: outcome.result.StatusCode ?? 0,
      output: await readLogs(container),
      timedOut,
    };
  } finally {
    await removeContainer(docker, container.id).catch(() => undefined);
  }
}

/**
 * Poll the log tail until the container exits or the deadline passes.
 *
 * Resolves *only* on timeout: on a normal exit it never resolves, which is what
 * lets the `Promise.race` above be decided by the `wait()` side. A read failure
 * is swallowed — the container disappearing mid-poll is the exit path, not an
 * error to propagate.
 */
async function pollUntilSettled(
  container: Docker.Container,
  exit: Promise<unknown>,
  spec: ToolRunSpec,
  onTimeout: () => void,
): Promise<void> {
  const deadline = Date.now() + spec.timeoutMs;
  let finished = false;
  void exit.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );

  while (!finished) {
    if (Date.now() >= deadline) {
      onTimeout();
      return;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
    if (finished) return;

    if (spec.onProgress) {
      try {
        spec.onProgress(await readLogs(container));
      } catch {
        // The container exited between the check and the read.
      }
    }
  }

  // Exited normally: never resolve, so the race is decided by `wait()`.
  await new Promise<never>(() => undefined);
}

async function readLogs(container: Docker.Container): Promise<string> {
  return getContainerLogs(docker, container.id, LOG_TAIL_LINES).catch(() => "");
}

/**
 * Build the dockerode creation options for a tool container.
 *
 * The hardening that does apply is kept: no new privileges, all capabilities
 * dropped, no port publishing, and a memory ceiling so a restic indexing a huge
 * repository cannot OOM the node. `AutoRemove` is deliberately off — the exit
 * code and the log tail must still be readable after the process exits, and
 * Docker removes an auto-remove container before either can be fetched.
 */
function buildToolConfig(spec: ToolRunSpec): Docker.ContainerCreateOptions {
  return {
    Image: spec.image,
    Cmd: spec.command,
    ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
    Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
    Tty: false,
    AttachStdout: false,
    AttachStderr: false,
    HostConfig: {
      Binds: spec.mounts.map(
        (mount) => `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`,
      ),
      NetworkMode: config.backupNetwork,
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // restic's index and cache for a multi-terabyte repository is the memory
      // consumer here; 2 GB is far above what a game-server-sized repository
      // needs and far below what would destabilise a node.
      Memory: 2048 * 1024 * 1024,
      RestartPolicy: { Name: "no" },
    },
  };
}
