"use client";

import * as React from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  consoleStreamUrl,
  getPublicSettings,
  requestConsoleSession,
  revokeConsoleSession,
  sendConsoleCommand,
} from "@/lib/api";
import { ConsoleHelperDialog } from "@/components/server/console-helper-dialog";
import { parseAnsi, type AnsiRun } from "@/lib/ansi";
import { cn } from "@/lib/utils";
import type { ServerStatus } from "@/lib/types";


interface Line {
  id: number;
  /** Pre-parsed styled runs for this line. Parsing at append time (once) avoids
   *  re-parsing the whole history on every re-render. */
  runs: AnsiRun[];
}

/** Backoff between reconnection attempts, after a dropped or closed socket. */
const RECONNECT_MS = 3_000;

/**
 * How many direct-WebSocket attempts may fail before the console gives up on
 * it and switches to the panel-proxied stream for the rest of the mount.
 *
 * One failure is not enough to conclude anything: a node agent restarting, or
 * a container not yet up, closes the socket for reasons that fix themselves.
 * Two consecutive opens that never reach `ready` means the address itself is
 * unusable from this browser (no TLS, private hostname, blocked port), which
 * retrying cannot fix — and unlike a mint that fails outright, the browser is
 * given no error to read, so the count is the only signal there is.
 */
const DIRECT_FAILURES_BEFORE_PROXY = 2;

