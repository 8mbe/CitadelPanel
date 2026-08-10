"use client";

import * as React from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ServerStatus } from "@/lib/types";


interface Line {
  id: number;
  text: string;
}

/** Lines kept in the DOM and requested as the initial backlog on (re)connect. */
const MAX_LINES = 100;

/**
 * Live console.
 *
 * Streams a server's log output over Server-Sent Events
 * (`/api/servers/:id/console/stream`), which the panel proxies to the node
 * agent's follow-mode Docker log stream. The browser never talks to the agent
 * directly. Command input is sent separately over the audited
 * `POST /api/servers/:id/command` endpoint.
 *
 * On open the agent replays the last {@link MAX_LINES} lines before live output
 * begins, so no separate backlog fetch is needed — and reloading the page shows
 * the same recent tail rather than an ever-growing history. The DOM is capped
 * to the same count so a long-running session never grows unbounded.
 *
 * The panel auto-scrolls to the newest line as output arrives, but stops doing
 * so the moment the user scrolls up to read history — so scrolling up to
 * inspect old logs is not yanked away by new output. It resumes when the user
 * scrolls back to the bottom.
 */
export function ConsolePanel({
  serverId,
  status,
}: {
  serverId: string;
  status: ServerStatus;
}) {
  const [lines, setLines] = React.useState<Line[]>([]);
  const [command, setCommand] = React.useState("");
  const [connected, setConnected] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const nextId = React.useRef(1);

  // "Sticky to bottom": true while the view is parked at the newest line. New
  // output auto-scrolls only while this is true; scrolling up sets it false so
  // the user can read history undisturbed, and scrolling back to the bottom
  // re-enables auto-scroll.
  const stickToBottom = React.useRef(true);

  const running = status === "running" || status === "starting";

  const append = React.useCallback((text: string) => {
    setLines((prev) => {
      const next = [...prev, { id: nextId.current++, text }];
      // Bound the DOM to the last MAX_LINES so a long session never grows
      // unbounded. Older history is gone from the view but a reload re-fetches
      // the recent tail from the agent.
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  const scrollToBottom = React.useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Auto-scroll on new output only when the user is parked at the bottom.
  React.useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [lines, scrollToBottom]);

  // Track whether the user is at the bottom. A small tolerance covers rounding
  // and fractional-pixel scroll positions across browsers.
  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickToBottom.current = atBottom;
  }, []);

  React.useEffect(() => {
    // The stream stays open across status transitions: a server prints its
    // most useful output (world save, crash trace) while shutting down, and the
    // user should be able to read history while the server is offline. The
    // agent's `follow:true` dockerode stream ends when the container exits;
    // EventSource then auto-reconnects, and a server that stays down gets a
    // one-shot `emptyStream` close from the panel route — harmless, no thrash.
    nextId.current = 1;
    stickToBottom.current = true;

    const es = new EventSource(
      `/api/servers/${serverId}/console/stream?tail=${MAX_LINES}`,
    );

    es.onopen = () => {
      // Clear stale lines so a fresh connection's backlog (e.g. after a
      // stop→start cycle) isn't appended to the previous session's output.
      setLines([]);
      setConnected(true);
    };

    // Default (unnamed) events carry one console log line each.
    es.onmessage = (event) => {
      if (event.data.length > 0) append(event.data);
    };

    // Named `console` events carry terminal messages from the panel/agent
    // (node unreachable, no container, etc.). Surface them inline so a silent
    // failure is not invisible.
    es.addEventListener("console", (event) => {
      const messageEvent = event as MessageEvent;
      try {
        const payload = JSON.parse(messageEvent.data) as { message?: string };
        if (payload.message) append(`[console] ${payload.message}`);
      } catch {
        if (messageEvent.data) append(`[console] ${messageEvent.data}`);
      }
    });

    // EventSource auto-reconnects on transient errors; only flag the state.
    // The existing lines stay on screen so history remains readable while
    // disconnected.
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      setConnected(false);
    };
  }, [serverId, append]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = command.trim();
    if (!trimmed) return;
    setCommand("");

    // Echo the command immediately, BEFORE sending it. The server's response
    // arrives over the SSE stream, which can fire `append` while the POST is in
    // flight — echoing after the await let output land above the echo. Echoing
    // first keeps input above its own output in reading order.
    append(`> ${trimmed}`);

    const response = await fetch(`/api/servers/${serverId}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: trimmed }),
    });
    if (!response.ok) append("[panel] command could not be sent.");
  };

  return (
    <div className="flex h-[28rem] flex-col overflow-hidden rounded-xl border bg-zinc-950 ring-1 ring-foreground/10">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-zinc-300"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            {!running
              ? "Server is offline — start it to see live console output."
              : connected
                ? "Waiting for output…"
                : "Connecting…"}
          </div>
        ) : (
          <>
            {!running && (
              <div className="mb-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-center text-zinc-500">
                Server is offline — showing the last console output.
              </div>
            )}
            {lines.map((line) => (
              <div key={line.id} className="whitespace-pre-wrap">
                {line.text}
              </div>
            ))}
          </>
        )}
      </div>
      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-zinc-800 p-2"
      >
        <span className="pl-2 font-mono text-xs text-zinc-500 select-none">
          &gt;
        </span>
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={running ? "Type a console command…" : "Server is offline"}
          disabled={!running || !connected}
          className={cn(
            "border-transparent bg-zinc-900 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus-visible:border-zinc-700",
          )}
          aria-label="Console command"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!running || !connected || !command.trim()}
        >
          <Send />
          <span className="sr-only">Send command</span>
        </Button>
      </form>
    </div>
  );
}
