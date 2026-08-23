"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

import { requestConsoleAiHelper, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/**
 * AI console helper dialog.
 *
 * Opens from a button on the console panel. The user describes what they want
 * fixed in plain text; the panel assembles the full prompt server-side (recent
 * console logs, game/blueprint, version, non-secret env) and returns the
 * assistant's reply. The browser only ever sends the free-text question. The
 * logs and context are gathered server-side, so the prompt is never
 * client-controlled and the API key never reaches the browser.
 *
 * Hidden entirely when AI is not configured (the console panel reads the public
 * `ai.enabled` flag and omits the trigger button).
 */
export function ConsoleHelperDialog({
  serverId,
  disabled,
}: {
  serverId: string;
  /** Disabled when the console is offline/disconnected (no live logs to read). */
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [reply, setReply] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset the form when the dialog closes, so reopening starts fresh. Done in
  // the open-change handler (not an effect) to avoid cascading renders, the
  // same pattern the db-explorer dialogs use.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setMessage("");
      setReply(null);
      setError(null);
      setLoading(false);
    }
  };

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setReply(null);
    try {
      const res = await requestConsoleAiHelper(serverId, trimmed);
      setReply(res.reply);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "The assistant could not respond. Try again shortly.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          />
        }
      >
        <Sparkles className="size-3.5" />
        AI helper
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            AI console helper
          </DialogTitle>
          <DialogDescription>
            Describe what you want fixed. The assistant reads your recent
            console output, the game, its version, and the non-secret
            environment. Your message is the only thing you type.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={ask} className="flex flex-col gap-3">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. The server crashes on startup. What does the error mean and how do I fix it?"
            maxLength={2000}
            disabled={loading}
            aria-label="What do you want fixed?"
            className="min-h-20 max-h-48 font-mono text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {message.length}/2000
            </p>
            <Button
              type="submit"
              disabled={loading || !message.trim()}
              className="w-fit"
            >
              {loading ? <Spinner /> : <Sparkles />}
              {loading ? "Reading the logs…" : "Ask the assistant"}
            </Button>
          </div>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {reply && (
          <div className="flex flex-col gap-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              Assistant
            </p>
            <div className="max-h-48 overflow-y-auto rounded-lg bg-muted/40 p-3 text-sm whitespace-pre-wrap">
              {reply}
            </div>
          </div>
        )}

        <DialogFooter showCloseButton>
          {reply && !loading && !error && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setReply(null);
                setMessage("");
              }}
            >
              Ask another question
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
