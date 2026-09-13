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
  // Sky, like creating/installing: the server is being built somewhere, and
  // the pulse says a long operation owns it. Not amber, which this palette
  // reserves for the seconds-long power transitions.
  // Sky and pulsing, like the other long transfers: an archive is a world being
  // uploaded or downloaded, and it takes as long as a migration does.
  archiving: {
    label: "Archiving",
    dot: "bg-sky-500 animate-pulse",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  restoring: {
    label: "Restoring",
    dot: "bg-sky-500 animate-pulse",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  // Settled, not transitional, so no pulse. Deliberately quieter than
  // `suspended`: an archived server is a normal thing an owner chose, not a
  // sanction, and it must not read as one in a list of servers. Muted like
  // `stopped`, which is the state it is closest to, with its own label doing the
  // work of telling them apart.
  archived: {
    label: "Archived",
    dot: "bg-muted-foreground/50",
    badge: "bg-muted text-muted-foreground",
  },
  migrating: {
    label: "Migrating",
    dot: "bg-sky-500 animate-pulse",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
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
