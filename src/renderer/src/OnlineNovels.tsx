import {
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowDownUp,
  Bell,
  BookmarkPlus,
  Check,
  Clock3,
  Compass,
  Copy,
  FolderDown,
  FolderOpen,
  Heart,
  Home,
  Info,
  LoaderCircle,
  Menu,
  Plus,
  Trash2,
  X,
  Download,
  Grid2X2,
  RefreshCw,
  Search,
} from "lucide-react";
import type { BrowseLocation, NavigationMode } from "../../shared/navigation";
import type { BrowseMemory, MediaItem, Progress } from "../../shared/types";
import type {
  NovelSourceId,
  NovelSourceInfo,
  OnlineNovel,
  OnlineNovelRef,
  OnlineNovelDetails,
  NovelSearchPage,
  NovelReaderState,
  NovelDownloadTask,
  NovelFollowState,
  NovelHubList,
} from "../../shared/onlineNovels";
import { Cover, IconButton, Modal } from "./components";
import { act, report, useApp } from "./store";
import NovelViewer from "./NovelViewer";
import { useExternalMediaSource } from "./layouts/source";
import SourceOrderList from "./SourceOrderList";
import type { LayoutProps } from "./layouts/shared";
import {
  ReadingHubCards,
  ReadingHomeSearch,
  ReadingHubMenu,
  ReadingDetailSkeleton,
  HomeSectionToggle,
  ReadingPageShell,
  ReadingResults,
  ReadingDetailHero,
  HubContextMenu,
  type HubMenuItem,
  DownloadQueueModal,
  type DownloadQueueGroup,
} from "./ReadingHub";
import {
  useReadingSearchPanel,
  ReadingSearchPanel,
  ReadingSearchHistory,
  ReadingResultControls,
  ReadingPagination,
  ReadingWaterfallStart,
  ReadingWaterfallControls,
} from "./ReadingSearch";
import {
  emptyReadingSearchPage,
  readingResultModePatch,
  readingResultStart,
  loadReadingSearchPage,
  newReadingSearchId,
  normalizeReadingSearchTerms,
  limitReadingSearchHistory,
  searchSourcePool,
  type ReadingSearchPage,
  type ReadingLoadOperation,
} from "../../shared/readingSearch";
import "./onlineComics.css";
import "./onlineNovels.css";

const api = () => window.media.onlineNovels;
const errorText = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
const refOf = (n: OnlineNovel): OnlineNovelRef => ({
  sourceId: n.sourceId,
  novelId: n.novelId,
});
const same = (a: OnlineNovelRef, b: OnlineNovelRef) =>
  a.sourceId === b.sourceId && a.novelId === b.novelId;
type NovelCardItem = OnlineNovel | MediaItem;
function cardItem(n: OnlineNovel): MediaItem {
  return {
    id: `novel-card:${n.sourceId}:${n.novelId}`,
    title: n.title,
    type: "novel",
    path: "",
    folder: "",
    ext: "online",
    size: 0,
    modifiedAt: 0,
    addedAt: 0,
    favorite: Boolean(n.favorite),
    missing: false,
    libraryIds: [],
    cover: n.cover,
    remoteCover: n.cover,
    // Cards use the controlled cover protocol; chapter refs are assigned only when opening the reader.
    remoteData: { novel: n },
  };
}
function NovelCards({
  novels,
  open,
}: {
  novels: OnlineNovel[];
  open(n: OnlineNovel): void;
}) {
  return (
    <ReadingHubCards
      items={novels}
      identity={(n) => `${n.sourceId}:${n.novelId}`}
      title={(n) => n.title}
      cover={(n) => <Cover item={cardItem(n)} />}
      open={open}
      empty="暂无小说"
      large
    />
  );
}

function preference<T>(key: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem(`novel:${key}`) || "null") ?? fallback
    );
  } catch {
    return fallback;
  }
}
type NovelResultPreference = {
  layout: "grid" | "archiveShelf" | "carousel";
  mode: "pagination" | "waterfall";
};
const retainedNovelSearchPages = new Map<
  string,
  ReadingSearchPage<OnlineNovel, NovelSearchPage>
>();
function novelSingleResultPreference(): NovelResultPreference {
  const fallback: NovelResultPreference = {
    layout: "grid",
    mode: "pagination",
  };
  try {
    let raw = localStorage.getItem("novel:single-result");
    if (!raw) {
      const legacyKeys = Object.keys(localStorage).filter((key) =>
        key.startsWith("novel:single-result:"),
      );
      raw = legacyKeys.length ? localStorage.getItem(legacyKeys[0]) : null;
      if (raw) localStorage.setItem("novel:single-result", raw);
    }
    const stored = JSON.parse(raw || "{}");
    return {
      layout: (["grid", "archiveShelf", "carousel"].includes(stored.layout)
        ? stored.layout
        : fallback.layout) as typeof fallback.layout,
      mode: (stored.mode === "waterfall"
        ? "waterfall"
        : fallback.mode) as typeof fallback.mode,
    };
  } catch {
    return fallback;
  }
}
const NOVEL_MENU_ITEMS = [
  { section: "home", label: "首页", Icon: Home },
  { section: "discover", label: "发现", Icon: Compass },
  { section: "search", label: "搜索", Icon: Search },
  { section: "shelf", label: "书架", Icon: Heart },
  { section: "history", label: "最近阅读", Icon: Clock3 },
  { section: "readLater", label: "稍后阅读", Icon: BookmarkPlus },
  { section: "following", label: "追更", Icon: BookmarkPlus },
  { section: "downloads", label: "已下载", Icon: FolderDown },
  { section: "local", label: "本地小说", Icon: FolderOpen },
];

function Results({
  novels,
  memory,
  remember,
  open,
  favorite,
  removeHistory,
  contextMenu,
  onReachEnd,
  onReachStart,
  change,
  onViewportAnchorChange,
}: {
  novels: OnlineNovel[];
  memory: BrowseMemory;
  remember(p: Partial<BrowseMemory>): void;
  open(n: OnlineNovel): void;
  favorite(n: OnlineNovel): void;
  removeHistory?(n: OnlineNovel): void;
  contextMenu?(n: OnlineNovel, event: ReactMouseEvent): void;
  onReachEnd?(): void;
  onReachStart?(): void;
  change?: ReadingSearchPage<OnlineNovel, NovelSearchPage>["change"];
  onViewportAnchorChange?(item: MediaItem, index: number): void;
}) {
  const latestMemory = useRef(memory);
  latestMemory.current = { ...latestMemory.current, layout: memory.layout };
  const rememberResult = (patch: Partial<BrowseMemory>) => {
    latestMemory.current = { ...latestMemory.current, ...patch };
    remember(patch);
  };
  const items = useMemo(() => novels.map(cardItem), [novels]);
  const source = useExternalMediaSource(
    "results",
    "novel",
    items,
    latestMemory.current,
    change && {
      ...change,
      targetId: change.targetId && `novel-card:${change.targetId}`,
    },
  );
  const settings = useApp((s) => s.settings);
  const props: LayoutProps = {
    source,
    memory: latestMemory.current,
    remember: rememberResult,
    interactive: true,
    onReachEnd,
    onReachStart,
    onViewportAnchorChange,
    reducedMotion: settings.reducedMotion,
    open: (item) => open(item.remoteData!.novel),
    favorite: (item) => favorite(item.remoteData!.novel),
    removeRecent: removeHistory
      ? (item) => removeHistory(item.remoteData!.novel)
      : undefined,
    contextMenu: contextMenu
      ? (item, _index, event) => {
          const novel = item.remoteData?.novel as OnlineNovel | undefined;
          if (novel) contextMenu(novel, event);
        }
      : undefined,
    select: (item, index) =>
      rememberResult({ focusId: item.id, focusIndex: index }),
    selected: (item) => memory.focusId === item.id,
  };
  return (
    <div className="online-layout novel-results-layout">
      <ReadingResults props={props} layout={memory.layout} single />
    </div>
  );
}

