/**
 * Admin blueprint routes (CRUD).
 *
 * All gated on `requireAdmin`. The heavy lifting is validation: a blueprint
 * carries nested structures (ports, an env schema, an optional install step)
 * that become container configuration and a shell script, so the input is
 * parsed strictly here before it reaches {@link blueprintManager}.
 */

import { requireAdmin } from "../auth/middleware";
import {
  badRequest,
  conflict,
  json,
  noContent,
  parseJsonBody,
  requireString,
  requireUuidParam,
} from "../lib/http";
import { isBlockedHost } from "../lib/ssrf";
import { recordAuditFromRequest } from "../services/auditLog";
import {
  createBlueprint,
  deleteBlueprint,
  getBlueprintDetail,
  listBlueprintsForAdmin,
  updateBlueprint,
  type BlueprintInput,
} from "../services/blueprintManager";
import type {
  BlueprintEnvField,
  BlueprintPort,
  ResourceProfile,
} from "../blueprints/types";
import { parsePluginSupport } from "../blueprints/plugins";

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESOURCE_PROFILES: ResourceProfile[] = ["bursty", "steady-low", "steady-high"];

// --- Small field readers (nested objects can't use the flat http helpers) ----

function str(value: unknown, label: string, max = 255): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`"${label}" must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`"${label}" must be at most ${max} characters`);
  return trimmed;
}

function optStr(value: unknown, label: string, max = 8192): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`"${label}" must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw badRequest(`"${label}" must be at most ${max} characters`);
  return trimmed;
}

function num(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw badRequest(`"${label}" must be a number`);
  if (n < min || n > max) throw badRequest(`"${label}" must be between ${min} and ${max}`);
  return n;
}

function strArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw badRequest(`"${label}" must be an array`);
  return value.map((entry, i) => {
    if (typeof entry !== "string") throw badRequest(`"${label}[${i}]" must be a string`);
    return entry;
  });
}

function parsePorts(value: unknown): BlueprintPort[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("A blueprint needs at least one port.");
  }
  if (value.length > 16) throw badRequest("A blueprint may declare at most 16 ports.");

  const seen = new Set<string>();
  let primaryCount = 0;

  const ports = value.map((raw, i): BlueprintPort => {
    const entry = raw as Record<string, unknown>;
    const container = num(entry.container, `ports[${i}].container`, 1, 65535);
    if (!Number.isInteger(container)) {
      throw badRequest(`"ports[${i}].container" must be a whole number`);
    }
    // No protocol: a published port is claimed on TCP and UDP both, so the
    // number alone is the declaration — and the number alone must be unique.
    const dedupeKey = String(container);
    if (seen.has(dedupeKey)) {
      throw badRequest(`Duplicate port ${dedupeKey}.`);
    }
    seen.add(dedupeKey);

    const primary = entry.primary === true;
    if (primary) primaryCount += 1;

    return { container, ...(primary ? { primary: true } : {}) };
  });

  // Exactly one primary. If the client marked none, promote the first, so a
  // valid blueprint is always producible from a simple list.
  if (primaryCount === 0) {
    ports[0] = { ...ports[0]!, primary: true };
  } else if (primaryCount > 1) {
    throw badRequest("Exactly one port may be marked primary.");
  }

  return ports;
}

function parseEnvSchema(value: unknown): Record<string, BlueprintEnvField> {
  // Accepted as an array of field descriptors (natural for a form); stored as a
  // keyed map, which is what the env resolver expects.
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) throw badRequest('"envFields" must be an array.');

  const schema: Record<string, BlueprintEnvField> = {};
  for (const [i, raw] of value.entries()) {
    const entry = raw as Record<string, unknown>;
    const key = str(entry.key, `envFields[${i}].key`, 64);
    if (!ENV_KEY_PATTERN.test(key)) {
      throw badRequest(
        `"${key}" is not a valid environment variable name (letters, digits, underscore).`,
      );
    }
    if (schema[key]) throw badRequest(`Duplicate environment variable "${key}".`);

    const options = entry.options === undefined ? undefined : strArray(entry.options, `envFields[${i}].options`);
    const field: BlueprintEnvField = { required: entry.required === true };
    const def = optStr(entry.default, `envFields[${i}].default`, 1024);
    if (def !== null) field.default = def;
    const description = optStr(entry.description, `envFields[${i}].description`, 512);
    if (description !== null) field.description = description;
    if (options && options.length > 0) field.options = options;
    if (entry.secret === true) field.secret = true;
    if (entry.editable === true) field.editable = true;

    schema[key] = field;
  }
  return schema;
}

function parseInstall(value: unknown): BlueprintInput["install"] {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest('"install" must be an object or null.');
  }
  const entry = value as Record<string, unknown>;
  const image = str(entry.image, "install.image");
  const script = str(entry.script, "install.script", 64_000);
  const entrypoint =
    entry.entrypoint === undefined || entry.entrypoint === null
      ? null
      : strArray(entry.entrypoint, "install.entrypoint");
  return { image, script, entrypoint: entrypoint && entrypoint.length > 0 ? entrypoint : null };
}

/**
 * Parse and validate a blueprint create/update body into a {@link BlueprintInput}.
 * `requireKey` is false on update, where the key is immutable and taken from the
 * existing row (a mismatch is still rejected in the manager).
 */
