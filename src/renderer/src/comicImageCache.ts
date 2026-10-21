import type { ComicPage } from "../../shared/types";

export interface ComicImageResource {
  url: string;
  width: number;
  height: number;
}
interface Entry {
  page: ComicPage;
  refs: number;
  priority: number;
  controller: AbortController;
  promise: Promise<ComicImageResource>;
  resolve(value: ComicImageResource): void;
  reject(error: unknown): void;
  running: boolean;
  value?: ComicImageResource;
  image?: HTMLImageElement;
  bytes: number;
  touched: number;
  retry: boolean;
}
const aborted = () => new DOMException("已取消漫画加载", "AbortError");

/** One chapter owns its fetched bytes and decoded images; navigation only changes pins. */
export class ComicImageCache {
  private entries = new Map<string, Entry>();
  private wanted = new Set<string>();
  private running = 0;
  private clock = 0;
  private closed = false;
  constructor(
    private onSize: (page: ComicPage, width: number, height: number) => void,
    private limit = 128 * 1024 * 1024,
  ) {}
  peek(page: ComicPage) {
    return this.entries.get(page.url)?.value;
  }
  acquire(page: ComicPage, retry = false) {
    const entry = this.entry(page, 0, retry);
    entry.refs++;
    entry.priority = 0;
    entry.touched = ++this.clock;
    this.pump();
    return {
      value: entry.value,
      ready: entry.promise,
      release: () => {
        entry.refs--;
        if (!entry.refs) {
          entry.priority = 1;
          if (!entry.value && !this.wanted.has(page.url)) this.remove(entry);
        }
        this.trim();
        this.pump();
      },
    };
  }
  preload(pages: ComicPage[]) {
    this.wanted = new Set(pages.map((page) => page.url));
    for (const entry of this.entries.values())
      if (!entry.refs && !entry.value && !this.wanted.has(entry.page.url))
        this.remove(entry);
    // A failed preload is removed, so an explicit display attempt can retry it.
    for (const page of pages) this.entry(page, 1);
    this.pump();
  }
  dispose() {
    this.closed = true;
    for (const entry of this.entries.values()) this.remove(entry);
    this.wanted.clear();
  }
  private entry(page: ComicPage, priority: number, retry = false): Entry {
    const old = this.entries.get(page.url);
    if (old && !retry) return old;
    if (old) this.remove(old);
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const promise = new Promise<ComicImageResource>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Preloads need no consumer, and cancelled jobs must never be unhandled.
    void promise.catch(() => {});
    const entry: Entry = {
      page,
      priority,
      retry,
      promise,
      resolve,
      reject,
      refs: 0,
      controller: new AbortController(),
      running: false,
      bytes: 0,
      touched: ++this.clock,
    };
    this.entries.set(page.url, entry);
    return entry;
  }
  private pump() {
    if (this.closed) return;
    const queued = [...this.entries.values()]
      .filter((entry) => !entry.running && !entry.value)
      .sort((a, b) => a.priority - b.priority || a.touched - b.touched);
    for (const entry of queued) {
      // Displayed pages take priority; at most two speculative jobs run at once.
      if (this.running >= (entry.priority === 0 ? 4 : 2)) break;
      entry.running = true;
      this.running++;
      void this.load(entry).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
  private async load(entry: Entry) {
    let url: string | undefined;
    try {
      const signal = entry.controller.signal;
      const request = new URL(entry.page.url);
      if (entry.retry) request.searchParams.set("retry", crypto.randomUUID());
      const response = await fetch(request.href, { signal });
      if (!response.ok) throw new Error("漫画页面读取失败");
      const blob = await response.blob();
      if (signal.aborted) throw aborted();
      url = URL.createObjectURL(blob);
      const image = new Image();
      entry.image = image;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          image.onload = image.onerror = null;
          signal.removeEventListener("abort", cancel);
          error ? reject(error) : resolve();
        };
        const cancel = () => finish(aborted());
        image.onload = () => finish();
        image.onerror = () => finish(new Error("漫画图片无法解码"));
        signal.addEventListener("abort", cancel, { once: true });
        image.src = url!;
      });
      await image.decode();
      if (signal.aborted || this.closed) throw aborted();
      const value = {
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
      if (!value.width || !value.height) throw new Error("漫画图片为空");
      entry.value = value;
      entry.bytes = blob.size + value.width * value.height * 4;
      this.onSize(entry.page, value.width, value.height);
      entry.resolve(value);
      this.trim();
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      this.remove(entry);
      entry.reject(error);
    }
  }
  private remove(entry: Entry) {
    if (this.entries.get(entry.page.url) === entry)
      this.entries.delete(entry.page.url);
    entry.controller.abort();
    if (entry.image) {
      entry.image.onload = entry.image.onerror = null;
      entry.image.removeAttribute("src");
    }
    if (entry.value) URL.revokeObjectURL(entry.value.url);
    entry.reject(aborted());
  }
  private trim() {
    const entries = [...this.entries.values()];
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries.sort((a, b) => a.touched - b.touched)) {
      if (bytes <= this.limit) break;
      if (!entry.refs && entry.value) {
        bytes -= entry.bytes;
        this.remove(entry);
      }
    }
  }
}
