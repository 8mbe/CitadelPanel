"use client";

import * as React from "react";
import { Check, Clipboard, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Writes `value` to the clipboard and reports `copied` for a beat afterwards. */
function useCopy(value: string) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return { copied, copy };
}

/**
 * A tiny copy-to-clipboard affordance. Shows a check for a beat after copying.
 * Shared by the cards that display connection details (databases, server links).
 */
export function CopyButton({
  value,
  label,
  size = "icon-sm",
}: {
  value: string;
  label: string;
  size?: "icon-sm" | "icon-xs";
}) {
  const { copied, copy } = useCopy(value);
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={`Copy ${label}`}
      onClick={copy}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/**
 * Inline text that copies itself when clicked, for values a user pastes
 * elsewhere (a server's connect address). `icon` is shown before the text;
 * a clipboard after the text swaps to a check after copying.
 */
export function CopyText({
  value,
  label,
  icon,
  className,
}: {
  value: string;
  label: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  const { copied, copy } = useCopy(value);
  return (
    <button
      type="button"
      data-slot="copy-text"
      title={copied ? "Copied" : "Click to copy"}
      aria-label={`Copy ${label}`}
      onClick={copy}
      className={cn(
        "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {icon}
      <span className="truncate">{value}</span>
      {copied ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <Clipboard aria-hidden="true" className="size-3.5 shrink-0" />
      )}
    </button>
  );
}
