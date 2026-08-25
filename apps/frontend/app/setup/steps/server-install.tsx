"use client";

import * as React from "react";
import { Check, Circle, PartyPopper, X } from "lucide-react";

import {
  ApiError,
  getServerInstallLog,
  getServer,
  startServer,
  type ApiServerSummary,
} from "@/lib/api";
import type { ServerInstallLogView, ServerStatus, ServerView } from "@/lib/types";
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

import { CopyRow, ErrorNote, StepNav, SuccessNote, WarningNote } from "./wizard-ui";

/**
 * Building the first server, watched live, then started.
 *
 * Provisioning pulls a Docker image, so it routinely runs for minutes. A
 * spinner is the wrong shape for that: past about ten seconds an operator
 * cannot tell a slow pull from a hung panel. So this shows named stages with
 * the current one called out, the elapsed time, and the panel's own log lines,
 * which is enough to see that something is still happening.
 *
 * The start is *not* issued from here. It is requested at create time with
 * `startWhenBuilt`, so it happens on the server the moment the build lands,
 * which matters because this step explicitly invites the operator to stop
 * waiting and finish setup. A browser-side start would simply not happen for
 * anyone who took that invitation. This component only watches the status the
 * panel reports, and keeps a manual start for the case where the automatic one
 * failed.
 *
 * The two failures are reported separately. A build that failed left nothing on
 * the node and has to be reinstalled; a container that was built and refused to
 * boot is intact, and retrying the start is the whole fix.
 */

/** Build stages, recognised from the panel's own `[panel]` log lines. */
const BUILD_STAGES = [
  { id: "ports", label: "Allocating ports", match: /Allocating ports/i },
  { id: "install", label: "Running the install script", match: /Running the install script/i },
  { id: "container", label: "Creating the container", match: /Creating the container/i },
  { id: "built", label: "Container built", match: /Done\. The server is ready/i },
] as const;

/**
 * How long to wait for the automatic start before saying it is not coming.
 *
 * Generous, because the start runs behind the plugin auto-updater, but bounded:
 * an indefinite "starting…" is the state this whole component exists to avoid.
 */
const START_GRACE_MS = 45_000;

