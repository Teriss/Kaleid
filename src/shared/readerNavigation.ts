/** One active engine operation and one latest intent, shared by every iframe. */
export class ReaderNavigation {
  private revision = 0;
  private active = false;
  private disposed = false;
  private pending?: {
    revision: number;
    run: () => Promise<void>;
    done: (completed: boolean) => void;
  };

  constructor(private readonly onError: (error: unknown) => void) {}

  get busy() {
    return this.active || !!this.pending;
  }

  submit(run: () => Promise<void>, replace = false) {
    if (this.disposed) return Promise.resolve(false);
    if (replace) this.revision++;
    this.clearPending();
    const result = new Promise<boolean>((done) => {
      this.pending = { revision: this.revision, run, done };
    });
    if (!this.active) void this.drain();
    return result;
  }

  private async drain() {
    this.active = true;
    try {
      while (this.pending && !this.disposed) {
        const task = this.pending;
        this.pending = undefined;
        try {
          await task.run();
          task.done(!this.disposed && task.revision === this.revision);
        } catch (error) {
          task.done(false);
          if (!this.disposed && task.revision === this.revision) {
            this.clearPending();
            this.onError(error);
          }
        }
      }
    } finally {
      this.active = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.revision++;
    this.clearPending();
  }

  private clearPending() {
    this.pending?.done(false);
    this.pending = undefined;
  }
}

export class ReaderWheelSequence {
  private lastAt = -Infinity;
  private inputAt = -Infinity;
  private direction = 0;

  accept(now: number, direction = 1) {
    if (!direction) return false;
    this.inputAt = now;
    const accepted = direction !== this.direction || now - this.lastAt >= 100;
    if (accepted) {
      this.lastAt = now;
      this.direction = direction;
    }
    return accepted;
  }

  current(now: number, direction: number) {
    return direction === this.direction && now - this.inputAt <= 100;
  }
}

export function epubProgress(
  location: {
    atStart?: boolean;
    atEnd?: boolean;
    start: { cfi: string; displayed?: { page: number; total: number } };
    end?: { displayed?: { page: number; total: number } };
  },
  indexedFraction?: number,
) {
  const displayed = location.end?.displayed ?? location.start.displayed;
  const chapter = displayed?.total
    ? Math.max(0, Math.min(1, displayed.page / displayed.total))
    : 0;
  return {
    chapter: location.atEnd ? 1 : location.atStart ? 0 : chapter,
    whole: location.atEnd
      ? 1
      : location.atStart
        ? 0
        : Number.isFinite(indexedFraction)
          ? Math.max(0, Math.min(0.999, indexedFraction!))
          : 0,
  };
}

/** Chromium can expose fractional scrollLeft at 125%/150% scale. */
export function pageScrollTarget(
  position: number,
  extent: number,
  viewport: number,
  step: number,
  direction: number,
) {
  const max = Math.max(0, extent - viewport);
  if (direction > 0 && max - position <= 2) return undefined;
  if (direction < 0 && position <= 2) return undefined;
  return Math.max(0, Math.min(max, position + Math.sign(direction) * step));
}
