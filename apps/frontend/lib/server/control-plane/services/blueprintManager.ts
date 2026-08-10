/**
 * Blueprint administration (admin-only CRUD).
 *
 * Built-in blueprints (is_builtin = true) are defined in code and re-seeded on
 * every boot, so they are read-only here: editing or deleting one would either
 * be reverted on the next restart or orphan a code definition. This module
 * enforces that invariant, and refuses to delete any blueprint a server still
 * references (the `servers.blueprint_id` FK is ON DELETE RESTRICT).
 *
 * Reads for the create-server flow live in `blueprints/registry.ts`; this
 * module owns the write side and the admin-facing detail views.
 */

import { sql } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/http";
import type {
  BlueprintEnvField,
  BlueprintPort,
  ResourceProfile,
} from "../blueprints/types";

/** The writable shape of a blueprint, as accepted from the admin form. */
export interface BlueprintInput {
  key: string;
  name: string;
  description: string | null;
  dockerImage: string;
  defaultPorts: BlueprintPort[];
  envSchema: Record<string, BlueprintEnvField>;
  startupCommand: string | null;
  stopCommand: string | null;
  install: { image: string; script: string; entrypoint: string[] | null } | null;
  dataPath: string;
  minimums: { cpuLimit: number; memoryLimitMb: number; diskLimitMb: number };
  supportsReadOnlyRoot: boolean;
  expectedResourceProfile: ResourceProfile;
}

/** A row in the admin blueprint list. */
export interface AdminBlueprintSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  dockerImage: string;
  expectedResourceProfile: ResourceProfile;
  hasInstall: boolean;
  isBuiltin: boolean;
  /** Servers currently referencing this blueprint; delete is blocked above 0. */
  serverCount: number;
}

/** A blueprint's full detail, for the edit form. */
export interface AdminBlueprintDetail extends BlueprintInput {
  id: string;
  isBuiltin: boolean;
  serverCount: number;
}

interface DetailRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  docker_image: string;
  default_ports: BlueprintPort[];
  env_schema: Record<string, BlueprintEnvField>;
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
  is_builtin: boolean;
  server_count: number;
}

function rowToDetail(row: DetailRow): AdminBlueprintDetail {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    dockerImage: row.docker_image,
    defaultPorts: row.default_ports,
    envSchema: row.env_schema,
    startupCommand: row.startup_command,
    stopCommand: row.stop_command,
    install:
      row.install_image && row.install_script
        ? {
            image: row.install_image,
            script: row.install_script,
            entrypoint: row.install_entrypoint,
          }
        : null,
    dataPath: row.data_path,
    minimums: {
      cpuLimit: Number(row.min_cpu),
      memoryLimitMb: row.min_memory_mb,
      diskLimitMb: row.min_disk_mb,
    },
    supportsReadOnlyRoot: row.supports_readonly_root,
    expectedResourceProfile: row.expected_resource_profile,
    isBuiltin: row.is_builtin,
    serverCount: row.server_count,
  };
}

/** Every blueprint with its server count, built-ins first. */
export async function listBlueprintsForAdmin(): Promise<AdminBlueprintSummary[]> {
  const rows = (await sql`
    SELECT
      b.id, b.key, b.name, b.description, b.docker_image,
      b.expected_resource_profile, b.is_builtin,
      (b.install_image IS NOT NULL AND b.install_script IS NOT NULL) AS has_install,
      COUNT(s.id)::int AS server_count
    FROM blueprints b
    LEFT JOIN servers s ON s.blueprint_id = b.id
    GROUP BY b.id
    ORDER BY b.is_builtin DESC, b.name ASC
  `) as {
    id: string;
    key: string;
    name: string;
    description: string | null;
    docker_image: string;
    expected_resource_profile: ResourceProfile;
    is_builtin: boolean;
    has_install: boolean;
    server_count: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    dockerImage: row.docker_image,
    expectedResourceProfile: row.expected_resource_profile,
    hasInstall: row.has_install,
    isBuiltin: row.is_builtin,
    serverCount: row.server_count,
  }));
}

async function loadDetail(id: string): Promise<DetailRow> {
  const rows = (await sql`
    SELECT
      b.*,
      (SELECT COUNT(*)::int FROM servers s WHERE s.blueprint_id = b.id) AS server_count
    FROM blueprints b
    WHERE b.id = ${id}
  `) as DetailRow[];
  const row = rows[0];
  if (!row) throw notFound("Blueprint not found");
  return row;
}