/** How far the log has got, as an index into `BUILD_STAGES`. -1 means "not started". */
function reachedStage(log: string): number {
  let reached = -1;
  BUILD_STAGES.forEach((stage, index) => {
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

/** Where a player would point their game client, once ports are allocated. */
function connectAddress(server: ServerView): string | null {
  if (server.primaryPort <= 0) return null;
  return server.nodeHostname
    ? `${server.nodeHostname}:${server.primaryPort}`
    : `port ${server.primaryPort}`;
}

type Phase =
  | "building"
  | "starting"
  | "running"
  | "build-failed"
  | "start-failed"
  | "not-started";

/**
 * What the panel's reported status means at this point in the wizard.
 *
 * `error` is ambiguous on its own: the same status covers "the build fell over"
 * and "the build worked and the first start did not". The install log settles
 * it, because the start writes its own line.
 */
function phaseOf(
  status: ServerStatus,
  log: string,
  provisioning: boolean,
  waitedTooLong: boolean,
): Phase {
  if (status === "running") return "running";
  if (status === "error") {
    return /did not start|Starting the server/i.test(log) &&
      !/Provisioning failed:/i.test(log)
      ? "start-failed"
      : "build-failed";
  }
  if (provisioning) return "building";
  // Built. The start is either on its way or never coming.
  return waitedTooLong ? "not-started" : "starting";
}

export function InstallProgress({
  server,
  onFinish,
}: {
  server: ApiServerSummary;
  /** Carries the freshest summary up, so the final screen has the real ports. */
  onFinish: (latest: ApiServerSummary) => void;
}) {
  const [view, setView] = React.useState<ServerInstallLogView | null>(null);
  const [detail, setDetail] = React.useState<ServerView | null>(null);
  const [pollError, setPollError] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);

  const [manualStarting, setManualStarting] = React.useState(false);
  const [manualError, setManualError] = React.useState<string | null>(null);

  /** When the build finished, so a start that never arrives can be called out. */
  const builtAt = React.useRef<number | null>(null);
  const [waitedTooLong, setWaitedTooLong] = React.useState(false);

  React.useEffect(() => {
    const began = Date.now();
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - began) / 1000));
      if (builtAt.current && Date.now() - builtAt.current > START_GRACE_MS) {
        setWaitedTooLong(true);
      }
    }, 1000);
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

        if (!next.provisioning && builtAt.current === null) {
          builtAt.current = Date.now();
        }

        // Keep watching past the end of the build: the automatic start happens
        // just after it, and `provisioning` is already false by then.
        const settled = next.status === "running" || next.status === "error";
        if (!settled) timer = setTimeout(poll, 2000);
        else if (next.status === "running") await loadDetail();
      } catch (err) {
        if (cancelled) return;
        // A dropped poll is not a failed build: the panel keeps working. Say so,
        // keep the last known state on screen, and keep trying.
        setPollError(
          err instanceof ApiError
            ? err.message
            : "Lost contact with the panel while watching the build.",
        );
        timer = setTimeout(poll, 4000);
      }
    };

    // The connect address only exists once ports are allocated, which is part of
    // the build, so it is read at the end rather than guessed at the start.
    const loadDetail = async () => {
      try {
        const full = await getServer(server.id);
        if (!cancelled && full) setDetail(full);
      } catch {
        // Not worth an error of its own: the address is a convenience, and the
        // server's own page has it.
      }
    };

    (async () => {
      await poll();
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [server.id]);

  const log = view?.log ?? "";
  const status = view?.status ?? (server.status as ServerStatus);
  const phase = phaseOf(status, log, view?.provisioning ?? true, waitedTooLong);
  const reached = reachedStage(log);
  const message = lastPanelLine(log);
  const address = detail ? connectAddress(detail) : null;

  /** Retry the start by hand, for when the automatic one did not take. */
  const startByHand = async () => {
    setManualStarting(true);
    setManualError(null);
    try {
      const summary = await startServer(server.id);
      setView((prev) =>
        prev ? { ...prev, status: summary.status as ServerStatus } : prev,
      );
      const full = await getServer(server.id);
      if (full) setDetail(full);
    } catch (err) {
      setManualError(
        err instanceof ApiError
          ? err.message
          : "The server still refused to start.",
      );
    } finally {
      setManualStarting(false);
    }
  };

  const buildBroken = phase === "build-failed";
  const working = phase === "building" || phase === "starting";

  const stages = [
    ...BUILD_STAGES.map((stage, index) => ({
      id: stage.id,
      label: stage.label,
      state: buildBroken
        ? index <= reached
          ? ("done" as const)
          : ("failed" as const)
        : index <= reached
          ? ("done" as const)
          : index === reached + 1 && phase === "building"
            ? ("active" as const)
            : ("pending" as const),
    })),
    {
      id: "start",
      label: "Starting the server",
      state:
        phase === "running"
          ? ("done" as const)
          : phase === "starting" || manualStarting
            ? ("active" as const)
            : phase === "start-failed" || phase === "not-started"
              ? ("failed" as const)
              : ("pending" as const),
    },
  ];

  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {phase === "running" ? (
            <PartyPopper className="size-5 text-primary" />
          ) : working || manualStarting ? (
            <Spinner />
          ) : null}
          {TITLES[phase](server.name)}
        </CardTitle>
        <CardDescription>{DESCRIPTIONS[phase]}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="flex flex-col gap-2">
          {stages.map((stage) => (
            <li
              key={stage.id}
              className={cn(
                "flex items-center gap-2 text-sm",
                stage.state === "pending"
                  ? "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {stage.state === "done" ? (
                <Check className="size-4 shrink-0 text-primary" />
              ) : stage.state === "active" ? (
                <Spinner className="size-4 shrink-0" />
              ) : stage.state === "failed" ? (
                <X className="size-4 shrink-0 text-destructive" />
              ) : (
                <Circle className="size-4 shrink-0 opacity-40" />
              )}
              {stage.label}
            </li>
          ))}
        </ol>

        {working && (
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

        {pollError && working && (
          <ErrorNote title="Not getting updates">
            {pollError} The build carries on regardless; the panel is still
            trying to read its progress.
          </ErrorNote>
        )}

        {buildBroken && (
          <ErrorNote title="Provisioning failed">
            {message ?? "The build stopped before the container was created."}{" "}
            The usual causes are a node that cannot pull images, a data root the
            agent cannot write to, or no free port in the pool. Fix it, then
            reinstall the server from its settings.
          </ErrorNote>
        )}

        {(phase === "start-failed" || phase === "not-started") && (
          <ErrorNote
            title={
              phase === "start-failed"
                ? "The server was built but did not start"
                : "The server has not started"
            }
            onRetry={startByHand}
            retrying={manualStarting}
            retryLabel="Start it now"
          >
            {manualError ??
              message ??
              "The container exists on the node but is not running."}{" "}
            Its console shows what the game process printed, which is usually
            where the reason is.
          </ErrorNote>
        )}

        {phase === "running" && (
          <>
            <SuccessNote>
              The container is up and the game process is booting. A game server
              takes another moment to finish loading before it accepts
              connections, so give it a minute if the first attempt to join is
              refused.
            </SuccessNote>

            {address ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Connect to it at</span>
                <CopyRow value={address} label="Copy the server address" />
                <p className="text-xs text-muted-foreground">
                  The node&apos;s hostname and the port the panel allocated.
                  Nobody picked the number; it came from the range you reserved.
                </p>
              </div>
            ) : (
              detail && (
                <WarningNote>
                  The server is running but has no published port, so nothing can
                  connect to it yet. Publish one from its Ports tab.
                </WarningNote>
              )
            )}
          </>
        )}

        <StepNav
          onNext={() => onFinish(freshest(server, detail, status))}
          nextLabel={
            phase === "running" ? "Finish setup and open it" : "Finish setup"
          }
        />
      </CardContent>
    </>
  );
}

