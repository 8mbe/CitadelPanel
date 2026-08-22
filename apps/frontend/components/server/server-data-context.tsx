"use client";

import * as React from "react";

import { getServer, getServerStats } from "@/lib/api";
import { isProvisioning } from "@/lib/server-status";
import type { ServerStatus, ServerView } from "@/lib/types";

/**
 * Per-server page data.
 *
 * The server layout loads one {@link ServerView} and shares it with every
 * section (console, players, settings, …) through this context, so each section
 * route does not re-fetch. Live status is mutable here — power controls flip it
 * and the header/console read it — while the rest of the record is refreshed
 * from the backend on demand.
 */
interface ServerDataValue {
  server: ServerView;
  status: ServerStatus;
  setStatus: (status: ServerStatus) => void;
  /** Re-fetch the server record (e.g. after an env or resource change). */
  refresh: () => Promise<void>;
  /**
   * Register interest in the live resource sample. Returns the unsubscribe.
   * Use {@link useLiveResourceStats} rather than calling this directly.
   */
  watchStats: () => () => void;
}

const ServerDataContext = React.createContext<ServerDataValue | null>(null);

export function ServerDataProvider({
  initial,
  children,
}: {
  initial: ServerView;
  children: React.ReactNode;
}) {
  const [server, setServer] = React.useState<ServerView>(initial);
  const [status, setStatus] = React.useState<ServerStatus>(initial.status);

  const refresh = React.useCallback(async () => {
    const fresh = await getServer(initial.id);
    if (fresh) {
      setServer(fresh);
      setStatus(fresh.status);
    }
  }, [initial.id]);

  // While the server is mid-transition, re-read the record itself rather than a
  // resource sample: what matters is when the transition ends, not what the CPU
  // is doing.
  //
  // Provisioning (`creating`/`installing`) is the long case: there is no
  // container to sample, and this poll is what lets the shell's installing gate
  // fall away on its own — an owner who opened the page mid-install gets their
  // server without reloading, and an admin watching the install log sees the
  // console take over. Minutes long, so 5s is plenty.
  //
  // `starting`/`stopping` are the short case, and they need the *other* cadence.
  // A stop is seconds, and it is the window in which the power controls offer
  // Kill — a page that opened during someone else's stop has to see the stop
  // land, or it sits on a Kill button for a server that is already down.
  const recordPollMs = isProvisioning(status)
    ? 5000
    : status === "starting" || status === "stopping"
      ? 2000
      : null;

  React.useEffect(() => {
    if (recordPollMs === null) return;

    let cancelled = false;
    const interval = setInterval(() => {
      if (!cancelled) void refresh().catch(() => undefined);
    }, recordPollMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [recordPollMs, refresh]);

  // How many mounted components are actually showing the resource sample.
  //
  // This provider wraps the whole server page, but the stats cards live in one
  // section (the console). Polling unconditionally meant every other tab — files,
  // settings, backups, activity — sat there sampling CPU on a timer for numbers
  // nobody was looking at. Consumers declare their interest through
  // {@link useLiveResourceStats}, and the poll below runs only while at least one
  // of them is mounted.
  const [statsWatchers, setStatsWatchers] = React.useState(0);

  const watchStats = React.useCallback(() => {
    setStatsWatchers((n) => n + 1);
    return () => setStatsWatchers((n) => n - 1);
  }, []);

  // Only whether anyone is watching, not how many: a second consumer mounting
  // must not tear down and restart the running interval.
  const statsWanted = statsWatchers > 0;

  // Poll a live resource sample so the stats cards and status stay current
  // without a manual refresh.
  //
  // Cadence depends on status: while running, sample every 5s for CPU/mem/disk.
  // While stopped or errored, keep sampling every 30s — disk usage is a
  // property of the data directory and still changes offline (world saves,
  // manual file edits), and the agent reports it even with the container
  // stopped. CPU/mem come back zeroed in that case, which is correct. Other
  // transitional states (creating, installing, deleting, suspended) don't poll.
  const pollIntervalMs =
    status === "running"
      ? 5000
      : status === "stopped" || status === "error"
        ? 30000
        : null;

  React.useEffect(() => {
    if (pollIntervalMs === null || !statsWanted) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const stats = await getServerStats(initial.id);
        if (cancelled || !stats) return;
        setServer((prev) => ({
          ...prev,
          cpuPercent: Math.round(stats.cpuPercent),
          memoryUsedMb: Math.round(stats.memoryUsageMb),
          diskUsedMb: Math.round(stats.diskUsageMb),
        }));
      } catch {
        // A transient sample failure should not tear down the page.
      }
    };

    // Sample right away so the cards react without a poll delay, then keep the
    // interval. Any later effect run (a status change flipping the cadence)
    // samples immediately for the same reason.
    void tick();
    const interval = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, pollIntervalMs, statsWanted, initial.id]);

  const value = React.useMemo<ServerDataValue>(
    () => ({
      server: { ...server, status },
      status,
      setStatus,
      refresh,
      watchStats,
    }),
    [server, status, refresh, watchStats],
  );

  return (
    <ServerDataContext.Provider value={value}>
      {children}
    </ServerDataContext.Provider>
  );
}

export function useServerData(): ServerDataValue {
  const ctx = React.useContext(ServerDataContext);
  if (!ctx) {
    throw new Error("useServerData must be used inside a ServerDataProvider");
  }
  return ctx;
}

/**
 * Declare that this component is displaying the live resource sample.
 *
 * The provider polls `/stats` only while at least one component has said this,
 * so the poll follows what is on screen rather than running for the whole time
 * a server page is open. Call it from the component that renders the numbers —
 * keeping the declaration next to the display is what stops the two drifting
 * apart when a section moves.
 */
export function useLiveResourceStats(): void {
  const { watchStats } = useServerData();
  React.useEffect(() => watchStats(), [watchStats]);
}

/**
 * Back-compat status hook, now backed by {@link ServerDataProvider}. Existing
 * components read `[status, setStatus]` exactly as before.
 */
export function useServerStatus(): [ServerStatus, (status: ServerStatus) => void] {
  const { status, setStatus } = useServerData();
  return [status, setStatus];
}
