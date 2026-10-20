import { normalizeLayout, supportedLayouts } from "./layouts/policy";
import HorizontalGallery from "./layouts/HorizontalGallery";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Folder,
  FolderOpen,
  ExternalLink,
  Grid2X2,
  Heart,
  Layers3,
  List,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
  PanelsTopLeft,
  Pencil,
} from "lucide-react";
import {
  NavigationHistory,
  MediaNavigationHistory,
  type NavigationEntry,
  type NavigationSurface,
} from "../../shared/navigation";
import type {
  BrowseMemory,
  Library,
  MediaItem,
  MediaLayout,
  MediaQuery,
  MediaType,
} from "../../shared/types";
import {
  Cover,
  IconButton,
  LibraryModal,
  Modal,
  TYPES,
  typeInfo,
} from "./components";
import {
  act,
  report,
  useApp,
  usePlayback,
  setPlaybackBrowseOrigin,
} from "./store";
import {
  flushMemory,
  readLastScope,
  readLastTypeScope,
  readLastNormalScope,
  readMemory,
  saveLastScope,
  saveLastNormalScope,
  saveMemory,
  scopeKey,
  type BrowseScope,
} from "./layouts/memory";
import { PagedMediaSource, useMediaSource } from "./layouts/source";
import BravaisWall from "./layouts/BravaisWall";
import SpatialGrid from "./layouts/SpatialGrid";
import LibraryCarousel from "./layouts/LibraryCarousel";
import StandardGrid from "./layouts/StandardGrid";
import Player from "./Player";
import AutoHideNavigation from "./components/AutoHideNavigation";
import { ContentNavigationContext } from "./layouts/ContentNavigation";
import MusicQuickPanel from "./music/MusicQuickPanel";
import MusicSources from "./music/MusicSources";
import {
  musicPage,
  collectionLocation,
  isRemote,
  stableQueue,
  musicItems,
  cachedMusic,
  favoriteRemote,
  specialPage,
} from "./music/catalog";
import Viewer from "./Viewers";
import SettingsPanel from "./SettingsPanel";
import useVideoPosters from "./useVideoPosters";
import useBrowseTransition from "./layouts/useBrowseTransition";

const LAYOUTS = [
  { id: "bravais", label: "Bravais 墙面", icon: PanelsTopLeft },
  { id: "spatial", label: "空间网格", icon: Layers3 },
  { id: "grid", label: "标准网格", icon: Grid2X2 },
  { id: "gallery", label: "等高画廊", icon: Grid2X2 },
  { id: "verticalGallery", label: "等宽画廊", icon: Grid2X2 },
  { id: "carousel", label: "封面流", icon: List },
] as const;
type Overlay =
  | "libraries"
  | "search"
  | "layout"
  | "settings"
  | "folders"
  | "music-account"
  | null;
interface ViewerSession {
  historyRestore?: boolean;
  item: MediaItem;
  index: number;
  source?: PagedMediaSource;
}

