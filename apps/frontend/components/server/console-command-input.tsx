import * as React from "react";
import { ArrowDown, ArrowUp, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  commandHistoryReducer,
  emptyCommandHistory,
} from "@/lib/command-history";
import { cn } from "@/lib/utils";

export function ConsoleCommandInput({
  running,
  connected,
  onSend,
  className,
}: {
  running: boolean;
  connected: boolean;
  onSend: (command: string) => boolean;
  className?: string;
}) {
  const [history, dispatch] = React.useReducer(
    commandHistoryReducer,
    emptyCommandHistory,
  );
  const inputRef = React.useRef<HTMLInputElement>(null);
  const disabled = !running || !connected;
  const canGoPrevious = history.entries.length > 0 && history.position !== 0;
  const canGoNext = history.position !== null;

  // Move the caret on recall, without moving it when the user edits a command.
  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && document.activeElement === input) {
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [history.position]);

  const recall = (type: "previous" | "next") => {
    inputRef.current?.focus();
    dispatch({ type });
  };

  const keepInputFocused = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // Avoid a blur/refocus cycle that closes the phone's software keyboard.
    event.preventDefault();
    inputRef.current?.focus();
  };

  return (
    <form
      data-slot="console-command-input"
      onSubmit={(event) => {
        event.preventDefault();
        const command = history.command.trim();
        if (disabled || !command || !onSend(command)) return;
        dispatch({ type: "submit", command });
      }}
      className={cn(
        "flex items-center gap-2 border-t border-zinc-800 p-2",
        className,
      )}
    >
      <span className="pl-2 font-mono text-xs text-zinc-500 select-none">
        &gt;
      </span>
      <Input
        ref={inputRef}
        value={history.command}
        onChange={(event) =>
          dispatch({ type: "edit", command: event.target.value })
        }
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            dispatch({ type: event.key === "ArrowUp" ? "previous" : "next" });
          }
        }}
        placeholder={running ? "Type a console command…" : "Server is offline"}
        disabled={disabled}
        className="h-11 border-transparent bg-zinc-900 font-mono text-base text-zinc-100 placeholder:text-zinc-600 focus-visible:border-zinc-700 sm:h-8 sm:text-xs"
        aria-label="Console command"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
      />
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="size-11 sm:size-8"
        disabled={disabled || !canGoPrevious}
        onPointerDown={keepInputFocused}
        onClick={() => recall("previous")}
        aria-label="Previous command"
        title="Previous command (↑)"
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="size-11 sm:size-8"
        disabled={disabled || !canGoNext}
        onPointerDown={keepInputFocused}
        onClick={() => recall("next")}
        aria-label="Next command"
        title="Next command (↓)"
      >
        <ArrowDown className="size-4" />
      </Button>
      <Button
        type="submit"
        size="icon"
        className="size-11 sm:size-8"
        disabled={disabled || !history.command.trim()}
      >
        <Send className="size-4" />
        <span className="sr-only">Send command</span>
      </Button>
    </form>
  );
}
