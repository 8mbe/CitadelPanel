"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminListSuspicious, adminReviewSuspicious, ApiError } from "@/lib/api";
import { formatRelative, scoreTone } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SuspiciousActivityView } from "@/lib/types";

/**
 * The resource-abuse review queue.
 *
 * The panel flags and records; a human decides. Each flag is evidence for an
 * admin, never an automatic verdict — reviewing it (or dismissing it) is a
 * separate action from any enforcement (suspend), which lives on the server.
 */
export function SecurityQueue() {
  const [items, setItems] = React.useState<SuspiciousActivityView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<"open" | "all">("open");
  const [selected, setSelected] = React.useState<SuspiciousActivityView | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { activity } = await adminListSuspicious(filter === "all");
        if (cancelled) return;
        setItems(activity);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : "Failed to load the queue.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const openCount = items.filter((i) => !i.reviewed).length;
  const visible = [...items].sort((a, b) => b.score - a.score);

  const review = async (id: string) => {
    try {
      await adminReviewSuspicious(id, true);
      // Reflect locally; a full reload also picks up server-side ordering.
      setItems((prev) =>
        prev.map((i) => (i.id === id ? { ...i, reviewed: true } : i)),
      );
      setSelected(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to mark reviewed.");
    }
  };

  return (
    <>
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Security
          </h1>
          <p className="text-sm text-muted-foreground">
            Resource-abuse detection: {openCount} flagged{" "}
            {openCount === 1 ? "event" : "events"} to review. Scores are evidence
            for a human decision, not proof — nothing is suspended automatically.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border p-0.5">
          {(["open", "all"] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f === "open" ? "Open" : "All"}
            </Button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheck />
            </EmptyMedia>
            <EmptyTitle>All clear</EmptyTitle>
            <EmptyDescription>
              No suspicious activity matches this filter.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3">
          {visible.map((item) => {
            const tone = scoreTone(item.score);
            return (
              <div
                key={item.id}
                className={cn(
                  "flex flex-col gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/5 md:flex-row md:items-center",
                  item.reviewed && "opacity-60",
                )}
              >
                <div
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-lg",
                    tone === "destructive" && "bg-destructive/10 text-destructive",
                    tone === "secondary" &&
                      "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                    tone === "outline" && "bg-muted text-muted-foreground",
                  )}
                >
                  <AlertTriangle className="size-4" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {item.serverName ?? item.serverId}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-normal",
                        item.reviewed
                          ? "bg-muted text-muted-foreground"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {item.reviewed ? "Reviewed" : "Open"}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {item.ownerEmail ?? "unknown"} ·{" "}
                      {formatRelative(item.detectedAt)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {item.reason}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Badge
                    variant={tone}
                    className="min-w-12 justify-center px-2.5 tabular-nums"
                  >
                    {item.score}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(item)}
                  >
                    <Eye />
                    Evidence
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <EvidenceDialog
        selected={selected}
        onClose={() => setSelected(null)}
        onReview={review}
      />
    </>
  );
}

function EvidenceDialog({
  selected,
  onClose,
  onReview,
}: {
  selected: SuspiciousActivityView | null;
  onClose: () => void;
  onReview: (id: string) => void;
}) {
  return (
    <Dialog open={selected !== null} onOpenChange={(open) => !open && onClose()}>
      {selected && (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>Evidence</DialogTitle>
              <Badge variant={scoreTone(selected.score)} className="tabular-nums">
                score {selected.score}
              </Badge>
            </div>
            <DialogDescription>
              {selected.serverName ?? selected.serverId}
              {" — "}
              {selected.ownerEmail ?? "unknown owner"} ·{" "}
              {formatRelative(selected.detectedAt)}
            </DialogDescription>
          </DialogHeader>

          <p className="text-sm">{selected.reason}</p>

          <Separator />

          {selected.evidence.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <TriangleAlert className="size-4" />
              No structured evidence was captured for this flag.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-48">Field</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selected.evidence.map((e) => (
                  <TableRow key={e.field}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {e.field}
                    </TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {e.value}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!selected.reviewed && (
            <DialogFooter>
              <Button onClick={() => onReview(selected.id)}>
                <CheckCircle2 />
                Mark reviewed
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
