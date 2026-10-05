/**
 * Commands the console has echoed locally and expects a TTY to echo back.
 *
 * A TTY container's pseudo-terminal runs in cooked mode unless the program
 * inside switches it to raw, and cooked mode echoes every line written to
 * stdin. The panel already shows the command as `> list`, so the PTY's `list`
 * is a duplicate. Each submitted command is queued here and the first output
 * line that matches it is dropped.
 *
 * Entries expire because not every TTY echoes: a program that puts the
 * terminal in raw mode and draws its own input line sends nothing that
 * matches. A stale entry must not later swallow a real log line that happens
 * to read the same as an old command.
 */
export interface PendingEcho {
  command: string;
  expiresAt: number;
}

/** How long a submitted command waits for its echo before it is forgotten. */
export const ECHO_WINDOW_MS = 3000;

export function expectEcho(
  queue: PendingEcho[],
  command: string,
  now: number,
): void {
  queue.push({ command, expiresAt: now + ECHO_WINDOW_MS });
}

/**
 * Whether `line` (plain text, escapes already stripped) is the echo of the
 * oldest pending command. A match is consumed. Only the oldest entry is
 * compared, because a PTY echoes lines in the order they were written; log
 * output landing between a submit and its echo leaves the entry in place.
 */
export function consumeEcho(
  queue: PendingEcho[],
  line: string,
  now: number,
): boolean {
  while (queue.length > 0 && queue[0].expiresAt <= now) queue.shift();
  if (queue.length === 0 || line.trim() !== queue[0].command) return false;
  queue.shift();
  return true;
}
