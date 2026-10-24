import ePub from "epubjs";
// epub.js does not publish types for its manager extension points.
// @ts-expect-error Internal manager class from pinned epub.js 0.3.x.
import ContinuousManager from "epubjs/src/managers/continuous/index.js";
// @ts-expect-error Internal manager class from pinned epub.js 0.3.x.
import DefaultManager from "epubjs/src/managers/default/index.js";
import {
  ReaderNavigation,
  ReaderWheelSequence,
  ReaderBoundaryWheel,
  epubProgress,
  pageScrollTarget,
} from "../../shared/readerNavigation";
import { EpubResources } from "./epubResources";
import { ReaderProgressUpdates } from "../../shared/readerProgress";

class ReaderPagedManager extends DefaultManager {
  declare q: { stop(): void };
  declare container: HTMLElement;
  declare settings: { axis: string; direction: string };
  declare layout: { delta: number };
  declare isPaginated: boolean;
  declare scrollTo: (x: number, y: number, silent: boolean) => void;

  private turn(direction: number) {
    if (
      this.isPaginated &&
      this.settings.axis === "horizontal" &&
      this.settings.direction !== "rtl"
    ) {
      const target = pageScrollTarget(
        this.container.scrollLeft,
        this.container.scrollWidth,
        this.container.clientWidth,
        this.layout.delta,
        direction,
      );
      if (target !== undefined) {
        this.scrollTo(target, 0, true);
        return;
      }
      if (direction < 0) this.scrollTo(0, 0, true);
    }
    return direction > 0 ? super.next() : super.prev();
  }

  next() {
    return this.turn(1);
  }
  destroy() {
    // A rapid chapter change can close the session before render() creates its
    // scroller. epub.js otherwise tries to remove listeners from undefined.
    if (!this.container) {
      this.q?.stop();
      return;
    }
    super.destroy();
  }
  prev() {
    return this.turn(-1);
  }
}

/** Keep native append/trim compensation, but serialize coverage checks. */
class ReaderContinuousManager extends ContinuousManager {
  declare q: {
    enqueue(task: () => Promise<unknown>): Promise<void>;
    stop(): void;
  };
  declare views: { length: number };
  declare container: HTMLElement;
  declare scrollTop: number;
  declare scrollLeft: number;
  declare emit: (event: string, value: unknown) => void;
  declare afterScrolled: ReturnType<typeof setTimeout>;
  declare trimTimeout: ReturnType<typeof setTimeout>;
  declare scrollTimeout: ReturnType<typeof setTimeout>;
  private coverage?: Promise<void>;
  private coverageAgain = false;
  private closed = false;

  createView(section: unknown, forceRight: boolean) {
    const view = super.createView(section, forceRight);
    view.on("loaderror", (error: unknown) => this.emit("readererror", error));
    return view;
  }

  ensureCoverage(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.coverage) {
      this.coverageAgain = true;
      return this.coverage;
    }
    this.coverage = this.q
      .enqueue(async () => {
        if (this.closed || !this.views?.length) return;
        this.scrollTop = this.container.scrollTop;
        this.scrollLeft = this.container.scrollLeft;
        await super.check();
      })
      .then(() => undefined)
      .finally(() => {
        this.coverage = undefined;
        if (this.coverageAgain && !this.closed) {
          this.coverageAgain = false;
          void this.ensureCoverage().catch((error) =>
            this.emit("readererror", error),
          );
        }
      });
    return this.coverage!;
  }

  scrolled() {
    void this.ensureCoverage().catch((error) =>
      this.emit("readererror", error),
    );
    this.emit("scroll", { top: this.scrollTop, left: this.scrollLeft });
    clearTimeout(this.afterScrolled);
    this.afterScrolled = setTimeout(() => {
      if (!this.closed)
        this.emit("scrolled", { top: this.scrollTop, left: this.scrollLeft });
    }, 50);
  }

  destroy() {
    this.closed = true;
    clearTimeout(this.afterScrolled);
    clearTimeout(this.trimTimeout);
    clearTimeout(this.scrollTimeout);
    if (!this.container) {
      this.q?.stop();
      return;
    }
    super.destroy();
  }
}

