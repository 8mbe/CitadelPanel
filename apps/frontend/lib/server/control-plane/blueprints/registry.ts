/**
 * Blueprint registry.
 *
 * Two roles:
 *  1. Holds the built-in blueprints defined in code, and syncs them into the
 *     `blueprints` table on boot (`syncBlueprintsToDatabase`).
 *  2. Reads blueprints back OUT of the database (`getBlueprintByKey` etc.).
 *
 * The database is the source of truth at run time: the create flow, the abuse
 * watcher and the admin routes all read from it, so an admin-created blueprint
 * (is_builtin = false) behaves exactly like a shipped one. Code only seeds the
 * built-ins; it is not consulted when resolving a blueprint for a server.
 */

import { sql } from "../db/client";
import { minecraftBedrock } from "./definitions/minecraft-bedrock";
import { minecraftJava } from "./definitions/minecraft-java";
import { velocity } from "./definitions/velocity";
import type {
  Blueprint,
  BlueprintEnvField,
  BlueprintInstall,
  BlueprintPort,
  ResourceProfile,
} from "./types";
import type { BlueprintPluginSupport } from "./plugins";

/** Every blueprint the panel ships. Add new built-in games here. */
export const BUILT_IN_BLUEPRINTS: readonly Blueprint[] = [
  minecraftJava,
  minecraftBedrock,
  velocity,
];

/** The row shape of the `blueprints` table. */
interface BlueprintRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  docker_image: string;
  default_ports: BlueprintPort[];
  env_schema: Record<string, BlueprintEnvField>;
  primary_port_env: string | null;
  startup_command: string | null;
  stop_command: string | null;
  install_image: string | null;
  install_script: string | null;
  install_entrypoint: string[] | null;
  data_path: string;
  min_cpu: string | number;
  min_memory_mb: number;
  min_disk_mb: number;
  supports_readonly_root: boolean;
  expected_resource_profile: ResourceProfile;
  run_as: string | null;
  tty: boolean;
  plugins: BlueprintPluginSupport | null;
}

/** Reconstruct a full {@link Blueprint} from a database row. */
function rowToBlueprint(row: BlueprintRow): Blueprint {
  const install: BlueprintInstall | undefined =
    row.install_image && row.install_script
      ? {
          image: row.install_image,
          script: row.install_script,
          ...(row.install_entrypoint
            ? { entrypoint: row.install_entrypoint }
            : {}),
        }
      : undefined;

  return {
    key: row.key,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    dockerImage: row.docker_image,
    defaultPorts: row.default_ports,
    envSchema: row.env_schema,
    ...(row.primary_port_env ? { primaryPortEnv: row.primary_port_env } : {}),
    ...(row.startup_command ? { startupCommand: row.startup_command } : {}),
    ...(row.stop_command ? { stopCommand: row.stop_command } : {}),
    ...(install ? { install } : {}),
    expectedResourceProfile: row.expected_resource_profile,
    dataPath: row.data_path,
    minimums: {
      cpuLimit: Number(row.min_cpu),
      memoryLimitMb: row.min_memory_mb,
      diskLimitMb: row.min_disk_mb,
    },
    supportsReadOnlyRoot: row.supports_readonly_root,
    ...(row.run_as ? { user: row.run_as } : {}),
    ...(row.tty ? { tty: true } : {}),
    ...(row.plugins ? { plugins: row.plugins } : {}),
  };
}

const BLUEPRINT_COLUMNS = sql`
  id, key, name, description, docker_image, default_ports, env_schema,
  primary_port_env,
  startup_command, stop_command, install_image, install_script,
  install_entrypoint, data_path, min_cpu, min_memory_mb, min_disk_mb,
  supports_readonly_root, expected_resource_profile, run_as, tty, plugins
`;

/**
 * Upsert every code-defined built-in blueprint into the database.
 *
 * Idempotent, and safe to run on every boot: `key` is unique, so an existing
 * row is updated in place and any `servers.blueprint_id` referencing it stays
 * valid. Only built-in rows are written here. Admin-created blueprints
 * (is_builtin = false) are never touched. Built-ins removed from code are
 * deliberately NOT deleted, because existing servers may still reference them.
 */
export async function syncBlueprintsToDatabase(): Promise<void> {
  for (const bp of BUILT_IN_BLUEPRINTS) {
    await sql`
      INSERT INTO blueprints (
        key, name, description, docker_image, default_ports, env_schema,
        primary_port_env,
        startup_command, stop_command, install_image, install_script,
        install_entrypoint, data_path, min_cpu, min_memory_mb, min_disk_mb,
        supports_readonly_root, expected_resource_profile, run_as, tty,
        plugins, is_builtin, updated_at
      ) VALUES (
        ${bp.key},
        ${bp.name},
        ${bp.description ?? null},
        ${bp.dockerImage},
        ${sql.json(bp.defaultPorts as never)},
        ${sql.json(bp.envSchema as never)},
        ${bp.primaryPortEnv ?? null},
        ${bp.startupCommand ?? null},
        ${bp.stopCommand ?? null},
        ${bp.install?.image ?? null},
        ${bp.install?.script ?? null},
        ${bp.install?.entrypoint ? sql.json(bp.install.entrypoint as never) : null},
        ${bp.dataPath},
        ${bp.minimums.cpuLimit},
        ${bp.minimums.memoryLimitMb},
        ${bp.minimums.diskLimitMb},
        ${bp.supportsReadOnlyRoot === true},
        ${bp.expectedResourceProfile},
        ${bp.user ?? null},
        ${bp.tty === true},
        ${bp.plugins ? sql.json(bp.plugins as never) : null},
        TRUE,
        now()
      )
      ON CONFLICT (key) DO UPDATE SET
        name                   = EXCLUDED.name,
        description            = EXCLUDED.description,
        docker_image           = EXCLUDED.docker_image,
        default_ports          = EXCLUDED.default_ports,
        env_schema             = EXCLUDED.env_schema,
        primary_port_env       = EXCLUDED.primary_port_env,
        startup_command        = EXCLUDED.startup_command,
        stop_command           = EXCLUDED.stop_command,
        install_image          = EXCLUDED.install_image,
        install_script         = EXCLUDED.install_script,
        install_entrypoint     = EXCLUDED.install_entrypoint,
        data_path              = EXCLUDED.data_path,
        min_cpu                = EXCLUDED.min_cpu,
        min_memory_mb          = EXCLUDED.min_memory_mb,
        min_disk_mb            = EXCLUDED.min_disk_mb,
        supports_readonly_root = EXCLUDED.supports_readonly_root,
        expected_resource_profile = EXCLUDED.expected_resource_profile,
        run_as                 = EXCLUDED.run_as,
        tty                    = EXCLUDED.tty,
        plugins                = EXCLUDED.plugins,
        is_builtin             = TRUE,
        updated_at             = now()
    `;
  }

  invalidateBlueprintCache();

  console.log(
    `[blueprints] synced ${BUILT_IN_BLUEPRINTS.length} built-in blueprint(s) to database`,
  );
}

