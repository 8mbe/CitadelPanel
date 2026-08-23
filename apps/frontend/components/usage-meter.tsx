"use client";

import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/**
 * A resource-usage bar whose colour means something.
 *
 * Every meter in the panel used to fill in `bg-primary`, which made a server at
 * 3% of its memory and one 3% from an OOM kill exactly the same colour. The bar
 * told you nothing the number next to it did not already say, while looking
 * like an alarm at every value. Worse, the primary colour is the operator's
 * brand (see `docs/theming.md`), so what the fill "meant" changed with the
 * site's paint.
 *
 * So the fill is neutral until the value is worth reacting to, and the two
 * thresholds are the only thing that colours it. A glance down a list of
 * servers or nodes now finds the one in trouble.
 */
const WARNING_PCT = 75;
const CRITICAL_PCT = 90;

export type UsageTone = "normal" | "warning" | "critical";

/** Where a percentage falls against the two thresholds. */
export function usageTone(percent: number): UsageTone {
  if (percent >= CRITICAL_PCT) return "critical";
  if (percent >= WARNING_PCT) return "warning";
  return "normal";
}

// Amber for "notice this" and destructive for "act on this", matching the
// vocabulary `StatusBadge` and the node connection tests already use.
const TONE_FILL: Record<UsageTone, string> = {
  normal: "bg-muted-foreground",
  warning: "bg-amber-500",
  critical: "bg-destructive",
};

export function UsageMeter({
  value,
  label,
  className,
}: {
  /** Percentage full, 0 to 100. Clamped, so callers may pass raw ratios. */
  value: number;
  /** Announced to screen readers, since the bar itself has no visible text. */
  label?: string;
  className?: string;
}) {
  const percent = Math.min(100, Math.max(0, Math.round(value)));

  return (
    <Progress
      value={percent}
      aria-label={label}
      className={cn("w-full", className)}
      indicatorClassName={cn(
        "rounded-full",
        TONE_FILL[usageTone(percent)],
        // A single-digit percentage is a few pixels wide, which reads as a
        // rendering artifact rather than a measurement. Floor it to a dot:
        // `min-width` wins over the inline width the primitive sets.
        percent > 0 && "min-w-1",
      )}
    />
  );
}
