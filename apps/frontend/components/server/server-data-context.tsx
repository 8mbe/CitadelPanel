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

  // While the server is still being built, re-read the record itself rather
  // than a resource sample: there is no container to sample, and the thing worth
  // knowing is when the provision ends. This is what lets the shell's installing
  // gate fall away on its own — an owner who opened the page mid-install gets
  // their server without reloading, and an admin watching the install log sees
  // the console take over. Provisioning is minutes long, so 5s is plenty.
  React.useEffect(() => {
    if (!isProvisioning(status)) return;

    let cancelled = false;
    const interval = setInterval(() => {
      if (!cancelled) void refresh().catch(() => undefined);
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, refresh]);

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
    if (pollIntervalMs === null) return;

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

    void tick();
    const interval = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, pollIntervalMs, initial.id]);

  const value = React.useMemo<ServerDataValue>(
    () => ({ server: { ...server, status }, status, setStatus, refresh }),
    [server, status, refresh],
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
 * Back-compat status hook, now backed by {@link ServerDataProvider}. Existing
 * components read `[status, setStatus]` exactly as before.
 */
export function useServerStatus(): [ServerStatus, (status: ServerStatus) => void] {
  const { status, setStatus } = useServerData();
  return [status, setStatus];
}
