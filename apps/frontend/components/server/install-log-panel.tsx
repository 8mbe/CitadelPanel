"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { getServerInstallLog } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ServerInstallLogView } from "@/lib/types";

/** How often the log is re-read while a provision is in flight. */
const POLL_MS = 2_000;

/**
 * Provisioning output, in place of the live console.
 *
 * A server being built has no container to attach to, so the console has
 * nothing to show. But the interesting output exists: the blueprint's install
 * script is running on the node right now, and before it there was an image to
 * pull. This is that output, polled rather than streamed. Polling is the right
 * shape here: the panel merges two sources (its own record of the provision and
 * the live tail from the node), a provision is minutes long, and a two-second
 * refresh reads the same as a stream at this pace.
 *
 * Admin-only, matching the endpoint. Non-admins never render this. They see the
 * installing notice in the server shell instead.
 *
 * Polling stops as soon as the log says the provision is over, so a finished
 * server does not keep asking. The final state stays on screen: a failed
 * install is exactly what an admin came here to read, and the shell's status
 * poll is what moves the page on once the server is ready.
 */
export function InstallLogPanel({ serverId }: { serverId: string }) {
  const [view, setView] = React.useState<ServerInstallLogView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // "Sticky to bottom", same rule as the console: follow new output only while
  // the reader is parked at the newest line, so scrolling up to read the start
  // of an install is not yanked away by the next poll.
  const stickToBottom = React.useRef(true);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const fresh = await getServerInstallLog(serverId);
        if (cancelled) return;
        setView(fresh);
        setError(null);
        // Once provisioning is done the log is final, so stop asking.
        if (fresh.provisioning) timer = setTimeout(tick, POLL_MS);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof Error ? caught.message : "Could not read the install log.",
        );
        timer = setTimeout(tick, POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [serverId]);

  React.useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [view]);

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const lines = view?.log.split("\n").filter((line) => line.length > 0) ?? [];

  return (
    <div className="flex h-[28rem] flex-col overflow-hidden rounded-xl border bg-zinc-950 ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-xs text-zinc-400">
        {view?.provisioning !== false && <Loader2 className="size-3 animate-spin" />}
        <span>
          {view === null
            ? "Reading install log…"
            : view.provisioning
              ? "Installing this server on its node"
              : view.status === "error"
                ? "Provisioning failed"
                : "Provisioning finished"}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-zinc-300"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            {error ?? "No output yet. The node is pulling the install image."}
          </div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap",
                // The panel's own phase lines are commentary around the
                // script's output, so they read as a quieter voice.
                line.startsWith("[panel] ") && "text-zinc-500",
              )}
            >
              {line}
            </div>
          ))
        )}
      </div>

      {error && lines.length > 0 && (
        <div className="border-t border-zinc-800 px-3 py-1.5 font-mono text-xs text-amber-500">
          {error}
        </div>
      )}
    </div>
  );
}