/**
 * The whole blueprint table, held in memory.
 *
 * Blueprints are read constantly, to resolve a server's image, its plugin
 * support, its minimums, and the key shown next to its name. They are written
 * only when an admin edits one or the built-ins are seeded at boot. Each of
 * those reads was its own SELECT, so a single server page load could spend
 * several database round trips re-fetching rows that had not changed since the
 * process started.
 *
 * The whole table is loaded at once rather than a row per key: there are a
 * handful of blueprints, one query answers every lookup shape below, and it
 * makes `getBlueprintById` (the hot one) a map read.
 *
 * Correctness comes from {@link invalidateBlueprintCache}, which every write
 * path calls; the TTL only bounds how long a *second* panel process can serve a
 * blueprint another one edited.
 */
interface BlueprintCache {
  /** Ordered by name, as the list endpoint expects. */
  all: Blueprint[];
  byId: Map<string, Blueprint>;
  byKey: Map<string, Blueprint>;
  idByKey: Map<string, string>;
  keyById: Map<string, string>;
  at: number;
}

const BLUEPRINT_CACHE_TTL_MS = 30_000;

let blueprintCache: BlueprintCache | null = null;
/** Set while a load is in flight, so concurrent readers share one query. */
let blueprintCacheLoad: Promise<BlueprintCache> | null = null;

/** Drop the cached blueprints. Every write to the table must call this. */
export function invalidateBlueprintCache(): void {
  blueprintCache = null;
  blueprintCacheLoad = null;
}

async function fetchBlueprintCache(): Promise<BlueprintCache> {
  const rows = (await sql`
    SELECT ${BLUEPRINT_COLUMNS} FROM blueprints ORDER BY name ASC
  `) as BlueprintRow[];

  const cache: BlueprintCache = {
    all: [],
    byId: new Map(),
    byKey: new Map(),
    idByKey: new Map(),
    keyById: new Map(),
    at: Date.now(),
  };

  for (const row of rows) {
    const blueprint = rowToBlueprint(row);
    cache.all.push(blueprint);
    cache.byId.set(row.id, blueprint);
    cache.byKey.set(row.key, blueprint);
    cache.idByKey.set(row.key, row.id);
    cache.keyById.set(row.id, row.key);
  }
  return cache;
}

async function loadBlueprints(): Promise<BlueprintCache> {
  const cached = blueprintCache;
  if (cached && Date.now() - cached.at < BLUEPRINT_CACHE_TTL_MS) return cached;

  blueprintCacheLoad ??= fetchBlueprintCache()
    .then((cache) => {
      blueprintCache = cache;
      return cache;
    })
    .finally(() => {
      blueprintCacheLoad = null;
    });

  return blueprintCacheLoad;
}

/** Every blueprint in the database, built-in and custom, by name. */
export async function listBlueprints(): Promise<Blueprint[]> {
  // A copy: the cached array outlives the request, and callers sort and filter.
  return [...(await loadBlueprints()).all];
}

/** Resolve a full blueprint by its stable key, or null when unknown. */
export async function getBlueprintByKey(key: string): Promise<Blueprint | null> {
  return (await loadBlueprints()).byKey.get(key) ?? null;
}

/** Resolve a full blueprint by database id, or null when unknown. */
export async function getBlueprintById(id: string): Promise<Blueprint | null> {
  return (await loadBlueprints()).byId.get(id) ?? null;
}

/** Look up the database id for a blueprint key. */
export async function getBlueprintIdByKey(key: string): Promise<string | null> {
  return (await loadBlueprints()).idByKey.get(key) ?? null;
}

/** Look up the blueprint key for a database id, for reverse resolution. */
export async function getBlueprintKeyById(id: string): Promise<string | null> {
  return (await loadBlueprints()).keyById.get(id) ?? null;
}

/**
 * The expected resource profile for a blueprint id, defaulting to "bursty".
 *
 * The abuse watcher wants this one field per server on every sweep, which used
 * to justify its own narrow SELECT; now that every blueprint is already in
 * memory, reading the whole record costs nothing.
 */
export async function getResourceProfileById(
  id: string,
): Promise<ResourceProfile> {
  return (await getBlueprintById(id))?.expectedResourceProfile ?? "bursty";
}
