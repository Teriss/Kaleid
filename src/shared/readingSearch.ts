/** Search state shared by comic and novel adapters; cursors remain source-owned. */
export type ReadingResultLayout = "grid" | "archiveShelf" | "carousel";
export type ReadingResultMode = "pagination" | "waterfall";
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
  fetchPage(page: number, cursor?: string | null): Promise<I>;
  unpack(info: I): { items: T[]; next?: string | null; maxPage?: number };
  identity(item: T): string;
  current(): boolean;
  update(patch: Partial<ReadingSearchPage<T, I>>): void;
  formatError?(error: unknown): string;
}) {
  const fresh = number === 1 && !append;
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
  });
  try {
    if (number > 1 && cursors[number - 1] === undefined && maxPage == null) {
      for (let page = Math.max(1, cursors.length); page < number; page++) {
        if (!current()) return;
        if (page > 1 && cursors[page - 1] == null)
          throw new Error(`该源最多只能访问第 ${page - 1} 页`);
        const intermediate = unpack(await fetchPage(page, cursors[page - 1]));
        if (!current()) return;
        maxPage = intermediate.maxPage ?? maxPage;
        if (maxPage != null && number > maxPage)
          throw new Error(`该源最多只能访问第 ${maxPage} 页`);
        cursors[page] = intermediate.next ?? null;
        if (
          page < number - 1 &&
          intermediate.next == null &&
          intermediate.maxPage == null
        )
          throw new Error(`该源最多只能访问第 ${page} 页`);
      }
    }
    if (number > 1 && cursors[number - 1] == null && maxPage == null)
      throw new Error(`该源最多只能访问第 ${number - 1} 页`);
    const info = await fetchPage(number, cursors[number - 1]);
    if (!current()) return;
    const result = unpack(info);
    cursors[number] = result.next;
    const seen = new Set(previous.cards.map(identity));
    const cards = append
      ? [
          ...previous.cards,
          ...result.items.filter((item) => !seen.has(identity(item))),
        ]
      : result.items;
    update({
      cards,
      pageInfo: info,
      page: number,
      cursors,
      maxPage: result.maxPage,
      jumpPage: String(number),
      busy: false,
      error: "",
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
    ...(mode === "pagination" ? { cards: pageItems } : {}),
  };
}
