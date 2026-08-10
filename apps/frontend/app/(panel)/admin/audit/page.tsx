"use client";

import * as React from "react";
import { ClipboardList } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminListAuditLogs, ApiError, type AdminAuditEntry } from "@/lib/api";
import { formatRelative } from "@/lib/format";

/**
 * Audit log viewer: a chronological record of every state-changing action on
 * the panel (server lifecycle, config edits, role changes, enforcement). Each
 * row shows who, what, when, and which target was affected.
 *
 * Entries come from the backend's admin audit endpoint; load failures are shown
 * inline rather than masked.
 */
export default function AdminAuditPage() {
  const [entries, setEntries] = React.useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const logs = await adminListAuditLogs(100);
        if (!cancelled) setEntries(logs);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Failed to load the audit log.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Audit log
        </h1>
        <p className="text-sm text-muted-foreground">
          {loading
            ? "Loading recent activity…"
            : error
              ? error
              : entries.length === 0
                ? "No entries yet."
                : `${entries.length} recent actions.`}
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-5 w-40" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-5 w-20" />
                    </TableCell>
                  </TableRow>
                ))
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="h-32 text-center text-sm text-muted-foreground"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <ClipboardList className="size-8 text-muted-foreground/50" />
                      <span>No audit entries yet.</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.userId ?? "system"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.targetType && entry.targetId
                        ? `${entry.targetType}:${entry.targetId.slice(0, 8)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                      {formatRelative(entry.createdAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
