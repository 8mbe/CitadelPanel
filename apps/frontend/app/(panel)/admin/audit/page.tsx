"use client";

import * as React from "react";
import Link from "next/link";
import { ClipboardList, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  actionMeta,
  CATEGORY_TONE,
  describeMetadata,
} from "@/lib/audit-actions";
import { adminListAuditLogs, ApiError, type AdminAuditEntry } from "@/lib/api";
import { formatRelative } from "@/lib/format";

/**
 * Fleet-wide audit log viewer.
 *
 * Every state-changing action across the panel is recorded in the audit log;
 * this page surfaces the most recent ones for an admin. Each row shows what
 * happened (labelled, not as a raw action string), who did it (name, linked to
 * their account), which target was affected (named and linked where a detail
 * page exists), the originating IP, and when.
 *
 * Actor identities and target names are resolved server-side in batched queries
 * (see handleListAuditLogs) so this page needs a single round-trip regardless
 * of how many distinct users or targets appear.
 */

export default function AdminAuditPage() {
  const [entries, setEntries] = React.useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const logs = await adminListAuditLogs(100);
      setEntries(logs);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to load the audit log.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

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
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
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
                  ? "No activity recorded yet."
                  : `${entries.length} recent action${entries.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
        {loading ? (
          <AuditSkeleton />
        ) : error ? (
          <Empty className="min-h-[14rem] rounded-b-xl">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ClipboardList />
              </EmptyMedia>
              <EmptyTitle>Couldn&apos;t load the audit log</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : entries.length === 0 ? (
          <Empty className="min-h-[14rem] rounded-b-xl">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ClipboardList />
              </EmptyMedia>
              <EmptyTitle>No audit entries yet</EmptyTitle>
              <EmptyDescription>
                State-changing actions across the panel &mdash; server lifecycle,
                config edits, role changes, enforcement &mdash; will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[34%]">Action</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Target</TableHead>
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
                      <ActorCell entry={entry} />
                    </TableCell>
                    <TableCell>
                      <TargetCell entry={entry} />
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
    </>
  );
}

/**
 * The "who" column. Shows the actor's name (or email, or a truncated id) as a
 * link to their admin account page when the actor is a real user; falls back to
 * "system" for null-user actions (setup, automated sweeps). A deleted account
 * (user_id set but no resolved name/email) shows a truncated id without a link.
 */
function ActorCell({ entry }: { entry: AdminAuditEntry }) {
  const label =
    entry.actorName ?? entry.actorEmail ?? entry.userId?.slice(0, 8) ?? "system";
  const ip = entry.ip;

  if (!entry.userId) {
    // System action — no account to link to.
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-muted-foreground">{label}</span>
        {ip && (
          <span className="font-mono text-xs text-muted-foreground/70">{ip}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <Link
        href={`/admin/users/${entry.userId}`}
        className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        {label}
      </Link>
      {ip && (
        <span className="font-mono text-xs text-muted-foreground/70">{ip}</span>
      )}
    </div>
  );
}

/**
 * The "what was affected" column. Resolves the target to a name (from the
 * server-side join) and links to the target's detail page when one exists.
 * Server targets link to the owner-facing server page; node and user targets
 * link to their admin pages; blueprints/suspicious/etc. show a name or type
 * label without a link (no dedicated detail page, or the page is the admin
 * list itself).
 */
function TargetCell({ entry }: { entry: AdminAuditEntry }) {
  const { targetType, targetId, targetName } = entry;

  if (!targetType || !targetId) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  // Prefer the resolved name; fall back to a readable type label + truncated id
  // so the column is never just an opaque UUID.
  const label = targetName ?? `${targetLabel(targetType)} ${targetId.slice(0, 8)}`;
  const href = targetHref(targetType, targetId);

  if (href) {
    return (
      <Link
        href={href}
        className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    );
  }

  return (
    <div className="flex flex-col">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xs text-muted-foreground/70">{targetType}</span>
    </div>
  );
}

/** Human-readable label for a target type, used when no name was resolved. */
function targetLabel(targetType: string): string {
  switch (targetType) {
    case "server":
      return "Server";
    case "node":
      return "Node";
    case "user":
      return "User";
    case "blueprint":
      return "Blueprint";
    case "database":
      return "Database";
    case "subuser":
      return "Subuser";
    case "suspicious_activity":
      return "Flag";
    case "settings":
      return "Settings";
    default:
      return targetType;
  }
}

/** Detail-page href for a target, or null when there is no dedicated page. */
function targetHref(targetType: string, targetId: string): string | null {
  switch (targetType) {
    case "server":
      // The server page is owner-facing but admin-accessible.
      return `/servers/${targetId}`;
    case "node":
      return `/admin/nodes/${targetId}`;
    case "user":
      return `/admin/users/${targetId}`;
    // blueprint: the admin blueprints list is the closest thing; linking to a
    // specific blueprint isn't supported (no per-blueprint page), so leave it
    // unlinked rather than dropping the admin on a list view.
    default:
      return null;
  }
}

function AuditSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[34%]">Action</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Target</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 8 }).map((_, i) => (
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
              <Skeleton className="h-4 w-24" />
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
