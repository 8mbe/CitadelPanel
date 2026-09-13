"use client";

import * as React from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getServerStartFailure } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Why the last start did not hold, with the output that explains it.
 *
 * A start that fails on boot leaves almost no trace on its own: the panel says
 * `stopped`, which is true and useless, and the container that printed the
 * reason has usually been restarted or removed by the time anyone looks. The
 * panel captures that output when it happens (see
 * `services/startWatchdog.ts`); this is where the person who pressed Start
 * reads it.
 *
 * The reason comes from the server summary the page already has, so the banner
 * appears with the page. The captured log is a second request, made only when
 * the reader opens it: it can be tens of kilobytes and most visitors want the
 * one-line reason, not the stack trace.
 */
export function StartFailureAlert({
  serverId,
  failure,
}: {
  serverId: string;
  failure: { reason: string; at: string };
}) {
  const [open, setOpen] = React.useState(false);
  const [log, setLog] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetched on first open only. The record is immutable once written -- a new
  // start replaces it wholesale, and that arrives as a new `failure` prop --
  // so there is nothing to re-read on a second open.
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || log !== null || loading) return;

    setLoading(true);
    setError(null);
    try {
      const view = await getServerStartFailure(serverId);
      setLog(view?.log ?? "");
    } catch {
      setError("The captured output could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  // A new failure (different timestamp) invalidates whatever was fetched for
  // the previous one, so the panel never shows an old run's output under a new
  // run's reason.
  React.useEffect(() => {
    setLog(null);
    setOpen(false);
    setError(null);
  }, [failure.at]);

  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>This server stopped shortly after it started</AlertTitle>
      <AlertDescription>
        <p>{failure.reason}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {new Date(failure.at).toLocaleString()}
        </p>

        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={toggle}
          aria-expanded={open}
        >
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
          {open ? "Hide output" : "Show output"}
        </Button>

        {open && (
          <div className="mt-2 max-h-80 overflow-auto rounded-lg border bg-zinc-950 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-300">
            {loading
              ? "Loading…"
              : error
                ? error
                : log && log.length > 0
                  ? log
                  : "The server produced no output before it stopped."}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
