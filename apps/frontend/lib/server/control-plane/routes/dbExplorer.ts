/**
 * Database explorer routes.
 *
 * Everything under /api/servers/:id/databases/:databaseId/explorer. All routes
 * — reads included — require the "database" permission, matching the rest of
 * the databases resource. The handlers stay thin: parse, authorize, delegate
 * to `services/dbExplorer.ts`, which composes the SQL (never the browser) and
 * audits every mutation.
 *
 * Table and column names arrive as path/body values and are vetted inside the
 * SQL builders before anything is interpolated — a hostile name yields a 400,
 * not a statement.
 */

import { requireServerPermission } from "../auth/middleware";
import {
  badRequest,
  conflict,
  json,
  noContent,
  parseJsonBody,
  requireString,
  requireUuidParam,
} from "../lib/http";
import { getServer } from "../services/serverManager";
import {
  addExplorerColumn,
  changeExplorerColumn,
  createExplorerTable,
  deleteExplorerRow,
  dropExplorerColumn,
  dropExplorerTable,
  EXPLORER_MAX_PAGE,
  getExplorerTableSchema,
  insertExplorerRow,
  listExplorerTables,
  parseColumnSpecInput,
  parseRowValues,
  readExplorerTableRows,
  updateExplorerRow,
} from "../services/dbExplorer";
import type { ColumnSpecInput } from "../services/dbExplorerSql";

/** Mutations are refused on suspended servers, matching provisioning. */
async function assertServerMutable(serverId: string): Promise<void> {
  const server = await getServer(serverId);
  if (server.status === "suspended") {
    throw conflict(
      "This server is suspended pending administrator review and cannot be modified.",
    );
  }
}

/** Parse a non-empty column-spec array from a JSON body. */
function parseColumnSpecs(value: unknown): ColumnSpecInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('"columns" must be a non-empty array.');
  }
  return value.map((spec, i) => parseColumnSpecInput(spec, `columns[${i}]`));
}

/** GET /api/servers/:id/databases/:databaseId/explorer/tables — table list. */
export async function handleListExplorerTables(
  request: Request,
  serverId: string,
  databaseId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  await requireServerPermission(request, id, "database");

  const tables = await listExplorerTables(id, dbId);
  return json({ tables });
}

/**
 * POST .../explorer/tables — create a table.
 *
 * Body: { table: string, columns: ColumnSpecInput[] }
 */
export async function handleCreateExplorerTable(
  request: Request,
  serverId: string,
  databaseId: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  const body = await parseJsonBody(request);
  const table = requireString(body, "table", { max: 64 });
  const columns = parseColumnSpecs(body.columns);

  await createExplorerTable(
    { serverId: id, databaseId: dbId, actorId: user.id },
    table,
    columns,
  );
  return json({ created: true }, 201);
}

/** DELETE .../explorer/tables/:table — drop a table (destructive). */
export async function handleDropExplorerTable(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  await dropExplorerTable({ serverId: id, databaseId: dbId, actorId: user.id }, table);
  return noContent();
}

/** GET .../explorer/tables/:table/schema — columns and primary key. */
export async function handleGetExplorerTableSchema(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  await requireServerPermission(request, id, "database");

  const schema = await getExplorerTableSchema(id, dbId, table);
  return json({ schema });
}

/**
 * GET .../explorer/tables/:table/rows?offset=&limit= — one page of rows.
 *
 * `limit` is clamped server-side (1..EXPLORER_MAX_PAGE) so a client cannot
 * ask for the whole table in one response.
 */
export async function handleGetExplorerTableRows(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  await requireServerPermission(request, id, "database");

  const params = new URL(request.url).searchParams;
  const offsetRaw = Number(params.get("offset") ?? "0");
  const limitRaw = Number(params.get("limit") ?? "50");
  const page = await readExplorerTableRows(id, dbId, table, {
    offset: Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0,
    limit: Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), EXPLORER_MAX_PAGE)
      : 50,
  });
  return json({ page });
}

/**
 * POST .../explorer/tables/:table/rows — insert a row.
 *
 * Body: { values: Record<string, string | null> }
 */
export async function handleInsertExplorerRow(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  const body = await parseJsonBody(request);
  const values = parseRowValues(body.values, "values");

  await insertExplorerRow({ serverId: id, databaseId: dbId, actorId: user.id }, table, values);
  return json({ inserted: true }, 201);
}

/**
 * PATCH .../explorer/tables/:table/rows — update one row by primary key.
 *
 * Body: { pk: Record<string, string | null>, values: Record<string, string | null> }
 */
export async function handleUpdateExplorerRow(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  const body = await parseJsonBody(request);
  const pk = parseRowValues(body.pk, "pk");
  const values = parseRowValues(body.values, "values");

  await updateExplorerRow({ serverId: id, databaseId: dbId, actorId: user.id }, table, pk, values);
  return json({ updated: true });
}

/**
 * DELETE .../explorer/tables/:table/rows — delete one row by primary key.
 *
 * Body: { pk: Record<string, string | null> } (a keyed DELETE keeps the row
 * identity out of the URL, where it would be logged everywhere).
 */
export async function handleDeleteExplorerRow(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  const body = await parseJsonBody(request);
  const pk = parseRowValues(body.pk, "pk");

  await deleteExplorerRow({ serverId: id, databaseId: dbId, actorId: user.id }, table, pk);
  return noContent();
}

/**
 * POST .../explorer/tables/:table/columns — add a column.
 *
 * Body: { column: ColumnSpecInput }
 */
export async function handleAddExplorerColumn(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  const body = await parseJsonBody(request);
  const column = parseColumnSpecInput(body.column, "column");

  await addExplorerColumn({ serverId: id, databaseId: dbId, actorId: user.id }, table, column);
  return json({ added: true }, 201);
}

/**
 * PATCH .../explorer/tables/:table/columns/:column — edit a column.
 *
 * Body: { column: ColumnSpecInput } — the full restated definition; the UI
 * prefills it from the schema so nothing is silently dropped.
 */
export async function handleChangeExplorerColumn(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
  column: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  const body = await parseJsonBody(request);
  const spec = parseColumnSpecInput(body.column, "column");

  await changeExplorerColumn(
    { serverId: id, databaseId: dbId, actorId: user.id },
    table,
    column,
    spec,
  );
  return json({ changed: true });
}

/** DELETE .../explorer/tables/:table/columns/:column — drop a column (destructive). */
export async function handleDropExplorerColumn(
  request: Request,
  serverId: string,
  databaseId: string,
  table: string,
  column: string,
): Promise<Response> {
  const id = requireUuidParam(serverId, "serverId");
  const dbId = requireUuidParam(databaseId, "databaseId");
  const { user } = await requireServerPermission(request, id, "database");
  await assertServerMutable(id);

  await dropExplorerColumn({ serverId: id, databaseId: dbId, actorId: user.id }, table, column);
  return noContent();
}