export default function OnlineNovels({
  scope,
  navigate,
  onBack,
  resumeSearch,
  memory,
  remember,
  local,
  openLocal,
  openLayout,
}: {
  scope: BrowseLocation;
  navigate(next: BrowseLocation, mode?: NavigationMode): void;
  onBack(): boolean;
  resumeSearch(): boolean;
  memory: BrowseMemory;
  remember(p: Partial<BrowseMemory>): void;
  local(): void;
  openLocal(item: MediaItem): void;
  openLayout(): void;
}) {
  const section = scope.section || "home",
    page = scope.novelPage || 1;
  const localRevision = useApp((state) => state.revision);
  const [sources, setSources] = useState<NovelSourceInfo[]>([]),
    [revision, setRevision] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [groups, setGroups] = useState<Record<string, NovelSearchPage>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<OnlineNovelDetails>(),
    [reading, setReading] = useState<NovelReaderState>();
  const [lists, setLists] = useState<Record<string, OnlineNovel[]>>({}),
    [tasks, setTasks] = useState<NovelDownloadTask[]>([]),
    [follows, setFollows] = useState<NovelFollowState[]>([]);
  const [downloadQueueOpen, setDownloadQueueOpen] = useState(false);
  const downloadQueueGroups = useMemo<DownloadQueueGroup[]>(() => {
    const groups = new Map<string, NovelDownloadTask[]>();
    for (const task of tasks) {
      // Paused tasks stay listed so pausing never looks like a deletion.
      if (
        task.state !== "downloading" &&
        task.state !== "queued" &&
        task.state !== "paused"
      )
        continue;
      const key = `${task.sourceId}\u0000${task.novelId}`;
      const group = groups.get(key) || [];
      group.push(task);
      groups.set(key, group);
    }
    return [...groups].map(([id, entries]) => {
      const active = entries.filter(
        (task) => task.state === "downloading" || task.state === "queued",
      );
      const paused = entries.filter((task) => task.state === "paused");
      const downloading = active.filter(
        (task) => task.state === "downloading",
      ).length;
      const queued = active.length - downloading;
      const pausedOnly = !!paused.length && !active.length;
      const allNovelTasks = tasks.filter(
        (task) =>
          task.sourceId === entries[0].sourceId &&
          task.novelId === entries[0].novelId,
      );
      const completed = allNovelTasks.filter(
        (task) => task.state === "completed",
      ).length;
      const source = sources.find((entry) => entry.id === entries[0].sourceId);
      return {
        id,
        title: entries[0].novelTitle,
        subtitle: [
          source?.name,
          downloading ? `${downloading} 章下载中` : "",
          queued ? `${queued} 章排队` : "",
          paused.length ? `${paused.length} 章已暂停` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        taskIds: entries.map((task) => task.id),
        activeTaskIds: active.map((task) => task.id),
        pausedTaskIds: paused.map((task) => task.id),
        downloading,
        queued,
        paused: paused.length,
        progressLabel: `队列已完成 ${completed} / ${allNovelTasks.length} 章 · ${
          downloading ? "当前章节处理中" : pausedOnly ? "已暂停" : "等待开始"
        }`,
      };
    });
  }, [tasks, sources]);
  // Download controls only tell downloaded apart from not downloaded; progress
  // itself lives in the queue popup.
  const downloadTasks = useMemo(() => {
    const map = new Map<string, NovelDownloadTask>();
    for (const task of tasks)
      map.set(
        `${task.sourceId}\u0000${task.novelId}\u0000${task.chapterId ?? ""}`,
        task,
      );
    return map;
  }, [tasks]);
  const taskOf = (novel: OnlineNovelRef, chapterId: string) =>
    downloadTasks.get(
      `${novel.sourceId}\u0000${novel.novelId}\u0000${chapterId ?? ""}`,
    );
  const [localItems, setLocalItems] = useState<MediaItem[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeywordValue] = useState(scope.search || "");
  const drafts = useRef(new Map<string, string>());
  const draftKey = scope.novelSearchId || "legacy";
  const setKeyword = (value: string) => {
    drafts.current.set(draftKey, value);
    setKeywordValue(value);
  };
  const searchSource =
    scope.searchMode === "single"
      ? scope.providerId ||
        sources.find((source) => source.enabled && source.capabilities.search)
          ?.id ||
        sources.find((source) => source.capabilities.search)?.id ||
        ""
      : "all";
  type SearchState = ReadingSearchPage<OnlineNovel, NovelSearchPage>;
  const searchPages = useRef(
    new Map<string, SearchState>(retainedNovelSearchPages),
  );
  const setSearchPage = (key: string, state: SearchState) => {
    searchPages.current.set(key, state);
    retainedNovelSearchPages.set(key, state);
  };
  const requestIds = useRef(new Map<string, number>());
  const [, setSearchStateRevision] = useState(0);
  const resultRequests = useRef(new Map<string, number>());
  const [resultPreference, setResultPreference] =
    useState<NovelResultPreference>(() => novelSingleResultPreference());
  const [loginSource, setLoginSource] = useState<NovelSourceId>(),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [loginBusy, setLoginBusy] = useState(false);
  const [directory, setDirectory] = useState(""),
    [detailError, setDetailError] = useState(""),
    [readerBusy, setReaderBusy] = useState(false);
  const [readerOverride, setReaderOverride] = useState<{
    id: string;
    progress: Progress;
  }>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [sourceSort, setSourceSort] = useState(() =>
    preference<string>("home-source-sort", "default"),
  );
  const [sourceOrder, setSourceOrder] = useState<string[]>(() =>
    preference<string[]>("home-source-order", []),
  );
  const [sourceBusy, setSourceBusy] = useState(false);
  const [collapsedHome, setCollapsedHome] = useState<Record<string, boolean>>(
    () => preference("home-collapsed", {}),
  );
  const [searchHistory, setSearchHistory] = useState<string[]>(() =>
    normalizeReadingSearchTerms(preference("search-history", [])),
  );
  const [pinnedSearchHistory, setPinnedSearchHistory] = useState<string[]>(() => {
    const history = normalizeReadingSearchTerms(
      preference("search-history", []),
    );
    return normalizeReadingSearchTerms(
      preference("search-history-pinned", []),
    ).filter((term) => history.includes(term));
  });
  const [searchHistoryCollapsed, setSearchHistoryCollapsed] = useState(() =>
    preference("search-history-collapsed", false),
  );
  const [aggregateIds, setAggregateIds] = useState<string[]>(
    () => scope.novelSearchSources || preference("search-sources", []),
  );
  const aggregateSelectionTouched = useRef(false);
  const aggregateSourceIds = sources
    .filter((source) => source.capabilities.search)
    .map((source) => source.id);
  const previousAggregateSourceIds = useRef<string[]>([]);
  useEffect(() => {
    if (!aggregateSourceIds.length) return;
    const previous = previousAggregateSourceIds.current;
    setAggregateIds((current) => {
      if (!previous.length && !aggregateSelectionTouched.current) {
        const saved = preference<string[] | undefined>(
          "search-sources",
          undefined,
        );
        return saved?.length
          ? [
              ...new Set([
                ...saved.filter((id) => aggregateSourceIds.includes(id)),
                ...aggregateSourceIds.filter((id) => !saved.includes(id)),
              ]),
            ]
          : aggregateSourceIds;
      }
      const retained = current.filter((id) => aggregateSourceIds.includes(id));
      const added = aggregateSourceIds.filter((id) => !previous.includes(id));
      return aggregateSelectionTouched.current
        ? retained
        : [...new Set([...retained, ...added])];
    });
    previousAggregateSourceIds.current = aggregateSourceIds;
  }, [sources]);
  const selectAggregateSources = (ids: string[]) => {
    aggregateSelectionTouched.current = true;
    setAggregateIds(ids);
  };
  const {
    searchPanelVisible,
    setSearchPanelVisible,
    searchInput,
    searchPanel,
    clearSearchPanelHideTimer,
    onSearchPointerMove,
    onSearchPointerDown,
  } = useReadingSearchPanel({
    section,
    remoteId: scope.remoteId,
    mode: scope.searchMode,
    sourceId: scope.providerId,
    pageId: scope.novelSearchId,
  });
  const [editingSource, setEditingSource] = useState<NovelSourceId>();
  const [sourceImportOpen, setSourceImportOpen] = useState(false);
  const [sourceAddress, setSourceAddress] = useState("");
  const [sourceRepositories, setSourceRepositories] = useState<string[]>([]);
  const [sourceEntries, setSourceEntries] = useState<
    {
      name: string;
      url: string;
      version?: string;
      description?: string;
      id?: string;
      installedId?: string;
    }[]
  >([]);
  const [sourceEntrySelection, setSourceEntrySelection] = useState<Set<string>>(
    new Set(),
  );
  const [sourceSettingsValues, setSourceSettingsValues] = useState<
    Record<string, unknown>
  >({});
  const root = useRef<HTMLElement>(null);
  const home = useRef<HTMLDivElement>(null);
  const manager = useRef<HTMLDivElement>(null);
  const hubMemory = useRef(memory);
  const rememberHub = (patch: Partial<BrowseMemory>) => {
    hubMemory.current = { ...hubMemory.current, ...patch };
    remember(patch);
  };
  const quickMenu = useRef<HTMLDivElement>(null);
  const locationKey = JSON.stringify([
    section,
    scope.providerId,
    scope.remoteId,
    scope.novelChapterId,
    scope.search,
    scope.searchMode,
    scope.novelPage,
    scope.novelSearchId,
    scope.novelSearchSources,
  ]);
  const singleSearch =
    section === "search" && scope.searchMode === "single" && !!scope.search;
  const emptySearch = section === "search" && !scope.search;
  const homeSources = useMemo(() => {
    const ordered = [...sources];
    if (sourceSort === "name-asc" || sourceSort === "name-desc")
      ordered.sort(
        (a, b) =>
          a.name.localeCompare(b.name, "zh-CN") *
          (sourceSort === "name-desc" ? -1 : 1),
      );
    if (sourceSort === "custom")
      ordered.sort(
        (a, b) =>
          (sourceOrder.indexOf(a.id) < 0 ? 99 : sourceOrder.indexOf(a.id)) -
          (sourceOrder.indexOf(b.id) < 0 ? 99 : sourceOrder.indexOf(b.id)),
      );
    return ordered;
  }, [sources, sourceSort, sourceOrder]);
  const persist = (key: string, value: unknown) =>
    localStorage.setItem(`novel:${key}`, JSON.stringify(value));
  const reorderHomeSources = (
    draggedId: string,
    targetId: string,
    insertAfter: boolean,
  ) => {
    if (!draggedId || draggedId === targetId) return;
    const reordered = [...homeSources];
    const draggedIndex = reordered.findIndex(
      (source) => source.id === draggedId,
    );
    if (draggedIndex < 0) return;
    const [dragged] = reordered.splice(draggedIndex, 1);
    const targetIndex = reordered.findIndex((source) => source.id === targetId);
    if (targetIndex < 0) return;
    reordered.splice(targetIndex + Number(insertAfter), 0, dragged);
    if (
      reordered.every((source, index) => source.id === homeSources[index]?.id)
    )
      return;
    const order = reordered.map((source) => source.id);
    setSourceOrder(order);
    persist("home-source-order", order);
    if (sourceSort !== "custom") {
      setSourceSort("custom");
      persist("home-source-sort", "custom");
    }
  };
  const toggleHome = (key: string) =>
    setCollapsedHome((old) => {
      const next = { ...old, [key]: !old[key] };
      persist("home-collapsed", next);
      return next;
    });
  useLayoutEffect(() => {
    hubMemory.current = memory;
    const node =
      section === "home"
        ? home.current
        : section === "sources"
          ? manager.current
          : root.current;
    if (node) node.scrollTop = hubMemory.current.scrollTop || 0;
    setSourceMenuOpen(false);
    setMenuOpen(false);
    // Layout components own their scroll/focus memory; the hub owns its outer pages.
  }, [locationKey]);
  useEffect(() => {
    const node =
      section === "home"
        ? home.current
        : section === "sources"
          ? manager.current
          : root.current;
    if (!node) return;
    // A loaded list or detail can grow after initial restoration.
    node.scrollTop = hubMemory.current.scrollTop || 0;
    if (hubMemory.current.focusId?.startsWith("hub:")) {
      const target = Array.from(
        node.querySelectorAll<HTMLElement>("[data-hub-id]"),
      ).find((el) => `hub:${el.dataset.hubId}` === hubMemory.current.focusId);
      target
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
    }
  }, [
    locationKey,
    sources.length,
    Object.values(lists)
      .map((items) => items.length)
      .join(","),
    details?.novelId,
    Object.keys(groups).join(","),
  ]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!quickMenu.current?.contains(event.target as Node))
        setSourceMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      clearSearchPanelHideTimer();
    };
  }, []);
  useEffect(() => {
    if (scope.novelSearchSources) setAggregateIds(scope.novelSearchSources);
  }, [locationKey]);
  const preparedReader = useRef<NovelReaderState | undefined>(undefined);
  const transitionBusy = useRef(false);
  const readerRoute = useRef("");
  readerRoute.current = JSON.stringify([
    scope.providerId,
    scope.remoteId,
    scope.novelChapterId,
  ]);
  const loadSerial = useRef(0),
    detailSerial = useRef(0),
    readerSerial = useRef(0);
  const sourceId = (scope.providerId ||
    sources.find((s) => s.enabled)?.id ||
    sources[0]?.id ||
    "") as NovelSourceId;
  const ref = useMemo<OnlineNovelRef | undefined>(
    () => (scope.remoteId ? { sourceId, novelId: scope.remoteId } : undefined),
    [sourceId, scope.remoteId],
  );
  const go = (patch: Partial<BrowseLocation>, mode: NavigationMode = "push") =>
    navigate(
      {
        view: "novel",
        type: "novel",
        section: "home",
        ...patch,
        ...(patch.section === "search"
          ? { novelSearchId: patch.novelSearchId || newReadingSearchId() }
          : {}),
      },
      mode,
    );
  const open = (novel: OnlineNovel) =>
    go({
      section: "details",
      providerId: novel.sourceId,
      remoteId: novel.novelId,
      remoteKind: "novel",
    });
  const back = () => {
    if (!onBack())
      go(
        {
          section: scope.novelChapterId ? "details" : "home",
          providerId: sourceId,
          remoteId: scope.novelChapterId ? scope.remoteId : undefined,
        },
        "replace",
      );
  };
  const read = async (
    id: string,
    progress?: Progress,
    entry?: "start" | "end",
  ) => {
    if (!ref || transitionBusy.current) return;
    if (reading && scope.novelChapterId) {
      transitionBusy.current = true;
      const expected = readerRoute.current;
      try {
        const next = await api().reader({ ...ref, chapterId: id });
        if (expected !== readerRoute.current) return;
        if (progress) next.item.progress = progress;
        else if (entry)
          next.item.progress = { scroll: entry === "end" ? 1 : 0 };
        if (entry)
          next.item.remoteData = { ...next.item.remoteData, novelEntry: entry };
        preparedReader.current = next;
      } finally {
        transitionBusy.current = false;
      }
    } else setReaderOverride(progress ? { id, progress } : undefined);
    go(
      {
        section: "details",
        providerId: ref.sourceId,
        remoteId: ref.novelId,
        remoteKind: "chapter",
        novelChapterId: id,
      },
      scope.novelChapterId ? "replace" : "push",
    );
  };
  // Downloaded novels open straight into the reader, like local novels do.
  const readDownloaded = async (novel: OnlineNovel) => {
    try {
      const value = await api().details(refOf(novel));
      const chapter =
        value.chapters.find((entry) => entry.id === value.lastChapterId) ||
        value.chapters.find((entry) => entry.progress) ||
        value.chapters[0];
      if (chapter) {
        go(
          {
            section: "details",
            providerId: novel.sourceId,
            remoteId: novel.novelId,
            remoteKind: "chapter",
            novelChapterId: chapter.id,
          },
          "push",
        );
        return;
      }
    } catch {
      const task = tasks.find((entry) => same(entry, novel));
      if (task) {
        go(
          {
            section: "details",
            providerId: novel.sourceId,
            remoteId: novel.novelId,
            remoteKind: "chapter",
            novelChapterId: task.chapterId,
          },
          "push",
        );
        return;
      }
    }
    open(novel);
  };
  useEffect(() => {
    // Chapter transitions arrive in bursts; collapse them into one library pass.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const unsubscribe = api().onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (live) setRevision((v) => v + 1);
      }, 250);
    });
    return () => {
      live = false;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api().sources(),
      api().downloads(),
      api().following(),
      api().downloadDirectory(),
      Promise.all(
        (
          ["shelf", "readLater", "following", "history", "downloads"] as const
        ).map(async (key) => [key, await api().library(key)] as const),
      ),
      window.media.query({ type: "novel", limit: 12, sort: "recent" }),
    ])
      .then(([s, t, f, d, l, localResult]) => {
        if (live) {
          setSources(s);
          setTasks(t);
          setFollows(f);
          setDirectory(d);
          setLists(Object.fromEntries(l));
          setLocalItems(localResult.items);
        }
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [revision, localRevision]);
  useEffect(() => {
    setKeywordValue(drafts.current.get(draftKey) ?? scope.search ?? "");
    setResultPreference(novelSingleResultPreference());
  }, [scope.novelSearchId, scope.search, scope.searchMode, sourceId]);
  const sourceIdentity = sources
    .filter((s) => s.enabled)
    .map((s) => `${s.id}:${s.apiNode}:${s.logged}`)
    .join("|");
  const searchPageKey = (id: string) =>
    JSON.stringify([
      scope.novelSearchId || "legacy",
      section,
      id,
      scope.search || "",
    ]);
  const activeSearchPage = searchPages.current.get(searchPageKey(sourceId));
  const resultLayout = resultPreference.layout;
  const resultMode = resultPreference.mode;
  const saveResultPreference = (patch: Partial<typeof resultPreference>) => {
    if (patch.mode && patch.mode !== resultMode) remember(readingResultStart());
    const value = { ...resultPreference, ...patch };
    persist("single-result", value);
    setResultPreference(value);
    const nextGroups: Record<string, NovelSearchPage> = {};
    for (const [key, current] of searchPages.current) {
      let state: SearchState = { ...current, resultLayout: value.layout };
      if (patch.mode) {
        if (state.busy && state.pageInfo) {
          requestIds.current.set(key, (requestIds.current.get(key) || 0) + 1);
          ++resultIntent.current;
          state = { ...state, busy: false, loadingOperation: undefined };
        }
        state = {
          ...state,
          ...readingResultModePatch(
            state,
            value.mode,
            state.pageInfo?.novels || [],
          ),
        };
      }
      setSearchPage(key, state);
      if (state.pageInfo) {
        try {
          const sourceKey = JSON.parse(key)[2] as string;
          nextGroups[sourceKey] = { ...state.pageInfo, novels: state.cards };
        } catch {}
      }
    }
    if (patch.mode) setBusy(false);
    if (Object.keys(nextGroups).length)
      setGroups((old) => ({ ...old, ...nextGroups }));
    setSearchStateRevision((revision) => revision + 1);
  };
  async function loadOne(
    id: NovelSourceId,
    serial: number,
    number = page,
    append = false,
    force = false,
    operation: ReadingLoadOperation = append ? "append" : "replace",
  ) {
    const key = searchPageKey(id);
    const requestKey = `${key}:${number}`;
    if (
      (operation === "append" || operation === "prepend") &&
      searchPages.current.get(key)?.busy
    )
      return;
    let state =
      searchPages.current.get(key) ||
      emptyReadingSearchPage<OnlineNovel, NovelSearchPage>({
        query: scope.search || "",
        resultLayout: resultPreference.layout,
        resultMode: resultPreference.mode,
      });
    const apply = () => {
      if (serial !== loadSerial.current) return;
      if (state.pageInfo)
        setGroups((old) => ({
          ...old,
          [id]: { ...state.pageInfo!, novels: state.cards },
        }));
      setErrors((old) => {
        const next = { ...old };
        if (state.error) next[id] = state.error;
        else delete next[id];
        return next;
      });
      setSearchStateRevision((value) => value + 1);
    };
    if (!force && state.pageInfo && state.page === number && !state.error) {
      state = { ...state, busy: false, loadingOperation: undefined };
      setSearchPage(key, state);
      apply();
      return;
    }
    const requestId = (requestIds.current.get(key) || 0) + 1;
    requestIds.current.set(key, requestId);
    resultRequests.current.set(requestKey, requestId);
    try {
      await loadReadingSearchPage<OnlineNovel, NovelSearchPage>({
        previous: state,
        number,
        append,
        operation,
        cursorBased: false,
        fetchPage: (pageNumber) =>
          section === "search"
            ? api().search(id, scope.search || "", pageNumber)
            : api().discover(
                id,
                section === "popular" ? "popular" : "latest",
                pageNumber,
              ),
        unpack: (result) => ({
          items: result.novels,
          next: result.hasMore ? String(result.page + 1) : null,
          maxPage: result.hasMore ? undefined : result.page,
        }),
        identity: (novel) => `${novel.sourceId}:${novel.novelId}`,
        current: () =>
          requestIds.current.get(key) === requestId &&
          serial === loadSerial.current,
        update: (patch) => {
          state = { ...state, ...patch };
          setSearchPage(key, state);
          apply();
        },
        formatError: errorText,
      });
    } finally {
      if (resultRequests.current.get(requestKey) === requestId)
        resultRequests.current.delete(requestKey);
    }
  }
  const refreshStamp = useRef("");
  useEffect(() => {
    const serial = ++loadSerial.current;
    setGroups({});
    setErrors({});
    if (
      !["discover", "popular", "search"].includes(section) ||
      (section === "search" && !scope.search)
    ) {
      setBusy(false);
      return;
    }
    const ids =
      section === "search" && scope.searchMode !== "single"
        ? sources
            .filter(
              (s) =>
                s.enabled &&
                s.capabilities.search &&
                (scope.novelSearchSources || aggregateIds).includes(s.id),
            )
            .map((s) => s.id)
        : [sourceId];
    if (!sources.length) {
      setBusy(false);
      return;
    }
    const stamp = `${sourceIdentity}:${refresh}`;
    const hasCachedSearchPages =
      section === "search" &&
      ids.every((id) => searchPages.current.get(searchPageKey(id))?.pageInfo);
    const force = refreshStamp.current !== stamp && !hasCachedSearchPages;
    refreshStamp.current = stamp;
    setBusy(true);
    void searchSourcePool(
      ids,
      (id) =>
        loadOne(
          id,
          serial,
          singleSearch
            ? searchPages.current.get(searchPageKey(id))?.page || page
            : page,
          false,
          force,
        ),
      () => serial === loadSerial.current,
    ).finally(() => {
      if (
        serial === loadSerial.current &&
        !ids.some((id) => searchPages.current.get(searchPageKey(id))?.busy)
      )
        setBusy(false);
    });
    return () => {
      ++loadSerial.current;
    };
  }, [
    section,
    scope.search,
    scope.searchMode,
    scope.novelSearchId,
    sourceId,
    page,
    sourceIdentity,
    JSON.stringify(scope.novelSearchSources),
    refresh,
  ]);
  const resultIntent = useRef(0);
  const loadResultPage = async (
    number: number,
    append = false,
    operation: ReadingLoadOperation = append
      ? "append"
      : singleSearch && resultMode === "waterfall"
        ? "jump"
        : "replace",
  ) => {
    if (
      (operation === "append" || operation === "prepend") &&
      searchPages.current.get(searchPageKey(sourceId))?.busy
    )
      return;
    if (operation === "replace") remember(readingResultStart());
    const intent = ++resultIntent.current,
      serial = loadSerial.current;
    setBusy(true);
    try {
      await loadOne(sourceId, serial, number, append, true, operation);
      if (
        intent === resultIntent.current &&
        serial === loadSerial.current &&
        !singleSearch
      )
        navigate({ ...scope, novelPage: number }, "replace");
    } finally {
      if (intent === resultIntent.current && serial === loadSerial.current)
        setBusy(false);
    }
  };
  const loadNextWaterfallPage = () => {
    const state = searchPages.current.get(searchPageKey(sourceId));
    if (
      !singleSearch ||
      resultMode !== "waterfall" ||
      !state ||
      state.busy ||
      state.afterPaused ||
      !state.pageInfo?.hasMore
    )
      return;
    void loadResultPage(state.endPage + 1, true);
  };
  const loadPreviousWaterfallPage = (manual = false) => {
    const state = searchPages.current.get(searchPageKey(sourceId));
    if (
      !singleSearch ||
      resultMode !== "waterfall" ||
      !state ||
      state.busy ||
      state.startPage <= 1 ||
      (!manual && state.beforePaused)
    )
      return;
    void loadResultPage(state.startPage - 1, false, "prepend");
  };
  useEffect(() => {
    const serial = ++detailSerial.current;
    setDetails(undefined);
    setSelected([]);
    setDetailError("");
    if (!ref) return;
    setBusy(true);
    void api()
      .details(ref, true)
      .then((value) => {
        if (serial === detailSerial.current) setDetails(value);
      })
      .catch((error) => {
        if (serial === detailSerial.current) setDetailError(errorText(error));
      })
      .finally(() => {
        if (serial === detailSerial.current) setBusy(false);
      });
    return () => {
      ++detailSerial.current;
    };
  }, [ref, refresh]);
  useEffect(() => {
    const serial = ++readerSerial.current;
    setReading(undefined);
    if (!ref || !scope.novelChapterId) {
      setReaderBusy(false);
      return;
    }
    if (
      preparedReader.current?.item.onlineNovelRef?.chapterId ===
        scope.novelChapterId &&
      same(preparedReader.current.details, ref)
    ) {
      setReading(preparedReader.current);
      preparedReader.current = undefined;
      setReaderBusy(false);
      setDetailError("");
      return;
    }
    setReaderBusy(true);
    setDetailError("");
    void api()
      .reader({ ...ref, chapterId: scope.novelChapterId })
      .then((value) => {
        if (serial !== readerSerial.current) return;
        if (readerOverride && readerOverride.id === scope.novelChapterId)
          value.item.progress = readerOverride.progress;
        setReading(value);
        if (value.notice) useApp.getState().notify(value.notice);
      })
      .catch((error) => {
        if (serial === readerSerial.current) setDetailError(errorText(error));
      })
      .finally(() => {
        if (serial === readerSerial.current) setReaderBusy(false);
      });
    return () => {
      ++readerSerial.current;
    };
  }, [ref, scope.novelChapterId, refresh]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (scope.novelChapterId && reading) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        !scope.novelChapterId
      ) {
        event.preventDefault();
        if (section !== "search")
          go({ section: "search", searchMode: "aggregate" });
      }
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]") &&
        !document.querySelector(".media-context-menu")
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (menuOpen) setMenuOpen(false);
        else if (sourceMenuOpen) setSourceMenuOpen(false);
        else if (singleSearch && searchPanelVisible)
          setSearchPanelVisible(false);
        else if (loginSource) {
          setLoginSource(undefined);
          setPassword("");
        } else if (scope.novelChapterId || section !== "home") back();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    scope,
    section,
    loginSource,
    reading,
    menuOpen,
    sourceMenuOpen,
    singleSearch,
    searchPanelVisible,
  ]);
  const updateHub = async (
    list: NovelHubList,
    novel: OnlineNovel,
    value: boolean,
  ) => {
    await api().hubSet(list, refOf(novel), value);
    if (details && same(details, novel))
      setDetails({
        ...details,
        favorite: list === "shelf" ? value : details.favorite,
      });
  };
  const has = (list: string, novel: OnlineNovel) =>
    Boolean(lists[list]?.some((n) => same(n, novel)));
  const [hubMenu, setHubMenu] = useState<{
    x: number;
    y: number;
    item: NovelCardItem;
  }>();
  const openHubMenu = (item: NovelCardItem, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setHubMenu({ x: event.clientX, y: event.clientY, item });
  };
  const copyTitle = async (title: string) => {
    try {
      await navigator.clipboard.writeText(title);
      useApp.getState().notify("已复制标题");
    } catch (error) {
      report(error);
    }
  };
  const isNovel = (item: NovelCardItem): item is OnlineNovel =>
    "novelId" in item;
  const novelTasks = (novel: OnlineNovel) =>
    tasks.filter((task) => same(task, novel));
  const deleteNovelDownloads = async (novel: OnlineNovel) => {
    const ids = novelTasks(novel).map((task) => task.id);
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => api().downloadAction(id, "delete")));
      // Keep shelf and follow; clear the browsing trail and read-later entry.
      await api().removeHistory(refOf(novel));
      await api().hubSet("readLater", refOf(novel), false);
      useApp.getState().notify("已删除下载");
    } catch (error) {
      report(error);
    }
  };
  const revealNovelDownloads = async (novel: OnlineNovel) => {
    const task = novelTasks(novel)[0];
    if (!task) return;
    try {
      await api().revealDownload(task.id);
    } catch (error) {
      report(error);
    }
  };
  const downloadWholeNovel = async (novel: OnlineNovel) => {
    try {
      const value = await api().details(refOf(novel));
      if (!value.chapters.length) return;
      await api().enqueue(
        refOf(novel),
        value.chapters.map((chapter) => chapter.id),
      );
      useApp.getState().notify("已加入下载队列");
    } catch (error) {
      report(error);
    }
  };
  const deleteLocalNovel = async (item: MediaItem) => {
    try {
      await window.media.trashFiles([item.id]);
      await window.media.removeRecent(item.id).catch(() => {});
      setLocalItems((items) => items.filter((entry) => entry.id !== item.id));
      useApp.getState().notify("已删除");
    } catch (error) {
      report(error);
    }
  };
  const hubMenuItems = (item: NovelCardItem): HubMenuItem[] => {
    if (!isNovel(item)) {
      return [
        {
          label: "复制标题",
          Icon: Copy,
          onSelect: () => void copyTitle(item.title),
        },
        {
          label: item.favorite ? "移出收藏" : "添加到收藏",
          Icon: Heart,
          onSelect: () =>
            void window.media
              .favorite(item.id, !item.favorite)
              .then(() => useApp.getState().notify("已更新收藏")),
        },
        {
          label: "打开文件夹",
          Icon: FolderOpen,
          onSelect: () => void window.media.reveal(item.id).catch(report),
        },
        {
          label: "删除",
          Icon: Trash2,
          danger: true,
          onSelect: () => void deleteLocalNovel(item),
        },
      ];
    }
    const downloaded = novelTasks(item).length > 0;
    return [
      { label: "详情", Icon: Info, onSelect: () => open(item) },
      {
        label: "复制标题",
        Icon: Copy,
        onSelect: () => void copyTitle(item.title),
      },
      {
        label: has("shelf", item) ? "移出书架" : "加入书架",
        Icon: Heart,
        onSelect: () =>
          void act(() => updateHub("shelf", item, !has("shelf", item))),
      },
      {
        label: has("readLater", item) ? "移出稍后阅读" : "稍后阅读",
        Icon: BookmarkPlus,
        onSelect: () =>
          void act(() => updateHub("readLater", item, !has("readLater", item))),
      },
      {
        label: has("following", item) ? "取消追更" : "追更",
        Icon: Bell,
        onSelect: () =>
          void act(() => updateHub("following", item, !has("following", item))),
      },
      ...(downloaded
        ? [
            {
              label: "打开文件夹",
              Icon: FolderOpen,
              onSelect: () => void revealNovelDownloads(item),
            },
            {
              label: "删除下载",
              Icon: Trash2,
              danger: true,
              onSelect: () => void deleteNovelDownloads(item),
            },
          ]
        : [
            {
              label: "下载",
              Icon: Download,
              onSelect: () => void downloadWholeNovel(item),
            },
          ]),
    ];
  };
  const submitSearch = (event?: FormEvent, term = keyword) => {
    event?.preventDefault();
    if (
      !term.trim() ||
      (searchSource === "all" &&
        !aggregateIds.some((id) =>
          sources.some(
            (s) => s.id === id && s.enabled && s.capabilities.search,
          ),
        ))
    )
      return;
    const history = limitReadingSearchHistory(
      [
        term.trim(),
        ...searchHistory.filter((value) => value !== term.trim()),
      ],
      pinnedSearchHistory,
      30,
    );
    remember(readingResultStart());
    setSearchHistory(history);
    persist("search-history", history);
    persist("search-sources", aggregateIds);
    const selected = sources.filter(
      (source) =>
        source.enabled &&
        source.capabilities.search &&
        aggregateIds.includes(source.id),
    );
    const directSource =
      searchSource === "all" && selected.length === 1
        ? selected[0].id
        : undefined;
    const targetSource =
      directSource || (searchSource === "all" ? undefined : searchSource);
    go({
      section: "search",
      search: term.trim(),
      novelSearchSources: targetSource ? undefined : aggregateIds,
      searchMode: targetSource ? "single" : "aggregate",
      providerId: targetSource,
      novelPage: 1,
      novelSearchId: directSource
        ? newReadingSearchId()
        : scope.novelSearchId || newReadingSearchId(),
    });
    clearSearchPanelHideTimer();
    setSearchPanelVisible(false);
    setRefresh((value) => value + 1);
  };
  const savePinnedSearchHistory = (next: string[]) => {
    setPinnedSearchHistory(next);
    persist("search-history-pinned", next);
  };
  const togglePinnedSearchHistory = (term: string) =>
    savePinnedSearchHistory(
      pinnedSearchHistory.includes(term)
        ? pinnedSearchHistory.filter((value) => value !== term)
        : [...pinnedSearchHistory, term],
    );
  const clearSearchHistory = () => {
    setSearchHistory([]);
    persist("search-history", []);
    savePinnedSearchHistory([]);
  };
  const removeSearchHistoryItem = (term: string) => {
    const next = searchHistory.filter((value) => value !== term);
    setSearchHistory(next);
    persist("search-history", next);
    savePinnedSearchHistory(
      pinnedSearchHistory.filter((value) => value !== term),
    );
  };
  const result =
    ["discover", "popular"].includes(section) || singleSearch
      ? groups[sourceId]
      : undefined;
  const librarySection = [
    "shelf",
    "history",
    "readLater",
    "following",
    "downloads",
  ].includes(section);
  const favorites = (novel: OnlineNovel) =>
    void act(() => updateHub("shelf", novel, !has("shelf", novel)));
  async function exportEpub() {
    if (!ref) return;
    const quote = await api().exportQuote(ref);
    if (
      !window.confirm(
        `${quote.title}\n源站原生 EPUB 下载${quote.cost ? `将消耗 ${quote.cost} 金币` : "免费"}。\n确认后将选择保存位置。是否继续？`,
      )
    )
      return;
    const file = await api().exportEpub(quote.id);
    if (file) useApp.getState().notify("原生 EPUB 已保存");
  }
  const sourceName = sources.find((s) => s.id === sourceId)?.name || "小说源";
  const updateSources = async (ids: NovelSourceId[], enabled: boolean) => {
    setSourceBusy(true);
    try {
      for (const id of ids) await api().settings(id, { enabled });
    } finally {
      setSourceBusy(false);
    }
  };
  const readNovelSourceAddress = async () => {
    if (!sourceAddress.trim()) return;
    setSourceBusy(true);
    try {
      const result = await api().openAddress(sourceAddress.trim());
      if (result.kind === "repository") {
        setSourceEntries(result.entries);
        setSourceRepositories(await api().repositories());
        setSourceEntrySelection(
          new Set(
            result.entries
              .filter((entry) => !entry.installedId)
              .map((entry) => entry.url),
          ),
        );
      } else {
        setSourceEntries([]);
        setSourceAddress("");
        setRefresh((value) => value + 1);
        useApp.getState().notify(`已导入小说源：${result.source.name}`);
      }
    } catch (error) {
      report(error);
    } finally {
      setSourceBusy(false);
    }
  };
  const installSelectedNovelSources = async () => {
    const selectedEntries = sourceEntries.filter((entry) =>
      sourceEntrySelection.has(entry.url),
    );
    if (!selectedEntries.length) return;
    setSourceBusy(true);
    try {
      const results = await Promise.allSettled(
        selectedEntries.map((entry) => api().install(entry.url)),
      );
      const installed = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      const failed = results.length - installed;
      setSourceEntries([]);
      setSourceEntrySelection(new Set());
      setRefresh((value) => value + 1);
      useApp
        .getState()
        .notify(
          `已导入 ${installed} 个小说源${failed ? `，${failed} 个失败` : ""}`,
        );
      for (const result of results)
        if (result.status === "rejected") report(result.reason);
    } finally {
      setSourceBusy(false);
    }
  };
  const rememberScroll = (node: HTMLElement) => {
    if (
      ["home", "sources", "details", "search"].includes(section) &&
      !(section === "search" && singleSearch)
    )
      rememberHub({ scrollTop: node.scrollTop });
  };
  const cards = (key: string, items = lists[key] || []) => (
    <ReadingHubCards
      items={items.slice(0, 10)}
      identity={(n) => `${n.sourceId}:${n.novelId}`}
      title={(n) => n.title}
      cover={(n) => <Cover item={cardItem(n)} />}
      open={key === "downloads" ? (n) => void readDownloaded(n) : open}
      contextMenu={(n, event) => openHubMenu(n, event)}
      empty="暂无小说"
      toggleLater={(n, value) =>
        void act(() => updateHub("readLater", n, value))
      }
      isLater={(n) => has("readLater", n)}
    />
  );
  const homeRow = (key: string, title: string) => (
    <section
      key={key}
      className={`comic-home-row ${lists[key]?.length || (key === "local" && localItems.length) ? "" : "is-empty"} ${collapsedHome[key] ? "is-collapsed" : ""}`}
    >
      <div className="comic-home-heading">
        <HomeSectionToggle
          title={title}
          count={key === "local" ? localItems.length : lists[key]?.length || 0}
          collapsed={!!collapsedHome[key]}
          onClick={() => toggleHome(key)}
        />
        <button
          className="text-button"
          onClick={() => (key === "local" ? local() : go({ section: key }))}
        >
          {key === "local"
            ? "浏览本地小说"
            : key === "downloads"
              ? "管理下载"
              : "查看全部"}
          <ArrowRight size={14} />
        </button>
        {key === "downloads" && (
          <button
            className="text-button download-queue-trigger"
            onClick={() => setDownloadQueueOpen(true)}
          >
            下载中{" "}
            <span>
              {downloadQueueGroups.reduce(
                (count, group) => count + group.taskIds.length,
                0,
              )}
            </span>
          </button>
        )}
        {key === "following" && (
          <button
            className="text-button"
            disabled={busy || !follows.length}
            onClick={() =>
              void act(async () => {
                setBusy(true);
                try {
                  setFollows(await api().checkFollowing());
                } finally {
                  setBusy(false);
                }
              })
            }
          >
            <RefreshCw size={14} />
            检查更新
          </button>
        )}
      </div>
      {!collapsedHome[key] &&
        (key === "local" ? (
          <ReadingHubCards
            items={localItems.slice(0, 10)}
            identity={(n) => n.id}
            title={(n) => n.title}
            cover={(n) => <Cover item={n} />}
            open={openLocal}
            contextMenu={(item, event) => openHubMenu(item, event)}
            empty="暂无本地小说，进入本地库添加 TXT 或 EPUB"
          />
        ) : (
          cards(key)
        ))}
      {key === "following" &&
        !collapsedHome[key] &&
        follows.some((f) => f.error) && (
          <p className="muted">部分小说源暂时无法检查；上次检查结果仍保留。</p>
        )}
    </section>
  );
  return (
    <ReadingPageShell
      ref={root}
      aria-label="在线小说"
      className={`online-novels${ref ? " is-detail-page" : ""}${scope.novelChapterId ? " has-novel-reader" : ""}`}
      onMouseMove={(event) => {
        if (
          (event.target as Element).closest(
            ".comic-single-search-back, .comic-main-menu-layer",
          )
        )
          return;
        if (
          event.clientX <= 44 &&
          !(event.target as Element).closest(
            "button, input, select, a, label",
          ) &&
          !scope.novelChapterId &&
          section !== "sources"
        )
          setMenuOpen(true);
        onSearchPointerMove(event);
      }}
      onPointerDownCapture={onSearchPointerDown}
      onScroll={(event) => {
        if (event.target === event.currentTarget)
          rememberScroll(event.currentTarget);
      }}
      onClickCapture={(event) => {
        const button = (event.target as Element).closest(
          ".comic-hub-cover, .novel-volume .online-chapters button:not(.icon-button)",
        );
        if (button) {
          const row = button.closest<HTMLElement>("[data-hub-id]");
          if (row) rememberHub({ focusId: `hub:${row.dataset.hubId}` });
        }
      }}
    >
      {section !== "sources" && (
        <>
          <button
            className="reading-menu-trigger icon-button"
            aria-label="打开小说菜单"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={18} />
          </button>
          <ReadingHubMenu
            title="小说"
            open={menuOpen}
            close={() => setMenuOpen(false)}
            section={section}
            items={NOVEL_MENU_ITEMS}
            navigate={(key) =>
              key === "search" && resumeSearch()
                ? undefined
                : key === "local"
                  ? local()
                  : go(
                      {
                        section: key,
                        providerId: sourceId,
                        searchMode: "aggregate",
                      },
                      "root",
                    )
            }
          />
        </>
      )}
      {section !== "home" && section !== "sources" && !scope.novelChapterId && (
        <header className="comic-detail-toolbar">
          <button
            className={`text-button comic-detail-back${singleSearch ? " comic-single-search-back" : ""}`}
            aria-label={`返回${ref ? "小说详情" : "小说首页"}`}
            title={`返回${ref ? "小说详情" : "小说首页"}`}
            onClick={back}
          >
            <ArrowLeft size={16} />
          </button>
          <strong>
            {ref
              ? sourceName
              : NOVEL_MENU_ITEMS.find((item) => item.section === section)
                  ?.label || "发现"}
          </strong>
          <span className="spacer" />
          {section === "downloads" && !ref && (
            <button
              className="text-button download-queue-trigger"
              aria-haspopup="dialog"
              onClick={() => setDownloadQueueOpen(true)}
            >
              下载中{" "}
              <span>
                {downloadQueueGroups.reduce(
                  (count, group) => count + group.taskIds.length,
                  0,
                )}
              </span>
            </button>
          )}
          {!ref && section !== "search" && (
            <IconButton label="小说显示方式" onClick={openLayout}>
              <Grid2X2 size={17} />
            </IconButton>
          )}
          <IconButton
            label="刷新小说页面"
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw size={17} />
          </IconButton>
          {section === "history" && !!lists.history?.length && (
            <button
              className="text-button"
              onClick={() => void act(() => api().removeHistory())}
            >
              清空历史
            </button>
          )}
        </header>
      )}
      {section === "home" && (
        <div
          ref={home}
          className="comic-home"
          onScroll={(event) => rememberScroll(event.currentTarget)}
        >
          <ReadingHomeSearch
            kind="小说"
            open={() =>
              resumeSearch() ||
              go(
                {
                  section: "search",
                  providerId: sourceId,
                  searchMode: "aggregate",
                },
                "root",
              )
            }
          />
          <section className="comic-home-row comic-home-sources">
            <div className="comic-home-heading">
              <button
                className="text-button comic-source-management-entry"
                onClick={() => go({ section: "sources" })}
              >
                小说源<span>{sources.filter((s) => s.enabled).length}</span>
                <ArrowRight size={14} />
              </button>
              <span className="spacer" />
              <div className="comic-source-tools" ref={quickMenu}>
                <button
                  className="icon-button comic-source-tools-trigger"
                  aria-label="小说源排序与激活"
                  aria-haspopup="dialog"
                  aria-expanded={sourceMenuOpen}
                  onClick={() => setSourceMenuOpen((v) => !v)}
                >
                  <ArrowDownUp size={16} />
                </button>
                {sourceMenuOpen && (
                  <div
                    className="comic-source-tools-menu"
                    role="dialog"
                    aria-label="小说源排序与激活"
                  >
                    <label className="comic-source-sort-control">
                      <span>排序方式</span>
                      <select
                        value={sourceSort}
                        onChange={(event) => {
                          setSourceSort(event.target.value);
                          persist("home-source-sort", event.target.value);
                        }}
                      >
                        <option value="default">默认顺序</option>
                        <option value="name-asc">名称升序</option>
                        <option value="name-desc">名称降序</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                    <div className="comic-source-bulk-actions">
                      <button
                        disabled={sourceBusy || sources.every((s) => s.enabled)}
                        onClick={() =>
                          void act(() =>
                            updateSources(
                              sources.map((s) => s.id),
                              true,
                            ),
                          )
                        }
                      >
                        全部激活
                      </button>
                      <button
                        disabled={
                          sourceBusy || sources.every((s) => !s.enabled)
                        }
                        onClick={() =>
                          void act(() =>
                            updateSources(
                              sources.map((s) => s.id),
                              false,
                            ),
                          )
                        }
                      >
                        全部停用
                      </button>
                    </div>
                    <SourceOrderList
                      items={homeSources}
                      idPrefix="novel"
                      disabled={sourceBusy}
                      emptyText="还没有安装小说源。"
                      onToggle={(source, enabled) => {
                        void act(() => updateSources([source.id], enabled));
                      }}
                      onReorder={reorderHomeSources}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="comic-source-pills novel-source-pills">
              {homeSources
                .filter((s) => s.enabled)
                .map((source) => (
                  <button
                    key={source.id}
                    onClick={() =>
                      go({ section: "discover", providerId: source.id })
                    }
                  >
                    {source.name}
                  </button>
                ))}
              {!sources.some((s) => s.enabled) && (
                <span className="muted">
                  还没有启用的源，请进入管理页启用。
                </span>
              )}
            </div>
          </section>
          {homeRow("history", "最近阅读")}
          {homeRow("shelf", "书架")}
          {homeRow("readLater", "稍后阅读")}
          {homeRow("local", "本地小说")}
          {homeRow("following", "追更")}
          {homeRow("downloads", "已下载")}
        </div>
      )}
      {section === "sources" && (
        <div
          className="online-source-manager-page"
          ref={manager}
          onScroll={(event) => rememberScroll(event.currentTarget)}
        >
          <header className="online-source-manager-heading">
            <button
              className="text-button comic-detail-back"
              aria-label="返回小说"
              title="返回小说"
              onClick={back}
            >
              <ArrowLeft size={17} />
            </button>
            <div>
              <h1>小说源</h1>
            </div>
          </header>
          <div className="online-row">
            <button
              className="button primary"
              disabled={sourceBusy}
              onClick={() => {
                setSourceImportOpen(true);
                void api()
                  .repositories()
                  .then(setSourceRepositories)
                  .catch(report);
              }}
            >
              <Plus size={16} /> 添加小说源
            </button>
            <h3>已导入 · {sources.length}</h3>
            <span className="spacer" />
            <button
              className="text-button"
              disabled={sourceBusy}
              onClick={() =>
                void act(async () => {
                  await api().checkUpdates();
                  setRefresh((value) => value + 1);
                })
              }
            >
              <RefreshCw size={14} /> 检查更新
            </button>
          </div>
          <div className="online-source-list">
            {homeSources.map((source) => (
              <div className="online-source-row" key={source.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={source.enabled}
                    disabled={sourceBusy}
                    onChange={(event) =>
                      void act(() =>
                        updateSources([source.id], event.target.checked),
                      )
                    }
                  />
                  <span>
                    {source.name}
                    <small>
                      {source.error ||
                        `${source.version || ""}${source.version ? " · " : ""}${source.url}`}
                    </small>
                  </span>
                </label>
                <button
                  className="text-button"
                  onClick={() => {
                    setEditingSource(source.id);
                    setSourceSettingsValues({ ...source.settingValues });
                  }}
                >
                  源设置
                </button>
                {source.capabilities.login.includes("password") && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setLoginSource(source.id);
                      setPassword("");
                    }}
                  >
                    {source.logged ? "账号 · 已登录" : "邮箱密码登录"}
                  </button>
                )}
                {source.capabilities.login.includes("webview") && (
                  <button
                    className="text-button"
                    onClick={() => void act(() => api().webLogin(source.id))}
                  >
                    网页登录与验证
                  </button>
                )}
                {source.logged && (
                  <button
                    className="text-button"
                    onClick={() => void act(() => api().logout(source.id))}
                  >
                    退出账号
                  </button>
                )}
                {source.update && (
                  <button
                    className="button"
                    disabled={sourceBusy}
                    onClick={() =>
                      void act(async () => {
                        await api().update(source.id);
                        setRefresh((value) => value + 1);
                      })
                    }
                  >
                    更新
                  </button>
                )}
                <button
                  className="text-button danger"
                  disabled={sourceBusy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `移除“${source.name}”？书架、阅读进度和已下载章节会保留。`,
                      )
                    )
                      return;
                    void act(async () => {
                      await api().uninstall(source.id);
                      setRefresh((value) => value + 1);
                    });
                  }}
                >
                  移除
                </button>
              </div>
            ))}
            {!sources.length && (
              <p className="muted">
                还没有导入来源；选择一个小说源 JS
                文件，或读取源仓库索引后勾选导入。
              </p>
            )}
          </div>
          <section className="online-download-directory">
            <div>
              <strong>离线下载位置</strong>
              <p className="muted">{directory}</p>
            </div>
            <div className="online-row">
              <button
                className="text-button"
                onClick={() =>
                  void act(async () =>
                    setDirectory(await api().downloadDirectory(true)),
                  )
                }
              >
                更改新任务的下载位置
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void act(async () => {
                    await api().clearCache();
                    useApp
                      .getState()
                      .notify("已清理小说临时缓存，离线下载保留");
                  })
                }
              >
                清理小说临时缓存
              </button>
            </div>
          </section>
        </div>
      )}
      {editingSource && (
        <Modal
          title={`${sources.find((s) => s.id === editingSource)?.name} · 设置`}
          close={() => setEditingSource(undefined)}
        >
          {Object.entries(
            sources.find((source) => source.id === editingSource)?.settings ||
              {},
          ).map(([key, schema]) => (
            <label className="novel-field" key={key}>
              {schema.title || key}
              {schema.type === "select" ? (
                <select
                  value={String(
                    sourceSettingsValues[key] ?? schema.default ?? "",
                  )}
                  onChange={(event) =>
                    setSourceSettingsValues((values) => ({
                      ...values,
                      [key]: event.target.value,
                    }))
                  }
                >
                  {(schema.options || []).map((option: any, index) => (
                    <option
                      key={index}
                      value={typeof option === "string" ? option : option.value}
                    >
                      {typeof option === "string"
                        ? option
                        : option.label || option.value}
                    </option>
                  ))}
                </select>
              ) : schema.type === "switch" ? (
                <input
                  type="checkbox"
                  checked={Boolean(sourceSettingsValues[key] ?? schema.default)}
                  onChange={(event) =>
                    setSourceSettingsValues((values) => ({
                      ...values,
                      [key]: event.target.checked,
                    }))
                  }
                />
              ) : (
                <input
                  value={String(
                    sourceSettingsValues[key] ?? schema.default ?? "",
                  )}
                  onChange={(event) =>
                    setSourceSettingsValues((values) => ({
                      ...values,
                      [key]: event.target.value,
                    }))
                  }
                />
              )}
            </label>
          ))}
          {sources
            .find((source) => source.id === editingSource)
            ?.capabilities.login.includes("webview") && (
            <button
              className="button secondary"
              onClick={() => void act(() => api().webLogin(editingSource))}
            >
              网页登录与验证
            </button>
          )}
          <button
            className="button primary"
            disabled={sourceBusy}
            onClick={() =>
              void act(async () => {
                await api().settings(editingSource, sourceSettingsValues);
                setEditingSource(undefined);
                setRefresh((value) => value + 1);
              })
            }
          >
            保存源设置
          </button>
        </Modal>
      )}
      {sourceImportOpen && (
        <Modal
          title="添加小说源"
          close={() => {
            setSourceImportOpen(false);
            setSourceEntries([]);
          }}
        >
          <p className="muted">
            可导入单个小说源 JS，或选择本地集合 JSON 并读取其中引用的同目录
            JS；网络仓库 JSON 可预览后勾选安装。
          </p>
          <form
            className="novel-source-url-form"
            onSubmit={(event) => {
              event.preventDefault();
              void readNovelSourceAddress();
            }}
          >
            <label htmlFor="novel-source-address">
              小说源 JS 或仓库索引网址
            </label>
            <div className="online-row">
              <input
                id="novel-source-address"
                type="url"
                placeholder="https://example.com/novel-sources.json"
                value={sourceAddress}
                onChange={(event) => setSourceAddress(event.target.value)}
              />
              <button
                className="button primary"
                type="submit"
                disabled={sourceBusy || !sourceAddress.trim()}
              >
                读取／导入
              </button>
            </div>
          </form>
          {!!sourceRepositories.length && (
            <div className="online-row novel-source-repositories">
              <span className="muted">最近仓库</span>
              {sourceRepositories.map((url) => (
                <button
                  key={url}
                  className="text-button"
                  type="button"
                  onClick={() => setSourceAddress(url)}
                >
                  {new URL(url).host}
                </button>
              ))}
            </div>
          )}
          <div className="online-row">
            <button
              className="button secondary"
              disabled={sourceBusy}
              onClick={() =>
                void act(async () => {
                  const result = await api().importFile();
                  if (result) {
                    if (result.sources.length) setRefresh((value) => value + 1);
                    const failed = result.errors.length;
                    const summary =
                      result.sources.length === 1 && !failed
                        ? `已导入小说源：${result.sources[0].name}`
                        : `本地导入完成：成功 ${result.sources.length} 个${failed ? `，失败 ${failed} 个` : ""}`;
                    useApp.getState().notify(summary);
                    if (failed) report(result.errors.join("\n"));
                  }
                })
              }
            >
              <Plus size={16} /> 选择本地 JSON／JS
            </button>
          </div>
          {!!sourceEntries.length && (
            <section className="online-source-list">
              <div className="online-row">
                <strong>仓库来源 · {sourceEntries.length}</strong>
                <button
                  className="text-button"
                  onClick={() =>
                    setSourceEntrySelection(
                      new Set(
                        sourceEntries
                          .filter((entry) => !entry.installedId)
                          .map((entry) => entry.url),
                      ),
                    )
                  }
                >
                  全选未安装
                </button>
              </div>
              {sourceEntries.map((entry) => (
                <label className="online-source-row" key={entry.url}>
                  <input
                    type="checkbox"
                    disabled={!!entry.installedId || sourceBusy}
                    checked={sourceEntrySelection.has(entry.url)}
                    onChange={(event) =>
                      setSourceEntrySelection((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(entry.url);
                        else next.delete(entry.url);
                        return next;
                      })
                    }
                  />
                  <span>
                    {entry.name}
                    <small>
                      {entry.description || entry.version || entry.url}
                    </small>
                  </span>
                  {entry.installedId && <small>已安装</small>}
                </label>
              ))}
              <button
                className="button primary"
                disabled={sourceBusy || !sourceEntrySelection.size}
                onClick={() => void installSelectedNovelSources()}
              >
                {sourceBusy
                  ? "正在导入…"
                  : `导入所选 · ${sourceEntrySelection.size}`}
              </button>
            </section>
          )}
        </Modal>
      )}
      {loginSource && (
        <Modal
          title="登录轻书架"
          close={() => {
            setPassword("");
            setLoginSource(undefined);
          }}
        >
          <form
            className="novel-login"
            onSubmit={(e) => {
              e.preventDefault();
              setLoginBusy(true);
              void api()
                .login(loginSource, email, password)
                .then(() => {
                  setPassword("");
                  setLoginSource(undefined);
                  setRefresh((v) => v + 1);
                })
                .catch(report)
                .finally(() => setLoginBusy(false));
            }}
          >
            <label className="novel-field">
              邮箱
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="novel-field">
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button className="button primary" disabled={loginBusy}>
              {loginBusy ? "正在登录…" : "登录"}
            </button>
          </form>
        </Modal>
      )}
      {["discover", "popular"].includes(section) && (
        <header className="online-toolbar">
          <div className="comic-source-pills online-source-selector">
            {homeSources
              .filter((s) => s.enabled)
              .map((source) => (
                <button
                  key={source.id}
                  className={sourceId === source.id ? "active" : ""}
                  onClick={() => go({ section, providerId: source.id })}
                >
                  {source.name}
                </button>
              ))}
            <span className="spacer" />
            <button
              className="text-button"
              onClick={() =>
                go({
                  section: "search",
                  providerId: sourceId,
                  searchMode: "single",
                })
              }
            >
              <Search size={16} />
              搜索当前源
            </button>
          </div>
          <nav
            className="online-tabs comic-discovery-tabs"
            aria-label="小说发现"
          >
            <button
              className={section === "discover" ? "active" : ""}
              onClick={() => go({ section: "discover", providerId: sourceId })}
            >
              最近更新
            </button>
            <button
              className={section === "popular" ? "active" : ""}
              onClick={() => go({ section: "popular", providerId: sourceId })}
            >
              热门作品
            </button>
          </nav>
        </header>
      )}
      {section === "search" && (
        <ReadingSearchPanel
          kind="小说"
          mode={scope.searchMode === "single" ? "single" : "aggregate"}
          sourceName={sourceName}
          query={keyword}
          change={setKeyword}
          submit={() => submitSearch()}
          clear={() =>
            go({
              section: "search",
              providerId: sourceId,
              searchMode: scope.searchMode,
              novelSearchId: scope.novelSearchId,
            })
          }
          hasQuery={!!scope.search}
          canSearch={
            !!keyword.trim() &&
            (scope.searchMode === "single" ||
              aggregateIds.some((id) =>
                sources.some(
                  (s) => s.id === id && s.enabled && s.capabilities.search,
                ),
              ))
          }
          visible={searchPanelVisible}
          inputRef={searchInput}
          panelRef={searchPanel}
          sources={homeSources.filter(
            (source) => source.enabled && source.capabilities.search,
          )}
          selected={aggregateIds}
          select={selectAggregateSources}
          extra={
            <div className="comic-search-extra-controls">
              {singleSearch && (
                <ReadingResultControls
                  layout={resultLayout}
                  mode={resultMode}
                  changeLayout={(layout) => saveResultPreference({ layout })}
                  changeMode={(mode) => saveResultPreference({ mode })}
                />
              )}
            </div>
          }
        >
          {!scope.search && (
            <ReadingSearchHistory
              terms={searchHistory}
              pinned={pinnedSearchHistory}
              collapsed={searchHistoryCollapsed}
              toggle={() => {
                setSearchHistoryCollapsed((v) => !v);
                persist("search-history-collapsed", !searchHistoryCollapsed);
              }}
              togglePin={togglePinnedSearchHistory}
              clear={clearSearchHistory}
              remove={removeSearchHistoryItem}
              submit={(term) => submitSearch(undefined, term)}
            />
          )}
        </ReadingSearchPanel>
      )}
      {singleSearch && (
        <div className="online-row comic-single-result-heading">
          <strong>{scope.search}</strong>
          <span className="muted">{sourceName}</span>
          <span className="spacer" />
          <button
            className="text-button"
            onClick={() => {
              setSearchPanelVisible(true);
              searchInput.current?.focus();
            }}
          >
            <Search size={16} />
            修改搜索
          </button>
        </div>
      )}
      {busy && !emptySearch && !scope.novelChapterId && !ref && (
        <div className="online-loading" role="status">
          <LoaderCircle className="spin" size={20} />
          正在加载…
        </div>
      )}
      {ref && !scope.novelChapterId && !details && !detailError && (
        <ReadingDetailSkeleton kind="小说" sourceName={sourceName} />
      )}
      {Object.entries(errors)
        .filter(
          ([id]) =>
            !emptySearch &&
            !(
              singleSearch &&
              resultMode === "waterfall" &&
              id === sourceId &&
              result?.novels.length
            ),
        )
        .map(([id, error]) => (
          <div className="novel-error" role="alert" key={id}>
            <strong>{sources.find((s) => s.id === id)?.name}</strong>
            <p>{error}</p>
            <button
              onClick={() =>
                void loadOne(
                  id as NovelSourceId,
                  loadSerial.current,
                  page,
                  false,
                  true,
                )
              }
            >
              重试此源
            </button>
            {/verification|auth-required|permission/.test(error) && (
              <button
                onClick={() =>
                  void act(() => api().webLogin(id as NovelSourceId))
                }
              >
                打开源站登录与验证
              </button>
            )}
          </div>
        ))}
      {section === "search" &&
        scope.search &&
        scope.searchMode !== "single" && (
          <div className="comic-aggregate-results novel-aggregate">
            {homeSources
              .filter((source) => groups[source.id]?.novels.length)
              .map((source) => [source.id, groups[source.id]] as const)
              .map(([id, g]) => (
                <section className="comic-aggregate-group" key={id}>
                  <div className="comic-aggregate-heading">
                    <button
                      className="comic-aggregate-source-link"
                      onClick={() =>
                        go({
                          section: "search",
                          search: scope.search,
                          searchMode: "single",
                          providerId: id,
                        })
                      }
                    >
                      <strong>{sources.find((s) => s.id === id)?.name}</strong>
                      <span>{g.novels.length} 条预览</span>
                      <ArrowRight size={15} />
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        go({
                          section: "search",
                          search: scope.search,
                          searchMode: "single",
                          providerId: id,
                        })
                      }
                    >
                      查看此源全部结果
                    </button>
                  </div>
                  <NovelCards novels={g.novels.slice(0, 8)} open={open} />
                </section>
              ))}
            {!busy &&
              scope.search &&
              !Object.values(groups).some((g) => g.novels.length) && (
                <p className="novel-muted">
                  {Object.keys(errors).length ===
                  sources.filter((s) => s.enabled).length
                    ? "所有源搜索失败，请检查上方错误后重试"
                    : "未找到小说"}
                </p>
              )}
          </div>
        )}
      {(["discover", "popular"].includes(section) ||
        (section === "search" && scope.searchMode === "single")) &&
        result && (
          <>
            {singleSearch && resultMode === "waterfall" && activeSearchPage && (
              <ReadingWaterfallStart
                state={activeSearchPage}
                load={() => loadPreviousWaterfallPage(true)}
              />
            )}
            <Results
              key={`${scope.novelSearchId || ""}:${sourceId}:${section}:${resultMode === "waterfall" ? "waterfall" : result.page}:${scope.search || ""}`}
              novels={result.novels}
              memory={
                singleSearch ? { ...memory, layout: resultLayout } : memory
              }
              remember={remember}
              open={open}
              contextMenu={openHubMenu}
              favorite={favorites}
              onReachEnd={loadNextWaterfallPage}
              onReachStart={
                activeSearchPage && activeSearchPage.startPage > 1
                  ? () => loadPreviousWaterfallPage()
                  : undefined
              }
              change={activeSearchPage?.change}
              onViewportAnchorChange={(item) => {
                const state = searchPages.current.get(searchPageKey(sourceId));
                const novel = item.remoteData?.novel as OnlineNovel | undefined;
                const page =
                  novel &&
                  state?.itemPages[`${novel.sourceId}:${novel.novelId}`];
                if (state && page) state.visiblePage = page;
              }}
            />
            {!result.novels.length && <p className="novel-muted">未找到小说</p>}
            {(!singleSearch || resultMode === "pagination") && (
              <ReadingPagination
                page={result.page}
                maxPage={activeSearchPage?.maxPage}
                busy={busy}
                hasMore={result.hasMore}
                jump={activeSearchPage?.jumpPage || String(result.page)}
                changeJump={
                  singleSearch
                    ? (value) => {
                        const state = searchPages.current.get(
                          searchPageKey(sourceId),
                        );
                        if (state) {
                          state.jumpPage = value;
                          setSearchStateRevision((v) => v + 1);
                        }
                      }
                    : undefined
                }
                go={(number) => void loadResultPage(number)}
              />
            )}
            {singleSearch && resultMode === "waterfall" && activeSearchPage && (
              <ReadingWaterfallControls
                state={activeSearchPage}
                hasMore={result.hasMore}
                changeJump={(value) => {
                  activeSearchPage.jumpPage = value;
                  setSearchStateRevision((v) => v + 1);
                }}
                go={(number) => void loadResultPage(number)}
                load={() =>
                  void loadResultPage(activeSearchPage.endPage + 1, true)
                }
              />
            )}
          </>
        )}
      {librarySection && (
        <>
          {section === "following" && (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setBusy(true);
                    try {
                      setFollows(await api().checkFollowing());
                    } finally {
                      setBusy(false);
                    }
                  })
                }
              >
                检查更新
              </button>
              {follows
                .filter((f) => f.error || f.newChapterIds.length)
                .map((f) => (
                  <p
                    className={f.error ? "novel-error" : "novel-muted"}
                    key={`${f.sourceId}:${f.novelId}`}
                  >
                    {lists.following?.find((n) => same(n, f))?.title ||
                      f.novelId}
                    ：{f.error || `${f.newChapterIds.length} 个新章节`}
                  </p>
                ))}
            </>
          )}
          {!!lists[section]?.length ? (
            <Results
              key={section}
              novels={lists[section]}
              memory={memory}
              remember={remember}
              open={
                section === "downloads" ? (n) => void readDownloaded(n) : open
              }
              contextMenu={openHubMenu}
              favorite={favorites}
              removeHistory={
                section === "history"
                  ? (novel) => void act(() => api().removeHistory(refOf(novel)))
                  : undefined
              }
            />
          ) : (
            <p className="novel-muted">此栏目暂无小说</p>
          )}
        </>
      )}
      {detailError && (
        <div className="online-detail-error novel-error" role="alert">
          <h2>暂时无法加载小说详情</h2>
          <p>{detailError}</p>
          <button onClick={() => setRefresh((v) => v + 1)}>重新加载</button>
          <button onClick={() => void act(() => api().webLogin(sourceId))}>
            打开源站登录与验证
          </button>
        </div>
      )}
      {details && !scope.novelChapterId && (
        <article className="online-detail comic-detail-loaded novel-detail">
          <ReadingDetailHero
            source={sourceName}
            title={details.title}
            cover={details.cover}
            subtitle={details.author}
            metadata={
              details.updatedAt && (
                <p className="comic-detail-updated">
                  更新于 {details.updatedAt}
                </p>
              )
            }
            actions={
              <>
                <button
                  className="button primary"
                  disabled={!details.chapters.length}
                  onClick={() =>
                    read(details.lastChapterId || details.chapters[0].id)
                  }
                >
                  {details.lastChapterId ? "继续阅读" : "开始阅读"}
                </button>
                {(
                  [
                    ["shelf", "书架"],
                    ["readLater", "稍后阅读"],
                    ["following", "追更"],
                  ] as const
                ).map(([key, title]) => (
                  <button
                    key={key}
                    className="button secondary"
                    aria-pressed={has(key, details)}
                    onClick={() =>
                      void act(() =>
                        updateHub(key, details, !has(key, details)),
                      )
                    }
                  >
                    {has(key, details) ? `移出${title}` : `加入${title}`}
                  </button>
                ))}
                {details.canExport && (
                  <button
                    className="button secondary"
                    onClick={() => void act(exportEpub)}
                  >
                    源站原生 EPUB
                    {details.exportCost ? ` · ${details.exportCost} 金币` : ""}
                  </button>
                )}
              </>
            }
          />
          {details.description?.trim() && (
            <section className="comic-detail-section">
              <h2>简介</h2>
              <p className="online-description">{details.description}</p>
            </section>
          )}
          {details.refreshError && (
            <p className="novel-error" role="alert">
              当前显示已保存目录：{details.refreshError}
            </p>
          )}
          <section className="comic-detail-section comic-detail-chapter-section">
            <div className="comic-detail-section-heading">
              <h2>目录 · {details.chapters.length} 章</h2>
              <div className="comic-detail-chapter-tools">
                <button
                  className="text-button"
                  onClick={() => setSelected(details.chapters.map((c) => c.id))}
                >
                  全选
                </button>
                <button className="text-button" onClick={() => setSelected([])}>
                  取消选择
                </button>
              </div>
            </div>
            <div className="online-row online-download-actions">
              <button
                className="button secondary"
                disabled={!selected.length}
                onClick={() => void act(() => api().enqueue(details, selected))}
              >
                <Download size={15} />
                下载所选 {selected.length || ""}
              </button>
              <button
                className="button secondary"
                disabled={
                  !details.chapters.length ||
                  details.chapters.every((c) => taskOf(details, c.id))
                }
                onClick={() =>
                  void act(() =>
                    api().enqueue(
                      details,
                      details.chapters.map((c) => c.id),
                    ),
                  )
                }
              >
                {details.chapters.length &&
                details.chapters.every((c) => taskOf(details, c.id)) ? (
                  <Check size={15} />
                ) : (
                  <Download size={15} />
                )}
                {details.chapters.length &&
                details.chapters.every((c) => taskOf(details, c.id))
                  ? "已下载"
                  : "下载全书"}
              </button>
              <button
                className="button secondary"
                disabled={
                  !details.chapters.some(
                    (c) => !c.progress?.completed && !taskOf(details, c.id),
                  )
                }
                onClick={() =>
                  void act(() =>
                    api().enqueue(
                      details,
                      details.chapters
                        .filter(
                          (c) =>
                            !c.progress?.completed && !taskOf(details, c.id),
                        )
                        .map((c) => c.id),
                    ),
                  )
                }
              >
                下载未读
              </button>
            </div>
            <div className="novel-volumes">
              {details.chapters
                .reduce<{ title: string; chapters: typeof details.chapters }[]>(
                  (volumes, chapter) => {
                    if (
                      !volumes.length ||
                      volumes.at(-1)!.title !== chapter.volume
                    )
                      volumes.push({ title: chapter.volume, chapters: [] });
                    volumes.at(-1)!.chapters.push(chapter);
                    return volumes;
                  },
                  [],
                )
                .map((volume, index) => (
                  <section
                    className="novel-volume"
                    key={`${index}:${volume.title}`}
                  >
                    <div className="comic-detail-section-heading">
                      <h3>{volume.title || "正文"}</h3>
                      <button
                        className="text-button"
                        disabled={volume.chapters.every((chapter) =>
                          taskOf(details, chapter.id),
                        )}
                        onClick={() =>
                          void act(() =>
                            api().enqueue(
                              details,
                              volume.chapters.map((chapter) => chapter.id),
                            ),
                          )
                        }
                      >
                        {volume.chapters.every((chapter) =>
                          taskOf(details, chapter.id),
                        ) ? (
                          <Check size={14} />
                        ) : (
                          <Download size={14} />
                        )}
                        {volume.chapters.every((chapter) =>
                          taskOf(details, chapter.id),
                        )
                          ? "已下载"
                          : "下载整卷"}
                      </button>
                    </div>
                    <div className="online-chapters">
                      {volume.chapters.map((chapter) => (
                        <div
                          key={chapter.id}
                          data-hub-id={`chapter:${chapter.id}`}
                        >
                          <input
                            type="checkbox"
                            aria-label={`选择章节 ${chapter.title}`}
                            checked={selected.includes(chapter.id)}
                            onChange={(event) =>
                              setSelected((old) =>
                                event.target.checked
                                  ? [...old, chapter.id]
                                  : old.filter((id) => id !== chapter.id),
                              )
                            }
                          />
                          <button
                            onClick={() => void act(() => read(chapter.id))}
                          >
                            <span>{chapter.title}</span>
                            <small>
                              {taskOf(details, chapter.id)
                                ? "已下载"
                                : chapter.progress?.completed
                                  ? "已读"
                                  : chapter.progress
                                    ? "阅读中"
                                    : "未读"}
                            </small>
                          </button>
                          <IconButton
                            label={
                              taskOf(details, chapter.id)
                                ? `${chapter.title} 已下载`
                                : `下载 ${chapter.title}`
                            }
                            disabled={!!taskOf(details, chapter.id)}
                            onClick={() =>
                              void act(() =>
                                api().enqueue(details, [chapter.id]),
                              )
                            }
                          >
                            {taskOf(details, chapter.id) ? (
                              <Check size={14} />
                            ) : (
                              <Download size={14} />
                            )}
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          </section>
        </article>
      )}
      {scope.novelChapterId && (
        <div className="novel-reader-surface viewer viewer-novel">
          {reading ? (
            <NovelViewer
              key={reading.item.id}
              item={reading.item}
              close={back}
              online={{
                details: reading.details,
                bookmarks: reading.bookmarks,
                chapterId: reading.item.onlineNovelRef!.chapterId,
                navigateChapter: read,
              }}
            />
          ) : (
            <div className="novel-reader-pending">
              <button className="button secondary" onClick={back}>
                返回目录
              </button>
              {readerBusy ? (
                <p role="status">正在加载章节与插图…</p>
              ) : (
                <>
                  <p role="alert">{detailError || "章节无法读取"}</p>
                  <button
                    className="button secondary"
                    onClick={() => setRefresh((v) => v + 1)}
                  >
                    重试章节
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => void act(() => api().webLogin(sourceId))}
                  >
                    网页登录与验证
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {hubMenu && (
        <HubContextMenu
          items={hubMenuItems(hubMenu.item)}
          point={hubMenu}
          close={() => setHubMenu(undefined)}
        />
      )}
      {downloadQueueOpen && (
        <DownloadQueueModal
          groups={downloadQueueGroups}
          close={() => setDownloadQueueOpen(false)}
          pause={(taskIds) =>
            void act(() =>
              Promise.all(
                taskIds.map((id) => api().downloadAction(id, "pause")),
              ),
            )
          }
          resume={(taskIds) =>
            void act(() =>
              Promise.all(
                taskIds.map((id) => api().downloadAction(id, "resume")),
              ),
            )
          }
          cancel={(taskIds) =>
            void act(() =>
              Promise.all(
                taskIds.map((id) => api().downloadAction(id, "cancel")),
              ),
            )
          }
        />
      )}
    </ReadingPageShell>
  );
}
