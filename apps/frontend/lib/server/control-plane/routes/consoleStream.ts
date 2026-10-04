/** Prepend the console's ready frame while preserving upstream cancellation. */
export function prependConsoleReady(
  body: ReadableStream<Uint8Array> | null,
  tty: boolean,
): ReadableStream<Uint8Array> {
  const ready = new TextEncoder().encode(
    `event: ready\ndata: ${JSON.stringify({ type: "ready", tty })}\n\n`,
  );
  const reader = body?.getReader();
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(ready);
      try {
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (cancelled || done) break;
            controller.enqueue(value);
          }
        }
      } catch {
        // A dropped upstream ends the feed; EventSource handles reconnection.
      } finally {
        reader?.releaseLock();
        if (!cancelled) controller.close();
      }
    },
    cancel(reason) {
      cancelled = true;
      // The reader owns the body lock. Cancelling the body itself would reject
      // and leave the agent's Docker log stream open after navigation.
      return reader?.cancel(reason).catch(() => undefined);
    },
  });
}
