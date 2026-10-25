/** Old installed sources may report throttling as a generic [source] error. */
export function rateLimitDelay(error: unknown): number | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const seconds = /(?:请在\s*)?(\d+(?:\.\d+)?)\s*秒后(?:再)?重试/.exec(text);
  if (seconds) return Number(seconds[1]) * 1000 + 500;
  if (/\[rate-limit\]|\bHTTP\s+429\b/i.test(text)) return 5500;
  return undefined;
}

function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Readers and downloads share each source's serial chapter request lane. */
export class ChapterRequests {
  private tails = new Map<string, Promise<unknown>>();
  private next = new Map<string, number>();
  private lifetime = new AbortController();

  availableAt(id: string) {
    return this.next.get(id) || 0;
  }

  run<T>(
    id: string,
    request: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const combined = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    const previous = this.tails.get(id) || Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(async () => {
        combined.throwIfAborted();
        await wait(this.availableAt(id) - Date.now(), combined);
        combined.throwIfAborted();
        if (id === "lightnovelshelf") this.next.set(id, Date.now() + 5500);
        try {
          return await request();
        } catch (error) {
          const delay = rateLimitDelay(error);
          if (delay !== undefined)
            this.next.set(
              id,
              Math.max(this.availableAt(id), Date.now() + delay),
            );
          throw error;
        } finally {
          // Start the gap after the response, including first-use runtime setup.
          if (id === "lightnovelshelf")
            this.next.set(
              id,
              Math.max(this.availableAt(id), Date.now() + 5500),
            );
        }
      });
    this.tails.set(id, result);
    void result
      .finally(() => {
        if (this.tails.get(id) === result) this.tails.delete(id);
      })
      .catch(() => {});
    return result;
  }

  close() {
    this.lifetime.abort();
  }
}
