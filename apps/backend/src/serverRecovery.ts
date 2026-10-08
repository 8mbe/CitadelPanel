/**
 * A node's durable inventory, separate from the directories tenants can edit.
 * This is recovery metadata, not a second control plane: the panel still owns
 * identity, permissions, scheduling and every decision to start a server.
 */
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type Docker from "dockerode";
import { config } from "./config";
import { badRequest, requireServerId, serviceUnavailable } from "./http";
import {
  serverContainerName,
  serverNetworkName,
  type PortBinding,
} from "./docker/hardening";
import type { CreateContainerRequest } from "./servers";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export interface ServerRecoveryMetadata {
  name: string;
  ownerId: string;
  ownerEmail: string;
  blueprint: Record<string, unknown>;
  diskLimitMb: number;
  ports: {
    hostPort: number;
    isPrimary: boolean;
    isAdditional: boolean;
    label?: string | null;
  }[];
  secretEnvKeys: string[];
  additionalPortLimit?: number | null;
  databaseLimit?: number | null;
  backupLimit?: number | null;
  status?: string;
  suspensionReason?: string | null;
}

export interface ServerManifest {
  version: 1;
  serverId: string;
  spec: CreateContainerRequest;
  recovery?: ServerRecoveryMetadata;
  updatedAt: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The agent stores the blueprint as data; only the panel can register it. */
export function parseRecoveryMetadata(value: unknown): ServerRecoveryMetadata {
  if (!object(value)) throw badRequest('"recovery" must be an object.');
  for (const key of ["name", "ownerId", "ownerEmail"] as const) {
    if (
      typeof value[key] !== "string" ||
      !value[key] ||
      value[key].length > 320
    ) {
      throw badRequest(`recovery.${key} must be a non-empty string.`);
    }
  }
  if (!object(value.blueprint))
    throw badRequest("recovery.blueprint must be an object.");
  if (
    typeof value.diskLimitMb !== "number" ||
    !Number.isFinite(value.diskLimitMb) ||
    value.diskLimitMb <= 0
  ) {
    throw badRequest("recovery.diskLimitMb must be a positive number.");
  }
  if (!Array.isArray(value.ports) || !Array.isArray(value.secretEnvKeys)) {
    throw badRequest(
      "recovery.ports and recovery.secretEnvKeys must be arrays.",
    );
  }
  const ports = value.ports.map((entry) => {
    if (
      !object(entry) ||
      !Number.isInteger(entry.hostPort) ||
      Number(entry.hostPort) < 1024 ||
      Number(entry.hostPort) > 65535 ||
      typeof entry.isPrimary !== "boolean" ||
      typeof entry.isAdditional !== "boolean"
    ) {
      throw badRequest(
        "Each recovery port needs hostPort, isPrimary and isAdditional.",
      );
    }
    if (
      entry.label !== undefined &&
      entry.label !== null &&
      typeof entry.label !== "string"
    ) {
      throw badRequest("Recovery port labels must be strings or null.");
    }
    return {
      hostPort: Number(entry.hostPort),
      isPrimary: entry.isPrimary,
      isAdditional: entry.isAdditional,
      ...(entry.label !== undefined
        ? { label: entry.label as string | null }
        : {}),
    };
  });
  const secretEnvKeys = value.secretEnvKeys.map((key) => {
    if (typeof key !== "string" || key.length === 0)
      throw badRequest("recovery.secretEnvKeys must contain strings.");
    return key;
  });
  const limits: Partial<ServerRecoveryMetadata> = {};
  for (const key of [
    "additionalPortLimit",
    "databaseLimit",
    "backupLimit",
  ] as const) {
    const limit = value[key];
    if (limit !== undefined) {
      if (
        limit !== null &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0)
      ) {
        throw badRequest(
          `recovery.${key} must be a non-negative integer or null.`,
        );
      }
      limits[key] = limit as number | null;
    }
  }
  if (value.status !== undefined && typeof value.status !== "string")
    throw badRequest("recovery.status must be a string.");
  if (
    value.suspensionReason !== undefined &&
    value.suspensionReason !== null &&
    typeof value.suspensionReason !== "string"
  )
    throw badRequest("recovery.suspensionReason must be a string or null.");
  return {
    name: value.name as string,
    ownerId: value.ownerId as string,
    ownerEmail: value.ownerEmail as string,
    blueprint: value.blueprint,
    diskLimitMb: value.diskLimitMb,
    ports,
    secretEnvKeys,
    ...limits,
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(value.suspensionReason !== undefined
      ? { suspensionReason: value.suspensionReason as string | null }
      : {}),
  };
}