export interface EpubLocationSnapshot {
  start: {
    cfi: string;
    href: string;
    index: number;
    displayed: { page: number; total: number };
  };
  end: {
    cfi: string;
    href: string;
    index: number;
    displayed: { page: number; total: number };
  };
  atStart: boolean;
  atEnd: boolean;
  whole: number;
  chapter: number;
}

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export class EpubReaderSession {
  book?: ReturnType<typeof ePub>;
  rendition: any;
  private resources?: EpubResources;
  private navigation: ReaderNavigation;
  private wheel = new ReaderWheelSequence();
  private closed = false;
  private failed = false;
  private ready = false;
  private restoring = false;
  private scrollIntent = 0;
  private scrollDirection = 0;
  private indexed = false;
  private revision = 0;
  private scrollX = 0;
  private scrollY = 0;
  private scrollFrame = 0;
  private scrolling = false;
  private boundaryPending = false;
  private boundaryWheel = new ReaderBoundaryWheel();
  private scrollBoundaryAllowed = true;
  private entryBoundary?: "start" | "end";
  holdBoundaryWheel(direction = 0) {
    this.boundaryWheel.hold(performance.now(), direction);
    this.scrollBoundaryAllowed = false;
  }
  private acceptWheelBoundary(direction: number) {
    return this.boundaryWheel.accept(performance.now(), direction);
  }
  private progressUpdates = new ReaderProgressUpdates<EpubLocationSnapshot>(
    (location) => {
      if (this.closed || this.failed || !this.ready || this.restoring) return;
      this.snapshot = location;
      this.host.dataset.readerLocation = JSON.stringify(location);
      this.host.dataset.readerIndexed = String(this.indexed);
      this.callbacks.location(location);
    },
  );
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private observer?: ResizeObserver;
  private cleanups = new Map<
    Document,
    { frame: Element | null; clean: () => void }
  >();
  private rejectOperation?: (error: unknown) => void;
  private snapshot?: EpubLocationSnapshot;
  private indexCancel?: () => void;

  constructor(
    private host: HTMLElement,
    readonly mode: "scroll" | "paged",
    private appearance: string,
    private callbacks: {
      content(doc: Document, sectionHref: string): () => void;
      location(value: EpubLocationSnapshot): void;
      indexReady(): void;
      navigation?(direction: number): void;
      boundary?(direction: number): void;
      failure(error: unknown): void;
    },
  ) {
    this.host.dataset.readerMode = mode;
    this.host.dataset.readerIndexed = "false";
    this.navigation = new ReaderNavigation((error) => this.fail(error));
  }

  private fail(error: unknown) {
    if (this.closed || this.failed) return;
    console.warn("EPUB reading session failed", error);
    this.failed = true;
    this.progressUpdates.cancel();
    this.ready = false;
    this.navigation.dispose();
    this.callbacks.failure(error);
  }

  private async operation<T>(run: () => Promise<T> | T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_resolve, reject) => {
          this.rejectOperation = reject;
          timer = setTimeout(
            () => reject(new Error("EPUB 章节加载超时，请重试")),
            12000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.rejectOperation = undefined;
    }
  }

  async start(data: ArrayBuffer, cfi?: string) {
    const book = ePub(data, { replacements: "none" });
    this.book = book;
    await this.operation(() => Promise.all([book.opened, book.ready]));
    if (this.closed) return;
    const resources = new EpubResources(book);
    this.resources = resources;
    await this.operation(() => resources.prepare());
    if (this.closed) return;
    book.spine.hooks.content.register(
      (doc: Document, section: { url: string }) => {
        resources.sanitize(doc, section, this.appearance);
      },
    );
    const rect = this.host.getBoundingClientRect();
    const rendition: any = book.renderTo(this.host, {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
      spread: "none",
      allowScriptedContent: false,
      manager:
        this.mode === "paged" ? ReaderPagedManager : ReaderContinuousManager,
      flow: this.mode === "paged" ? "paginated" : "scrolled-continuous",
      // Preload at least a viewport so a large wheel delta doesn't hit an empty edge.
      offset: Math.max(1000, rect.height * 2),
    } as any);
    this.rendition = rendition;
    rendition.on("started", () => {
      if (!this.closed)
        rendition.manager.on("readererror", (error: unknown) =>
          this.fail(error),
        );
    });
    rendition.on("displayerror", (error: unknown) => {
      this.rejectOperation?.(error);
      this.fail(error);
    });
    rendition.hooks.content.register((contents: any) => {
      if (this.closed) return;
      const doc = contents.document as Document;
      const style = doc.getElementById("kaleid-reader-appearance");
      if (style) style.textContent = this.appearance;
      this.cleanups.get(doc)?.clean();
      const section = book.spine.get(contents.sectionIndex);
      this.cleanups.set(doc, {
        frame: doc.defaultView?.frameElement ?? null,
        clean: this.callbacks.content(doc, section?.href ?? ""),
      });
    });
    rendition.on("removed", () => {
      for (const [doc, entry] of this.cleanups) {
        if (!entry.frame?.isConnected) {
          entry.clean();
          this.cleanups.delete(doc);
        }
      }
    });
    rendition.on("relocated", () => this.schedulePublish());
    await this.operation(() => rendition.display(cfi || undefined));
    if (this.closed) return;
    this.ready = true;
    this.publish();
    this.observer = new ResizeObserver(() => {
      if (!this.ready || this.closed) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.resize(), 120);
    });
    this.observer.observe(this.host);
    void this.generateIndex(data).catch((error) => {
      if (!this.closed) console.warn("EPUB location index unavailable", error);
    });
  }

  private async generateIndex(data: ArrayBuffer) {
    const indexBook = ePub(data.slice(0), { replacements: "none" });
    const locations: string[] = [];
    try {
      await Promise.all([indexBook.opened, indexBook.ready]);
      if (this.closed) return;
      indexBook.spine.hooks.content.register(
        (doc: Document, section: { url: string }) => {
          this.resources!.sanitize(doc, section);
        },
      );
      const sections = (indexBook.spine as any).spineItems as any[];
      for (const section of sections) {
        if (this.closed) return;
        if (!section.linear) continue;
        // Bounded idle scheduling: ongoing input cannot starve the index.
        await new Promise<void>((resolve) => {
          if (window.requestIdleCallback) {
            const id = window.requestIdleCallback(
              () => {
                this.indexCancel = undefined;
                resolve();
              },
              { timeout: 150 },
            );
            this.indexCancel = () => {
              window.cancelIdleCallback(id);
              resolve();
            };
          } else {
            const id = setTimeout(resolve, 16);
            this.indexCancel = () => {
              clearTimeout(id);
              resolve();
            };
          }
        });
        if (this.closed) return;
        const contents = await section.load(indexBook.load.bind(indexBook));
        locations.push(
          ...(indexBook.locations as any).parse(
            contents,
            section.cfiBase,
            // Match the footer's 0.1% precision; a 1000-character bucket can
            // otherwise leave several successfully turned pages at the same %.
            100,
          ),
        );
        section.unload();
      }
      if (!this.closed && locations.length) {
        this.book!.locations.load(JSON.stringify(locations));
        this.indexed = this.book!.locations.length() > 0;
        this.callbacks.indexReady();
        this.schedulePublish();
      }
    } finally {
      indexBook.destroy();
    }
  }

  private readLocation(): EpubLocationSnapshot | undefined {
    const manager = this.rendition?.manager;
    if (!manager?.views?.length) return;
    const raw = manager.currentLocation();
    const location = this.rendition.located(raw);
    if (!location.start?.cfi || !location.end?.cfi) return;
    const scroller = manager.container as HTMLElement;
    const first = this.book!.spine.first().index;
    const last = this.book!.spine.last().index;
    const vertical = this.mode === "scroll";
    const rtl = manager.settings.direction === "rtl";
    location.atStart =
      location.start.index === first &&
      (vertical
        ? scroller.scrollTop <= 2
        : rtl
          ? !!location.atStart
          : scroller.scrollLeft <= 2);
    location.atEnd =
      location.end.index === last &&
      (vertical
        ? scroller.scrollTop + scroller.clientHeight >=
          scroller.scrollHeight - 2
        : rtl
          ? !!location.atEnd
          : scroller.scrollLeft + scroller.clientWidth >=
            scroller.scrollWidth - 2);
    const indexedFraction =
      this.indexed && this.book!.locations.length() > 0
        ? this.book!.locations.percentageFromCfi(location.start.cfi)
        : undefined;
    const snapshot = {
      ...location,
      ...epubProgress(location, indexedFraction),
    };
    this.host.dataset.readerLiveLocation = JSON.stringify(snapshot);
    return snapshot;
  }

  private schedulePublish() {
    // Relocated may fire mid-layout. Completed engine operations publish their
    // own stable snapshots even when more navigation/scroll input is pending.
    if (!this.navigation.busy && !this.scrolling) this.publish();
  }

  private publish(immediate = false, stable?: EpubLocationSnapshot) {
    if (this.closed || this.failed || !this.ready || this.restoring) return;
    const location = stable ?? this.readLocation();
    if (!location) return;
    this.progressUpdates.push(location);
    if (immediate) this.progressUpdates.flush();
  }

  releaseBoundary() {
    this.boundaryPending = false;
  }
  private crossBoundary(direction: number) {
    if (this.boundaryPending || !this.callbacks.boundary) return;
    this.boundaryPending = true;
    this.flushProgress();
    this.callbacks.boundary(Math.sign(direction));
  }
  displayBoundary(direction: number) {
    if (!this.book) return Promise.resolve(false);
    this.entryBoundary = direction > 0 ? "end" : "start";
    return this.display(
      direction > 0
        ? this.book.spine.last().href
        : this.book.spine.first().href,
      direction > 0,
      direction < 0,
    );
  }

  page(
    direction: number,
    source: "wheel" | "other" = "other",
    boundaryAllowed = true,
  ) {
    if (
      !direction ||
      !this.ready ||
      this.restoring ||
      this.failed ||
      this.closed
    )
      return;
    if (this.mode === "scroll") {
      this.scroll(0, direction * this.host.clientHeight * 0.82);
      return;
    }
    const revision = this.revision;
    this.navigation.submit(async () => {
      if (
        source === "wheel" &&
        !this.wheel.current(performance.now(), direction)
      )
        return;
      if (this.closed || revision !== this.revision) return;
      const boundary = this.readLocation();
      if (
        this.callbacks.boundary &&
        (direction > 0 ? boundary?.atEnd : boundary?.atStart)
      ) {
        if (boundaryAllowed) this.crossBoundary(direction);
        return;
      }
      const manager = this.rendition.manager;
      const before = manager.container.scrollLeft;
      await this.operation(() =>
        direction > 0 ? this.rendition.next() : this.rendition.prev(),
      );
      if (this.closed || revision !== this.revision) return;
      this.entryBoundary = undefined;
      this.host.dataset.readerNavigation = JSON.stringify({
        direction,
        before,
        after: manager.container.scrollLeft,
        step: manager.layout.delta,
        axis: manager.settings.axis,
        manager: manager.constructor.name,
      });
      this.callbacks.navigation?.(direction);
      this.publish();
    });
  }

  wheelPage(direction: number) {
    const allowed = this.acceptWheelBoundary(direction);
    if (this.wheel.accept(performance.now(), direction))
      this.page(direction, "wheel", allowed);
  }

  scroll(x: number, y: number, source: "wheel" | "drag" | "other" = "other") {
    if (!this.ready || this.closed || this.failed || this.mode !== "scroll")
      return;
    this.scrollBoundaryAllowed =
      source !== "wheel" || this.acceptWheelBoundary(Math.sign(y));
    if (y && Math.sign(y) !== this.scrollDirection) {
      this.scrollDirection = Math.sign(y);
      this.scrollIntent++;
      this.scrollY = 0;
    }
    this.scrollX += x;
    this.scrollY = Math.max(
      -this.host.clientHeight * 6,
      Math.min(this.host.clientHeight * 6, this.scrollY + y),
    );
    this.queueScroll();
  }

  private queueScroll() {
    if (this.scrollFrame || this.scrolling || this.closed) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      void this.flushScroll().catch((error) => this.fail(error));
    });
  }

  private async flushScroll() {
    if (this.closed || this.failed || !this.ready) return;
    if (this.navigation.busy || this.restoring) {
      this.queueScroll();
      return;
    }
    // A fresh gesture at the existing chapter edge does not need to extend the
    // continuous manager's coverage (which has no adjacent spine item here).
    const boundary = this.readLocation();
    const boundaryDelta = this.scrollY;
    if (
      this.callbacks.boundary &&
      Math.abs(boundaryDelta) > 2 &&
      (boundaryDelta > 0 ? boundary?.atEnd : boundary?.atStart)
    ) {
      this.scrollX = this.scrollY = 0;
      if (this.scrollBoundaryAllowed) {
        this.crossBoundary(boundaryDelta);
      }
      return;
    }
    const revision = this.revision;
    this.scrolling = true;
    try {
      const manager = this.rendition.manager;
      await this.operation(() => manager.ensureCoverage());
      if (this.closed || revision !== this.revision) return;
      const scroller = manager.container as HTMLElement;
      const delta = this.scrollY;
      const intent = this.scrollIntent;
      this.scrollY = 0;
      const before = scroller.scrollTop;
      scroller.scrollLeft += this.scrollX;
      this.scrollX = 0;
      scroller.scrollTop += delta;
      if (Math.abs(scroller.scrollTop - before) > 0)
        this.entryBoundary = undefined;
      const remaining = delta - (scroller.scrollTop - before);
      await this.operation(() => manager.ensureCoverage());
      if (this.closed || revision !== this.revision) return;
      const location = this.readLocation();
      if (location) this.publish(false, location);
      if (
        intent === this.scrollIntent &&
        Math.abs(remaining) > 2 &&
        !(delta > 0 ? location?.atEnd : location?.atStart)
      )
        this.scrollY += remaining;
    } finally {
      this.scrolling = false;
      if (!this.closed && (Math.abs(this.scrollY) > 2 || this.scrollX))
        this.queueScroll();
      this.schedulePublish();
    }
  }

  display(target: string, end = false, start = false) {
    if (this.closed || this.failed || !this.ready)
      return Promise.resolve(false);
    this.progressUpdates.cancel();
    this.restoring = true;
    this.revision++;
    this.scrollX = this.scrollY = 0;
    const revision = this.revision;
    return this.navigation.submit(async () => {
      // Wait for an active coverage check before replacing its views.
      while (this.scrolling && !this.closed) await frame();
      if (this.closed || revision !== this.revision) return;
      await this.operation(() => this.rendition.display(target));
      if (this.closed || revision !== this.revision) return;
      if (end || start) {
        if (this.mode === "scroll")
          await this.operation(() => this.rendition.manager.ensureCoverage());
        const scroller = this.rendition.manager.container as HTMLElement;
        if (this.mode === "scroll")
          scroller.scrollTop = start ? 0 : scroller.scrollHeight;
        else if (end)
          scroller.scrollLeft =
            this.rendition.manager.settings.direction === "rtl"
              ? -(scroller.scrollWidth - scroller.clientWidth)
              : scroller.scrollWidth - scroller.clientWidth;
      }
      await frame();
      if (revision === this.revision) this.restoring = false;
      this.publish(true);
    }, true);
  }

  seek(fraction: number) {
    if (!this.indexed || !this.book) return Promise.resolve(false);
    // An explicit seek starts a new reading intent rather than continuing the
    // wheel inertia that crossed into this chapter.
    this.boundaryWheel.clear();
    if (fraction <= 0) {
      return this.display(this.book.spine.first().href);
    }
    return this.display(
      this.book.locations.cfiFromPercentage(fraction),
      fraction >= 1,
    );
  }

  updateAppearance(css: string, reflow: boolean) {
    this.appearance = css;
    if (!this.rendition || !this.ready || this.closed) return;
    const cfi = this.entryBoundary
      ? undefined
      : this.readLocation()?.start.cfi ?? this.snapshot?.start.cfi;
    const apply = () => {
      for (const contents of this.rendition.getContents()) {
        const style = contents.document.getElementById(
          "kaleid-reader-appearance",
        );
        if (style) style.textContent = css;
      }
    };
    if (!reflow) {
      apply();
      return;
    }
    this.revision++;
    this.progressUpdates.cancel();
    this.restoring = true;
    const revision = this.revision;
    this.scrollX = this.scrollY = 0;
    this.navigation.submit(async () => {
      while (this.scrolling && !this.closed) await frame();
      if (this.closed) return;
      apply();
      await frame();
      await frame();
      this.rendition.manager.updateLayout();
      if (cfi) await this.operation(() => this.rendition.display(cfi));
      if (revision === this.revision) this.restoring = false;
      this.publish(true);
    }, true);
  }

  private resize() {
    if (!this.ready || this.closed) return;
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const size = this.rendition.manager._stageSize;
    if (size?.width === width && size?.height === height) return;
    const cfi = this.entryBoundary
      ? undefined
      : this.readLocation()?.start.cfi ?? this.snapshot?.start.cfi;
    this.revision++;
    this.progressUpdates.cancel();
    this.restoring = true;
    const revision = this.revision;
    // Keep a gesture received just before the ResizeObserver callback. Losing
    // it here would swallow the first deliberate wheel at a chapter boundary.
    this.navigation.submit(async () => {
      while (this.scrolling && !this.closed) await frame();
      if (this.closed) return;
      await this.operation(() => {
        this.rendition.resize(width, height, cfi);
        return this.rendition.q.enqueue(() => undefined);
      });
      if (this.entryBoundary && this.mode === "scroll") {
        await this.operation(() => this.rendition.manager.ensureCoverage());
        const scroller = this.rendition.manager.container as HTMLElement;
        scroller.scrollTop =
          this.entryBoundary === "start" ? 0 : scroller.scrollHeight;
      }
      if (revision === this.revision) this.restoring = false;
      this.publish(true);
      if (this.scrollY || this.scrollX) this.queueScroll();
    }, true);
  }

  flushProgress() {
    if (!this.navigation.busy && !this.scrolling) this.publish(true);
    this.progressUpdates.flush();
  }

  dispose() {
    this.progressUpdates.cancel();
    this.closed = true;
    this.revision++;
    this.navigation.dispose();
    this.indexCancel?.();
    this.observer?.disconnect();
    this.progressUpdates.cancel();
    clearTimeout(this.resizeTimer);
    cancelAnimationFrame(this.scrollFrame);
    this.rejectOperation?.(new Error("Reading session closed"));
    for (const entry of this.cleanups.values()) entry.clean();
    this.cleanups.clear();
    // Book.opened resolves before navigation parsing. Destroying immediately can
    // null out `loading`/`resources` while epub.js is still using them (dev is
    // particularly sensitive because mode switches happen during module loads).
    const book = this.book;
    const rendition = this.rendition;
    const renderWork =
      rendition?.manager?.views
        ?.all?.()
        .map((view: any) => view.sectionRender)
        .filter(Boolean) ?? [];
    rendition?.manager?.container?.remove();
    void Promise.allSettled([
      book?.opened,
      book?.ready,
      rendition?.started,
      ...renderWork,
    ]).then(() => {
      rendition?.q?.stop();
      rendition?.manager?.q?.stop();
      book?.destroy();
      this.resources?.dispose();
    });
    delete this.host.dataset.readerLiveLocation;
    delete this.host.dataset.readerLocation;
    delete this.host.dataset.readerIndexed;
    delete this.host.dataset.readerNavigation;
  }
}
