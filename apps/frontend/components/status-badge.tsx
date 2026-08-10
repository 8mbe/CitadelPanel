import type { ServerStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  ServerStatus,
  { label: string; dot: string; badge: string }
> = {
  running: {
    label: "Running",
    dot: "bg-emerald-500",
    badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  starting: {
    label: "Starting",
    dot: "bg-amber-500 animate-pulse",
    badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  stopping: {
    label: "Stopping",
    dot: "bg-amber-500 animate-pulse",
    badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  stopped: {
    label: "Stopped",
    dot: "bg-muted-foreground/50",
    badge: "bg-muted text-muted-foreground",
  },
  suspended: {
    label: "Suspended",
    dot: "bg-orange-500",
    badge: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  },
  error: {
    label: "Error",
    dot: "bg-destructive",
    badge: "bg-destructive/10 text-destructive",
  },
  creating: {
    label: "Creating",
    dot: "bg-sky-500 animate-pulse",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  installing: {
    label: "Installing",
    dot: "bg-sky-500 animate-pulse",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  deleting: {
    label: "Deleting",
    dot: "bg-destructive animate-pulse",
    badge: "bg-destructive/10 text-destructive",
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: ServerStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", meta.badge, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}