export async function getBlueprintDetail(id: string): Promise<AdminBlueprintDetail> {
  return rowToDetail(await loadDetail(id));
}

/** Create a custom (non-built-in) blueprint. */
export async function createBlueprint(
  input: BlueprintInput,
): Promise<AdminBlueprintDetail> {
  const existing = (await sql`
    SELECT 1 FROM blueprints WHERE key = ${input.key}
  `) as { "?column?": number }[];
  if (existing.length > 0) {
    throw conflict(`A blueprint with key "${input.key}" already exists.`);
  }

  const rows = (await sql`
    INSERT INTO blueprints (
      key, name, description, docker_image, default_ports, env_schema,
      startup_command, stop_command, install_image, install_script,
      install_entrypoint, data_path, min_cpu, min_memory_mb, min_disk_mb,
      supports_readonly_root, expected_resource_profile, is_builtin, updated_at
    ) VALUES (
      ${input.key},
      ${input.name},
      ${input.description},
      ${input.dockerImage},
      ${sql.json(input.defaultPorts as never)},
      ${sql.json(input.envSchema as never)},
      ${input.startupCommand},
      ${input.stopCommand},
      ${input.install?.image ?? null},
      ${input.install?.script ?? null},
      ${input.install?.entrypoint ? sql.json(input.install.entrypoint as never) : null},
      ${input.dataPath},
      ${input.minimums.cpuLimit},
      ${input.minimums.memoryLimitMb},
      ${input.minimums.diskLimitMb},
      ${input.supportsReadOnlyRoot},
      ${input.expectedResourceProfile},
      FALSE,
      now()
    )
    RETURNING id
  `) as { id: string }[];

  return getBlueprintDetail(rows[0]!.id);
}

/** Update a custom blueprint. Built-ins and the immutable key are rejected. */
export async function updateBlueprint(
  id: string,
  input: BlueprintInput,
): Promise<AdminBlueprintDetail> {
  const current = await loadDetail(id);
  if (current.is_builtin) {
    throw conflict(
      "Built-in blueprints are defined in code and cannot be edited here.",
    );
  }

  // The key is the stable identifier used in env-schema joins and audit
  // records; changing it is not supported, so a mismatch is a client bug.
  if (input.key !== current.key) {
    throw badRequest("A blueprint's key cannot be changed after creation.");
  }

  await sql`
    UPDATE blueprints SET
      name                   = ${input.name},
      description            = ${input.description},
      docker_image           = ${input.dockerImage},
      default_ports          = ${sql.json(input.defaultPorts as never)},
      env_schema             = ${sql.json(input.envSchema as never)},
      startup_command        = ${input.startupCommand},
      stop_command           = ${input.stopCommand},
      install_image          = ${input.install?.image ?? null},
      install_script         = ${input.install?.script ?? null},
      install_entrypoint     = ${input.install?.entrypoint ? sql.json(input.install.entrypoint as never) : null},
      data_path              = ${input.dataPath},
      min_cpu                = ${input.minimums.cpuLimit},
      min_memory_mb          = ${input.minimums.memoryLimitMb},
      min_disk_mb            = ${input.minimums.diskLimitMb},
      supports_readonly_root = ${input.supportsReadOnlyRoot},
      expected_resource_profile = ${input.expectedResourceProfile},
      updated_at             = now()
    WHERE id = ${id}
  `;

  return getBlueprintDetail(id);
}

/**
 * Delete a custom blueprint.
 *
 * Refused for built-ins, and for any blueprint still referenced by a server —
 * checked explicitly so the caller gets a readable count instead of a raw
 * foreign-key violation.
 */
export async function deleteBlueprint(id: string): Promise<void> {
  const current = await loadDetail(id);
  if (current.is_builtin) {
    throw conflict("Built-in blueprints cannot be deleted.");
  }
  if (current.server_count > 0) {
    throw conflict(
      `This blueprint is still used by ${current.server_count} server(s). ` +
        "Delete or migrate those servers first.",
    );
  }

  await sql`DELETE FROM blueprints WHERE id = ${id}`;
}
