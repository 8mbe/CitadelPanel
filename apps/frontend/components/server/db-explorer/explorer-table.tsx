"use client";

/**
 * The explorer's right pane: one table, two views. "Data" pages through the
 * rows (edit/delete keyed by primary key); "Structure" lists the columns and
 * offers add/edit/drop plus the table-level drop.
 */

import * as React from "react";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  deleteDatabaseRow,
  dropDatabaseColumn,
  dropDatabaseTable,
  getDatabaseTableRows,
  getDatabaseTableSchema,
  type DbTableSchema,
} from "@/lib/api";
import {
  ColumnDialog,
  ConfirmDialog,
  RowDialog,
  apiErrorMessage,
} from "./explorer-dialogs";

/** Rows per page — the server clamps to this range anyway. */
const PAGE_SIZE = 50;

/** Strip control characters and clamp length so a cell can't wreck the grid. */
function displayCell(value: string | null): string {
  if (value === null) return "NULL";
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .slice(0, 96);
}

/** The "Data" view: one page of rows with row-level actions and pagination. */
function TableDataView({
  serverId,
  databaseId,
  table,
  schema,
  onMutated,
}: {
  serverId: string;
  databaseId: string;
  table: string;
  schema: DbTableSchema;
  onMutated: () => void | Promise<void>;
}) {
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState<{
    columns: string[];
    rows: (string | null)[][];
    total: number;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const hasPk = schema.primaryKey.length > 0;

  React.useEffect(() => {
    setOffset(0);
  }, [table]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await getDatabaseTableRows(serverId, databaseId, table, {
          offset,
          limit: PAGE_SIZE,
        });
        if (!cancelled) setPage(result);
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Failed to load rows."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, databaseId, table, offset]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {hasPk
            ? "Rows are ordered by the primary key; edit and delete match rows by it."
            : "This table has no primary key — rows can be browsed but not edited or deleted here."}
        </p>
        <RowDialog
          serverId={serverId}
          databaseId={databaseId}
          table={table}
          schema={schema}
          onSaved={async () => {
            await onMutated();
            setOffset(0);
          }}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Spinner />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !page || page.rows.length === 0 ? (
        <Empty className="min-h-[10rem]">
          <EmptyHeader>
            <EmptyTitle>No rows</EmptyTitle>
            <EmptyDescription>This table is empty.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {page.columns.map((column) => (
                    <TableHead key={column} className="font-mono text-xs">
                      {column}
                    </TableHead>
                  ))}
                  {hasPk && (
                    <TableHead className="w-16 text-right">
                      <span className="sr-only">Row actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((row, rowIndex) => {
                  const pk: Record<string, string | null> = {};
                  if (hasPk) {
                    for (const pkColumn of schema.primaryKey) {
                      const index = page.columns.indexOf(pkColumn);
                      pk[pkColumn] = index >= 0 ? (row[index] ?? null) : null;
                    }
                  }
                  return (
                    <TableRow key={rowIndex}>
                      {row.map((cell, cellIndex) =>
                        cell === null ? (
                          <TableCell
                            key={cellIndex}
                            className="max-w-[16rem] truncate font-mono text-xs italic text-muted-foreground"
                          >
                            NULL
                          </TableCell>
                        ) : (
                          <TableCell
                            key={cellIndex}
                            className="max-w-[16rem] truncate font-mono text-xs"
                            title={cell}
                          >
                            {displayCell(cell) || (
                              <span className="text-muted-foreground">“”</span>
                            )}
                          </TableCell>
                        ),
                      )}
                      {hasPk && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-0.5">
                            <RowDialog
                              serverId={serverId}
                              databaseId={databaseId}
                              table={table}
                              schema={schema}
                              compact
                              editing={{ columns: page.columns, values: row }}
                              onSaved={onMutated}
                            />
                            <ConfirmDialog
                              trigger={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label="Delete row"
                                  className="text-muted-foreground hover:text-destructive"
                                >
                                  <Trash2 />
                                </Button>
                              }
                              title="Delete row?"
                              description="This permanently removes the row from the table."
                              confirmLabel="Delete row"
                              onConfirm={async () => {
                                await deleteDatabaseRow(serverId, databaseId, table, pk);
                                await onMutated();
                              }}
                            />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {page.total === 0
                ? "0 rows"
                : `${offset + 1}–${Math.min(offset + page.rows.length, page.total)} of ${page.total.toLocaleString()}`}
            </p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Previous page"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Next page"
                disabled={offset + page.rows.length >= page.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The "Structure" view: the columns, with column- and table-level actions. */
function TableStructureView({
  serverId,
  databaseId,
  table,
  schema,
  onSchemaChanged,
  onDropped,
}: {
  serverId: string;
  databaseId: string;
  table: string;
  schema: DbTableSchema;
  onSchemaChanged: () => void | Promise<void>;
  onDropped: () => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {schema.columns.length} column{schema.columns.length === 1 ? "" : "s"}
          {schema.primaryKey.length > 0 && (
            <>
              {" · primary key: "}
              <span className="font-mono">{schema.primaryKey.join(", ")}</span>
            </>
          )}
        </p>
        <div className="flex items-center gap-0.5">
          <ColumnDialog
            serverId={serverId}
            databaseId={databaseId}
            table={table}
            onSaved={onSchemaChanged}
          />
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
                <Trash2 />
                Drop table
              </Button>
            }
            title={`Drop table “${table}”?`}
            description="This permanently deletes the table and all of its data."
            confirmLabel="Drop table"
            onConfirm={async () => {
              await dropDatabaseTable(serverId, databaseId, table);
              await onDropped();
            }}
          />
        </div>
      </div>

      {schema.columns.length === 0 ? (
        <Empty className="min-h-[10rem]">
          <EmptyHeader>
            <EmptyTitle>No columns</EmptyTitle>
            <EmptyDescription>
              Add a column to give this table a shape.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Column</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Null</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Extra</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Column actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schema.columns.map((column) => (
                <TableRow key={column.name}>
                  <TableCell className="font-mono text-xs font-medium">
                    {column.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {column.type}
                  </TableCell>
                  <TableCell className="text-xs">
                    {column.nullable ? "yes" : "no"}
                  </TableCell>
                  <TableCell>
                    {column.keyType ? (
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {column.keyType}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate font-mono text-xs">
                    {column.defaultValue ?? <span className="text-muted-foreground">NULL</span>}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate text-xs text-muted-foreground">
                    {column.extra ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <ColumnDialog
                        serverId={serverId}
                        databaseId={databaseId}
                        table={table}
                        editing={column}
                        onSaved={onSchemaChanged}
                      />
                      <ConfirmDialog
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Drop column ${column.name}`}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 />
                          </Button>
                        }
                        title={`Drop column “${column.name}”?`}
                        description="The data stored in this column is permanently deleted."
                        confirmLabel="Drop column"
                        onConfirm={async () => {
                          await dropDatabaseColumn(serverId, databaseId, table, column.name);
                          await onSchemaChanged();
                        }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/**
 * One selected table: loads the schema (shared by both views — the data view
 * needs the primary key for ordering and row identity) and hosts the
 * Data/Structure tabs.
 */
export function ExplorerTable({
  serverId,
  databaseId,
  table,
  onTablesChanged,
  onDropped,
}: {
  serverId: string;
  databaseId: string;
  table: string;
  onTablesChanged: () => void | Promise<void>;
  onDropped: () => void | Promise<void>;
}) {
  const [schema, setSchema] = React.useState<DbTableSchema | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const result = await getDatabaseTableSchema(serverId, databaseId, table);
        if (!cancelled) setSchema(result);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Failed to load the table schema.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, databaseId, table, refreshKey]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!schema) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Spinner />
      </div>
    );
  }

  const refreshSchema = async () => {
    setRefreshKey((k) => k + 1);
    await onTablesChanged();
  };

  return (
    <Tabs defaultValue="data">
      <TabsList>
        <TabsTrigger value="data">Data</TabsTrigger>
        <TabsTrigger value="structure">Structure</TabsTrigger>
      </TabsList>
      <TabsContent value="data" className="mt-4">
        <TableDataView
          serverId={serverId}
          databaseId={databaseId}
          table={table}
          schema={schema}
          onMutated={refreshSchema}
        />
      </TabsContent>
      <TabsContent value="structure" className="mt-4">
        <TableStructureView
          serverId={serverId}
          databaseId={databaseId}
          table={table}
          schema={schema}
          onSchemaChanged={refreshSchema}
          onDropped={onDropped}
        />
      </TabsContent>
    </Tabs>
  );
}
