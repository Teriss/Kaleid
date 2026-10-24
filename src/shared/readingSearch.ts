/** Search state shared by comic and novel adapters; cursors remain source-owned. */
export type ReadingResultLayout = "grid" | "archiveShelf" | "carousel";
export type ReadingResultMode = "pagination" | "waterfall";
export type ReadingLoadOperation = "replace" | "jump" | "prepend" | "append";
/** New searches/pages must not inherit the last result's scroll or selection. */
export function readingResultStart() {
  return {
    focusId: undefined,
    focusIndex: 0,
    scrollTop: 0,
    carouselPosition: 0,
    spatialCamera: { x: 0, y: 0 },
    revealFocus: false,
    focusRequest: Date.now(),
  };
}
export interface ReadingSearchPage<T, I> {
  query: string;
  options: unknown[];
  submittedOptions: unknown[];
  resultLayout: ReadingResultLayout;
  resultMode: ReadingResultMode;
  cards: T[];
  pageInfo?: I;
  page: number;
  cursors: (string | null | undefined)[];
  maxPage?: number;
  jumpPage: string;
  busy: boolean;
  error: string;
  autoLoadPaused: boolean;
  pages: Record<number, { items: T[]; info: I }>;
  startPage: number;
  endPage: number;
  visiblePage: number;
  itemPages: Record<string, number>;
  beforeError: string;
  afterError: string;
  beforePaused: boolean;
  afterPaused: boolean;
  jumpError: string;
  failedPage?: number;
  loadingOperation?: ReadingLoadOperation;
  change?: { serial: number; kind: ReadingLoadOperation; targetId?: string };
}
export function emptyReadingSearchPage<T, I>(
  patch: Partial<ReadingSearchPage<T, I>> = {},
): ReadingSearchPage<T, I> {
  return {
    query: "",
    options: [],
    submittedOptions: patch.options || [],
    resultLayout: "grid",
    resultMode: "pagination",
    cards: [],
    page: 1,
    cursors: [null],
    jumpPage: "1",
    busy: false,
    error: "",
    autoLoadPaused: false,
    pages: {},
    startPage: 1,
    endPage: 1,
    visiblePage: 1,
    itemPages: {},
    beforeError: "",
    afterError: "",
    beforePaused: false,
    afterPaused: false,
    jumpError: "",
    ...patch,
  };
}
export function newReadingSearchId() {
  return crypto.randomUUID();
}
export async function searchSourcePool<T>(
  sources: T[],
  search: (source: T) => Promise<void>,
  current: () => boolean = () => true,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, sources.length) }, async () => {
      while (current() && next < sources.length) await search(sources[next++]);
    }),
  );
}
export async function loadReadingSearchPage<T, I>({
  previous,
  number,
  append = false,
  operation = append ? "append" : "replace",
  cursorBased = true,
  fetchPage,
  unpack,
  identity,
  current,
  update,
  formatError = String,
}: {
  previous: ReadingSearchPage<T, I>;
  number: number;
  append?: boolean;
  operation?: ReadingLoadOperation;
  cursorBased?: boolean;
  fetchPage(page: number, cursor?: string | null): Promise<I>;
  unpack(info: I): { items: T[]; next?: string | null; maxPage?: number };
  identity(item: T): string;
  current(): boolean;
  update(patch: Partial<ReadingSearchPage<T, I>>): void;
  formatError?(error: unknown): string;
}) {
  const fresh = number === 1 && operation === "replace";
  const adjoining = operation === "append" || operation === "prepend";
  const before = operation === "prepend";
  const pages = fresh ? {} : { ...previous.pages };
  const pageItems = (items: T[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const id = identity(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const cursors = fresh ? [null] : [...previous.cursors];
  let maxPage = fresh ? undefined : previous.maxPage;
  update({
    ...(fresh
      ? {
          cards: [],
          pageInfo: undefined,
          page: 1,
          cursors: [null],
          maxPage: undefined,
          jumpPage: "1",
        }
      : {}),
    busy: true,
    error: "",
    loadingOperation: operation,
    ...(operation === "jump"
      ? { jumpError: "" }
      : before
        ? { beforeError: "", beforePaused: false }
        : { afterError: "", afterPaused: false }),
  });
  try {
    if (number < 1 || (maxPage != null && number > maxPage))
      throw new Error(`页码应在 1–${maxPage ?? "末页"} 之间`);
    if (
      !pages[number] &&
      cursorBased &&
      number > 1 &&
      cursors[number - 1] === undefined &&
      maxPage == null
    ) {
      for (let page = Math.max(1, cursors.length); page < number; page++) {
        if (!current()) return;
        if (page > 1 && cursors[page - 1] == null)
          throw new Error(`该源最多只能访问第 ${page - 1} 页`);
        const info =
          pages[page]?.info ?? (await fetchPage(page, cursors[page - 1]));
        if (!current()) return;
        const intermediate = unpack(info);
        pages[page] = { items: pageItems(intermediate.items), info };
        maxPage = intermediate.maxPage ?? maxPage;
        if (maxPage != null && number > maxPage)
          throw new Error(`该源最多只能访问第 ${maxPage} 页`);
        cursors[page] = intermediate.next ?? null;
        if (
          page < number - 1 &&
          intermediate.next == null &&
          intermediate.maxPage == null
        ) {
          maxPage = page;
          throw new Error(`该源最多只能访问第 ${page} 页`);
        }
      }
    }
    if (
      !pages[number] &&
      cursorBased &&
      number > 1 &&
      cursors[number - 1] == null &&
      maxPage == null
    )
      throw new Error(`该源最多只能访问第 ${number - 1} 页`);
    const info =
      operation !== "replace" && pages[number]
        ? pages[number].info
        : await fetchPage(number, cursors[number - 1]);
    if (!current()) return;
    const result = unpack(info);
    cursors[number] = result.next;
    pages[number] = { items: pageItems(result.items), info };
    const inside =
      operation === "jump" &&
      number >= previous.startPage &&
      number <= previous.endPage;
    const startPage =
      adjoining || inside ? Math.min(previous.startPage, number) : number;
    const endPage =
      adjoining || inside ? Math.max(previous.endPage, number) : number;
    const seen = new Set<string>(),
      cards: T[] = [],
      itemPages: Record<string, number> = {};
    for (let page = startPage; page <= endPage; page++) {
      for (const item of pages[page]?.items ?? []) {
        const id = identity(item);
        if (seen.has(id)) continue;
        seen.add(id);
        cards.push(item);
        itemPages[id] = page;
      }
    }
    const oldIds = new Set(previous.cards.map(identity));
    const noNewItems =
      adjoining && cards.every((item) => oldIds.has(identity(item)));
    const targetId = cards.find((item) => itemPages[identity(item)] === number);
    update({
      cards,
      pages,
      startPage,
      endPage,
      itemPages,
      visiblePage: adjoining ? previous.visiblePage : number,
      pageInfo: pages[endPage]?.info,
      page: endPage,
      cursors,
      maxPage:
        result.maxPage ??
        maxPage ??
        (result.next === null ? number : undefined),
      jumpPage: String(number),
      busy: false,
      error: "",
      jumpError: "",
      failedPage: undefined,
      loadingOperation: undefined,
      autoLoadPaused: before ? previous.afterPaused : noNewItems,
      ...(!adjoining
        ? {
            beforeError: "",
            beforePaused: false,
            afterError: "",
            afterPaused: false,
          }
        : before
          ? { beforeError: "", beforePaused: noNewItems }
          : { afterError: "", afterPaused: noNewItems }),
      change: {
        serial: (previous.change?.serial ?? 0) + 1,
        kind: operation,
        targetId: targetId && identity(targetId),
      },
    });
  } catch (error) {
    if (current())
      update({
        ...(fresh
          ? {
              cards: [],
              pageInfo: undefined,
              page: 1,
              cursors: [null],
              maxPage: undefined,
            }
          : {}),
        busy: false,
        error: formatError(error),
        loadingOperation: undefined,
        autoLoadPaused: before ? previous.afterPaused : true,
        ...(operation === "jump"
          ? { jumpError: formatError(error), failedPage: number }
          : before
            ? { beforeError: formatError(error), beforePaused: true }
            : { afterError: formatError(error), afterPaused: true }),
        pages,
        cursors,
        maxPage,
      });
  }
}

/** Returning from a waterfall to pagination shows only the current source page. */
export function readingResultModePatch<T, I>(
  state: ReadingSearchPage<T, I>,
  mode: ReadingResultMode,
  pageItems: T[],
) {
  return {
    resultMode: mode,
    ...(mode === "pagination"
      ? {
          cards: state.pages[state.visiblePage]?.items ?? pageItems,
          pageInfo: state.pages[state.visiblePage]?.info ?? state.pageInfo,
          page: state.visiblePage,
          startPage: state.visiblePage,
          endPage: state.visiblePage,
          jumpPage: String(state.visiblePage),
        }
      : {}),
  };
}
