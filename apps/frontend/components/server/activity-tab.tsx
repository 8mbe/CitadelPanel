"use client";

import * as React from "react";
import { History, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, listServerActivity, type ServerActivityEntry } from "@/lib/api";
import {
  actionMeta,
  CATEGORY_TONE,
  describeMetadata,
} from "@/lib/audit-actions";
import { formatRelative } from "@/lib/format";
import { useServerData } from "./server-data-context";

/**
 * Per-server activity feed.
 *
 * Every state-changing action on this server is recorded in the audit log. This
 * tab surfaces those rows scoped to the current server: starts, stops, file
 * edits, console commands, subuser changes, SFTP sessions. Every row carries
 * enough context (who, what, when) to answer "what happened here?" without
 * leaving the page.
 *
 * The data comes from GET /api/servers/:id/activity, which filters the shared
 * audit_logs table by (target_type='server', target_id=this). Actor identity is
 * joined server-side so the UI never needs a second round-trip per row.
 */

function actorLabel(entry: ServerActivityEntry): string {
  if (entry.actorName) return entry.actorName;
  if (entry.actorEmail) return entry.actorEmail;
  if (entry.userId) return entry.userId.slice(0, 8);
  return "system";
}

// --- Component ---------------------------------------------------------------

export function ActivityTab() {
  const { server } = useServerData();
  const [entries, setEntries] = React.useState<ServerActivityEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listServerActivity(server.id, 100);
      setEntries(data);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Failed to load activity for this server.",
      );
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listServerActivity(server.id, 100);
        if (!cancelled) setEntries(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : "Failed to load activity for this server.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server.id]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-muted-foreground" />
          Activity
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {loading
            ? "Loading recent activity…"
            : error
              ? error
              : entries.length === 0
                ? "No activity recorded yet."
                : `${entries.length} recent action${entries.length === 1 ? "" : "s"}.`}
        </p>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <ActivitySkeleton />
        ) : error ? (
          <Empty className="min-h-[14rem] rounded-b-xl">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>Couldn&apos;t load activity</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : entries.length === 0 ? (
          <Empty className="min-h-[14rem] rounded-b-xl">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>No activity yet</EmptyTitle>
              <EmptyDescription>
                Actions on this server &mdash; starts, stops, config changes,
                file edits, console commands &mdash; will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[38%]">Action</TableHead>
                <TableHead>User</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const meta = actionMeta(entry.action);
                const detail = describeMetadata(entry.action, entry.metadata);
                const Icon = meta.icon;
                return (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`flex size-6 shrink-0 items-center justify-center rounded-md ${CATEGORY_TONE[meta.category]}`}
                          >
                            <Icon className="size-3.5" />
                          </span>
                          <span className="text-sm font-medium">
                            {meta.label}
                          </span>
                        </div>
                        {detail && (
                          <span className="ml-8 truncate font-mono text-xs text-muted-foreground">
                            {detail}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-foreground">
                          {actorLabel(entry)}
                        </span>
                        {entry.ip && (
                          <span className="font-mono text-xs text-muted-foreground">
                            {entry.ip}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                      {formatRelative(entry.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ActivitySkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[38%]">Action</TableHead>
          <TableHead>User</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 6 }).map((_, i) => (
          <TableRow key={i}>
            <TableCell>
              <div className="flex items-center gap-2">
                <Skeleton className="size-6 rounded-md" />
                <Skeleton className="h-4 w-32" />
              </div>
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-28" />
            </TableCell>
            <TableCell>
              <Skeleton className="ml-auto h-4 w-16" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