const TITLES: Record<Phase, (name: string) => string> = {
  building: (name) => `Building ${name}`,
  starting: (name) => `Starting ${name}`,
  running: (name) => `${name} is running`,
  "build-failed": (name) => `${name} could not be built`,
  "start-failed": (name) => `${name} was built but did not start`,
  "not-started": (name) => `${name} is built but not running`,
};

const DESCRIPTIONS: Record<Phase, string> = {
  building:
    "The node is pulling images and running the install script. This takes a few minutes the first time; you do not have to wait here, the server starts itself when it is built.",
  starting:
    "The container was built and the panel is starting it, so it is running by the time you reach the panel.",
  running:
    "Your panel works end to end: the node answered, the image pulled, the container was created and the game process is up.",
  "build-failed":
    "The server row exists, so nothing is lost. It can be rebuilt from its settings once the cause is fixed.",
  "start-failed":
    "The build succeeded, so the container is on the node. Only the start failed, which is the smaller problem of the two.",
  "not-started":
    "The build finished but the start has not landed. The container is on the node either way.",
};

/**
 * The best summary available for the final screen.
 *
 * The create-time row had no ports yet, so prefer the detail fetched after the
 * build; fall back to the original with its status corrected, which is still
 * better than reporting `creating` on a server that has finished.
 */
function freshest(
  original: ApiServerSummary,
  detail: ServerView | null,
  status: ServerStatus,
): ApiServerSummary {
  if (!detail) return { ...original, status };
  return {
    ...original,
    status: detail.status,
    ports: detail.ports,
    nodeHostname: detail.nodeHostname,
  };
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
