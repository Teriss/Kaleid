import { queryFailure, type QueryErrorCode } from "./queryFailure";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  IndexChange,
  MediaItem,
  MediaQuery,
  QueryResult,
} from "../../../shared/types";

export const PAGE_SIZE = 100;
export interface ExternalResultChange {
  serial: number;
  kind: "replace" | "jump" | "prepend" | "append";
  targetId?: string;
}
type FetchPage = (query: MediaQuery) => Promise<QueryResult>;
export class PagedMediaSource {
  private pages = new Map<number, MediaItem[]>();
  private jobs = new Map<number, Promise<void>>();
  private failed = new Set<number>();
  private listeners = new Set<() => void>();
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private disposed = false;
  private generation = 0;
  private refreshJob: Promise<void> | null = null;
  private refreshAgain = false;
  private lastChangeVersion = 0;
  private snapshot = {
    sections: [] as { title: string; start: number; count: number }[],
    scene: "collection" as "carousel" | "collection",
    total: 0,
    ready: false,
    version: 0,
    error: "",
    errorCode: "unknown" as QueryErrorCode,
    anchorIndex: 0,
    indexVersion: 0,
    refreshSerial: 0,
    metricsVersion: 0,
    externalChange: undefined as ExternalResultChange | undefined,
  };
  private wanted = new Set<number>();
  constructor(
    readonly query: MediaQuery,
    private fetchPage: FetchPage = (query) => window.media.query(query),
    readonly external = false,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private emit(patch: Partial<typeof this.snapshot> = {}) {
    if (this.disposed) return;
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      version: this.snapshot.version + 1,
    };
    this.listeners.forEach((listener) => listener());
  }
  get total() {
    return this.snapshot.total;
  }
  get cacheSize() {
    return [...this.pages.values()].reduce(
      (sum, items) => sum + items.length,
      0,
    );
  }
  peek(index: number) {
    return this.pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
  }
  indexOfId(id: string) {
    for (const [page, items] of this.pages) {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) return page * PAGE_SIZE + index;
    }
    return -1;
  }
  cachedItems() {
    return [...this.pages.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, items]) => items);
  }
  /** Publish an in-memory result set without resetting layout or scroll state. */
  replaceExternalItems(
    items: MediaItem[],
    anchorId?: string,
    index = 0,
    change?: ExternalResultChange,
  ) {
    if (!this.external)
      throw new Error("Only external sources accept result items");
    if (this.disposed) return;
    this.generation++;
    this.jobs.clear();
    this.pages = new Map();
    for (let offset = 0; offset < items.length; offset += PAGE_SIZE)
      this.pages.set(
        offset / PAGE_SIZE,
        items.slice(offset, offset + PAGE_SIZE),
      );
    this.failed.clear();
    const found = anchorId
      ? items.findIndex((item) => item.id === anchorId)
      : -1;
    this.emit({
      ready: true,
      total: items.length,
      anchorIndex: this.snapshot.ready
        ? this.snapshot.anchorIndex
        : Math.max(0, Math.min(items.length - 1, found < 0 ? index : found)),
      error: "",
      errorCode: "unknown",
      externalChange: change,
    });
  }
  async initialize(anchorId?: string, index = 0) {
    const generation = this.generation;
    try {
      const first = await this.fetchPage({
        ...this.query,
        offset: 0,
        limit: PAGE_SIZE,
        anchorId,
      });
      if (this.disposed || generation !== this.generation) return;
      this.pages.set(0, first.items);
      const anchorIndex = Math.max(
        0,
        Math.min(first.total - 1, first.anchorIndex ?? index),
      );
      this.emit({
        sections: first.sections ?? [],
        scene:
          first.scene ??
          (this.external &&
          first.items.length &&
          first.items.every((item) => Boolean(item.kind))
            ? "carousel"
            : "collection"),
        total: first.total,
        anchorIndex,
        indexVersion: first.version ?? 0,
      });
      await this.loadPage(Math.floor(anchorIndex / PAGE_SIZE));
      if (this.disposed || generation !== this.generation) return;
      this.emit({ ready: true });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.emit({
        ready: true,
        error: queryFailure(error).message,
        errorCode: queryFailure(error).code,
      });
    }
  }
  private pump() {
    while (this.active < 4 && this.queue.length && !this.disposed) {
      const run = this.queue.shift()!;
      this.active++;
      void run().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
  private loadPage(page: number): Promise<void> {
    if (
      this.disposed ||
      this.pages.has(page) ||
      this.failed.has(page) ||
      page * PAGE_SIZE >= this.total
    )
      return Promise.resolve();
    const existing = this.jobs.get(page);
    if (existing) return existing;
    const generation = this.generation;
    const job = new Promise<void>((resolve) => {
      this.queue.push(async () => {
        try {
          const result = await this.fetchPage({
            ...this.query,
            offset: page * PAGE_SIZE,
            limit: PAGE_SIZE,
          });
          if (!this.disposed && generation === this.generation) {
            if (
              result.version !== undefined &&
              result.version !== this.snapshot.indexVersion
            ) {
              void this.refresh();
              return;
            }
            this.pages.set(page, result.items);
            this.evict();
            this.emit({ total: result.total });
          }
        } catch (error) {
          if (this.disposed || generation !== this.generation) return;
          this.failed.add(page);
          this.emit({
            error: queryFailure(error).message,
            errorCode: queryFailure(error).code,
          });
        } finally {
          if (this.jobs.get(page) === job) this.jobs.delete(page);
          resolve();
        }
      });
    });
    this.jobs.set(page, job);
    this.pump();
    return job;
  }
  private evict() {
    for (const page of this.pages.keys()) {
      if (this.pages.size <= 20) break;
      if (!this.wanted.has(page)) this.pages.delete(page);
    }
  }
  async ensure(indices: number[]) {
    const pages = [
      ...new Set(
        indices
          .filter((index) => index >= 0 && index < this.total)
          .map((index) => Math.floor(index / PAGE_SIZE)),
      ),
    ];
    this.wanted = new Set(pages);
    await Promise.all(pages.map((page) => this.loadPage(page)));
    this.evict();
  }
  async at(index: number) {
    if (index < 0 || index >= this.total) return undefined;
    await this.loadPage(Math.floor(index / PAGE_SIZE));
    return this.peek(index);
  }
  patch(id: string, patch: Partial<MediaItem>) {
    let metricsChanged = false;
    for (const items of this.pages.values())
      for (let i = 0; i < items.length; i++)
        if (items[i].id === id) {
          metricsChanged ||=
            (patch.width !== undefined && patch.width !== items[i].width) ||
            (patch.height !== undefined && patch.height !== items[i].height);
          items[i] = { ...items[i], ...patch };
        }
    this.emit({
      metricsVersion: this.snapshot.metricsVersion + (metricsChanged ? 1 : 0),
    });
  }
  applyChange(
    change: IndexChange,
    anchor?: { focusId?: string; focusIndex?: number },
  ) {
    if (change.version <= this.lastChangeVersion) return;
    this.lastChangeVersion = change.version;
    const q = this.query;
    if (
      (q.libraryId && !change.libraryIds.includes(q.libraryId)) ||
      (q.type && !change.types.includes(q.type))
    ) {
      this.emit({ indexVersion: change.version });
      return;
    }
    if (change.structural || q.search || q.recent || q.favorite) {
      void this.refresh(anchor?.focusId, anchor?.focusIndex);
    } else {
      for (const item of change.updated) this.patch(item.id, item);
      this.emit({ indexVersion: change.version });
    }
  }
  refresh(
    anchorId?: string,
    fallbackIndex = this.snapshot.anchorIndex,
  ): Promise<void> {
    if (this.disposed || !this.snapshot.ready) return Promise.resolve();
    if (this.refreshJob) {
      this.refreshAgain = true;
      return this.refreshJob;
    }
    this.refreshJob = (async () => {
      for (let attempt = 0; attempt < 3 && !this.disposed; attempt++) {
        const first = await this.fetchPage({
          ...this.query,
          offset: 0,
          limit: PAGE_SIZE,
          anchorId,
        });
        if (this.disposed) return;
        const anchorIndex = Math.max(
          0,
          Math.min(first.total - 1, first.anchorIndex ?? fallbackIndex),
        );
        const pageNumbers = [
          ...new Set([
            0,
            ...this.pages.keys(),
            Math.floor(anchorIndex / PAGE_SIZE),
          ]),
        ].filter((page) => page === 0 || page * PAGE_SIZE < first.total);
        const replacement = await Promise.all(
          pageNumbers.map(
            async (page) =>
              [
                page,
                page === 0
                  ? first
                  : await this.fetchPage({
                      ...this.query,
                      offset: page * PAGE_SIZE,
                      limit: PAGE_SIZE,
                    }),
              ] as const,
          ),
        );
        if (this.disposed) return;
        if (replacement.some(([, result]) => result.version !== first.version))
          continue;
        this.generation++;
        this.pages = new Map(
          replacement.map(([page, result]) => [page, result.items]),
        );
        this.failed.clear();
        this.emit({
          sections: first.sections ?? this.snapshot.sections,
          scene: first.scene ?? this.snapshot.scene,
          total: first.total,
          anchorIndex,
          indexVersion: first.version ?? 0,
          refreshSerial: this.snapshot.refreshSerial + 1,
          error: "",
        });
        return;
      }
      this.refreshAgain = true;
    })()
      .catch((error) => {
        this.emit({
          error: queryFailure(error).message,
          errorCode: queryFailure(error).code,
        });
      })
      .finally(() => {
        this.refreshJob = null;
        if (this.refreshAgain && !this.disposed) {
          this.refreshAgain = false;
          setTimeout(() => void this.refresh(anchorId, fallbackIndex), 80);
        }
      });
    return this.refreshJob;
  }
  retry() {
    if (!this.pages.size || this.snapshot.errorCode === "auth-required") {
      this.generation++;
      this.pages.clear();
      this.failed.clear();
      this.jobs.clear();
      this.emit({ error: "", errorCode: "unknown", ready: false });
      void this.initialize();
      return;
    }
    const pages = [...this.failed];
    this.failed.clear();
    this.emit({ error: "" });
    void Promise.all(pages.map((page) => this.loadPage(page)));
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
/** Identity changes only for a new result session, never for appended pages. */
export function useExternalMediaSource(
  key: string,
  type: MediaQuery["type"],
  items: MediaItem[],
  anchor: { focusId?: string; focusIndex?: number } = {},
  change?: ExternalResultChange,
) {
  const current = useRef(items);
  current.current = items;
  const source = useMemo(() => {
    const result = new PagedMediaSource(
      { type, sort: "name" },
      async (query) => ({
        items: current.current.slice(
          query.offset ?? 0,
          (query.offset ?? 0) + (query.limit ?? PAGE_SIZE),
        ),
        total: current.current.length,
      }),
      true,
    );
    // A newly mounted layout must never observe an empty placeholder extent.
    result.replaceExternalItems(
      current.current,
      anchor.focusId,
      anchor.focusIndex,
    );
    return result;
  }, [key, type]);
  useLayoutEffect(() => {
    source.replaceExternalItems(
      items,
      anchor.focusId,
      anchor.focusIndex,
      change,
    );
  }, [source, items, change?.serial]);
  useEffect(() => () => source.dispose(), [source]);
  useSyncExternalStore(source.subscribe, source.getSnapshot);
  return source;
}

export function useMediaSource(
  query: MediaQuery,
  revision: number,
  anchor: { focusId?: string; focusIndex?: number },
  fetchPage?: FetchPage,
) {
  const key = JSON.stringify(query);
  const source = useMemo(
    () => new PagedMediaSource(query, fetchPage, Boolean(fetchPage)),
    [key, fetchPage],
  );
  useEffect(() => {
    void source.initialize(anchor.focusId, anchor.focusIndex);
    return () => source.dispose();
  }, [source]);
  useEffect(() => {
    void source.refresh(anchor.focusId, anchor.focusIndex);
  }, [source, revision]);
  useEffect(
    () =>
      window.media.onIndexChange((change) =>
        source.applyChange(change, anchor),
      ),
    [source, anchor.focusId, anchor.focusIndex],
  );
  useEffect(
    () =>
      window.media.onHistoryChange(() => {
        if (query.recent)
          void source.refresh(anchor.focusId, anchor.focusIndex);
      }),
    [source, query.recent, anchor.focusId, anchor.focusIndex],
  );
  useEffect(() => {
    const authenticated = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (
        !fetchPage ||
        ((query as any).providerId && (query as any).providerId !== id)
      )
        return;
      if (source.getSnapshot().errorCode === "auth-required") source.retry();
      else void source.refresh(anchor.focusId, anchor.focusIndex);
    };
    window.addEventListener("music-auth-changed", authenticated);
    return () =>
      window.removeEventListener("music-auth-changed", authenticated);
  }, [source, fetchPage]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  return { source, ...snapshot };
}
