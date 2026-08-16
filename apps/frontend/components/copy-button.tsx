"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

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
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
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
