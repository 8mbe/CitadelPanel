"use client";

import * as React from "react";
import { Check, Circle, PartyPopper } from "lucide-react";

import { ApiError, getServerInstallLog, type ApiServerSummary } from "@/lib/api";
import type { ServerInstallLogView } from "@/lib/types";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { ErrorNote, StepNav, SuccessNote } from "./wizard-ui";

/**
 * Building the first server, watched live.
 *
 * Provisioning pulls a Docker image, so it routinely runs for minutes. A
 * spinner is the wrong shape for that: past about ten seconds an operator
 * cannot tell a slow pull from a hung panel. So this shows named stages with
 * the current one called out, the elapsed time, and the panel's own log lines,
 * which is enough to see that something is still happening.
 *
 * Nothing here blocks. The build runs on the server whether or not this page is
 * open, so "Finish setup" stays available throughout and the operator can watch
 * the rest from the server's own console.
 */

const STAGES = [
  { id: "ports", label: "Allocating ports", match: /Allocating ports/i },
  { id: "install", label: "Running the install script", match: /Running the install script/i },
  { id: "container", label: "Creating the container", match: /Creating the container/i },
  { id: "ready", label: "Ready to start", match: /Done\. The server is ready/i },
] as const;

/** How far the log has got, as an index into `STAGES`. -1 means "not started". */
function reachedStage(log: string): number {
  let reached = -1;
  STAGES.forEach((stage, index) => {
    if (stage.match.test(log)) reached = Math.max(reached, index);
  });
  return reached;
}

/** The most recent line the panel itself wrote, which is the human-readable one. */
function lastPanelLine(log: string): string | null {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[panel]"));
  const last = lines[lines.length - 1];
  return last ? last.replace(/^\[panel\]\s*/, "") : null;
}

export function InstallProgress({
  server,
  onFinish,
}: {
  server: ApiServerSummary;
  onFinish: () => void;
}) {
  const [view, setView] = React.useState<ServerInstallLogView | null>(null);
  const [pollError, setPollError] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    const started = Date.now();
    const tick = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(tick);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const next = await getServerInstallLog(server.id);
        if (cancelled) return;
        setView(next);
        setPollError(null);
        if (next.provisioning) timer = setTimeout(poll, 2000);
      } catch (err) {
        if (cancelled) return;
        // A dropped poll is not a failed build: the panel keeps provisioning.
        // Say so, keep the last known state on screen, and keep trying.
        setPollError(
          err instanceof ApiError
            ? err.message
            : "Lost contact with the panel while watching the build.",
        );
        timer = setTimeout(poll, 4000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [server.id]);

  const log = view?.log ?? "";
  const reached = reachedStage(log);
  const failed = view?.status === "error" || /Provisioning failed:/i.test(log);
  const done = !failed && view != null && !view.provisioning && reached >= 3;
  const message = lastPanelLine(log);

  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {done ? (
            <PartyPopper className="size-5 text-primary" />
          ) : failed ? null : (
            <Spinner />
          )}
          {done
            ? `${server.name} is ready`
            : failed
              ? `${server.name} could not be built`
              : `Building ${server.name}`}
        </CardTitle>
        <CardDescription>
          {done
            ? "The container exists on the node and is ready to start. Everything the panel needs is working."
            : failed
              ? "The server row exists, so nothing is lost. It can be rebuilt from its settings once the cause is fixed."
              : "The node is pulling images and running the install script. This takes a few minutes the first time; you do not have to wait here."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="flex flex-col gap-2">
          {STAGES.map((stage, index) => {
            const complete = index <= reached;
            const active = !done && !failed && index === reached + 1;
            return (
              <li
                key={stage.id}
                className={cn(
                  "flex items-center gap-2 text-sm",
                  complete
                    ? "text-foreground"
                    : active
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {complete ? (
                  <Check className="size-4 shrink-0 text-primary" />
                ) : active ? (
                  <Spinner className="size-4 shrink-0" />
                ) : (
                  <Circle className="size-4 shrink-0 opacity-40" />
                )}
                {stage.label}
              </li>
            );
          })}
        </ol>

        {!done && !failed && (
          <div className="flex flex-col gap-1.5">
            <Progress value={null} />
            <p className="text-xs text-muted-foreground">
              {message ?? "Waiting for the node to pick this up…"}
              {elapsed > 0 && ` · ${formatElapsed(elapsed)} elapsed`}
            </p>
          </div>
        )}

        {log.trim() !== "" && (
          <ScrollArea className="h-40 rounded-lg border bg-muted/40">
            <pre className="p-3 font-mono text-xs whitespace-pre-wrap break-words">
              {log.trimEnd()}
            </pre>
          </ScrollArea>
        )}

        {pollError && !done && !failed && (
          <ErrorNote title="Not getting updates">
            {pollError} The build carries on regardless; the panel is still
            trying to read its progress.
          </ErrorNote>
        )}

        {failed && (
          <ErrorNote title="Provisioning failed">
            {message ??
              "The build stopped before the container was created."}{" "}
            The usual causes are a node that cannot pull images, a data root the
            agent cannot write to, or no free port in the pool. Fix it, then
            reinstall the server from its settings.
          </ErrorNote>
        )}

        {done && (
          <SuccessNote>
            Your panel is working end to end: the node answered, the image
            pulled, and the container was created. Start it from its console
            whenever you are ready.
          </SuccessNote>
        )}

        <StepNav
          onNext={onFinish}
          nextLabel={done ? "Finish setup and open the panel" : "Finish setup"}
        />
      </CardContent>
    </>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