/**
 * Live console.
 *
 * Opens a direct WebSocket to the node agent. The panel mints a short-lived,
 * single-use capability token (`POST /api/servers/:id/console/session`) and
 * hands back a `wss://` URL the browser connects to. The panel is then out of
 * the data path: output and input both flow over the one socket. The agent
 * calls back to the panel to audit each command typed, so the
 * `server.console.command` trail is preserved even though input no longer
 * transits the panel.
 *
 * On open the agent replays the last {@link MAX_LINES} lines as `output` frames
 * before signaling `ready`, so no separate backlog fetch is needed, and
 * reloading the page shows the same recent tail rather than an ever-growing
 * history. After that backlog, live output accumulates without a cap so a full
 * session stays readable in the view; only the on-open replay is bounded.
 *
 * Reconnection mints a fresh token each time (tokens are single-use), and only
 * retries while the server is running. While stopped the last history stays
 * readable so shutdown output (world-save, crash traces) can be inspected.
 *
 * The panel auto-scrolls to the newest line as output arrives, but stops doing
 * so the moment the user scrolls up to read history, so scrolling up to
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

  // Whether the AI console helper is configured. Fetched once from public
  // settings (cached server-side); the helper button is hidden entirely when
  // false, so users never see a feature the operator has not turned on.
  const [aiEnabled, setAiEnabled] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await getPublicSettings();
        if (!cancelled) setAiEnabled(Boolean(settings.ai?.enabled));
      } catch {
        // Non-critical: leave the helper hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const nextId = React.useRef(1);
  // Whether the server's container has a pseudo-TTY. A TTY container's server
  // (e.g. Minecraft via JLine3) echoes typed commands back itself and prints an
  // interactive prompt, so the panel must NOT locally echo commands (that would
  // double them) and must NOT render the trailing partial line (it is JLine's
  // prompt, not log content).
  const ttyRef = React.useRef(false);

  // Raw-text accumulator for the current incomplete line. Live output frames
  // arrive on arbitrary byte boundaries (not newline-aligned), and ANSI escape
  // sequences can be split across frames, so we buffer until a newline arrives
  // and parse the whole line as one unit. The remainder (no trailing newline)
  // is shown as a live "pending" line at the bottom and re-parsed as it grows.
  const bufferRef = React.useRef("");
  const [pendingRuns, setPendingRuns] = React.useState<AnsiRun[]>([]);
  // The live console socket, held in a ref so `submit` can write input to it
  // without the socket being a render-tracked dependency.
  const wsRef = React.useRef<WebSocket | null>(null);
  // The token for the currently (or soon-to-be) open socket. Tracked so a
  // genuine page-leave can revoke the exact token, not "all my sessions for
  // this server", which would clobber another tab's console. Tokens are
  // single-use, so a fresh mint overwrites this and the stale token is dead
  // anyway; revoke only matters for the live one.
  const tokenRef = React.useRef<string | null>(null);
  // Whether this console has fallen back to the panel-proxied stream. Input
  // routing depends on it (agent socket vs the command API), and it is sticky
  // for the mount so a reconnect doesn't re-probe a node already known to be
  // unreachable from the browser.
  const proxyRef = React.useRef(false);

  // "Sticky to bottom": true while the view is parked at the newest line. New
  // output auto-scrolls only while this is true; scrolling up sets it false so
  // the user can read history undisturbed, and scrolling back to the bottom
  // re-enables auto-scroll.
  const stickToBottom = React.useRef(true);

  const running = status === "running" || status === "starting";
  // A ref mirror of `running` so the reconnect timer (a closure captured once
  // per effect run) sees the current value without re-subscribing the socket.
  // Updated in an effect below, not during render.
  const runningRef = React.useRef(running);

  // Keep the ref mirror in sync without touching it during render. The
  // connection effect reads `runningRef.current` from its reconnect timer.
  React.useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const append = React.useCallback((text: string) => {
    // Live output arrives on arbitrary byte boundaries. A single frame can
    // carry a partial line, several lines, or an ANSI sequence split across a
    // frame edge. Buffer until newlines and parse each complete line as one
    // unit so escapes never break across runs. The trailing partial line is
    // rendered live (re-parsed on each chunk) so in-progress output shows
    // immediately rather than waiting for a newline.
    bufferRef.current += text;
    const buf = bufferRef.current;
    // Split on true line terminators only: \r\n (Windows) and \n (Unix). A
    // bare \r (not followed by \n) is NOT a newline. It is a carriage return,
    // meaning "move cursor to column 0 so subsequent output overwrites the
    // current line." This is how JLine3's interactive prompt works: it prints
    // a prompt (e.g. ">...."), then when log output arrives it does \r + erase
    // (\x1b[K) to clear the prompt before writing the log line. Treating \r as
    // a line break would render the prompt as its own visible line.
    //
    // To emulate the overwrite: within each \n-delimited segment, keep only the
    // content after the LAST bare \r. The final overwrite wins, which is what
    // a terminal user sees. This also collapses progress-bar refreshes
    // (" 10%\r 20%\r 30%\n") to just the final " 30%".
    const parts = buf.split(/\r\n|\n/);
    // The last element is always the incomplete remainder (possibly "").
    bufferRef.current = parts.pop() ?? "";

    if (parts.length > 0) {
      const newLines = parts
        .map((p) => p.slice(Math.max(0, p.lastIndexOf("\r") + 1)))
        .map((p) => ({
          id: nextId.current++,
          runs: parseAnsi(p),
        }));
      setLines((prev) => [...prev, ...newLines]);
    }
    // The pending (partial) line: apply the same last-\r overwrite so a prompt
    // fragment followed by \r doesn't linger in the live view. For a TTY
    // container the trailing partial line is JLine3's interactive prompt
    // (e.g. ">...."), not log content, so suppress it entirely.
    if (ttyRef.current) {
      setPendingRuns([]);
    } else {
      const pending = bufferRef.current.slice(
        Math.max(0, bufferRef.current.lastIndexOf("\r") + 1),
      );
      setPendingRuns(parseAnsi(pending));
    }
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
    let ws: WebSocket | null = null;
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    // How many direct-WS attempts have opened and died without ever reaching
    // `ready`. Once this hits the threshold the console stops trying the direct
    // socket for the rest of this mount and stays on the proxied stream.
    let directFailures = 0;
    wsRef.current = null;
    tokenRef.current = null;
    proxyRef.current = false;

    // Clear the view for a fresh connection's backlog, so a stop→start cycle
    // does not append the new session's replay to the old session's output.
    const resetView = () => {
      nextId.current = 1;
      stickToBottom.current = true;
      setLines([]);
      bufferRef.current = "";
      setPendingRuns([]);
    };

    // One frame handler for both transports. The panel's proxied stream
    // deliberately re-emits the agent's own event shapes (`ready`, `output`,
    // `console`/`error`), so the only difference between a WS message and an
    // SSE message is how the bytes arrived.
    const handleFrame = (payload: string) => {
      let parsed: {
        type?: string;
        data?: unknown;
        message?: string;
        code?: string;
        tty?: boolean;
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return; // Ignore malformed frames rather than killing the console.
      }
      switch (parsed.type) {
        case "ready":
          // History frames arrive before `ready` on the WS path (the agent
          // replays them on open) and after it on the proxied path (where
          // `ready` is what carries `tty`). Either way it means connected.
          if (typeof parsed.tty === "boolean") ttyRef.current = parsed.tty;
          directFailures = 0;
          setConnected(true);
          break;
        case "output":
          if (typeof parsed.data === "string" && parsed.data.length > 0) {
            append(parsed.data);
          }
          break;
        case "closed":
          // Container exited. On the WS path the agent follows this with
          // ws.close(), and the reconnect is scheduled there; scheduling here
          // too would open two sockets. So this only updates the UI.
          setConnected(false);
          break;
        case "console":
        case "error": {
          // A container the node no longer has is not the viewer's problem to
          // decode: the panel rebuilds it from the stored spec on the next
          // power action, and the reconnect loop attaches on its own once it is
          // back. So say that, not the agent's Docker fact.
          const text =
            parsed.code === "no_container"
              ? "Please wait, rebuilding container…"
              : parsed.message;
          if (text) append(`[console] ${text}\n`);
          setConnected(false);
          break;
        }
      }
    };

    /**
     * The panel-proxied fallback: output over SSE, input over the command API.
     *
     * Used when the agent has no address this browser can open a WebSocket to.
     * EventSource carries the session cookie itself and reconnects on its own,
     * but its built-in retry has no notion of "the server is stopped", so the
     * stream is closed and re-opened by the same backoff the socket path uses.
     */
    const connectProxy = () => {
      if (closed) return;
      proxyRef.current = true;
      resetView();

      source = new EventSource(consoleStreamUrl(serverId));

      // The agent's SSE stream is not the WebSocket's JSON protocol. A log line
      // is sent as a *nameless* event whose data is the line itself (no JSON,
      // no wrapper), and only the out-of-band frames are named events carrying
      // JSON. So plain messages are appended as text, and the two named events
      // go through the shared frame handler.
      source.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        // sseWrap emits one event per log line with the terminator stripped;
        // `append` is newline-driven, so put it back.
        append(`${event.data}\n`);
      };
      // `ready` is the panel's own frame (it carries `tty`); `console` is the
      // agent's error frame. Both are JSON in the WebSocket's shape.
      source.addEventListener("ready", (event) =>
        handleFrame((event as MessageEvent<string>).data),
      );
      source.addEventListener("console", (event) =>
        handleFrame((event as MessageEvent<string>).data),
      );
      source.onerror = () => {
        // EventSource reports every transport fault the same way and retries by
        // itself. Close it and drive the retry from our own backoff instead, so
        // a stopped server doesn't reconnect in a tight loop.
        setConnected(false);
        source?.close();
        source = null;
        if (!closed) reconnect = setTimeout(connect, RECONNECT_MS);
      };
    };

    // The connection stays open across status transitions: a server prints its
    // most useful output (world save, crash trace) while shutting down, and the
    // user should be able to read history while the server is offline. A retry
    // only actually connects while the server is running, so a stopped server
    // doesn't thrash. This also covers the stopped→start case: the pending
    // retry fires once `running` is true again.
    const connect = async () => {
      if (closed) return;
      if (!runningRef.current) {
        // Not running yet. Re-arm and wait for the server to come up.
        reconnect = setTimeout(connect, RECONNECT_MS);
        return;
      }

      // Already decided this node isn't directly reachable: don't re-probe it
      // on every reconnect, just stay on the proxy.
      if (proxyRef.current) {
        connectProxy();
        return;
      }

      resetView();

      let session: { token: string; url: string; tty: boolean };
      try {
        session = await requestConsoleSession(serverId);
      } catch (error) {
        // A 4xx from the mint is a verdict, not a hiccup: the node has no
        // browser-reachable console address (no TLS behind an HTTPS panel, or
        // an agent that only exists on the panel's private network). Retrying
        // cannot change that, so switch to the proxied stream immediately.
        // A 5xx or a network failure is transient — back off and try again.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          connectProxy();
          return;
        }
        if (!closed) reconnect = setTimeout(connect, RECONNECT_MS);
        return;
      }
      if (closed) return;

      ttyRef.current = session.tty === true;
      // Tracks whether this particular socket ever became usable, so a close is
      // classified as "dropped after working" vs "never worked".
      let becameReady = false;
      ws = new WebSocket(session.url);
      wsRef.current = ws;
      tokenRef.current = session.token;

      ws.onmessage = (event) => {
        if (typeof event.data === "string" && event.data.includes('"ready"')) {
          becameReady = true;
        }
        handleFrame(event.data);
      };

      ws.onclose = () => {
        setConnected(false);
        // The token for this socket is now spent (single-use). Clear it so a
        // later page-leave revoke doesn't fire against a dead token. The next
        // `connect()` mints a fresh one. This is the lag/reconnect path, NOT a
        // leave, so no revoke here.
        tokenRef.current = null;
        wsRef.current = null;
        if (closed) return;

        // A socket that closed without ever reaching `ready` means the URL the
        // panel handed out does not work from this browser. The mint succeeded,
        // so the panel thinks the node is reachable; only the browser knows
        // otherwise, and it is told nothing beyond the close. Count the silent
        // failures and move to the proxy once they can't be coincidence.
        if (!becameReady) directFailures += 1;
        if (directFailures >= DIRECT_FAILURES_BEFORE_PROXY) {
          append(
            "[console] Direct connection to the node failed; " +
              "streaming through the panel instead.\n",
          );
          // Latch the decision, then go back through `connect` so the
          // server-is-running check still gates the next attempt.
          proxyRef.current = true;
          reconnect = setTimeout(connect, RECONNECT_MS);
          return;
        }
        reconnect = setTimeout(connect, RECONNECT_MS);
      };

      ws.onerror = () => setConnected(false);
    };

    // Revoke the live token on a genuine page-leave. This is distinct from the
    // WS `onclose` path above, which fires on lag/reconnect and must NOT revoke
    // (a dropped connection should be able to re-establish with a fresh token).
    // Two leave signals:
    //   - `pagehide`: tab close, reload, back/forward, or any hard navigation.
    //     React's cleanup may not run on a hard unload, so this is the reliable
    //     signal there. `keepalive` (set in revokeConsoleSession) flushes the
    //     request as the page dies.
    //   - effect cleanup: SPA route change or `serverId` change. React runs
    //     this, so it covers soft navigation the browser doesn't surface as
    //     `pagehide`.
    // Both are idempotent together: revoke is a no-op on an already-revoked or
    // unknown token, so the unmount + pagehide double-fire from one leave is
    // harmless. The token ref is cleared after revoke so a later in-flight
    // reconnect can't revoke a token it hasn't minted.
    const revokeOnLeave = () => {
      const token = tokenRef.current;
      if (!token) return;
      tokenRef.current = null;
      revokeConsoleSession(serverId, token);
    };

    const onPageHide = () => revokeOnLeave();
    window.addEventListener("pagehide", onPageHide);

    void connect();

    return () => {
      closed = true;
      window.removeEventListener("pagehide", onPageHide);
      revokeOnLeave();
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
      // Closing the EventSource aborts the panel's route handler, which aborts
      // its fetch to the agent, which releases the Docker log stream. The whole
      // chain unwinds from this one call.
      source?.close();
      wsRef.current = null;
      tokenRef.current = null;
      setConnected(false);
    };
  }, [serverId, append]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = command.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    const viaProxy = proxyRef.current;
    // On the direct socket the command needs a live socket to ride. On the
    // proxied path there is no socket at all — input is its own HTTP request —
    // so only the connection state gates it.
    if (!viaProxy && (!ws || ws.readyState !== WebSocket.OPEN)) return;
    if (viaProxy && !connected) return;
    setCommand("");

    // Echo the command locally so input appears above its own output. Even for
    // a TTY container this is needed: JLine3 sets the terminal to raw mode,
    // which disables the PTY's line-discipline echo, so without local echo the
    // user would never see what they typed. The trailing \n finalizes the echo
    // as its own line.
    append(`> ${trimmed}\n`);

    // For a TTY container, JLine3's prompt (">....") is sitting in the pending
    // buffer. Clear it so it doesn't merge with the next chunk of output
    // (otherwise the buffer would read ">....> ban..." before the newline
    // splits them).
    if (ttyRef.current) {
      bufferRef.current = "";
    }

    if (viaProxy) {
      // Fire-and-forget like the socket write it replaces: the result of the
      // command shows up in the output stream, not in this response. A failure
      // is surfaced in the console itself rather than thrown away, since on
      // this path there is no socket close to hint that something went wrong.
      void sendConsoleCommand(serverId, trimmed).catch((error: unknown) => {
        const message =
          error instanceof ApiError ? error.message : "Failed to send command.";
        append(`[console] ${message}\n`);
      });
      return;
    }

    ws!.send(JSON.stringify({ type: "input", data: trimmed }));
  };

  return (
    <div className="flex h-[28rem] flex-col overflow-hidden rounded-xl border bg-zinc-950 ring-1 ring-foreground/10">
      {aiEnabled && (
        <div className="flex items-center justify-end border-b border-zinc-800 bg-zinc-900/50 px-2 py-1">
          <ConsoleHelperDialog serverId={serverId} />
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-zinc-300"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            {!running
              ? "Server is offline. Start it to see live console output."
              : connected
                ? "Waiting for output…"
                : "Connecting…"}
          </div>
        ) : (
          <>
            {!running && (
              <div className="mb-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-center text-zinc-500">
                Server is offline, showing the last console output.
              </div>
            )}
            {lines.map((line) => (
              <div key={line.id} className="whitespace-pre-wrap">
                {line.runs.map((run, i) =>
                  run.style ? (
                    <span key={i} style={run.style}>
                      {run.text}
                    </span>
                  ) : (
                    <React.Fragment key={i}>{run.text}</React.Fragment>
                  ),
                )}
              </div>
            ))}
            {/* Trailing partial line, no newline yet. Rendered live so
                in-progress output shows immediately. */}
            {pendingRuns.length > 0 && (
              <div className="whitespace-pre-wrap">
                {pendingRuns.map((run, i) =>
                  run.style ? (
                    <span key={i} style={run.style}>
                      {run.text}
                    </span>
                  ) : (
                    <React.Fragment key={i}>{run.text}</React.Fragment>
                  ),
                )}
              </div>
            )}
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
