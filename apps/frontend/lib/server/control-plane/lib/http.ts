/**
 * Shared HTTP helpers for `Bun.serve()` route handlers.
 *
 * Errors are represented as thrown `HttpError`s and converted to responses at
 * the edge, so handlers can validate-and-throw without nesting.
 */

import { env } from "../config/env";
import { APIError } from "better-auth/api";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);
export const unauthorized = (message = "Authentication required") =>
  new HttpError(401, message);
export const forbidden = (message = "Insufficient permissions") =>
  new HttpError(403, message);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const payloadTooLarge = (message: string) => new HttpError(413, message);
/**
 * The panel is working but a dependency it needs is not. Distinct from a 500:
 * nothing is wrong with the request, and retrying it later is the right advice.
 */
export const serviceUnavailable = (message: string) => new HttpError(503, message);

export function json(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * CORS headers for the configured frontend origin only — not a wildcard, since
 * credentialed requests (session cookies) require an exact origin match.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": env.frontendUrl,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
  };
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Convert a thrown value into a JSON response.
 *
 * Better Auth `APIError`s (thrown by the auth layer and its plugins — e.g. an
 * invalid API key failing the plugin's before-hook during `getSession`) keep
 * their own status and message; an invalid credential surfaces as 401 rather
 * than a generic 500. Everything else unexpected is logged in full but
 * reported generically, so internal details (stack traces, SQL text) never
 * reach the client.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      { error: error.message, ...(error.details ? { details: error.details } : {}) },
      error.status,
    );
  }

  if (error instanceof APIError) {
    const status =
      error.body?.code === "INVALID_API_KEY" || error.statusCode === 401 ? 401 : error.statusCode;
    return json({ error: error.body?.message ?? "Authentication failed" }, status);
  }

  console.error("[http] unhandled error:", error);
  return json({ error: "Internal server error" }, 500);
}

/** Parse a JSON request body, rejecting anything that is not an object. */
export async function parseJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Best-effort client IP for audit logging, honouring a reverse proxy header. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}

// --- Small validation helpers -------------------------------------------------

export function requireString(
  body: Record<string, unknown>,
  key: string,
  { min = 1, max = 255 }: { min?: number; max?: number } = {},
): string {
  const value = body[key];
  if (typeof value !== "string") throw badRequest(`"${key}" must be a string`);

  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw badRequest(`"${key}" must be at least ${min} character(s)`);
  }
  if (trimmed.length > max) {
    throw badRequest(`"${key}" must be at most ${max} character(s)`);
  }
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  { max = 255 }: { max?: number } = {},
): string | undefined {
  if (body[key] === undefined || body[key] === null) return undefined;
  return requireString(body, key, { min: 1, max });
}

export function requireNumber(
  body: Record<string, unknown>,
  key: string,
  { min, max }: { min?: number; max?: number } = {},
): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`"${key}" must be a number`);
  }
  if (min !== undefined && value < min) {
    throw badRequest(`"${key}" must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw badRequest(`"${key}" must be <= ${max}`);
  }
  return value;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Validate a path parameter that will be used in a UUID column comparison.
 * Rejecting early gives a clean 400 instead of a Postgres cast error.
 */
export function requireUuidParam(value: string | undefined, name: string): string {
  if (!value || !isUuid(value)) {
    throw badRequest(`"${name}" must be a valid UUID`);
  }
  return value;
}
