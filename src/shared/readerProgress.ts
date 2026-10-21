/** Leading + bounded trailing updates; ongoing input never postpones the timer. */
export class ReaderProgressUpdates<T> {
  private timer?: ReturnType<typeof setTimeout>;
  private latest?: { value: T };
  private lastAt = -Infinity;

  constructor(private readonly publish: (value: T) => void) {}

  push(value: T) {
    this.latest = { value };
    const wait = Math.max(0, 100 - (performance.now() - this.lastAt));
    if (!wait) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), wait);
  }

  flush() {
    const latest = this.latest;
    this.cancel();
    if (!latest) return;
    this.lastAt = performance.now();
    this.publish(latest.value);
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
  }
}

/** The thumb follows input immediately, independently of asynchronous book layout. */
export class ReaderSeekController {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { id: number; value: number };
  private revision = 0;
  private active = false;
  private held = false;
  private final = false;
  private disposed = false;
  private lastAt = -Infinity;

  constructor(
    private readonly apply: (value: number) => Promise<boolean>,
    private readonly preview: (value: number | undefined) => void,
    private readonly failure: (error: unknown) => void,
  ) {}

  begin() {
    this.held = true;
  }

  input(value: number) {
    if (this.disposed) return;
    this.pending = { id: ++this.revision, value };
    this.final = false;
    this.preview(value);
    this.schedule();
  }

  finish() {
    this.held = false;
    this.final = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending) this.schedule();
    else if (!this.active && !this.disposed) this.preview(undefined);
  }

  private schedule() {
    if (this.active || this.timer || !this.pending || this.disposed) return;
    const wait = this.final
      ? 0
      : Math.max(0, 100 - (performance.now() - this.lastAt));
    if (!wait) void this.run();
    else
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.run();
      }, wait);
  }

  private async run() {
    const task = this.pending;
    if (!task || this.disposed) return;
    this.pending = undefined;
    this.active = true;
    this.lastAt = performance.now();
    try {
      const completed = await this.apply(task.value);
      if (!completed && !this.disposed && task.id === this.revision) {
        this.held = false;
        this.preview(undefined);
      }
    } catch (error) {
      if (!this.disposed && task.id === this.revision) {
        this.held = false;
        this.preview(undefined);
        this.failure(error);
      }
    } finally {
      this.active = false;
      if (!this.disposed) {
        if (this.pending) this.schedule();
        else if (!this.held) this.preview(undefined);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.revision++;
    clearTimeout(this.timer);
    this.pending = undefined;
  }
}
