"use client";

import * as React from "react";
import { ArrowRight, Check, Copy, KeyRound, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the setup wizard's steps.
 *
 * They exist so every step answers the same four questions the same way: what
 * it looks like while it works, when it succeeds, when it fails, and when there
 * is nothing there yet. A step that hand-rolls its own error paragraph is how
 * one of those four quietly goes missing.
 */

/**
 * An inline failure, placed next to the control that caused it.
 *
 * Every setup failure is correctable by the operator (a wrong host, an agent
 * that is not running yet), so none of them belong in a toast that can scroll
 * away unseen. `onRetry` is offered whenever the action is safe to repeat, so
 * the recovery is one click and not a re-read of the form.
 */
export function ErrorNote({
  title,
  children,
  onRetry,
  retryLabel = "Try again",
  retrying,
}: {
  title?: string;
  children: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {title && <p className="font-medium text-destructive">{title}</p>}
        <div className="text-muted-foreground">{children}</div>
        {onRetry && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={retrying}
            className="self-start"
          >
            {retrying && <Spinner />}
            {retryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A non-blocking caveat: the step worked, but something needs attention later. */
export function WarningNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
}

/** Confirmation that an action landed. Small and local, never a page event. */
export function SuccessNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
      <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
}

/**
 * The back / skip / next row every step ends with.
 *
 * `skip` is a first-class control rather than small print: most of these steps
 * are genuinely optional, and an operator who cannot see a way past a step they
 * do not need will invent a bad value to get through it.
 */
export function StepNav({
  onBack,
  onNext,
  nextLabel,
  loading,
  nextDisabled,
  onSkip,
  skipLabel = "Skip for now",
  skipping,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  loading?: boolean;
  nextDisabled?: boolean;
  onSkip?: () => void;
  skipLabel?: string;
  skipping?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onBack && (
        <Button type="button" variant="ghost" onClick={onBack} disabled={loading}>
          Back
        </Button>
      )}
      {onSkip && (
        <Button
          type="button"
          variant="outline"
          onClick={onSkip}
          disabled={loading || skipping}
          className="ml-auto"
        >
          {skipping && <Spinner />}
          {skipLabel}
        </Button>
      )}
      <Button
        type="button"
        onClick={onNext}
        disabled={loading || nextDisabled}
        className={cn(!onSkip && "ml-auto")}
      >
        {loading && <Spinner />}
        {nextLabel}
        {!loading && <ArrowRight />}
      </Button>
    </div>
  );
}

/**
 * What is still missing before a step's primary action can run.
 *
 * Shown next to a disabled button, never instead of one: a greyed-out control
 * with no explanation is indistinguishable from a broken one.
 */
export function BlockingIssues({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
      {issues.map((issue) => (
        <li key={issue} className="flex items-start gap-1.5">
          <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          {issue}
        </li>
      ))}
    </ul>
  );
}

/**
 * A value the operator has to get out of the browser and into something else,
 * with copy-to-clipboard.
 *
 * The button confirms in place (the icon becomes a tick) because the clipboard
 * is invisible: without that, the only way to know the copy worked is to paste
 * it somewhere, and by then the wizard has moved on. A denied clipboard says so
 * rather than leaving a button that silently does nothing.
 */
export function CopyRow({
  value,
  label,
}: {
  value: string;
  /** Accessible name for the copy button, e.g. "Copy the agent token". */
  label: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={copy}
          aria-label={label}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
      {failed && (
        <p className="text-xs text-muted-foreground">
          Copying was blocked by the browser. Select the value above and copy it
          manually.
        </p>
      )}
    </div>
  );
}

/** A secret the panel will never show again, with copy-to-clipboard. */
export function GeneratedToken({
  token,
  children,
}: {
  token: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2 text-sm">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span className="text-muted-foreground">{children}</span>
      </div>
      <CopyRow value={token} label="Copy the agent token" />
    </div>
  );
}
