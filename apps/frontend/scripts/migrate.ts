import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { loadRepositoryEnv } from "../lib/server/control-plane/config/load-repository-env";
// Import the definition objects directly, NOT the registry: the registry pulls
// in the db client (a connect-on-import side effect) before env is loaded here.
import { minecraftBedrock } from "../lib/server/control-plane/blueprints/definitions/minecraft-bedrock";
import { minecraftJava } from "../lib/server/control-plane/blueprints/definitions/minecraft-java";

loadRepositoryEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = postgres(databaseUrl, {
  max: 1,
  onnotice: () => undefined,
});
const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "server",
  "control-plane",
  "db",
  "migrations",
);

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

const appliedRows = await sql<{ filename: string }[]>`
  SELECT filename FROM schema_migrations
`;
const applied = new Set(appliedRows.map((row) => row.filename));
const files = (await readdir(migrationsDirectory))
  .filter((file) => file.endsWith(".sql"))
  .sort();

for (const file of files) {
  if (applied.has(file)) continue;
  const statements = await readFile(join(migrationsDirectory, file), "utf8");
  console.log(`[migrate] applying ${file}`);
  await sql.begin(async (transaction) => {
    await transaction.unsafe(statements);
    await transaction`INSERT INTO schema_migrations (filename) VALUES (${file})`;
  });
}

for (const bp of [minecraftJava, minecraftBedrock]) {
  await sql`
    INSERT INTO blueprints (
      key, name, description, docker_image, default_ports, env_schema,
      startup_command, stop_command, install_image, install_script,
      install_entrypoint, data_path, min_cpu, min_memory_mb, min_disk_mb,
      supports_readonly_root, expected_resource_profile, is_builtin, updated_at
    ) VALUES (
      ${bp.key}, ${bp.name}, ${bp.description ?? null}, ${bp.dockerImage},
      ${sql.json(bp.defaultPorts as never)},
      ${sql.json(bp.envSchema as never)},
      ${bp.startupCommand ?? null},
      ${bp.stopCommand ?? null},
      ${bp.install?.image ?? null},
      ${bp.install?.script ?? null},
      ${bp.install?.entrypoint ? sql.json(bp.install.entrypoint as never) : null},
      ${bp.dataPath},
      ${bp.minimums.cpuLimit}, ${bp.minimums.memoryLimitMb}, ${bp.minimums.diskLimitMb},
      ${bp.supportsReadOnlyRoot === true},
      ${bp.expectedResourceProfile}, TRUE, now()
    )
    ON CONFLICT (key) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      docker_image = EXCLUDED.docker_image,
      default_ports = EXCLUDED.default_ports,
      env_schema = EXCLUDED.env_schema,
      startup_command = EXCLUDED.startup_command,
      stop_command = EXCLUDED.stop_command,
      install_image = EXCLUDED.install_image,
      install_script = EXCLUDED.install_script,
      install_entrypoint = EXCLUDED.install_entrypoint,
      data_path = EXCLUDED.data_path,
      min_cpu = EXCLUDED.min_cpu,
      min_memory_mb = EXCLUDED.min_memory_mb,
      min_disk_mb = EXCLUDED.min_disk_mb,
      supports_readonly_root = EXCLUDED.supports_readonly_root,
      expected_resource_profile = EXCLUDED.expected_resource_profile,
      is_builtin = TRUE,
      updated_at = now()
  `;
}

await sql.end();
console.log("[migrate] panel schema and blueprints are current");
