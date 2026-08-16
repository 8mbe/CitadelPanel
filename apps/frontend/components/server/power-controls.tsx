"use client";

import * as React from "react";
import { OctagonX, Play, RotateCw, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useServerData } from "@/components/server/server-data-context";
import { viewerAllows } from "@/lib/permissions";
import { ApiError, killServer, restartServer, startServer, stopServer } from "@/lib/api";

/**
 * Power controls for a server.
 *
 * Each action calls the real backend endpoint and reflects the returned status.
 * The backend drives the actual container lifecycle; a transition status
 * (starting/stopping) is shown while the request is in flight, then reconciled
 * to whatever the backend reports.
 *
 * Rendered only for viewers holding `start_stop` — for anyone else the row is
 * absent rather than disabled, since there is nothing they could do with it.
 * The backend rejects the calls regardless; this is presentation.
 *
 * Kill: whenever the server is in a graceful stop (status `stopping` — whether
 * this client initiated it or not), the Stop button morphs into a red Kill. It
 * is disabled for a short grace window after the transition starts (so the
 * graceful shutdown gets a fair chance), then arms — at which point clicking it
 * sends SIGKILL to force the container down immediately. Kill is the escape
 * hatch for a container wedged in a graceful stop; it is never shown while the
 * server is simply running.
 */
export function PowerControls() {
  const { server, status, setStatus, refresh } = useServerData();
  const [pending, setPending] = React.useState(false);
  // Separate from `pending`: a graceful stop can block on Docker for a long time
  // (a game server saving its world), and Kill is the escape hatch for exactly
  // that situation. If Kill shared `pending`, it would stay disabled for the
  // whole graceful stop — defeating its purpose.
  const [killPending, setKillPending] = React.useState(false);
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

  // After the hooks: a viewer without `start_stop` gets no controls at all.
  if (!viewerAllows(server.viewer, "start_stop")) return null;

  const isBusy =
    pending ||
    ["starting", "stopping", "installing", "creating"].includes(status);
  // A suspended server is never startable by its owner — the layout replaces
  // the whole shell with a notice, and the backend rejects it regardless.
  const canStart = ["stopped", "error"].includes(status);
  const canStop = status === "running";

  const act = async (
    optimistic: "starting" | "stopping",
    fn: (id: string) => Promise<unknown>,
  ) => {
    setPending(true);
    setError(null);
    setStatus(optimistic);
    try {
      await fn(server.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
      await refresh();
    } finally {
      setPending(false);
    }
  };

  const kill = async () => {
    setKillPending(true);
    setError(null);
    try {
      await killServer(server.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kill failed.");
      await refresh();
    } finally {
      setKillPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => act("starting", startServer)}
          disabled={!canStart || isBusy}
          size="sm"
        >
          <Play />
          Start
        </Button>
        <Button
          variant="secondary"
          onClick={() => act("stopping", restartServer)}
          disabled={!canStop || isBusy}
          size="sm"
        >
          <RotateCw />
          Restart
        </Button>
        {stopping ? (
          // The server is in a graceful stop (whether or not this client is the
          // one that initiated it). Offer Kill as the escape hatch once the grace
          // window elapses, so a wedged shutdown can always be forced.
          <Button
            variant="destructive"
            onClick={kill}
            disabled={!killArmed || killPending}
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
            onClick={() => act("stopping", stopServer)}
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