/** Parse runtime specs on the wire and on disk using the same rules. */
export function parseServerContainerRequest(
  body: Record<string, unknown>,
): CreateContainerRequest {
  if (typeof body.image !== "string" || !body.image)
    throw badRequest('"image" is required.');
  if (
    typeof body.containerDataPath !== "string" ||
    !body.containerDataPath.startsWith("/") ||
    body.containerDataPath.includes("\0")
  )
    throw badRequest('"containerDataPath" must be an absolute path.');
  const cpuLimit = Number(body.cpuLimit);
  const memoryLimitMb = Number(body.memoryLimitMb);
  if (!Number.isFinite(cpuLimit) || cpuLimit <= 0)
    throw badRequest('"cpuLimit" must be a positive number.');
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb <= 0)
    throw badRequest('"memoryLimitMb" must be a positive number.');
  if (body.env !== undefined && !object(body.env))
    throw badRequest('"env" must be an object.');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.env ?? {})) {
    if (typeof value !== "string")
      throw badRequest(`env value for "${key}" must be a string.`);
    Object.defineProperty(env, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (!Array.isArray(body.ports)) throw badRequest('"ports" must be an array.');
  const ports: PortBinding[] = body.ports.map((entry): PortBinding => {
    if (!object(entry)) throw badRequest("Each port must be an object.");
    const hostPort = Number(entry.hostPort);
    const containerPort = Number(entry.containerPort);
    if (
      !Number.isInteger(hostPort) ||
      hostPort < 1024 ||
      hostPort > 65535 ||
      containerPort !== hostPort
    )
      throw badRequest(
        "Ports must use identical host/container numbers in the range 1024-65535.",
      );
    if (entry.protocol !== "tcp" && entry.protocol !== "udp")
      throw badRequest('Port protocol must be "tcp" or "udp".');
    return { hostPort, containerPort, protocol: entry.protocol };
  });
  const strings = (key: "command" | "extraNetworks") => {
    if (body[key] === undefined) return undefined;
    if (
      !Array.isArray(body[key]) ||
      !(body[key] as unknown[]).every((part) => typeof part === "string")
    )
      throw badRequest(`"${key}" must be an array of strings.`);
    return body[key] as string[];
  };
  const user =
    typeof body.user === "string" && body.user ? body.user : undefined;
  if (user !== undefined && !/^\d+(:\d+)?$/.test(user))
    throw badRequest('"user" must be a "uid" or "uid:gid" of digits only.');
  const extraNetworks = strings("extraNetworks");
  if (extraNetworks?.some((network) => !network))
    throw badRequest('"extraNetworks" must contain non-empty strings.');
  return {
    image: body.image,
    containerDataPath: body.containerDataPath,
    cpuLimit,
    memoryLimitMb,
    env,
    ports,
    command: strings("command"),
    extraNetworks,
    user,
    readOnlyRootFilesystem: body.readOnlyRootFilesystem === true,
    tty: body.tty === true,
    ...(body.recovery !== undefined
      ? { recovery: parseRecoveryMetadata(body.recovery) }
      : {}),
  };
}

/** These files are outside every server bind mount, owned by the agent. */
async function manifestDirectory(
  root: string,
  create = false,
): Promise<string | null> {
  const path = join(root, ".citadel");
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error: { code?: string }) => {
      if (error.code !== "EEXIST") throw error;
    });
  const info = await lstat(path).catch((error: { code?: string }) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw serviceUnavailable(
      "The node recovery directory must be a real directory owned by the agent.",
    );
  if (info.uid !== (process.getuid?.() ?? info.uid))
    throw serviceUnavailable(
      "The node recovery directory must be owned by the agent.",
    );
  if (create) await chmod(path, 0o700);
  else if ((info.mode & 0o077) !== 0)
    throw serviceUnavailable(
      "The node recovery directory must have permissions 0700.",
    );
  return path;
}

