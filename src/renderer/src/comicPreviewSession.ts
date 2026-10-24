import type { ComicThumbnailPage } from "../../shared/onlineComics";

export interface ComicPreviewSnapshot {
  items: string[];
  loading: boolean;
  hasMore: boolean;
  error: string;
}

/** One detail visit's cursor sequence, retained while its reader is open. */
export class ComicPreviewSession {
  private state: ComicPreviewSnapshot;
  private listeners = new Set<() => void>();
  private pending?: Promise<void>;
  private loaded = false;
  private next: string | null = null;
  private accepted = new Set<string | null>();
  private closed = false;
  readonly signature: string;
  constructor(initial: string[], private loader?: (next: string | null) => Promise<ComicThumbnailPage>) {
    this.signature = JSON.stringify([initial, !!loader]);
    this.state = { items: initial, loading: false, hasMore: !!loader, error: "" };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<ComicPreviewSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  start = () => {
    if (!this.loaded && !this.state.error) return this.loadNext();
    return Promise.resolve();
  };
  loadNext = (): Promise<void> => {
    if (this.pending) return this.pending;
    if (this.closed || !this.loader || !this.state.hasMore) return Promise.resolve();
    const cursor = this.loaded ? this.next : null;
    // Reserve before notifying subscribers, which may synchronously reenter.
    this.pending = Promise.resolve().then(async () => {
      try {
        const result = await this.loader!(cursor);
        if (this.closed) return;
        if (!Array.isArray(result.thumbnails) || result.thumbnails.some((url) => typeof url !== "string") ||
          (result.next !== null && typeof result.next !== "string"))
          throw new Error("源返回了无效的预览分页数据");
        if (result.next !== null && (result.next === cursor || this.accepted.has(result.next)))
          throw new Error("源返回了重复的预览分页游标");
        this.accepted.add(cursor);
        this.loaded = true;
        this.next = result.next;
        this.update({ items: [...this.state.items, ...result.thumbnails], hasMore: result.next !== null });
      } catch (error) {
        if (!this.closed) this.update({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.pending = undefined;
        if (!this.closed) this.update({ loading: false });
      }
    });
    this.update({ loading: true, error: "" });
    return this.pending;
  };
  dispose() {
    this.closed = true;
    this.listeners.clear();
  }
}
