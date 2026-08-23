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
import { randomBytes } from "node:crypto";

/**
 * Marks a container as one of the agent's own tooling containers.
 *
 * Deliberately *not* `citadel.managed`, which means "a tenant's game server" and
 * is what `docker/stats.ts` lists to collect per-server statistics — a restic
 * container appearing in that list would be reported as somebody's server.
 */
const TOOL_LABEL = "citadel.tool";
const TOOL_LABEL_VALUE = "backup";

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

  let timedOut = false;

  try {
    // Inside the `try`, so a network that does not exist (or a `connect` that
    // races a removal) still reaches the `finally`. Attaching outside it left a
    // created-but-never-started container behind on every such failure.
    for (const networkName of spec.extraNetworks ?? []) {
      await docker.getNetwork(networkName).connect({ Container: container.id });
    }

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
    // A removal that fails is logged rather than swallowed: the container is now
    // a leak holding a repository lock, and silence made that state impossible
    // to explain. `removeOrphanedToolContainers` sweeps it at the next boot.
    await removeContainer(docker, container.id).catch((error: unknown) => {
      console.error(
        `[agent] could not remove backup tool container ${container.id.slice(0, 12)}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }
}

/**
 * Remove tool containers left over from a previous run of this process.
 *
 * The `finally` above cannot run if the agent is killed mid-backup, and what it
 * leaves behind is a restic holding a repository lock — which makes every later
 * backup of that subject fail with a stale-lock error until somebody finds and
 * deletes an anonymous container by hand. So they carry a label, and the agent
 * sweeps them at boot.
 *
 * Safe to run only at boot, which is the one moment when no run of ours is in
 * flight: anything wearing this label is by definition from a dead process.
 */
export async function removeOrphanedToolContainers(): Promise<void> {
  try {
    const orphans = await docker.listContainers({
      all: true,
      filters: { label: [`${TOOL_LABEL}=${TOOL_LABEL_VALUE}`] },
    });
    if (orphans.length === 0) return;

    console.warn(
      `[agent] removing ${orphans.length} backup tool container` +
        `${orphans.length === 1 ? "" : "s"} left behind by a previous run.`,
    );
    for (const orphan of orphans) {
      await removeContainer(docker, orphan.Id).catch((error: unknown) => {
        console.error(
          `[agent] could not remove orphaned container ${orphan.Id.slice(0, 12)}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
  } catch (error) {
    // Docker unreachable at boot is reported by the routes that need it; this
    // is housekeeping and must not stop the agent from starting.
    console.error(
      "[agent] could not sweep orphaned backup containers:",
      error instanceof Error ? error.message : error,
    );
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
 * The capabilities a backup tool needs, on top of a dropped-everything base.
 *
 * These containers run as root (the images do), and dropping *all* capabilities
 * takes `CAP_DAC_OVERRIDE` with it — which is what lets root ignore file
 * permissions. Without it root is weaker than an ordinary user for file access:
 * it can only touch paths whose mode grants access to `other`. Every host
 * directory these containers are given is owned by the agent's own user, so the
 * result was that restic could not create its cache (`open /cache/CACHEDIR.TAG:
 * permission denied`) and `mariadb-dump` could not write into the staging
 * directory. Both scopes failed before any backup began.
 *
 * Reading every file regardless of who owns it *is* what a backup is, so this is
 * the one place where a DAC bypass is the point rather than a weakening:
 *
 *   - `DAC_OVERRIDE` — read a world whose files belong to the game's uid, and
 *     write the cache, the dumps, and a restore's output.
 *   - `CHOWN` / `FOWNER` — put ownership and modes back as they were on restore,
 *     rather than leaving a restored world owned by root.
 *
 * Everything actually dangerous stays dropped (`SYS_ADMIN`, `NET_RAW`,
 * `SETUID`, `MKNOD`, …), the container gets no tenant network, and it sees only
 * the mounts its scope needs — so the blast radius is the paths it was handed.
 */
const TOOL_CAPABILITIES = ["DAC_OVERRIDE", "CHOWN", "FOWNER"];

/**
 * Build the dockerode creation options for a tool container.
 *
 * The hardening that does apply is kept: no new privileges, every capability
 * except `TOOL_CAPABILITIES` dropped, no port publishing, and a memory ceiling
 * so a restic indexing a huge repository cannot OOM the node. `AutoRemove` is
 * deliberately off — the exit code and the log tail must still be readable after
 * the process exits, and Docker removes an auto-remove container before either
 * can be fetched.
 *
 * The name and label exist so a container that outlives the agent is
 * recognisable as ours: an anonymous `restic` holding a repository lock is
 * indistinguishable from something an operator started themselves.
 */
export function buildToolConfig(spec: ToolRunSpec): Docker.ContainerCreateOptions {
  return {
    name: `citadel-backup-${randomBytes(4).toString("hex")}`,
    Image: spec.image,
    Cmd: spec.command,
    ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
    Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
    Labels: { [TOOL_LABEL]: TOOL_LABEL_VALUE },
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
      CapAdd: TOOL_CAPABILITIES,
      SecurityOpt: ["no-new-privileges"],
      // The same alternative-runtime knob as tenant containers (CONTAINER_RUNTIME):
      // these are trusted images, but they parse untrusted tenant data — a
      // node that pays for gVisor on games should get it here too.
      ...(config.containerRuntime ? { Runtime: config.containerRuntime } : {}),
      // restic's index and cache for a multi-terabyte repository is the memory
      // consumer here; 2 GB is far above what a game-server-sized repository
      // needs and far below what would destabilise a node.
      Memory: 2048 * 1024 * 1024,
      RestartPolicy: { Name: "no" },
    },
  };
}