export async function readServerManifest(
  serverId: string,
  root = config.serverDataRoot,
): Promise<ServerManifest | null> {
  requireServerId(serverId);
  const directory = await manifestDirectory(root);
  if (!directory) return null;
  let file;
  try {
    file = await open(
      join(directory, `${serverId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > MAX_MANIFEST_BYTES ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== (process.getuid?.() ?? info.uid)
    )
      throw new Error("Invalid recovery manifest file.");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (
      !object(value) ||
      value.version !== 1 ||
      value.serverId !== serverId ||
      !object(value.spec) ||
      typeof value.updatedAt !== "string"
    )
      throw new Error("Invalid recovery manifest.");
    return {
      version: 1,
      serverId,
      spec: parseServerContainerRequest(value.spec),
      updatedAt: value.updatedAt,
      ...(value.recovery !== undefined
        ? { recovery: parseRecoveryMetadata(value.recovery) }
        : {}),
    };
  } finally {
    await file.close();
  }
}

export async function writeServerManifest(
  serverId: string,
  spec: CreateContainerRequest,
  recovery: ServerRecoveryMetadata | undefined = spec.recovery,
  root = config.serverDataRoot,
): Promise<void> {
  requireServerId(serverId);
  const directory = await manifestDirectory(root, true);
  if (!directory) throw new Error("Could not create recovery directory.");
  const { recovery: _embedded, ...runtimeSpec } = spec;
  const contents = JSON.stringify({
    version: 1,
    serverId,
    spec: runtimeSpec,
    ...(recovery ? { recovery: parseRecoveryMetadata(recovery) } : {}),
    updatedAt: new Date().toISOString(),
  });
  if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES)
    throw badRequest("Server recovery metadata exceeds 2 MiB.");
  const temporary = join(directory, `${serverId}.${crypto.randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(contents);
    await file.sync();
    await file.close();
    await rename(temporary, join(directory, `${serverId}.json`));
    const parent = await open(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

export async function removeServerManifest(
  serverId: string,
  root = config.serverDataRoot,
): Promise<void> {
  requireServerId(serverId);
  const directory = await manifestDirectory(root);
  if (directory) await rm(join(directory, `${serverId}.json`), { force: true });
}

export async function listServerManifests(
  root = config.serverDataRoot,
): Promise<{ manifests: ServerManifest[]; warnings: string[] }> {
  const directory = await manifestDirectory(root);
  if (!directory) return { manifests: [], warnings: [] };
  const manifests: ServerManifest[] = [];
  const warnings: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    const serverId = entry.name.slice(0, -5);
    try {
      requireServerId(serverId);
      const manifest = await readServerManifest(serverId, root);
      if (manifest) manifests.push(manifest);
    } catch {
      warnings.push(`Recovery metadata ${entry.name} could not be read.`);
    }
  }
  return { manifests, warnings };
}

/** Symlinked per-server roots are never adopted as somebody else's server. */
export async function serverDataPresent(
  serverId: string,
  root = config.serverDataRoot,
): Promise<boolean> {
  requireServerId(serverId);
  const info = await lstat(join(root, serverId)).catch(
    (error: { code?: string }) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

/**
 * Observe remembered identities even if their container was renamed or lost
 * its managed label. Such a workload blocks rebuilding over its live files.
 * This only observes summaries; adoption still requires the strict inspector.
 */
export function rememberedContainerIdentities(
  container: Pick<Docker.ContainerInfo, "Names" | "Labels" | "Mounts">,
  rememberedIds: Iterable<string>,
  roots: string[],
): string[] {
  const ids = new Set(rememberedIds);
  const matched = new Set<string>();
  const labelled = container.Labels?.["citadel.server-id"];
  if (labelled && ids.has(labelled)) matched.add(labelled);
  for (const serverId of ids) {
    if (container.Names?.includes(`/${serverContainerName(serverId)}`))
      matched.add(serverId);
  }
  for (const mount of container.Mounts ?? []) {
    if (mount.Type !== "bind" || mount.RW === false) continue;
    const source = resolve(mount.Source);
    const serverId = basename(source);
    if (
      ids.has(serverId) &&
      roots.some((root) => dirname(source) === resolve(root))
    )
      matched.add(serverId);
  }
  return [...matched];
}

/**
 * Older containers keep only an id prefix in their name. Their bind mount has
 * the full id; it is usable only when it is an exact direct child of our root.
 * An installer, tool container or unrelated Docker workload is never adopted.
 */
export function discoverContainerSpec(
  info: Docker.ContainerInspectInfo,
  root = config.serverDataRoot,
): { serverId: string; spec: CreateContainerRequest } | null {
  if (info.Config.Labels?.["citadel.managed"] !== "true") return null;
  const kind = info.Config.Labels?.["citadel.kind"];
  if (kind !== undefined && kind !== "server") return null;
  const mounts = info.Mounts.filter(
    (mount) =>
      mount.Type === "bind" && dirname(resolve(mount.Source)) === resolve(root),
  );
  if (mounts.length !== 1) return null;
  const mount = mounts[0]!;
  if (mount.RW === false) return null;
  const serverId = basename(resolve(mount.Source));
  try {
    requireServerId(serverId);
  } catch {
    return null;
  }
  if (mount.Source !== join(resolve(root), serverId)) return null;
  if (info.Name !== `/${serverContainerName(serverId)}`) return null;
  const labelledId = info.Config.Labels?.["citadel.server-id"];
  if (labelledId !== undefined && labelledId !== serverId) return null;
  // A nonstandard bind or port model cannot safely be rebuilt by this panel.
  if (info.Mounts.some((entry) => entry.Type !== "tmpfs" && entry !== mount))
    return null;
  const env: Record<string, string> = {};
  for (const entry of info.Config.Env ?? []) {
    const equals = entry.indexOf("=");
    if (equals > 0)
      Object.defineProperty(env, entry.slice(0, equals), {
        value: entry.slice(equals + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  const ports: unknown[] = [];
  const portBindings = (info.HostConfig.PortBindings ?? {}) as Record<
    string,
    { HostPort: string; HostIp?: string }[] | null
  >;
  for (const [key, bindings] of Object.entries(portBindings)) {
    const [number, protocol] = key.split("/");
    for (const binding of bindings ?? []) {
      if (
        binding.HostIp &&
        binding.HostIp !== "0.0.0.0" &&
        binding.HostIp !== "::"
      )
        return null;
      ports.push({
        containerPort: Number(number),
        hostPort: Number(binding.HostPort),
        protocol,
      });
    }
  }
  try {
    return {
      serverId,
      spec: parseServerContainerRequest({
        image: info.Config.Image,
        containerDataPath: mount.Destination,
        env,
        ports,
        cpuLimit:
          Number(info.HostConfig.CpuQuota) / Number(info.HostConfig.CpuPeriod),
        memoryLimitMb: Number(info.HostConfig.Memory) / (1024 * 1024),
        command: info.Config.Cmd ?? undefined,
        user: info.Config.User,
        tty: info.Config.Tty,
        readOnlyRootFilesystem: info.HostConfig.ReadonlyRootfs,
        extraNetworks: Object.keys(info.NetworkSettings.Networks ?? {}).filter(
          (network) => network !== serverNetworkName(serverId),
        ),
      }),
    };
  } catch {
    return null;
  }
}

/** An existing workload must agree with the recovery record before adoption. */
export function recoverySpecMatchesContainer(
  saved: CreateContainerRequest,
  actual: CreateContainerRequest,
): boolean {
  const ports = (spec: CreateContainerRequest) =>
    spec.ports
      .map((port) => `${port.hostPort}/${port.containerPort}/${port.protocol}`)
      .sort();
  return (
    saved.image === actual.image &&
    saved.containerDataPath === actual.containerDataPath &&
    Math.abs(saved.cpuLimit - actual.cpuLimit) < 0.000011 &&
    saved.memoryLimitMb === actual.memoryLimitMb &&
    Boolean(saved.tty) === Boolean(actual.tty) &&
    Boolean(saved.readOnlyRootFilesystem) ===
      Boolean(actual.readOnlyRootFilesystem) &&
    (saved.user === undefined || saved.user === actual.user) &&
    (saved.command === undefined ||
      JSON.stringify(saved.command) === JSON.stringify(actual.command)) &&
    JSON.stringify(ports(saved)) === JSON.stringify(ports(actual)) &&
    Object.entries(saved.env).every(
      ([key, value]) => actual.env[key] === value,
    ) &&
    (saved.extraNetworks ?? []).every((network) =>
      actual.extraNetworks?.includes(network),
    )
  );
}
