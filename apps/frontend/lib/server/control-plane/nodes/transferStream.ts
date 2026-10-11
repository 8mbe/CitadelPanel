/** Count forwarded bytes without reading ahead of the destination's demand. */
export function countTransferStream(
  source: ReadableStream<Uint8Array>,
  onChunk: (bytes: number) => void,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let settled = false;
  let abort = () => {};
  let cancellation: Promise<void> | undefined;

  function release() {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  function cancelReader(reason: unknown) {
    return cancellation ??= reader.cancel(reason).catch(() => undefined).finally(release);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        controller.error(signal?.reason);
        void cancelReader(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) {
          release();
          controller.close();
        } else {
          onChunk(value.byteLength);
          controller.enqueue(value);
        }
      } catch (error) {
        await cancelReader(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelReader(reason);
    },
  }, { highWaterMark: 0 });
}
