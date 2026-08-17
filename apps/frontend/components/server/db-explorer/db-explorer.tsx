"use client";

/**
 * The database explorer shell: a table sidebar on the left, the selected
 * table's Data/Structure views on the right.
 *
 * The explorer is opened from the Databases tab and replaces it until the
 * owner navigates back — one database at a time, matching how a game server
 * uses exactly one connection at a time.
 */

import * as React from "react";
import { ArrowLeft, RefreshCw, Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  ApiError,
  getDatabaseTables,
  type DbTableSummary,
  type ServerDatabase,
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { CreateTableDialog } from "./explorer-dialogs";
import { ExplorerTable } from "./explorer-table";

/** Format the sidebar's secondary line: row estimate and size when known. */
function tableMeta(table: DbTableSummary): string {
  const parts: string[] = [];
  if (table.rowsEstimate !== null) parts.push(`≈ ${table.rowsEstimate.toLocaleString()} rows`);
  if (table.sizeBytes !== null) parts.push(formatBytes(table.sizeBytes));
  return parts.join(" · ");
}

/**
 * The explorer for one provisioned database.
 *
 * `onExit` returns to the databases list. Table selection is local state; the
 * sidebar reloads after any table-level mutation (create/drop) and after row
 * mutations (so the ≈ estimate ticks).
 */
export function DatabaseExplorer({
  serverId,
  database,
  onExit,
}: {
  serverId: string;
  database: ServerDatabase;
  onExit: () => void;
}) {
  const [tables, setTables] = React.useState<DbTableSummary[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await getDatabaseTables(serverId, database.id);
        if (!cancelled) setTables(list);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Failed to load the table list.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, database.id, refreshKey]);

  const refreshTables = () => setRefreshKey((k) => k + 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onExit}>
          <ArrowLeft />
          Databases
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <Table2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-sm font-medium">{database.name}</span>
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {database.host}:{database.port}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh tables"
          onClick={refreshTables}
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-2">
          <CreateTableDialog
            serverId={serverId}
            databaseId={database.id}
            onCreated={async (table) => {
              await refreshTables();
              setSelected(table);
            }}
          />
          {loading && tables === null ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Spinner />
            </div>
          ) : tables !== null && tables.length === 0 ? (
            <p className="px-1 py-4 text-xs text-muted-foreground">
              No tables yet — create the first one.
            </p>
          ) : (
            <nav className="flex min-w-0 flex-col gap-0.5" aria-label="Tables">
              {tables?.map((table) => {
                const active = table.name === selected;
                const meta = tableMeta(table);
                return (
                  <button
                    key={table.name}
                    type="button"
                    onClick={() => setSelected(table.name)}
                    aria-current={active ? "true" : undefined}
                    className={`flex min-w-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                      active
                        ? "bg-muted"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="w-full truncate font-mono">{table.name}</span>
                    {meta && (
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {meta}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          )}
        </aside>

        <div className="min-w-0">
          {selected ? (
            <ExplorerTable
              key={selected}
              serverId={serverId}
              databaseId={database.id}
              table={selected}
              onTablesChanged={refreshTables}
              onDropped={async () => {
                setSelected(null);
                await refreshTables();
              }}
            />
          ) : (
            <Empty className="min-h-[16rem]">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Table2 />
                </EmptyMedia>
                <EmptyTitle>No table selected</EmptyTitle>
                <EmptyDescription>
                  Pick a table on the left to browse its rows and structure, or
                  create a new one.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}
