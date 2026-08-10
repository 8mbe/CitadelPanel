"use client";

import * as React from "react";
import { OctagonX, Play, RotateCw, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useServerData } from "@/components/server/server-data-context";
import { ApiError, killServer, restartServer, startServer, stopServer } from "@/lib/api";

/**
 * Power controls for a server.
 *
 * Each action calls the real backend endpoint and reflects the returned status.
 * The backend drives the actual container lifecycle; a transition status
 * (starting/stopping) is shown while the request is in flight, then reconciled
 * to whatever the backend reports.
 *
 * Kill: when a graceful Stop or Restart is in flight (status `stopping`), the
 * Stop button morphs into a red Kill. It is disabled for a short grace window
 * after the transition starts (so the graceful shutdown gets a fair chance),
 * then arms — at which point clicking it sends SIGKILL to force the container
 * down immediately. Kill is the escape hatch for a container wedged in a
 * graceful stop; it is never shown while the server is simply running.
 */
export function PowerControls() {
  const { server, status, setStatus, refresh } = useServerData();
  const [pending, setPending] = React.useState(false);
  /** Which graceful action is in flight, so Kill knows it's the fallback. */
  const [pendingAction, setPendingAction] = React.useState<
    "stop" | "restart" | null
  >(null);
  const [error, setError] = React.useState<string | null>(null);

  const stopping = status === "stopping";
  // Kill arms a few seconds into a graceful stop, so the graceful path gets a
  // real chance before the user reaches for the destructive option.
  const [killArmed, setKillArmed] = React.useState(false);
  React.useEffect(() => {
    if (!stopping) {
      setKillArmed(false);
      return;
    }
    const t = setTimeout(() => setKillArmed(true), 3000);
    return () => clearTimeout(t);
  }, [stopping]);

  const isBusy =
    pending ||
    ["starting", "stopping", "installing", "creating"].includes(status);
  const canStart = ["stopped", "suspended", "error"].includes(status);
  const canStop = status === "running";

  const act = async (
    optimistic: "starting" | "stopping",
    action: "stop" | "restart" | null,
    fn: (id: string) => Promise<unknown>,
  ) => {
    setPending(true);
    setError(null);
    setPendingAction(action);
    setStatus(optimistic);
    try {
      await fn(server.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
      await refresh();
    } finally {
      setPending(false);
      setPendingAction(null);
    }
  };

  const kill = async () => {
    setPending(true);
    setError(null);
    setPendingAction("stop");
    try {
      await killServer(server.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kill failed.");
      await refresh();
    } finally {
      setPending(false);
      setPendingAction(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => act("starting", null, startServer)}
          disabled={!canStart || isBusy}
          size="sm"
        >
          <Play />
          Start
        </Button>
        <Button
          variant="secondary"
          onClick={() => act("stopping", "restart", restartServer)}
          disabled={!canStop || isBusy}
          size="sm"
        >
          <RotateCw />
          Restart
        </Button>
        {stopping && pendingAction ? (
          // A graceful stop/restart is in flight: offer Kill as the escape hatch.
          <Button
            variant="destructive"
            onClick={kill}
            disabled={!killArmed || pending}
            size="sm"
            title={
              killArmed
                ? "Force-stop the container immediately (SIGKILL). The server will not get a chance to save."
                : "Kill becomes available shortly if the graceful stop doesn't finish…"
            }
          >
            <OctagonX />
            Kill
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => act("stopping", "stop", stopServer)}
            disabled={!canStop || isBusy}
            size="sm"
          >
            <Square />
            Stop
          </Button>
        )}
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