export default function App() {
  const { libraries, scans, settings, revision, toast, toastKind } = useApp();
  const [scope, setScope] = useState<BrowseScope>(
    () => readLastScope() ?? { view: "type", type: "image" },
  );
  const scopeRef = useRef(scope);
  const navigateRef = useRef<
    (next: BrowseScope, rememberScope?: boolean) => void
  >(() => {});
  const [memory, setMemory] = useState<BrowseMemory>(() => readMemory(scope));
  const memoryRef = useRef(memory);
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState("");
  const browseTransition = useBrowseTransition(settings.reducedMotion);
  const [navigationRetry, setNavigationRetry] = useState<BrowseScope | null>(
    null,
  );
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settingsSection, setSettingsSection] = useState("appearance");
  const [musicPreview, setMusicPreview] = useState<MediaItem | null>(null);
  const journals = useRef(new MediaNavigationHistory());
  const history = useRef(new NavigationHistory());
  const applyingHistory = useRef(false);
  const surfaces = useRef<NavigationSurface[]>([]);
  const navigationSerial = useRef(0);
  const typeNavigationSerial = useRef(0);
  const [, updateHistoryButtons] = useState(0);
  const closeSurfaceRef = useRef<() => void>(() => {});
  const historyMoveRef = useRef<(direction: number) => void>(() => {});
  const [createType, setCreateType] = useState<MediaType | null>(null);
  const [manage, setManage] = useState<Library | null>(null);
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [viewer, setViewer] = useState<ViewerSession | null>(null);
  const [folders, setFolders] = useState<{ path: string; count: number }[]>([]);
  const [focusedEntry, setFocusedEntry] = useState<{
    item: MediaItem;
    index: number;
    queryKey: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: MediaItem;
    index: number;
  } | null>(null);
  const [renameItem, setRenameItem] = useState<MediaItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [trashPreview, setTrashPreview] = useState<
    { title: string; isDirectory: boolean }[]
  >([]);
  const [trashTargetIds, setTrashTargetIds] = useState<string[]>([]);
  const [trashTargetPaths, setTrashTargetPaths] = useState<string[]>([]);
  const playerExpanded = usePlayback((state) => state.expanded);
  const playingTrack = usePlayback((state) => state.track);
  const queueVisible = usePlayback((state) => state.queueVisible);
  const matchOpen = usePlayback((state) => state.matchOpen);
  const activeLibrary = libraries.find((lib) => lib.id === scope.libraryId);
  const previousNormal = readLastNormalScope();
  const previousLibrary = libraries.find(
    (lib) => lib.id === previousNormal?.libraryId,
  );
  const previousType =
    (previousNormal?.type as MediaType | undefined) ?? previousLibrary?.type;
  const currentType = ["type", "libraries", "music"].includes(scope.view)
    ? (scope.type as MediaType)
    : (activeLibrary?.type ??
      (scope.view === "favorites" || scope.view === "recent"
        ? previousType
        : undefined));
  useLayoutEffect(() => {
    const layout = normalizeLayout(
      memoryRef.current.layout,
      currentType ?? "mixed",
    );
    if (layout !== memoryRef.current.layout) {
      memoryRef.current = { ...memoryRef.current, layout };
      setMemory(memoryRef.current);
    }
  }, [currentType, scope, memory.layout]);
  history.current = journals.current.forType(currentType ?? "image");
  if (currentType === "music")
    setPlaybackBrowseOrigin({ ...scope, search: searchTerm });
  const key = scopeKey(scope);
  const query = useMemo<MediaQuery>(
    () => ({
      libraryId:
        scope.view === "library" || scope.view === "folders"
          ? scope.libraryId
          : undefined,
      type:
        scope.view === "favorites" || scope.view === "recent"
          ? undefined
          : currentType,
      favorite: scope.view === "favorites",
      recent: scope.view === "recent",
      folder: searchTerm
        ? undefined
        : scope.view === "library" || scope.view === "folders"
          ? scope.folder
          : undefined,
      search: searchTerm || undefined,
      sort: scope.view === "recent" ? "recent" : memory.sort,
      browse: scope.view === "library" && !searchTerm,
    }),
    [key, currentType, memory.sort, searchTerm],
  );
  const remoteMusic = scope.view === "music";
  const fetchMusic = useMemo(
    () =>
      remoteMusic
        ? (q: MediaQuery) => musicPage(scope, q)
        : scope.view === "favorites" || scope.view === "recent"
          ? (q: MediaQuery) =>
              specialPage(scope.view as "favorites" | "recent", q)
          : scope.view === "libraries"
            ? async () => ({ items: [], total: 0 })
            : undefined,
    [key],
  );
  const media = useMediaSource(query, revision, memoryRef.current, fetchMusic);
  useEffect(() => {
    const typing = (event: Event) =>
      (event.target as HTMLElement)?.closest(
        "input,textarea,select,[contenteditable=true]",
      );
    const mouseDown = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) event.preventDefault();
    };
    const mouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (!typing(event)) historyMoveRef.current(event.button === 3 ? -1 : 1);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector(
          "dialog[open],.music-quick-panel,.music-platform-menu[open]",
        ) &&
        (usePlayback.getState().queueVisible ||
          snapshotRef.current().musicExpanded)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSurfaceRef.current();
        return;
      }
      if (
        typing(event) ||
        !event.altKey ||
        !["ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      historyMoveRef.current(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("mousedown", mouseDown, true);
    window.addEventListener("mouseup", mouseUp, true);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("mousedown", mouseDown, true);
      window.removeEventListener("mouseup", mouseUp, true);
      window.removeEventListener("keydown", keyboard, true);
    };
  }, []);
  useEffect(() => {
    const notice = (event: Event) =>
      useApp.getState().notify(String((event as CustomEvent).detail));
    window.addEventListener("music:notice", notice);
    return () => window.removeEventListener("music:notice", notice);
  }, []);
  useEffect(() => {
    setFocusedEntry(null);
  }, [query]);
  useEffect(() => {
    setFocusedEntry((current) => {
      if (!current) return current;
      const index = media.source.indexOfId(current.item.id);
      return index < 0 || index === current.index
        ? current
        : { ...current, index };
    });
  }, [media.refreshSerial]);
  useEffect(() => {
    const source = viewer?.source;
    if (!source) return;
    let serial = source.getSnapshot().refreshSerial;
    return source.subscribe(() => {
      const snapshot = source.getSnapshot();
      if (serial === snapshot.refreshSerial) return;
      serial = snapshot.refreshSerial;
      setViewer((current) =>
        current?.source === source
          ? { ...current, index: snapshot.anchorIndex }
          : current,
      );
    });
  }, [viewer?.source]);
  const loadedItems = media.source.cachedItems();
  useVideoPosters(loadedItems);
  const remember = useCallback(
    (patch: Partial<BrowseMemory>) => {
      if (scopeKey(scopeRef.current) !== key) return;
      memoryRef.current = { ...memoryRef.current, ...patch };
      saveMemory(scope, patch);
      if (
        history.current.current &&
        scopeKey(history.current.current.scope) === key
      )
        history.current.updateMemory(memoryRef.current);
    },
    [key],
  );
  useEffect(() => {
    let live = true;
    void Promise.all([
      useApp.getState().refresh(),
      window.media.settings().then((settings) => useApp.setState({ settings })),
    ])
      .then(async () => {
        if (!live) return;
        await window.music.upgrade();
        const libs = useApp.getState().libraries;
        const last = readLastScope();
        if (
          last?.view === "library" &&
          libs.some((lib) => lib.id === last.libraryId)
        )
          navigate(last, false);
        else if (
          last?.view === "music" ||
          last?.view === "libraries" ||
          last?.view === "favorites" ||
          last?.view === "recent"
        )
          navigate(last, false);
        else
          await activateType(
            (last?.type as MediaType | undefined) ?? libs[0]?.type ?? "image",
          );
        if (!live) return;
        setBooted(true);
        void window.media
          .musicSession()
          .then(async (localSession) => {
            const saved = await window.music.session();
            const session = saved?.session ?? localSession;
            if (!session?.trackId) return;
            const ids = [
              ...new Set([session.trackId, ...session.queueIds.slice(0, 199)]),
            ];
            const tracks = await musicItems(ids);
            usePlayback.getState().restore(session, tracks);
          })
          .catch(report);
      })
      .catch((error) => {
        if (live) {
          setBootError(String(error));
          setBooted(true);
        }
      });
    const off = window.media.onScan((status) => {
      useApp.setState((state) => ({
        scans: { ...state.scans, [status.libraryId]: status },
      }));
      if (status.status !== "scanning") {
        if (status.reason !== "background")
          void useApp.getState().refresh().catch(report);
        if (
          status.status === "error" ||
          (status.reason === "background" && status.message)
        )
          useApp.getState().notify(status.message ?? "扫描失败", "error");
      }
    });
    const flush = () => flushMemory();
    window.addEventListener("beforeunload", flush);
    return () => {
      live = false;
      off();
      window.removeEventListener("beforeunload", flush);
      flushMemory();
    };
  }, []);
  useEffect(
    () =>
      window.media.onIndexChange((change) => {
        void Promise.all([window.media.libraries(), window.media.statistics()])
          .then(([libraries, counts]) => useApp.setState({ libraries, counts }))
          .catch(report);
        setViewer((current) => {
          if (!current) return current;
          if (change.removedIds.includes(current.item.id)) {
            current.source?.dispose();
            return null;
          }
          current.source?.applyChange(change, {
            focusId: current.item.id,
            focusIndex: current.index,
          });
          const updated = change.updated.find(
            (item) => item.id === current.item.id,
          );
          return updated ? { ...current, item: updated } : current;
        });
        setFocusedEntry((current) => {
          if (!current) return current;
          if (change.removedIds.includes(current.item.id)) return null;
          const updated = change.updated.find(
            (item) => item.id === current.item.id,
          );
          return updated ? { ...current, item: updated } : current;
        });
        const state = usePlayback.getState();
        if (state.track && change.removedIds.includes(state.track.id))
          usePlayback.setState({
            track: null,
            playing: false,
            expanded: false,
          });
        else if (state.track) {
          const updated = change.updated.find(
            (item) => item.id === state.track!.id,
          );
          if (updated) usePlayback.setState({ track: updated });
        }
      }),
    [],
  );
  useEffect(() => {
    document.documentElement.dataset.motion = settings.reducedMotion
      ? "reduced"
      : "full";
  }, [settings.reducedMotion]);
  useEffect(() => {
    if (overlay === "search")
      requestAnimationFrame(() => searchInput.current?.focus());
    if (overlay === "folders")
      void window.media.folders(scope.libraryId).then(setFolders).catch(report);
  }, [overlay, scope.libraryId]);
  useEffect(() => {
    if (booted && scope.view === "library" && !activeLibrary)
      navigate(
        {
          view: "libraries",
          type: (scope.type as MediaType | undefined) ?? "image",
        },
        false,
      );
  }, [booted, activeLibrary, scope.view]);
  useEffect(() => {
    if (
      !booted ||
      scope.view !== "library" ||
      !scope.folder ||
      !media.ready ||
      media.error ||
      media.total !== 0 ||
      memory.layout === "bravais" ||
      searchTerm
    )
      return;
    if (scans[scope.libraryId ?? ""]?.status === "scanning") return;
    goParent();
  }, [
    booted,
    scope.view,
    scope.folder,
    scope.libraryId,
    media.ready,
    media.error,
    media.total,
    memory.layout,
    searchTerm,
    scans,
  ]);
  function navigate(
    next: BrowseScope,
    rememberScope = true,
    restoring = false,
  ) {
    ++typeNavigationSerial.current;
    if (!restoring) {
      ++navigationSerial.current;
      applyingHistory.current = false;
    }
    const resolved: BrowseScope = {
      ...next,
      type:
        next.type ??
        useApp.getState().libraries.find((lib) => lib.id === next.libraryId)
          ?.type ??
        currentType,
    };
    if (booted)
      browseTransition.start(
        snapshotRef.current(),
        resolved,
        readMemory(resolved).layout,
      );
    if (
      booted &&
      !restoring &&
      scopeKey(resolved) !== scopeKey(scopeRef.current)
    ) {
      journals.current.forType(resolved.type ?? currentType ?? "image").record({
        ...snapshotRef.current(),
        scope: resolved,
        memory: readMemory(resolved),
        search: resolved.search ?? "",
        viewer: undefined,
        musicDetailId: undefined,
        musicExpanded: false,
        queueOpen: false,
        matchOpen: false,
        overlay: null,
        createType: null,
        manageId: undefined,
      });
      updateHistoryButtons((n) => n + 1);
    }
    setNavigationRetry(null);
    flushMemory();
    scopeRef.current = resolved;
    setScope(resolved);
    setViewer((current) => {
      current?.source?.dispose();
      return null;
    });
    setMusicPreview(null);
    usePlayback.setState({
      expanded: false,
      queueVisible: false,
      matchOpen: false,
    });
    const value = readMemory(resolved);
    memoryRef.current = value;
    setMemory(value);
    if (rememberScope) {
      saveLastScope(resolved);
      saveLastNormalScope(resolved);
    }
    setSearch(next.search ?? "");
    setSearchTerm(next.search ?? "");
    setOverlay(null);
    setFocusedEntry(null);
    setContextMenu(null);
  }

  navigateRef.current = navigate;
  useEffect(() => {
    if (!browseTransition.pending) return;
    let frame = 0,
      live = true,
      recovering = false;
    const poll = () => {
      if (!live) return;
      if (media.errorCode === "auth-required") {
        browseTransition.cancel();
        return;
      }
      if (media.error && !recovering) {
        recovering = true;
        const previous = browseTransition.previous(),
          target = browseTransition.target();
        if (previous)
          void restoreEntry(previous)
            .then(() => {
              if (
                target &&
                scopeKey(scopeRef.current) === scopeKey(previous.scope)
              )
                setNavigationRetry(target);
            })
            .catch(report);
        report(new Error(media.error));
        return;
      }
      if (media.ready) void browseTransition.reveal();
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [
    browseTransition.pending,
    media.ready,
    media.error,
    media.errorCode,
    media.total,
    key,
  ]);
  function returnToPrevious() {
    const previous = readLastNormalScope();
    const libraryExists =
      !previous?.libraryId ||
      libraries.some((lib) => lib.id === previous.libraryId);
    navigate(
      previous && libraryExists
        ? previous
        : {
            view: "libraries",
            type: (previous?.type as MediaType | undefined) ?? "image",
          },
    );
  }
  function toggleSpecial(view: "favorites" | "recent") {
    if (scope.view === view) returnToPrevious();
    else navigate({ view });
  }
  function goParent() {
    if (scope.view !== "library" || !scope.folder || !activeLibrary) return;
    const folder = scope.folder;
    const isRoot = activeLibrary.roots.some(
      (root) => root.toLowerCase() === folder.toLowerCase(),
    );
    const separator = Math.max(
      folder.lastIndexOf("\\"),
      folder.lastIndexOf("/"),
    );
    const parent = isRoot
      ? undefined
      : separator > 0
        ? folder.slice(0, separator)
        : undefined;
    navigate({ view: "library", libraryId: scope.libraryId, folder: parent });
  }
  function changeLayout(layout: MediaLayout) {
    if (!supportedLayouts(currentType).includes(layout)) return;
    browseTransition.start(snapshotRef.current(), scope, layout);
    remember({ layout });
    setMemory({ ...memoryRef.current, layout });
    setOverlay(null);
  }
  function changeSort(sort: BrowseMemory["sort"]) {
    remember({ sort, focusId: undefined, focusIndex: 0, scrollTop: 0 });
    setMemory({ ...memoryRef.current, sort });
  }
  async function removeRecent(item: MediaItem) {
    const result = await window.media.removeRecent(item.id);
    setFocusedEntry((current) =>
      current?.item.id === item.id ? null : current,
    );
    if (result.errors.length) report(new Error(result.errors.join("；")));
  }
  async function open(item: MediaItem, index: number) {
    if (item.missing) {
      useApp.getState().notify("文件不可用，请检查来源文件夹", "error");
      return;
    }
    remember({ focusId: item.id, focusIndex: index });
    if (item.kind === "collection") {
      navigate(collectionLocation(item));
      return;
    }
    if (item.kind === "folder") {
      navigate({
        view: "library",
        libraryId: scope.libraryId,
        folder: item.path,
      });
      return;
    }
    if (item.type === "music") {
      setMusicPreview(null);
      const playback = usePlayback.getState();
      playback.play(item, media.source.cachedItems());
      usePlayback.setState({ expanded: true, queueVisible: false });
      void (
        remoteMusic
          ? stableQueue(scope, searchTerm)
          : window.media.musicQueueIds(query)
      )
        .then((ids) => {
          if (usePlayback.getState().track?.id === item.id)
            usePlayback.getState().setQueueIds(ids);
        })
        .catch(report);
      return;
    }
    setOverlay(null);
    if (item.type === "image") {
      const source = new PagedMediaSource({
        ...query,
        browse: false,
        type: "image",
        folder: item.folder,
      });
      await source.initialize(item.id);
      setViewer({
        item,
        index: source.getSnapshot().anchorIndex,
        source,
        historyRestore: true,
      });
    } else setViewer({ item, index });
  }
  const closeViewerDirect = useCallback(() => {
    setViewer((current) => {
      current?.source?.dispose();
      return null;
    });
    useApp.getState().touch();
  }, []);
  function closeSurface(fallback: () => void) {
    if (
      history.current.current &&
      scopeKey(history.current.current.scope) === key
    )
      history.current.updateMemory(memoryRef.current);
    const current = snapshotRef.current();
    const top = current.surfaceStack?.at(-1);
    const contains = (entry: NavigationEntry) =>
      top === "create"
        ? Boolean(entry.createType)
        : top === "manage"
          ? Boolean(entry.manageId)
          : top === "overlay"
            ? entry.overlay === current.overlay
            : top === "match"
              ? entry.matchOpen
              : top === "queue"
                ? entry.queueOpen
                : top === "viewer"
                  ? Boolean(entry.viewer)
                  : entry.musicExpanded;
    const target = history.current.closeSurface(contains);
    if (target) void restoreEntry(target).catch(report);
    else fallback();
  }
  closeSurfaceRef.current = () => {
    if (usePlayback.getState().queueVisible) {
      usePlayback.setState({ queueVisible: false });
      return;
    }
    closeSurface(() => {
      setMusicPreview(null);
      usePlayback.setState({ expanded: false });
    });
  };
  const closeViewer = () => closeSurface(closeViewerDirect);
  function closeOverlay() {
    if (overlay === "layout") {
      setOverlay(null);
      return;
    }
    closeSurface(() => setOverlay(null));
  }
  async function activateType(type: MediaType) {
    const serial = ++typeNavigationSerial.current;
    const members = useApp
      .getState()
      .libraries.filter((lib) => lib.type === type);
    const saved = readLastTypeScope(type);
    if (saved?.view === "music") {
      navigate(saved);
      return;
    }
    if (saved?.libraryId && members.some((lib) => lib.id === saved.libraryId)) {
      const folder = await window.media.resolveBrowseLocation(
        saved.libraryId,
        saved.folder,
      );
      if (serial !== typeNavigationSerial.current) return;
      navigate({ ...saved, folder: folder ?? undefined });
      return;
    }
    if (members.length === 1)
      navigate({ view: "library", libraryId: members[0].id, type });
    else navigate({ view: "libraries", type });
  }
  function snapshot(): NavigationEntry {
    window.dispatchEvent(new Event("wall:flush"));
    const active: NavigationSurface[] = [];
    if (viewer) active.push("viewer");
    if (playerExpanded || musicPreview) active.push("music");
    if (queueVisible) active.push("queue");
    if (matchOpen) active.push("match");
    if (overlay && overlay !== "layout") active.push("overlay");
    if (createType) active.push("create");
    if (manage) active.push("manage");
    surfaces.current = [
      ...surfaces.current.filter((s) => active.includes(s)),
      ...active.filter((s) => !surfaces.current.includes(s)),
    ];
    return {
      surfaceStack: [...surfaces.current],
      scope,
      memory: { ...memoryRef.current },
      search: searchTerm,
      overlay: overlay === "layout" ? null : overlay,
      settingsSection,
      viewer: viewer ? { id: viewer.item.id, index: viewer.index } : undefined,
      musicDetailId:
        musicPreview?.id ?? (playerExpanded ? playingTrack?.id : undefined),
      musicExpanded: playerExpanded || Boolean(musicPreview),
      queueOpen: queueVisible,
      matchOpen,
      createType,
      manageId: manage?.id,
    };
  }
  const snapshotRef = useRef<() => NavigationEntry>(() => snapshot());
  snapshotRef.current = snapshot;
  useLayoutEffect(() => {
    if (
      !booted ||
      applyingHistory.current ||
      (browseTransition.pending && !media.ready)
    )
      return;
    saveLastScope({ ...scope, search: searchTerm });
    saveLastNormalScope({ ...scope, search: searchTerm });
    if (history.current.record(snapshotRef.current()))
      updateHistoryButtons((n) => n + 1);
  }, [
    booted,
    browseTransition.pending,
    media.ready,
    key,
    memory.layout,
    memory.sort,
    searchTerm,
    overlay,
    settingsSection,
    viewer?.item.id,
    playerExpanded,
    musicPreview?.id,
    queueVisible,
    matchOpen,
    createType,
    manage?.id,
  ]);
  async function restoreEntry(entry: NavigationEntry) {
    const serial = ++navigationSerial.current;
    applyingHistory.current = true;
    try {
      let next = entry.scope;
      if (next.libraryId) {
        const lib = useApp
          .getState()
          .libraries.find((lib) => lib.id === next.libraryId);
        if (!lib) next = { view: "libraries", type: next.type ?? "image" };
        else
          next = {
            ...next,
            folder:
              (await window.media.resolveBrowseLocation(lib.id, next.folder)) ??
              undefined,
          };
      }
      if (serial !== navigationSerial.current) return;
      navigate(next, false, true);
      const restoredMemory = {
        ...entry.memory,
        layout: normalizeLayout(
          readMemory(next).layout,
          next.type ?? currentType ?? "mixed",
        ),
      };
      saveMemory(next, restoredMemory);
      memoryRef.current = restoredMemory;
      setMemory(restoredMemory);
      saveLastScope(next);
      saveLastNormalScope(next);
      setSearch(entry.search);
      setSearchTerm(entry.search);
      setSettingsSection(entry.settingsSection ?? "appearance");
      setCreateType(entry.createType);
      setManage(
        useApp.getState().libraries.find((lib) => lib.id === entry.manageId) ??
          null,
      );
      if (entry.viewer) {
        try {
          const item = await window.media.item(entry.viewer.id);
          if (serial !== navigationSerial.current) return;
          if (item.type === "image") {
            const source = new PagedMediaSource({
              libraryId: next.libraryId,
              type: "image",
              folder: item.folder,
              search: entry.search || undefined,
              sort: entry.memory.sort,
            });
            await source.initialize(item.id);
            if (serial !== navigationSerial.current) {
              source.dispose();
              return;
            }
            setViewer({
              item,
              index: source.getSnapshot().anchorIndex,
              source,
              historyRestore: true,
            });
          } else
            setViewer({
              item,
              index: entry.viewer.index,
              historyRestore: true,
            });
        } catch {
          useApp.getState().notify("该内容已不可用，已返回浏览页");
        }
      }
      if (entry.musicExpanded && entry.musicDetailId) {
        try {
          const item =
            cachedMusic(entry.musicDetailId) ??
            (await musicItems([entry.musicDetailId]))[0];
          if (!item) throw new Error("歌曲不可用");
          if (usePlayback.getState().track?.id === item.id)
            usePlayback.setState({ expanded: true, queueVisible: false });
          else setMusicPreview(item);
        } catch {
          useApp.getState().notify("该歌曲已不可用");
        }
      }
      surfaces.current = entry.surfaceStack ?? [];
      setOverlay(entry.overlay as Overlay);
      usePlayback.setState({
        queueVisible: Boolean(entry.queueOpen && usePlayback.getState().track),
        matchOpen: entry.matchOpen,
      });
    } finally {
      if (serial === navigationSerial.current)
        requestAnimationFrame(() => {
          applyingHistory.current = false;
          history.current.replace(snapshotRef.current());
          updateHistoryButtons((n) => n + 1);
        });
    }
  }
  historyMoveRef.current = (direction) => {
    const platformMenu = document.querySelector<HTMLDetailsElement>(
      ".music-platform-menu[open]",
    );
    if (platformMenu) {
      platformMenu.open = false;
      return;
    }
    if (clearHistoryOpen) {
      setClearHistoryOpen(false);
      return;
    }
    if (contextMenu) {
      setContextMenu(null);
      return;
    }
    if (trashOpen || renameItem) {
      setTrashOpen(false);
      setRenameItem(null);
      return;
    }
    if (
      history.current.current &&
      scopeKey(history.current.current.scope) === key
    )
      history.current.updateMemory(memoryRef.current);
    const entry =
      direction < 0 ? history.current.back() : history.current.forward();
    if (entry) void restoreEntry(entry).catch(report);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.defaultPrevented ||
        document.querySelector("dialog[open]")
      )
        return;
      setTimeout(() => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (focusedEntry) {
          clearFocus();
          return;
        }
        historyMoveRef.current(-1);
      }, 0);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focusedEntry]);
  async function stepViewer(direction: number) {
    if (!viewer?.source) return;
    const nextIndex = viewer.index + direction;
    const item = await viewer.source.at(nextIndex);
    if (item) {
      setViewer({ ...viewer, item, index: nextIndex, historyRestore: false });
      remember({ focusId: item.id });
    }
  }
  function favorite(item: MediaItem) {
    if (item.kind === "folder") return;
    void act(async () => {
      if (isRemote(item)) await favoriteRemote(item, !item.favorite);
      else await window.media.favorite(item.id, !item.favorite);
      media.source.patch(item.id, { favorite: !item.favorite });
      if (scope.view === "favorites") useApp.getState().touch();
    });
  }
  const activeScans = Object.values(scans).filter(
    (scan) => scan.status === "scanning" && scan.reason !== "background",
  );
  const sideNavigation =
    settings.navigationPosition === "left" ||
    settings.navigationPosition === "right";
  const title =
    scope.view === "library"
      ? (activeLibrary?.name ?? "媒体库")
      : scope.view === "favorites"
        ? "收藏"
        : scope.view === "recent"
          ? "最近"
          : scope.view === "folders"
            ? (scope.folder?.split(/[\\/]/).at(-1) ?? "文件夹")
            : currentType
              ? typeInfo(currentType).name
              : "全部";
  const currentRoot =
    scope.folder &&
    activeLibrary?.roots.find((root) => {
      const source = root.replace(/[\\/]+$/, "").toLowerCase();
      const folder = scope.folder!.replace(/[\\/]+$/, "").toLowerCase();
      return (
        folder === source ||
        folder.startsWith(`${source}\\`) ||
        folder.startsWith(`${source}/`)
      );
    });
  const folderSegments =
    currentRoot && scope.folder
      ? scope.folder
          .slice(currentRoot.length)
          .split(/[\\/]+/)
          .filter(Boolean)
      : [];
  const blocked = Boolean(
    overlay ||
    createType ||
    manage ||
    viewer ||
    musicPreview ||
    playerExpanded ||
    contextMenu ||
    clearHistoryOpen ||
    trashOpen ||
    renameItem,
  );
  const focusKey = JSON.stringify(query);
  const focused = focusedEntry?.queryKey === focusKey ? focusedEntry : null;
  const focusedCount = focused ? 1 : 0;
  function clearFocus() {
    setFocusedEntry(null);
    setContextMenu(null);
  }
  function focusItem(item: MediaItem, index: number) {
    remember({ focusId: item.id, focusIndex: index });
    setFocusedEntry((current) =>
      current?.item === item &&
      current.index === index &&
      current.queryKey === focusKey
        ? current
        : { item, index, queryKey: focusKey },
    );
  }
  function openContext(
    item: MediaItem,
    index: number,
    event: {
      clientX: number;
      clientY: number;
      preventDefault(): void;
      stopPropagation(): void;
    },
  ) {
    event.preventDefault();
    event.stopPropagation();
    focusItem(item, index);
    setContextMenu({
      item,
      index,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 236)),
      y: Math.max(42, Math.min(event.clientY, window.innerHeight - 390)),
    });
  }

  function renameBaseName(item: MediaItem) {
    const name = item.path.split(/[\\/]/).at(-1) || item.title;
    if (item.kind === "folder" || item.ext === "folder") return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }
  function isProtectedRoot(item: MediaItem) {
    const target = item.path.replace(/[\\/]+$/, "").toLowerCase();
    return item.libraryIds.some((id) => {
      const library = libraries.find((entry) => entry.id === id);
      return (
        library?.roots.some((root) => {
          const source = root.replace(/[\\/]+$/, "").toLowerCase();
          if (target === source) return true;
          const separator = source.includes("\\") ? "\\" : "/";
          return source.startsWith(`${target}${separator}`);
        }) ?? false
      );
    });
  }
  async function openTrashConfirmation() {
    if (focused && isRemote(focused.item)) return;
    if (!focused) return;
    const item = focused.item;
    setTrashTargetIds([item.id]);
    setTrashTargetPaths([item.path]);
    setTrashPreview([
      {
        title: item.title,
        isDirectory: item.kind === "folder" || item.ext === "folder",
      },
    ]);
    setTrashOpen(true);
    setContextMenu(null);
  }
  async function copyFocused(pathsOnly = false) {
    if (focused && isRemote(focused.item)) return;
    if (!focused) return;
    if (pathsOnly) await window.media.copyPaths([focused.item.id]);
    else await window.media.copyFiles([focused.item.id]);
    setContextMenu(null);
    useApp.getState().notify(pathsOnly ? "已复制路径" : "已复制文件");
  }
  function pathContains(parentPath: string, candidatePath: string) {
    const parent = parentPath.replace(/[\\/]+$/, "").toLowerCase();
    const candidate = candidatePath.replace(/[\\/]+$/, "").toLowerCase();
    if (parent === candidate) return true;
    const separator = parent.includes("\\") ? "\\" : "/";
    return candidate.startsWith(`${parent}${separator}`);
  }
  async function releasePlaybackUnder(paths: string[]) {
    const state = usePlayback.getState();
    const track = state.track;
    if (!track || !paths.some((target) => pathContains(target, track.path)))
      return;
    usePlayback.setState({
      track: null,
      queue: [],
      playing: false,
      position: 0,
      duration: 0,
      expanded: false,
    });
  }
  async function trashFocused() {
    await releasePlaybackUnder(trashTargetPaths);
    const result = await window.media.trashFiles(trashTargetIds);
    setTrashOpen(false);
    setContextMenu(null);
    clearFocus();
    await useApp.getState().refresh();
    if (result.errors.length)
      useApp
        .getState()
        .notify(
          `已移到回收站 ${result.removed.length} 项，清理失效记录 ${result.cleared.length} 项，${result.errors.length} 项失败：${result.errors[0]}`,
          "error",
        );
    else if (result.cleared.length)
      useApp
        .getState()
        .notify(
          `已移到回收站 ${result.removed.length} 项，清理失效记录 ${result.cleared.length} 项`,
        );
    else useApp.getState().notify(`已移到回收站：${result.removed.length} 项`);
  }
  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renameItem) return;
    try {
      await releasePlaybackUnder([renameItem.path]);
      if (renameItem.kind === "folder")
        await window.media.renameFolder(renameItem.id, renameValue);
      else await window.media.renameFile(renameItem.id, renameValue);
      setRenameItem(null);
      useApp.getState().touch();
      useApp.getState().notify("已重命名");
    } catch (error) {
      report(error);
    }
  }
  useEffect(() => {
    if (!contextMenu) return;
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(".media-context-menu [role=menuitem]")
        ?.focus(),
    );
  }, [contextMenu]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) ||
        target?.isContentEditable;
      if (
        (event.ctrlKey || event.metaKey) &&
        ["k", "f"].includes(event.key.toLowerCase()) &&
        !viewer &&
        !playerExpanded &&
        (!document.querySelector("dialog[open]") || overlay === "search") &&
        (!typing || overlay === "search")
      ) {
        event.preventDefault();
        setOverlay("search");
        requestAnimationFrame(() => {
          searchInput.current?.focus();
          searchInput.current?.select();
        });
        return;
      }
      if (event.key === "Escape" && contextMenu) {
        event.preventDefault();
        setContextMenu(null);
        return;
      }
      if (
        !typing &&
        contextMenu &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "c" &&
        focusedCount
      ) {
        event.preventDefault();
        void copyFocused().catch(report);
        return;
      }
      if (
        !typing &&
        contextMenu &&
        event.key === "F2" &&
        focusedCount === 1 &&
        !isRemote(contextMenu.item) &&
        !isProtectedRoot(contextMenu.item)
      ) {
        event.preventDefault();
        setRenameItem(contextMenu.item);
        setRenameValue(renameBaseName(contextMenu.item));
        setContextMenu(null);
        return;
      }
      if (!typing && contextMenu && event.key === "Delete" && focusedCount) {
        event.preventDefault();
        void openTrashConfirmation();
        setContextMenu(null);
        return;
      }
      if (
        event.key === "Escape" &&
        !document.querySelector("dialog[open]") &&
        !queueVisible &&
        playerExpanded
      ) {
        closeSurface(() => usePlayback.setState({ expanded: false }));
        event.preventDefault();
      }
      if (!typing && !blocked) {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
        } else if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "c" &&
          focusedCount
        ) {
          event.preventDefault();
          void copyFocused().catch(report);
        } else if (event.key === "Delete" && focusedCount) {
          event.preventDefault();
          void openTrashConfirmation();
          setContextMenu(null);
        } else if (event.key === "F2" && focusedCount === 1) {
          event.preventDefault();
          const index = focused?.index;
          const item = focused?.item;
          if (item && !isRemote(item) && !isProtectedRoot(item)) {
            setRenameItem(item);
            setRenameValue(renameBaseName(item));
          }
        } else if (
          event.key === "Enter" &&
          focusedCount === 1 &&
          ["grid", "gallery", "verticalGallery"].includes(memory.layout)
        ) {
          const index = focused?.index;
          event.preventDefault();
          if (focused) void open(focused.item, focused.index);
        } else if (event.key === "Escape" && focusedCount) {
          if (!["bravais", "spatial"].includes(memory.layout))
            event.preventDefault();
          clearFocus();
        }
      }
      if (
        event.code === "Space" &&
        !viewer &&
        !overlay &&
        !createType &&
        !manage &&
        !typing &&
        !blocked &&
        !["BUTTON"].includes(target?.tagName) &&
        usePlayback.getState().track
      ) {
        event.preventDefault();
        usePlayback.getState().toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    viewer,
    overlay,
    createType,
    manage,
    playerExpanded,
    blocked,
    focusKey,
    focusedCount,
    media.total,
    focused,
    contextMenu,
    scope.view,
    scope.folder,
    scope.libraryId,
    activeLibrary,
    copyFocused,
    open,
    goParent,
    clearFocus,
    openTrashConfirmation,
    memory.layout,
  ]);
  const navigation = (
    <>
      {TYPES.map((type) => (
        <button
          key={type.id}
          className={`media-tab ${currentType === type.id ? "selected" : ""}`}
          aria-label={`浏览${type.name}`}
          onClick={() => void activateType(type.id)}
        >
          <type.icon size={17} />
          <span>{type.name}</span>
        </button>
      ))}
    </>
  );
  const actions = (
    <>
      <span className="navigation-history-controls">
        <IconButton
          label="后退"
          disabled={!history.current.canBack}
          onClick={() => historyMoveRef.current(-1)}
        >
          <ChevronLeft size={17} />
        </IconButton>
        <IconButton
          label="前进"
          disabled={!history.current.canForward}
          onClick={() => historyMoveRef.current(1)}
        >
          <ChevronRight size={17} />
        </IconButton>
      </span>
      <IconButton
        label="媒体库"
        active={scope.view === "library"}
        onClick={() => setOverlay("libraries")}
      >
        <Layers3 size={17} />
      </IconButton>
      <IconButton
        label="收藏"
        active={scope.view === "favorites"}
        onClick={() => toggleSpecial("favorites")}
      >
        <Heart size={17} />
      </IconButton>
      <IconButton
        label="最近打开"
        active={scope.view === "recent"}
        onClick={() => toggleSpecial("recent")}
      >
        <Clock3 size={17} />
      </IconButton>
      <IconButton
        label="文件夹"
        active={scope.view === "folders"}
        onClick={() => setOverlay("folders")}
      >
        <FolderOpen size={17} />
      </IconButton>
      <IconButton
        label="搜索"
        active={Boolean(searchTerm)}
        onClick={() => setOverlay("search")}
      >
        <Search size={17} />
      </IconButton>
      <IconButton label="显示方式" onClick={() => setOverlay("layout")}>
        <Grid2X2 size={17} />
      </IconButton>
      <IconButton label="设置" onClick={() => setOverlay("settings")}>
        <Settings size={17} />
      </IconButton>
    </>
  );
  const contentNavigation = (
    <div className="content-navigation-body">
      {libraries.length > 0 && !remoteMusic && scope.view !== "recent" && (
        <div
          className={`scope-pill ${settings.navigationPosition === "left" ? "left-scope" : sideNavigation ? "wall-scope" : ""}`}
        >
          <button
            aria-label="切换媒体库"
            onClick={() => setOverlay("libraries")}
          >
            {title}
            <ChevronDown size={11} />
          </button>
          {scope.view === "library" && scope.folder && currentRoot && (
            <div className="folder-breadcrumbs" aria-label="文件夹路径">
              <button aria-label="返回上级文件夹" onClick={goParent}>
                <ChevronLeft size={13} />
              </button>
              <button
                onClick={() =>
                  navigate({
                    view: "library",
                    libraryId: scope.libraryId,
                    folder:
                      activeLibrary?.roots.length === 1
                        ? undefined
                        : currentRoot,
                  })
                }
              >
                {currentRoot.split(/[\\/]/).filter(Boolean).at(-1)}
              </button>
              {folderSegments.map((segment, index) => {
                const separator = currentRoot.includes("\\") ? "\\" : "/";
                const base = /[\\/]$/.test(currentRoot)
                  ? currentRoot
                  : `${currentRoot}${separator}`;
                const prefix = folderSegments
                  .slice(0, index + 1)
                  .join(separator);
                const current = `${base}${prefix}`;
                return (
                  <span className="breadcrumb-part" key={current}>
                    <small>›</small>
                    <button
                      onClick={() =>
                        navigate({
                          view: "library",
                          libraryId: scope.libraryId,
                          folder: current,
                        })
                      }
                    >
                      {segment}
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {memory.layout === "bravais" && currentType !== "image" && (
            <button
              className="seam-search"
              aria-label="搜索当前内容"
              onClick={() => setOverlay("search")}
            >
              <Search size={14} />
              搜索
            </button>
          )}
          {searchTerm && (
            <button
              aria-label="清除搜索"
              onClick={() => {
                setSearch("");
                setSearchTerm("");
              }}
            >
              <Search size={11} />
              {searchTerm}
              <X size={11} />
            </button>
          )}
          {(scope.view === "library" || scope.view === "type") && (
            <select
              aria-label="排序方式"
              value={memory.sort}
              onChange={(event) =>
                changeSort(event.target.value as BrowseMemory["sort"])
              }
            >
              <option value="added">最近添加</option>
              <option value="name">名称</option>
              <option value="recent">最近打开</option>
            </select>
          )}
        </div>
      )}
      {currentType === "music" &&
        scope.view !== "favorites" &&
        scope.view !== "recent" && (
          <MusicSources
            scope={scope}
            navigate={navigate}
            local={() => {
              const members = libraries.filter((lib) => lib.type === "music");
              navigate(
                members.length === 1
                  ? {
                      view: "library",
                      type: "music",
                      libraryId: members[0].id,
                    }
                  : { view: "libraries", type: "music" },
              );
            }}
            accountOpen={overlay === "music-account"}
            account={() => setOverlay("music-account")}
            closeAccount={closeOverlay}
          />
        )}
    </div>
  );
  const layoutProps = {
    scope,
    source: media.source,
    memory: memoryRef.current,
    remember,
    open: (item: MediaItem, index: number) => void open(item, index),
    favorite,
    selected: (item: MediaItem) => focused?.item.id === item.id,
    clearFocus,
    select: focusItem,
    contextMenu: openContext,
    removeRecent: scope.view === "recent" ? removeRecent : undefined,
    interactive: !blocked,
    reducedMotion: settings.reducedMotion,
  };
  return (
    <div
      className={`browser-shell layout-${memory.layout} ${currentType === "music" && !["favorites", "recent"].includes(scope.view) ? "music-browse" : ""} ${playingTrack ? "has-player" : ""}`}
      data-navigation={settings.navigationPosition}
    >
      <div className="window-drag" aria-hidden="true" />
      <div className="browser-content" inert={blocked}>
        {!booted ||
        (!media.ready &&
          !browseTransition.pending &&
          (libraries.length > 0 || remoteMusic)) ? (
          <div className="scene-loading">
            <LoaderCircle size={21} className="spin" />
          </div>
        ) : media.errorCode === "auth-required" && media.error ? (
          <div className="minimal-empty login-required-page">
            <p>登录后查看此栏目</p>
            <button
              className="button primary"
              onClick={() => setOverlay("music-account")}
            >
              登录音乐平台
            </button>
          </div>
        ) : bootError || (media.error && !media.total) ? (
          <div className="minimal-empty">
            <p>{bootError || media.error}</p>
            <button
              className="button secondary"
              onClick={() => location.reload()}
            >
              重新加载
            </button>
          </div>
        ) : scope.view === "libraries" ? (
          <div
            className="type-library-page"
            aria-label={`${typeInfo((scope.type as MediaType) ?? "image").name}媒体库`}
          >
            {["spatial", "carousel"].includes(memory.layout) ? (
              <LibraryCarousel
                memory={memory}
                remember={remember}
                reducedMotion={settings.reducedMotion}
                libraries={libraries.filter((lib) => lib.type === scope.type)}
                open={(lib) =>
                  navigate({
                    view: "library",
                    libraryId: lib.id,
                    type: lib.type,
                  })
                }
                create={() =>
                  setCreateType((scope.type as MediaType) ?? "image")
                }
              />
            ) : (
              <>
                {libraries
                  .filter((lib) => lib.type === scope.type)
                  .map((lib) => (
                    <button
                      key={lib.id}
                      className="type-library-entry"
                      onClick={() =>
                        navigate({
                          view: "library",
                          libraryId: lib.id,
                          type: lib.type,
                        })
                      }
                    >
                      <FolderOpen size={25} />
                      <span>{lib.name}</span>
                    </button>
                  ))}
                <button
                  className="type-library-entry create-library-entry"
                  onClick={() =>
                    setCreateType((scope.type as MediaType) ?? "image")
                  }
                >
                  <Plus size={24} />
                  <span>
                    {libraries.some((lib) => lib.type === scope.type)
                      ? "添加媒体库"
                      : "创建媒体库"}
                  </span>
                </button>
              </>
            )}
          </div>
        ) : !libraries.length && !remoteMusic ? (
          <div className="minimal-empty">
            <span className="empty-brand">映间</span>
            <button
              className="button primary"
              onClick={() => setCreateType("image")}
            >
              <Plus size={17} />
              创建媒体库
            </button>
          </div>
        ) : !media.total && !browseTransition.pending ? (
          <div className="minimal-empty">
            <p>{searchTerm ? "没有匹配的媒体" : "暂无媒体"}</p>
            {!searchTerm && activeLibrary && (
              <button
                className="text-button"
                onClick={() => setManage(activeLibrary)}
              >
                管理来源文件夹
              </button>
            )}
          </div>
        ) : (
          <div
            className="layout-surface"
            inert={browseTransition.pending && !media.ready}
            key={
              memory.layout === "bravais"
                ? "bravais"
                : `${key}:${memory.layout}:${JSON.stringify(query)}`
            }
          >
            {memory.layout === "bravais" ? (
              <ContentNavigationContext.Provider
                value={
                  scope.view === "recent" || currentType === "image"
                    ? null
                    : { content: contentNavigation, title }
                }
              >
                <BravaisWall {...layoutProps} />
              </ContentNavigationContext.Provider>
            ) : memory.layout === "spatial" || memory.layout === "carousel" ? (
              <SpatialGrid
                {...layoutProps}
                forceCarousel={memory.layout === "carousel"}
              />
            ) : memory.layout === "gallery" ||
              memory.layout === "verticalGallery" ? (
              <HorizontalGallery
                {...layoutProps}
                vertical={memory.layout === "verticalGallery"}
              />
            ) : (
              <StandardGrid {...layoutProps} />
            )}
          </div>
        )}
        <AutoHideNavigation
          edge={settings.navigationPosition}
          locked={Boolean(overlay)}
          className="main-chrome"
        >
          {sideNavigation ? (
            <nav
              className={`side-rail nav-${settings.navigationPosition}`}
              aria-label="媒体导航"
            >
              <button
                className="rail-brand"
                onClick={() => setOverlay("libraries")}
                title={title}
              >
                {title}
              </button>
              <div className="rail-types">{navigation}</div>
              <div className="rail-actions">{actions}</div>
            </nav>
          ) : (
            <header
              className={`floating-header nav-${settings.navigationPosition}`}
            >
              <button
                className="wordmark"
                onClick={() => setOverlay("libraries")}
              >
                映间
              </button>
              <nav className="top-types" aria-label="媒体导航">
                {navigation}
              </nav>
              <div className="top-actions">{actions}</div>
            </header>
          )}
        </AutoHideNavigation>
        {scope.view === "recent" && (
          <div className="recent-toolbar">
            <span>最近打开</span>
            <button
              className="text-button"
              aria-label="清空历史记录"
              onClick={() => setClearHistoryOpen(true)}
            >
              <Trash2 size={14} />
              清空历史记录
            </button>
          </div>
        )}
        {(currentType === "image" ||
          memory.layout !== "bravais" ||
          (!media.total && !browseTransition.pending)) && (
          <AutoHideNavigation
            edge="top"
            className="content-chrome"
            locked={Boolean(overlay)}
          >
            {contentNavigation}
          </AutoHideNavigation>
        )}
        {activeScans.length > 0 && (
          <div className="scan-capsule">
            <LoaderCircle size={12} className="spin" />
            <span>{activeScans[0].processed}</span>
            <button
              aria-label="取消扫描"
              onClick={() =>
                void act(() =>
                  window.media.cancelScan(activeScans[0].libraryId),
                )
              }
            >
              <X size={12} />
            </button>
          </div>
        )}
        {media.error && media.total > 0 && (
          <button
            className="page-retry"
            onClick={() => {
              media.source.retry();
              void media.source.ensure([media.anchorIndex]);
            }}
          >
            部分媒体未能载入，重试
          </button>
        )}
        {navigationRetry && (
          <button
            className="page-retry"
            onClick={() => navigate(navigationRetry)}
          >
            页面未能载入，重试
          </button>
        )}
      </div>
      {contextMenu && (
        <div
          className="context-dismiss"
          onMouseDown={() => setContextMenu(null)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="media-context-menu"
            role="menu"
            aria-label="文件操作"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[role=menuitem]",
                ),
              ];
              const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              buttons[
                (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                  buttons.length
              ]?.focus();
            }}
          >
            <div className="context-heading">{contextMenu.item.title}</div>
            {scope.view === "recent" && (
              <button
                role="menuitem"
                onClick={() => {
                  const item = contextMenu.item;
                  setContextMenu(null);
                  void removeRecent(item).catch(report);
                }}
              >
                <X size={15} />
                <span>从历史记录移除</span>
              </button>
            )}
            {contextMenu.item.type === "music" && !contextMenu.item.kind && (
              <>
                {[true, false].map((next) => (
                  <button
                    key={String(next)}
                    role="menuitem"
                    onClick={() => {
                      const p = usePlayback.getState(),
                        item = contextMenu.item;
                      const ids = p.queueIds.filter((id) => id !== item.id);
                      ids.splice(
                        next
                          ? Math.max(0, ids.indexOf(p.track?.id ?? "") + 1)
                          : ids.length,
                        0,
                        item.id,
                      );
                      usePlayback.setState({
                        queue: [
                          ...p.queue.filter((row) => row.id !== item.id),
                          item,
                        ],
                      });
                      p.setQueueIds(ids);
                      setContextMenu(null);
                    }}
                  >
                    <List size={15} />
                    <span>{next ? "下一首播放" : "添加到播放队列"}</span>
                  </button>
                ))}
              </>
            )}
            {focusedCount === 1 && (
              <button
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  void open(contextMenu.item, contextMenu.index);
                }}
              >
                {contextMenu.item.kind === "folder" ? (
                  <FolderOpen size={15} />
                ) : (
                  <ArrowUpRight size={15} />
                )}
                <span>
                  {contextMenu.item.kind === "folder"
                    ? "进入文件夹"
                    : "应用内打开"}
                </span>
              </button>
            )}
            {focusedCount === 1 && !isRemote(contextMenu.item) && (
              <button
                role="menuitem"
                onClick={() => {
                  const item = contextMenu.item;
                  setContextMenu(null);
                  void window.media.openExternal(item.id).catch(report);
                }}
              >
                <ExternalLink size={15} />
                <span>
                  {contextMenu.item.kind === "folder" ||
                  contextMenu.item.ext === "folder"
                    ? "在资源管理器中打开"
                    : "使用系统默认程序打开"}
                </span>
              </button>
            )}
            {!isRemote(contextMenu.item) && (
              <>
                <button role="menuitem" onClick={() => void copyFocused()}>
                  <Copy size={15} />
                  <span>
                    {contextMenu.item.kind === "folder"
                      ? "复制文件夹"
                      : "复制文件"}
                  </span>
                  <kbd>Ctrl+C</kbd>
                </button>
                <button role="menuitem" onClick={() => void copyFocused(true)}>
                  <Copy size={15} />
                  <span>复制路径</span>
                </button>
                {focusedCount === 1 && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      const id = contextMenu.item.id;
                      setContextMenu(null);
                      void window.media.reveal(id).catch(report);
                    }}
                  >
                    <FolderOpen size={15} />
                    <span>
                      {contextMenu.item.kind === "folder" ||
                      contextMenu.item.ext === "folder"
                        ? "定位文件夹"
                        : "在资源管理器中显示"}
                    </span>
                  </button>
                )}
                {focusedCount === 1 && !isProtectedRoot(contextMenu.item) && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setRenameItem(contextMenu.item);
                      setRenameValue(renameBaseName(contextMenu.item));
                      setContextMenu(null);
                    }}
                  >
                    <Pencil size={15} />
                    <span>重命名</span>
                    <kbd>F2</kbd>
                  </button>
                )}
              </>
            )}
            {focusedCount === 1 && !contextMenu.item.kind && (
              <button
                role="menuitem"
                onClick={() => {
                  favorite(contextMenu.item);
                  setContextMenu(null);
                }}
              >
                <Heart size={15} />
                <span>{contextMenu.item.favorite ? "取消收藏" : "收藏"}</span>
              </button>
            )}
            <div className="context-separator" />
            {!isRemote(contextMenu.item) &&
              !isProtectedRoot(contextMenu.item) && (
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => void openTrashConfirmation()}
                >
                  <Trash2 size={15} />
                  <span>移到回收站</span>
                  <kbd>Delete</kbd>
                </button>
              )}
          </div>
        </div>
      )}
      {renameItem && (
        <Modal
          title="重命名"
          close={() => setRenameItem(null)}
          className="rename-modal"
        >
          <form
            className="rename-form"
            onSubmit={(event) => void submitRename(event)}
          >
            <label htmlFor="rename-entry">新名称</label>
            <input
              id="rename-entry"
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setRenameItem(null)}
              >
                取消
              </button>
              <button className="button primary" type="submit">
                保存
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {trashOpen && (
        <Modal
          title="移到回收站？"
          close={() => setTrashOpen(false)}
          className="confirm-modal"
        >
          <div className="confirm-content">
            <Trash2 size={20} />
            <div>
              <p>
                将所选 {focusedCount}{" "}
                项移到系统回收站。文件夹会连同其中全部内容一起移动。
              </p>
              <ul>
                {trashPreview.map((entry, index) => (
                  <li key={`${entry.title}:${index}`}>
                    <span>
                      {entry.isDirectory ? <Folder size={13} /> : null}
                      {entry.title}
                    </span>
                    <small>
                      {entry.isDirectory ? "文件夹及其内容" : "文件"}
                    </small>
                  </li>
                ))}
              </ul>
              {focusedCount > trashPreview.length && (
                <small>以及其他 {focusedCount - trashPreview.length} 项</small>
              )}
            </div>
          </div>
          <footer>
            <button
              className="button secondary"
              onClick={() => setTrashOpen(false)}
            >
              取消
            </button>
            <button
              className="button danger-button"
              onClick={() => void trashFocused().catch(report)}
            >
              移到回收站
            </button>
          </footer>
        </Modal>
      )}
      <MusicQuickPanel
        scope={scope}
        navigate={navigate}
        libraries={libraries}
      />
      <Player
        browseMusic={navigate}
        closeUI={closeSurface}
        closeDetail={() =>
          closeSurface(() => usePlayback.setState({ expanded: false }))
        }
      />
      {clearHistoryOpen && (
        <Modal
          title="清空历史记录？"
          className="confirm-modal"
          close={() => {
            setClearHistoryOpen(false);
          }}
        >
          <p className="confirm-content">
            清空全部最近打开记录，保留文件、收藏、书签和阅读进度。
          </p>
          <footer>
            <button
              className="button secondary"
              disabled={historyBusy}
              onClick={() => setClearHistoryOpen(false)}
            >
              取消
            </button>
            <button
              className="button danger-button"
              disabled={historyBusy}
              onClick={async () => {
                setHistoryBusy(true);
                try {
                  const result = await window.media.clearRecent();
                  setClearHistoryOpen(false);
                  useApp
                    .getState()
                    .notify(`已清空 ${result.cleared} 条历史记录`);
                  if (result.errors.length)
                    report(new Error(result.errors.join("；")));
                } catch (error) {
                  report(error);
                } finally {
                  setHistoryBusy(false);
                }
              }}
            >
              确认清空
            </button>
          </footer>
        </Modal>
      )}
      {musicPreview && (
        <div className="music-stage music-detail-preview">
          <header>
            <button
              className="back-button"
              onClick={() => closeSurface(() => setMusicPreview(null))}
            >
              <ChevronLeft />
              返回
            </button>
          </header>
          <Cover item={musicPreview} />
          <h1>{musicPreview.title}</h1>
          <p>{musicPreview.artist}</p>
          <button
            className="button primary"
            onClick={() => {
              usePlayback.getState().play(musicPreview);
              setMusicPreview(null);
              usePlayback.setState({ expanded: true, queueVisible: false });
            }}
          >
            播放此曲
          </button>
        </div>
      )}
      {viewer && (
        <Viewer
          item={viewer.item}
          passive={viewer.historyRestore}
          items={viewer.source?.cachedItems() ?? loadedItems}
          close={closeViewer}
          switchItem={(item) =>
            setViewer({ ...viewer, item, historyRestore: false })
          }
          navigation={
            viewer.source
              ? {
                  index: viewer.index,
                  total: viewer.source.total,
                  step: stepViewer,
                }
              : undefined
          }
        />
      )}
      {overlay === "libraries" && (
        <Modal title="媒体库" close={closeOverlay} className="library-picker">
          <div className="library-picker-list">
            {TYPES.filter(
              (type) => !currentType || type.id === currentType,
            ).map((type) => {
              const members = libraries.filter((lib) => lib.type === type.id);
              return members.length ? (
                <section key={type.id}>
                  <h3>{type.name}</h3>
                  {members.map((lib) => (
                    <div className="library-choice" key={lib.id}>
                      <button
                        onClick={() =>
                          navigate({ view: "library", libraryId: lib.id })
                        }
                      >
                        <type.icon size={18} />
                        <span>{lib.name}</span>
                        {scope.libraryId === lib.id && <Check size={14} />}
                      </button>
                      <IconButton
                        label={`管理 ${lib.name}`}
                        onClick={() => {
                          setOverlay(null);
                          setManage(lib);
                        }}
                      >
                        <MoreHorizontal size={16} />
                      </IconButton>
                    </div>
                  ))}
                </section>
              ) : null;
            })}
          </div>
          <footer>
            <button
              className="text-button"
              onClick={() => {
                setOverlay(null);
                setCreateType(currentType ?? "image");
              }}
            >
              <Plus size={15} />
              添加媒体库
            </button>
            <span className="spacer" />
            {activeLibrary && (
              <IconButton
                label="重新扫描媒体库"
                disabled={scans[activeLibrary.id]?.status === "scanning"}
                onClick={() =>
                  void act(() => window.media.scan(activeLibrary.id))
                }
              >
                <RefreshCw size={16} />
              </IconButton>
            )}
          </footer>
        </Modal>
      )}
      {overlay === "layout" && (
        <Modal title="显示方式" close={closeOverlay} className="layout-picker">
          <div className="layout-options">
            {LAYOUTS.filter((layout) =>
              supportedLayouts(currentType).includes(layout.id),
            ).map((layout) => (
              <button
                key={layout.id}
                className={`layout-option ${memory.layout === layout.id ? "selected" : ""}`}
                aria-label={`切换到${layout.label}`}
                onClick={() => changeLayout(layout.id)}
              >
                <span className={`layout-preview preview-${layout.id}`}>
                  {Array.from({ length: 7 }, (_, index) => (
                    <i key={index} />
                  ))}
                </span>
                <span>{layout.label}</span>
                {memory.layout === layout.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {overlay === "search" && (
        <Modal title="搜索" close={closeOverlay} className="search-panel">
          <div className="search-field">
            <Search size={17} />
            <input
              ref={searchInput}
              aria-label="搜索媒体"
              autoFocus
              placeholder={remoteMusic ? "搜索歌曲" : "搜索媒体"}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setSearchTerm(search.trim());
                  setOverlay(null);
                }
              }}
            />
            {search && (
              <IconButton
                label="清除搜索内容"
                onClick={() => {
                  setSearch("");
                  setSearchTerm("");
                }}
              >
                <X size={14} />
              </IconButton>
            )}
          </div>
          {searchTerm && (
            <div className="search-results">
              {loadedItems.slice(0, 8).map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    const index = loadedItems.indexOf(item);
                    setOverlay(null);
                    void open(item, index);
                  }}
                >
                  <Cover item={item} />
                  <span>{item.title}</span>
                  <small>{typeInfo(item.type).name}</small>
                </button>
              ))}
              {!media.total && <p>没有匹配的媒体</p>}
            </div>
          )}
          <footer>
            <span className="muted">
              {activeLibrary
                ? activeLibrary.name
                : remoteMusic
                  ? scope.musicSource === "navidrome"
                    ? "Navidrome"
                    : "当前在线音乐"
                  : "全部媒体"}
              {searchTerm ? ` · ${media.total} 项` : ""}
            </span>
            <span className="spacer" />
            <button
              className="text-button"
              onClick={() => {
                setSearchTerm(search.trim());
                setOverlay(null);
              }}
            >
              查看结果
            </button>
          </footer>
        </Modal>
      )}
      {overlay === "folders" && (
        <Modal title="文件夹" close={closeOverlay} className="folder-picker">
          <div className="folder-choices">
            {folders.length ? (
              folders.map((folder) => (
                <button
                  key={folder.path}
                  title={folder.path}
                  onClick={() =>
                    navigate({
                      view: "folders",
                      libraryId: scope.libraryId,
                      folder: folder.path,
                    })
                  }
                >
                  <FolderOpen size={16} />
                  <span>{folder.path}</span>
                  <small>{folder.count}</small>
                </button>
              ))
            ) : (
              <p className="muted">暂无文件夹</p>
            )}
          </div>
        </Modal>
      )}
      {overlay === "settings" && (
        <SettingsPanel
          close={closeOverlay}
          section={settingsSection}
          onSectionChange={setSettingsSection}
        />
      )}
      {createType && (
        <LibraryModal
          initialType={createType}
          onSaved={(lib) => {
            setCreateType(null);
            navigate({ view: "library", libraryId: lib.id, type: lib.type });
          }}
          close={() => closeSurface(() => setCreateType(null))}
        />
      )}
      {manage && (
        <LibraryModal
          library={manage}
          close={() => closeSurface(() => setManage(null))}
        />
      )}
      {toast && (
        <div className={`toast ${toastKind}`} role="status">
          <span>{toast}</span>
          <button
            aria-label="关闭提示"
            onClick={() => useApp.setState({ toast: "" })}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