function parseBlueprintInput(body: Record<string, unknown>): BlueprintInput {
  const key = str(body.key, "key", 63);
  if (!KEY_PATTERN.test(key)) {
    throw badRequest(
      "Key must be lowercase letters, digits and dashes (e.g. \"valheim\"), 2–63 characters.",
    );
  }

  const profile = body.expectedResourceProfile;
  if (typeof profile !== "string" || !RESOURCE_PROFILES.includes(profile as ResourceProfile)) {
    throw badRequest(
      `"expectedResourceProfile" must be one of: ${RESOURCE_PROFILES.join(", ")}`,
    );
  }

  const dataPath = optStr(body.dataPath, "dataPath", 512) ?? "/data";
  if (!dataPath.startsWith("/")) {
    throw badRequest('"dataPath" must be an absolute path.');
  }

  const minimums = body.minimums as Record<string, unknown> | undefined;
  if (typeof minimums !== "object" || minimums === null) {
    throw badRequest('"minimums" is required.');
  }

  const envSchema = parseEnvSchema(body.envFields);

  // The plugins section is pure data but security-relevant (it names the
  // hosts the panel's plugin fetch engine and auto-updater will contact), so
  // it is validated as strictly as the install script — see plugins.ts.
  let plugins: BlueprintInput["plugins"] = null;
  if (body.plugins !== undefined && body.plugins !== null) {
    try {
      plugins = parsePluginSupport(body.plugins, envSchema, isBlockedHost);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  }

  return {
    key,
    name: str(body.name, "name", 128),
    description: optStr(body.description, "description", 1024),
    dockerImage: str(body.dockerImage, "dockerImage", 512),
    defaultPorts: parsePorts(body.ports),
    envSchema,
    startupCommand: optStr(body.startupCommand, "startupCommand", 8192),
    stopCommand: optStr(body.stopCommand, "stopCommand", 512),
    install: parseInstall(body.install),
    plugins,
    dataPath,
    minimums: {
      cpuLimit: num(minimums.cpuLimit, "minimums.cpuLimit", 0.1, 64),
      memoryLimitMb: num(minimums.memoryLimitMb, "minimums.memoryLimitMb", 128, 262_144),
      diskLimitMb: num(minimums.diskLimitMb, "minimums.diskLimitMb", 256, 2_000_000),
    },
    supportsReadOnlyRoot: body.supportsReadOnlyRoot === true,
    expectedResourceProfile: profile as ResourceProfile,
  };
}

// --- Handlers -----------------------------------------------------------------

/** GET /api/admin/blueprints */
export async function handleAdminListBlueprints(request: Request): Promise<Response> {
  await requireAdmin(request);
  return json({ blueprints: await listBlueprintsForAdmin() });
}

/** GET /api/admin/blueprints/:id */
export async function handleAdminGetBlueprint(
  request: Request,
  blueprintId: string,
): Promise<Response> {
  await requireAdmin(request);
  const id = requireUuidParam(blueprintId, "blueprintId");
  return json({ blueprint: await getBlueprintDetail(id) });
}

/** POST /api/admin/blueprints */
export async function handleAdminCreateBlueprint(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const input = parseBlueprintInput(await parseJsonBody(request));

  const blueprint = await createBlueprint(input);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "blueprint.create",
    targetType: "blueprint",
    targetId: blueprint.id,
    metadata: { key: blueprint.key, name: blueprint.name },
  });

  return json({ blueprint }, 201);
}

/** PATCH /api/admin/blueprints/:id */
export async function handleAdminUpdateBlueprint(
  request: Request,
  blueprintId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(blueprintId, "blueprintId");
  const input = parseBlueprintInput(await parseJsonBody(request));

  const blueprint = await updateBlueprint(id, input);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "blueprint.update",
    targetType: "blueprint",
    targetId: id,
    metadata: { key: blueprint.key, name: blueprint.name },
  });

  return json({ blueprint });
}

/** DELETE /api/admin/blueprints/:id */
export async function handleAdminDeleteBlueprint(
  request: Request,
  blueprintId: string,
): Promise<Response> {
  const admin = await requireAdmin(request);
  const id = requireUuidParam(blueprintId, "blueprintId");

  await deleteBlueprint(id);

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "blueprint.delete",
    targetType: "blueprint",
    targetId: id,
  });

  return noContent();
}

// --- Import from URL ----------------------------------------------------------

const MAX_IMPORT_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * POST /api/admin/blueprints/import-url
 *
 * Server-side fetch of a blueprint JSON file, so an admin can import from a link
 * without the browser hitting CORS. Returns the parsed object under `file`; the
 * client validates it and opens the create form prefilled for review — it is
 * not created here.
 */
export async function handleAdminImportBlueprintUrl(
  request: Request,
): Promise<Response> {
  await requireAdmin(request);
  const body = await parseJsonBody(request);
  const rawUrl = requireString(body, "url", { max: 2048 });

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest("Enter a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("Only http(s) URLs are supported.");
  }
  if (isBlockedHost(url.hostname)) {
    throw badRequest("That host is not allowed.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "application/json, text/plain, */*" },
    });
  } catch {
    throw conflict("Could not fetch that URL.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw conflict(`The URL responded with status ${response.status}.`);
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMPORT_BYTES) {
    throw badRequest("That file is too large to import.");
  }

  const text = await response.text();
  if (text.length > MAX_IMPORT_BYTES) {
    throw badRequest("That file is too large to import.");
  }

  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw badRequest("The URL did not return valid JSON.");
  }
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw badRequest("Expected a JSON object describing one blueprint.");
  }

  return json({ file });
}
