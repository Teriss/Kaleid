import { normalizeLayout, supportedLayouts } from "./layouts/policy";
import HorizontalGallery from "./layouts/HorizontalGallery";
import VideoExportTasks from "./VideoExportTasks";
import VideoPlayer from "./VideoPlayer";
import ComicLibraryPanel from "./ComicLibraryPanel";
import OnlineComics from "./OnlineComics";
import OnlineNovels from "./OnlineNovels";
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
  BookmarkPlus,
  Check,
  Copy,
  ChevronLeft,
  ChevronRight,
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
  Disc3,
  Clapperboard,
  Images,
} from "lucide-react";
import {
  ParentNavigationStack,
  SuspendedSearchSessions,
  containsSingleSourceSearch,
  hasSingleSourceSearch,
  leavesAggregateReadingSearch,
  parentLibraryLocation,
  readingHubHomeLocation,
  type NavigationSnapshot,
  type NavigationMode,
  type NavigationSurface,
  type ReadingSearchView,
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
  availableScope,
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
import { singleCollectionMedia } from "./layouts/collectionActivation";
import { isPlaybackSpaceShortcut } from "./playbackSpace";
import BravaisWall from "./layouts/BravaisWall";
import SpatialGrid from "./layouts/SpatialGrid";
import LibraryCarousel from "./layouts/LibraryCarousel";
import StandardGrid from "./layouts/StandardGrid";
import ArchiveShelf from "./layouts/ArchiveShelf";
import RecordCrate from "./layouts/RecordCrate";
import ScreeningRoom from "./layouts/ScreeningRoom";
import PhotoLightbox from "./layouts/PhotoLightbox";
import Player from "./Player";
import AutoHideNavigation from "./components/AutoHideNavigation";
import WindowTitleBar from "./components/WindowTitleBar";
import { ContentNavigationContext } from "./layouts/ContentNavigation";
import MusicQuickPanel from "./music/MusicQuickPanel";
import useMusicWallFilter from "./music/useMusicWallFilter";
import MusicSources from "./music/MusicSources";
import WallMenu, { openWallSearch } from "./layouts/WallMenu";
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
import AppUpdatePrompt from "./AppUpdatePrompt";
import useBrowseTransition from "./layouts/useBrowseTransition";
import {
  hideVideo,
  startVideo,
  stopVideo,
  useVideoSession,
} from "./videoSession";

const LAYOUTS = [
  { id: "bravais", label: "Bravais 墙面", icon: PanelsTopLeft },
  { id: "spatial", label: "空间网格", icon: Layers3 },
  { id: "grid", label: "标准网格", icon: Grid2X2 },
  { id: "gallery", label: "等高画廊", icon: Grid2X2 },
  { id: "verticalGallery", label: "等宽画廊", icon: Grid2X2 },
  { id: "carousel", label: "封面流", icon: List },
  { id: "archiveShelf", label: "立体书架", icon: Layers3 },
  { id: "recordCrate", label: "唱片箱", icon: Disc3 },
  { id: "screeningRoom", label: "放映厅", icon: Clapperboard },
  { id: "photoLightbox", label: "摄影灯箱", icon: Images },
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
interface CardVideoSession {
  id: string;
  item: MediaItem;
  anchorId: string;
  expanded: boolean;
  origin: string;
}

export default function App() {
  const { libraries, scans, settings, revision, toast, toastKind } = useApp();
  const [scope, setScope] = useState<BrowseScope>(
    () => readLastScope() ?? { view: "type", type: "image" },
  );
  const scopeRef = useRef(scope);
  const backRef = useRef<() => void>(() => {});
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
  const parents = useRef(new ParentNavigationStack());
  const suspendedSearches = useRef(new SuspendedSearchSessions());
  const parentStackRollback = useRef<NavigationSnapshot[] | null>(null);
  const restoringNavigation = useRef(false);
  const surfaces = useRef<NavigationSurface[]>([]);
  const navigationSerial = useRef(0);
  const typeNavigationSerial = useRef(0);
  const mediaOpenSerial = useRef(0);
  const closeSurfaceRef = useRef<() => void>(() => {});
  const [createType, setCreateType] = useState<MediaType | null>(null);
  const [manage, setManage] = useState<Library | null>(null);
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [viewer, setViewer] = useState<ViewerSession | null>(null);
  const presentationSnapshot = useRef<NavigationSnapshot | null>(null);
  const [videoPlayback, setVideoPlayback] = useState<{
    item: MediaItem;
    sort: "name" | "added" | "recent";
  } | null>(null);
  const [videoPiPReason, setVideoPiPReason] = useState<
    "manual" | "automatic"
  >();
  const [cardVideo, setCardVideo] = useState<CardVideoSession | null>(null);
  const cardVideoRef = useRef(cardVideo);
  cardVideoRef.current = cardVideo;
  const cardRequest = useRef(0);
  const inlineMusicAnchor = useRef<
    { anchorId: string; mediaId: string } | undefined
  >(undefined);
  const inlineVideo = viewer?.item.type === "video" ? viewer.item : undefined;
  const activeVideo =
    cardVideo && !cardVideo.expanded
      ? undefined
      : (inlineVideo ?? videoPlayback?.item);
  useEffect(() => {
    if (inlineVideo) setVideoPlayback({ item: inlineVideo, sort: memory.sort });
  }, [inlineVideo]);
  const [comicOrganizer, setComicOrganizer] = useState<
    MediaItem | null | undefined
  >(undefined);
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
  const [trashPreview, setTrashPreview] = useState<
    { title: string; isDirectory: boolean }[]
  >([]);
  const [trashTargetIds, setTrashTargetIds] = useState<string[]>([]);
  const [trashTargetPaths, setTrashTargetPaths] = useState<string[]>([]);
  const playerExpanded = usePlayback((state) => state.expanded);
  const playingTrack = usePlayback((state) => state.track);
  // Queue/transport changes update the player, not the detail destination
  // that was explicitly opened by the user.
  const musicDestination = useRef<{ open: boolean; id?: string }>({
    open: false,
  });
  if (!playerExpanded) musicDestination.current.open = false;
  else if (!musicDestination.current.open)
    musicDestination.current = { open: true, id: playingTrack?.id };
  const queueVisible = usePlayback((state) => state.queueVisible);
  const matchOpen = usePlayback((state) => state.matchOpen);
  const activeLibrary = libraries.find((lib) => lib.id === scope.libraryId);
  const previousNormal = readLastNormalScope();
  const previousLibrary = libraries.find(
    (lib) => lib.id === previousNormal?.libraryId,
  );
  const previousType =
    (previousNormal?.type as MediaType | undefined) ?? previousLibrary?.type;
  const currentType = ["type", "libraries", "music", "comic", "novel"].includes(
    scope.view,
  )
    ? (scope.type as MediaType)
    : (activeLibrary?.type ??
      (scope.view === "favorites" || scope.view === "recent"
        ? ((scope.type as MediaType | undefined) ?? previousType)
        : undefined));
  const layoutMediaType = scope.view === "novel"
    ? "novel"
    : scope.view === "comic"
      ? "comic"
      : currentType;
  const layoutsForView = supportedLayouts(layoutMediaType).filter((layout) =>
    scope.view === "novel" || scope.view === "comic"
      ? ["grid", "archiveShelf", "carousel"].includes(layout)
      : ["recordCrate", "screeningRoom", "photoLightbox"].includes(layout)
        ? !["favorites", "recent"].includes(scope.view) ||
          Boolean(scope.localOnly)
        : layout !== "archiveShelf" ||
          Boolean(scope.type) ||
          scope.view === "library",
  );
  useLayoutEffect(() => {
    const readingHub = scope.view === "novel" || scope.view === "comic";
    const layout = readingHub
      ? layoutsForView.includes(memoryRef.current.layout)
        ? memoryRef.current.layout
        : "grid"
      : normalizeLayout(
          memoryRef.current.layout,
          !layoutsForView.includes(memoryRef.current.layout)
            ? "mixed"
            : (currentType ?? "mixed"),
        );
    if (layout !== memoryRef.current.layout) {
      memoryRef.current = { ...memoryRef.current, layout };
      setMemory(memoryRef.current);
    }
  }, [currentType, scope, memory.layout]);
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
          ? scope.localOnly
            ? currentType
            : undefined
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
              scope.localOnly
                ? window.media.query(q)
                : specialPage(scope.view as "favorites" | "recent", q)
          : scope.view === "libraries" ||
              scope.view === "comic" ||
              scope.view === "novel"
            ? async () => ({ items: [], total: 0 })
            : undefined,
    [key],
  );
  const media = useMediaSource(query, revision, memoryRef.current, fetchMusic);
  const wallView =
    scope.view !== "comic" &&
    scope.view !== "novel" &&
    memory.layout === "bravais";
  const musicWall = currentType === "music" && wallView;
  const wallFilter = useMusicWallFilter(
    media.source,
    `${key}:${searchTerm}`,
    wallView,
    () => memoryRef.current,
    (patch) => remember(patch),
  );
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
      if (event.button === 3) backRef.current();
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
      if (event.key === "ArrowLeft") backRef.current();
    };
    window.addEventListener("mousedown", mouseDown, true);
    window.addEventListener("mouseup", mouseUp, true);
    window.addEventListener("keydown", keyboard, true);
    const videoNavigate = (event: Event) => {
      if ((event as CustomEvent).detail === "back") backRef.current();
    };
    window.addEventListener("video:navigate", videoNavigate);
    return () => {
      window.removeEventListener("mousedown", mouseDown, true);
      window.removeEventListener("mouseup", mouseUp, true);
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("video:navigate", videoNavigate);
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
  const remember = useCallback(
    (patch: Partial<BrowseMemory>) => {
      if (scopeKey(scopeRef.current) !== key) return;
      memoryRef.current = { ...memoryRef.current, ...patch };
      saveMemory(scope, patch);
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
          last?.view === "novel" ||
          last?.view === "libraries" ||
          last?.view === "favorites"
        )
          navigate(last, false);
        else
          await activateType(
            (last?.type as MediaType | undefined) ??
              (readLastNormalScope()?.type as MediaType | undefined) ??
              libs[0]?.type ??
              "image",
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
        setCardVideo((current) => {
          if (!current) return current;
          if (change.removedIds.includes(current.item.id)) {
            void stopVideo(current.id).catch(report);
            cardVideoRef.current = null;
            return null;
          }
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
    mode: NavigationMode = "root",
  ) {
    if (next.view === "recent")
      next = { view: "type", type: next.type ?? currentType ?? "image" };
    if (cardVideoRef.current && !cardVideoRef.current.expanded)
      stopCardPlayback();
    next = availableScope(next);
    if (inlineVideo) {
      if (!settings.videoAutoPictureInPicture) setVideoPlayback(null);
      else setVideoPiPReason("automatic");
    }
    presentationSnapshot.current = null;
    ++typeNavigationSerial.current;
    if (!restoring) {
      ++navigationSerial.current;
      restoringNavigation.current = false;
    }
    const resolved: BrowseScope = {
      ...next,
      type:
        next.type ??
        useApp.getState().libraries.find((lib) => lib.id === next.libraryId)
          ?.type ??
        currentType,
    };
    if (booted && !restoring && mode === "root") {
      const currentScope = scopeRef.current;
      const currentView =
        currentScope.view === "comic" || currentScope.view === "novel"
          ? currentScope.view
          : null;
      if (currentView) {
        const leavingAggregateSearch = leavesAggregateReadingSearch(
          currentScope,
          resolved,
        );
        const openingAggregateSearch =
          resolved.view === currentView &&
          resolved.section === "search" &&
          resolved.searchMode !== "single";
        if (leavingAggregateSearch || openingAggregateSearch) {
          suspendedSearches.current.clear(currentView);
        } else if (
          scopeKey(currentScope) !== scopeKey(resolved) &&
          containsSingleSourceSearch(currentScope, parents.current.snapshot())
        ) {
          suspendedSearches.current.save({
            view: currentView,
            current: snapshotRef.current(),
            parents: parents.current.snapshot(),
          });
        }
      }
    }
    if (
      booted &&
      !restoring &&
      hasSingleSourceSearch(resolved) &&
      !containsSingleSourceSearch(scopeRef.current, parents.current.snapshot())
    ) {
      suspendedSearches.current.clear(resolved.view);
    }
    const isComicDetail = (location: BrowseScope) =>
      location.view === "comic" &&
      Boolean(location.remoteId) &&
      location.remoteKind !== "chapter";
    if (booted && (isComicDetail(scopeRef.current) || isComicDetail(resolved)))
      browseTransition.cancel();
    else if (booted)
      browseTransition.start(
        snapshotRef.current(),
        resolved,
        readMemory(resolved).layout,
      );
    if (booted && !restoring) {
      const scopeChanged = scopeKey(resolved) !== scopeKey(scopeRef.current);
      if (scopeChanged && !parentStackRollback.current)
        parentStackRollback.current = parents.current.snapshot();
      if (mode === "root") parents.current.reset();
      else if (mode === "push" && scopeChanged)
        parents.current.push(snapshotRef.current());
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
  useEffect(() => {
    if (!browseTransition.pending) return;
    let frame = 0,
      live = true,
      recovering = false;
    const poll = () => {
      if (!live) return;
      if (media.errorCode === "auth-required" || (wallView && media.error)) {
        browseTransition.cancel();
        return;
      }
      if (media.error && !recovering) {
        recovering = true;
        const previous = browseTransition.previous(),
          target = browseTransition.target();
        if (parentStackRollback.current) {
          parents.current.restore(parentStackRollback.current);
          parentStackRollback.current = null;
        }
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
      if (media.ready)
        void browseTransition.reveal().then(() => {
          parentStackRollback.current = null;
        });
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
    wallView,
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
  function toggleSpecial(view: "favorites") {
    if (scope.view === view) returnToPrevious();
    else navigate({ view });
  }
  function popParentPage() {
    const home = readingHubHomeLocation(scopeRef.current);
    if (home) {
      navigate(home, true, false, "root");
      return true;
    }
    if (!parentStackRollback.current)
      parentStackRollback.current = parents.current.snapshot();
    const parent = parents.current.pop();
    if (parent) {
      void restoreEntry(parent).catch(report);
      return true;
    }
    const parentScope = parentLibraryLocation(
      scopeRef.current,
      libraries.find((lib) => lib.id === scopeRef.current.libraryId)?.roots,
    );
    if (!parentScope) {
      parentStackRollback.current = null;
      return false;
    }
    const current = snapshotRef.current();
    void restoreEntry({
      ...current,
      surfaceStack: [],
      scope: parentScope,
      memory: readMemory(parentScope),
      search: "",
      overlay: null,
      viewer: undefined,
      musicDetailId: undefined,
      musicExpanded: false,
      queueOpen: false,
      matchOpen: false,
      createType: null,
      manageId: undefined,
    }).catch(report);
    return true;
  }
  function resumeSearch(view: ReadingSearchView) {
    const session = suspendedSearches.current.take(view);
    if (!session) return false;
    void restoreEntry(session.current)
      .then(() => {
        parents.current.restore(session.parents);
        parentStackRollback.current = null;
      })
      .catch(report);
    return true;
  }
  function goParent() {
    popParentPage();
  }
  function changeLayout(layout: MediaLayout) {
    if (cardVideoRef.current && !cardVideoRef.current.expanded)
      stopCardPlayback();
    if (!layoutsForView.includes(layout)) return;
    ++mediaOpenSerial.current;
    browseTransition.start(snapshotRef.current(), scope, layout);
    remember({ layout });
    setMemory({ ...memoryRef.current, layout });
    setOverlay(null);
  }
  function changeSort(sort: BrowseMemory["sort"]) {
    if (cardVideoRef.current && !cardVideoRef.current.expanded)
      stopCardPlayback();
    ++mediaOpenSerial.current;
    remember({ sort, focusId: undefined, focusIndex: 0, scrollTop: 0 });
    setMemory({ ...memoryRef.current, sort });
  }
  async function open(
    item: MediaItem,
    index: number,
    onlySingle = false,
  ): Promise<boolean | undefined> {
    const request = ++mediaOpenSerial.current;
    const navigation = navigationSerial.current;
    const typeNavigation = typeNavigationSerial.current;
    const live = () =>
      request === mediaOpenSerial.current &&
      navigation === navigationSerial.current &&
      typeNavigation === typeNavigationSerial.current;
    presentationSnapshot.current = null;
    if (item.missing) {
      useApp.getState().notify("文件不可用，请检查来源文件夹", "error");
      return true;
    }
    remember({ focusId: item.id, focusIndex: index });
    if (item.kind) {
      const destination: BrowseScope =
        item.kind === "collection"
          ? collectionLocation(item)
          : {
              view: "library",
              libraryId: scope.libraryId ?? item.libraryIds[0],
              type: item.type,
              folder: item.path,
            };
      try {
        const single = await singleCollectionMedia(item, (entry) =>
          entry.kind === "folder"
            ? window.media.query({
                libraryId: destination.libraryId,
                type: entry.type,
                folder: entry.path,
                browse: true,
                sort: memory.sort,
                limit: 2,
              })
            : musicPage(destination, { type: "music", offset: 0, limit: 100 }),
        );
        if (!live()) return;
        if (single)
          await openMedia(
            single,
            0,
            {
              scope: destination,
              query: {
                libraryId: destination.libraryId,
                type: single.type,
                folder: single.folder,
                sort: memory.sort,
              },
              items: [single],
              queueIds: [single.id],
            },
            live,
          );
        else if (onlySingle) return false;
        else navigate(destination, true, false, "push");
      } catch (error) {
        if (live()) report(error);
      }
      if (onlySingle && !live()) return;
      return true;
    }
    await openMedia(
      item,
      index,
      { scope, query, items: media.source.cachedItems() },
      live,
    );
    return true;
  }
  async function openFolderChoice(folder: string) {
    const request = ++mediaOpenSerial.current;
    const navigation = navigationSerial.current;
    const typeNavigation = typeNavigationSerial.current;
    const live = () =>
      request === mediaOpenSerial.current &&
      navigation === navigationSerial.current &&
      typeNavigation === typeNavigationSerial.current;
    try {
      const result = await window.media.query({
        libraryId: scope.libraryId,
        folder,
        sort: memory.sort,
        limit: 2,
      });
      if (!live()) return;
      if (
        result.total === 1 &&
        result.items.length === 1 &&
        !result.items[0].kind
      ) {
        const item = result.items[0];
        presentationSnapshot.current = null;
        setOverlay(null);
        await openMedia(
          item,
          0,
          {
            scope,
            query: {
              libraryId: scope.libraryId,
              type: item.type,
              folder: item.folder,
              sort: memory.sort,
            },
            items: [item],
            queueIds: [item.id],
          },
          live,
        );
      } else
        navigate(
          { view: "folders", libraryId: scope.libraryId, folder },
          true,
          false,
          "push",
        );
    } catch (error) {
      if (live()) report(error);
    }
  }
  async function openMedia(
    item: MediaItem,
    index: number,
    origin: {
      scope: BrowseScope;
      query: MediaQuery;
      items: MediaItem[];
      queueIds?: string[];
    },
    live: () => boolean,
  ) {
    if (cardVideoRef.current && !cardVideoRef.current.expanded)
      stopCardPlayback();
    if (item.type === "music") {
      musicDestination.current = { open: true, id: item.id };
      if (viewer?.item.type === "video") setViewer(null);
      setMusicPreview(null);
      const playback = usePlayback.getState();
      if (playback.track?.id !== item.id) playback.play(item, origin.items);
      usePlayback.setState({ expanded: true, queueVisible: false });
      void (
        origin.queueIds
          ? Promise.resolve(origin.queueIds)
          : origin.scope.view === "music"
            ? stableQueue(origin.scope, origin.query.search ?? "")
            : window.media.musicQueueIds(origin.query)
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
        ...origin.query,
        browse: false,
        type: "image",
        folder: item.folder,
      });
      await source.initialize(item.id);
      if (!live()) {
        source.dispose();
        return;
      }
      setViewer({
        item,
        index: source.getSnapshot().anchorIndex,
        source,
        historyRestore: true,
      });
    } else setViewer({ item, index });
  }
  async function resolveSingleForLayout(entry: MediaItem) {
    if (entry.kind !== "folder") return;
    const navigation = navigationSerial.current,
      typeNavigation = typeNavigationSerial.current;
    const single = await singleCollectionMedia(entry, (child) =>
      child.kind === "folder"
        ? window.media.query({
            libraryId: scope.libraryId ?? child.libraryIds[0],
            type: child.type,
            folder: child.path,
            browse: true,
            sort: memory.sort,
            limit: 2,
          })
        : musicPage(collectionLocation(child), {
            type: "music",
            offset: 0,
            limit: 2,
          }),
    );
    return navigation === navigationSerial.current &&
      typeNavigation === typeNavigationSerial.current
      ? single
      : undefined;
  }
  function stopCardPlayback(keepControls = false) {
    ++cardRequest.current;
    const current = cardVideoRef.current;
    if (!current) return;
    void hideVideo(current.id);
    if (keepControls) {
      // Keep the captured control window alive until the drag is released.
      void window.video
        .command(current.id, { type: "pause", value: true })
        .catch(() => {});
      return;
    }
    void stopVideo(current.id).catch(report);
    if (!keepControls) {
      cardVideoRef.current = null;
      setCardVideo(null);
      setVideoPlayback(null);
    }
  }
  function expandCardPlayback() {
    const current = cardVideoRef.current;
    if (!current || useVideoSession.getState().id !== current.id) return;
    void hideVideo(current.id);
    cardVideoRef.current = { ...current, expanded: true };
    setCardVideo(cardVideoRef.current);
    setViewer({ item: current.item, index: 0 });
  }
  function returnToCard() {
    const current = cardVideoRef.current;
    if (
      !current ||
      current.origin !== `${scopeKey(scope)}:${memory.layout}` ||
      current.item.id !== activeVideo?.id ||
      useVideoSession.getState().id !== current.id
    )
      return false;
    void hideVideo(current.id);
    cardVideoRef.current = { ...current, expanded: false };
    setCardVideo(cardVideoRef.current);
    setViewer(null);
    setVideoPlayback(null);
    setVideoPiPReason(undefined);
    void window.video
      .command(current.id, { type: "pause", value: false })
      .catch(report);
    return true;
  }
  async function playInline(item: MediaItem, index: number, anchor: MediaItem) {
    if (item.missing) {
      useApp.getState().notify("文件不可用，请检查来源文件夹", "error");
      return;
    }
    remember({ focusId: anchor.id, focusIndex: index });
    if (item.type === "music") {
      const state = usePlayback.getState();
      inlineMusicAnchor.current = { anchorId: anchor.id, mediaId: item.id };
      if (state.track?.id === item.id) state.toggle();
      else {
        state.play(
          item,
          media.source.cachedItems().filter((entry) => !entry.kind),
        );
        const queue = anchor.kind
          ? Promise.resolve([item.id])
          : scope.view === "music"
            ? stableQueue(scope, query.search ?? "")
            : window.media.musicQueueIds(query);
        void queue
          .then((ids) => {
            if (usePlayback.getState().track?.id === item.id)
              usePlayback.getState().setQueueIds(ids);
          })
          .catch(report);
      }
      return;
    }
    const previous = cardVideoRef.current;
    if (
      previous?.item.id === item.id &&
      useVideoSession.getState().id === previous.id &&
      useVideoSession.getState().state?.status !== "error"
    ) {
      const state = useVideoSession.getState().state;
      await window.video
        .command(previous.id, { type: "pause", value: !state?.paused })
        .catch(report);
      return;
    }
    if (previous) stopCardPlayback();
    setViewer(null);
    setVideoPlayback(null);
    const request = ++cardRequest.current,
      id = crypto.randomUUID();
    const started = startVideo(item, true, false, id, "card");
    const value = {
      id,
      item,
      anchorId: anchor.id,
      expanded: false,
      origin: `${scopeKey(scope)}:${memory.layout}`,
    };
    cardVideoRef.current = value;
    setCardVideo(value);
    try {
      await started;
    } catch (error) {
      if (request === cardRequest.current) {
        stopCardPlayback();
        report(error);
      }
    }
  }
  useEffect(() => {
    const current = cardVideoRef.current;
    if (
      current &&
      !current.expanded &&
      current.origin !== `${key}:${memory.layout}`
    )
      stopCardPlayback();
  }, [key, memory.layout]);
  const closeViewerDirect = useCallback(() => {
    setViewer((current) => {
      current?.source?.dispose();
      return null;
    });
    useApp.getState().touch();
  }, []);
  function closeSurface(fallback: () => void) {
    fallback();
    const active = snapshotRef.current().surfaceStack ?? [];
    surfaces.current = surfaces.current.filter((surface) =>
      active.includes(surface),
    );
  }
  closeSurfaceRef.current = () => {
    if (usePlayback.getState().queueVisible) {
      usePlayback.setState({ queueVisible: false });
      return;
    }
    if (usePlayback.getState().matchOpen) {
      usePlayback.setState({ matchOpen: false });
      return;
    }
    closeSurface(() => {
      setMusicPreview(null);
      usePlayback.setState({ expanded: false });
    });
  };
  const closeViewer = () => closeSurface(closeViewerDirect);
  function closeOverlay() {
    ++mediaOpenSerial.current;
    if (overlay === "layout") {
      setOverlay(null);
      return;
    }
    closeSurface(() => setOverlay(null));
  }
  async function activateType(type: MediaType) {
    const serial = ++typeNavigationSerial.current;
    if (type === "novel") {
      navigate({ view: "novel", type: "novel", section: "home" });
      return;
    }
    if (type === "comic") {
      navigate({
        view: "comic",
        type: "comic",
        section: "home",
        providerId: localStorage.getItem("comic:active-source") || undefined,
      });
      return;
    }
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
  function snapshot(): NavigationSnapshot {
    window.dispatchEvent(new Event("wall:flush"));
    const active: NavigationSurface[] = [];
    if (viewer || presentationSnapshot.current?.viewer) active.push("viewer");
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
      viewer: presentationSnapshot.current
        ? presentationSnapshot.current.viewer
        : viewer
          ? { id: viewer.item.id, index: viewer.index }
          : undefined,
      musicDetailId:
        musicPreview?.id ??
        (playerExpanded ? musicDestination.current.id : undefined),
      musicExpanded: playerExpanded || Boolean(musicPreview),
      queueOpen: queueVisible,
      matchOpen,
      createType,
      manageId: manage?.id,
    };
  }
  const snapshotRef = useRef<() => NavigationSnapshot>(() => snapshot());
  snapshotRef.current = snapshot;
  useLayoutEffect(() => {
    if (
      !booted ||
      restoringNavigation.current ||
      (browseTransition.pending && !media.ready)
    )
      return;
    saveLastScope({ ...scope, search: searchTerm });
    saveLastNormalScope({ ...scope, search: searchTerm });
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
  async function restoreEntry(entry: NavigationSnapshot) {
    const serial = ++navigationSerial.current;
    restoringNavigation.current = true;
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
        sort: readMemory(next).sort,
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
      setCreateType(null);
      setManage(null);
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
              sort: restoredMemory.sort,
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
          if (usePlayback.getState().track?.id === item.id) {
            musicDestination.current = { open: true, id: item.id };
            usePlayback.setState({ expanded: true, queueVisible: false });
          } else setMusicPreview(item);
        } catch {
          useApp.getState().notify("该歌曲已不可用");
        }
      }
      surfaces.current = entry.surfaceStack ?? [];
      setOverlay(null);
      usePlayback.setState({
        queueVisible: false,
        matchOpen: false,
      });
    } finally {
      if (serial === navigationSerial.current)
        requestAnimationFrame(() => {
          restoringNavigation.current = false;
        });
    }
  }
  function goBack() {
    const dialogs =
      document.querySelectorAll<HTMLDialogElement>("dialog[open]");
    const topDialog = dialogs.item(dialogs.length - 1);
    if (topDialog) {
      topDialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      return;
    }
    if (overlay) {
      setOverlay(null);
      return;
    }
    const wallSearchClose = document.querySelector<HTMLButtonElement>(
      ".music-wall-menu.is-search button[aria-label^='关闭']",
    );
    if (wallSearchClose) {
      wallSearchClose.click();
      return;
    }
    if (createType || manage) {
      setCreateType(null);
      setManage(null);
      return;
    }
    if (matchOpen || queueVisible) {
      if (matchOpen) usePlayback.setState({ matchOpen: false });
      else usePlayback.setState({ queueVisible: false });
      return;
    }
    const platformMenu = document.querySelector<HTMLDetailsElement>(
      ".music-platform-menu[open]",
    );
    if (platformMenu) {
      platformMenu.open = false;
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
      scopeRef.current.view === "comic" &&
      scopeRef.current.remoteKind === "chapter"
    ) {
      window.dispatchEvent(new Event("comic:back"));
      return;
    }
    if (activeVideo) {
      window.dispatchEvent(new Event("video:back"));
      return;
    }
    if (viewer?.item.type === "video") {
      setVideoPlayback(null);
      closeViewer();
      return;
    }
    if (viewer) {
      closeViewer();
      return;
    }
    if (musicPreview) {
      closeSurface(() => setMusicPreview(null));
      return;
    }
    if (playerExpanded) {
      closeSurface(() => usePlayback.setState({ expanded: false }));
      return;
    }
    popParentPage();
  }
  backRef.current = goBack;
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
        goBack();
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
      : scope.view === "libraries"
        ? currentType === "comic"
          ? "本地漫画"
          : currentType === "novel"
            ? "本地小说"
            : currentType
              ? typeInfo(currentType).name
              : "媒体库"
      : scope.view === "favorites"
        ? "收藏"
        : scope.view === "recent"
          ? "最近"
          : scope.view === "folders"
            ? (scope.folder?.split(/[\\/]/).at(-1) ?? "文件夹")
            : currentType
              ? typeInfo(currentType).name
              : "全部";
  const blocked = Boolean(
    overlay ||
    createType ||
    manage ||
    viewer ||
    musicPreview ||
    playerExpanded ||
    contextMenu ||
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
      if (scope.view === "comic" || scope.view === "novel") return;
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
        if (wallView) {
          openWallSearch();
          return;
        }
        setOverlay("search");
        requestAnimationFrame(() => {
          searchInput.current?.focus();
          searchInput.current?.select();
        });
        return;
      }
      if (musicWall && !typing && event.key === "/" && !blocked) {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("wall:search", { detail: "search" }),
        );
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
        isPlaybackSpaceShortcut(event) &&
        !viewer &&
        !overlay &&
        !createType &&
        !manage &&
        !blocked &&
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
        onClick={() =>
          scope.view === "novel"
            ? navigate({ view: "novel", type: "novel", section: "shelf" })
            : scope.view === "comic"
              ? navigate({
                  view: "comic",
                  type: "comic",
                  providerId: scope.providerId,
                  section: "favorites",
                })
              : toggleSpecial("favorites")
        }
      >
        <Heart size={17} />
      </IconButton>
      <IconButton
        label="文件夹"
        active={scope.view === "folders"}
        disabled={scope.view === "comic" || scope.view === "novel"}
        onClick={() => setOverlay("folders")}
      >
        <FolderOpen size={17} />
      </IconButton>
      <IconButton
        label="搜索"
        active={Boolean(searchTerm)}
        onClick={() =>
          scope.view === "novel"
            ? resumeSearch("novel") ||
              navigate({
                view: "novel",
                type: "novel",
                section: "search",
                searchMode: "aggregate",
              })
            : scope.view === "comic"
              ? resumeSearch("comic") ||
                navigate({
                  view: "comic",
                  type: "comic",
                  providerId: scope.providerId,
                  section: "search",
                  searchMode: "aggregate",
                  remoteId: undefined,
                  remoteKind: undefined,
                  comicChapterId: undefined,
                })
              : wallView
                ? openWallSearch()
                : setOverlay("search")
        }
      >
        <Search size={17} />
      </IconButton>
      {!((scope.view === "comic" || scope.view === "novel") && scope.section === "search") && (
        <IconButton label="显示方式" onClick={() => setOverlay("layout")}>
          <Grid2X2 size={17} />
        </IconButton>
      )}
      <IconButton label="设置" onClick={() => setOverlay("settings")}>
        <Settings size={17} />
      </IconButton>
    </>
  );
  function submitWallSearch(value: string) {
    navigate(
      remoteMusic
        ? {
            ...scope,
            section: "search",
            remoteId: undefined,
            remoteKind: undefined,
            search: value,
          }
        : {
            view: scope.libraryId ? "library" : "type",
            libraryId: scope.libraryId,
            type: currentType,
            search: value,
          },
      true,
      false,
      remoteMusic ? "push" : "replace",
    );
  }
  const basicContentNavigation =
    currentType === "music" &&
    (musicWall || (scope.view !== "favorites" && scope.view !== "recent")) ? (
      <div className="content-navigation-body">
        <MusicSources
          wall={musicWall && remoteMusic}
          filter={wallFilter}
          submitSearch={submitWallSearch}
          settings={() => setOverlay("settings")}
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
      </div>
    ) : null;
  const contentNavigation =
    wallView && scope.view !== "libraries" && (!musicWall || !remoteMusic) ? (
      <div className="content-navigation-body">
        <WallMenu
          identity={key + ":" + searchTerm}
          title={title}
          music={musicWall}
          filter={wallFilter}
          submit={submitWallSearch}
        >
          <strong className="music-wall-heading">书库</strong>
          {musicWall && (
            <div
              className="music-source-tabs"
              role="group"
              aria-label="音乐来源"
            >
              <button className="active" aria-pressed="true">
                本地
              </button>
              <button
                aria-pressed="false"
                onClick={() =>
                  navigate(
                    availableScope({
                      view: "music",
                      type: "music",
                      musicSource: "online",
                      providerId:
                        localStorage.getItem("music:active-provider") ??
                        "netease",
                      section: "discover",
                    }),
                  )
                }
              >
                在线
              </button>
            </div>
          )}
          <nav className="music-wall-sections" aria-label="墙面栏目">
            <button
              aria-label="切换媒体库"
              onClick={() => setOverlay("libraries")}
            >
              {title}
            </button>
            {scope.folder && (
              <button aria-label="返回上级文件夹" onClick={goParent}>
                上一级
              </button>
            )}
            <button onClick={() => setOverlay("folders")}>文件夹</button>
            <button
              onClick={() =>
                navigate({
                  view: "favorites",
                  type: currentType,
                  localOnly: true,
                })
              }
            >
              {musicWall ? "我喜欢的音乐" : "收藏"}
            </button>
          </nav>
          <div className="music-wall-bottom">
            <select
              aria-label="排序方式"
              value={memory.sort}
              onChange={(e) =>
                changeSort(e.target.value as BrowseMemory["sort"])
              }
            >
              <option value="added">最近添加</option>
              <option value="name">名称</option>
              <option value="recent">最近打开</option>
            </select>
            {wallFilter.query && (
              <button
                aria-label="清除当前视图过滤"
                onClick={() => wallFilter.update("")}
              >
                {wallFilter.query} ×
              </button>
            )}
            {searchTerm && (
              <button
                aria-label="清除搜索"
                onClick={() =>
                  navigate(
                    { ...scope, search: undefined },
                    true,
                    false,
                    "replace",
                  )
                }
              >
                {searchTerm} ×
              </button>
            )}
            <div className="music-wall-tools">
              <button aria-label="墙面搜索" onClick={() => openWallSearch()}>
                <Search size={20} />
              </button>
              <button
                aria-label="墙面设置"
                onClick={() => setOverlay("settings")}
              >
                <Settings size={20} />
              </button>
            </div>
          </div>
        </WallMenu>
      </div>
    ) : (
      basicContentNavigation
    );
  const layoutProps = {
    scope,
    source: wallFilter.active ? wallFilter.source : media.source,
    memory: wallFilter.active ? wallFilter.memory : memoryRef.current,
    remember: wallFilter.active ? wallFilter.remember : remember,
    open: (item: MediaItem, index: number) => {
      if (memory.layout === "recordCrate" && item.kind === "collection") {
        remember({ focusId: item.id, focusIndex: index });
        navigate(collectionLocation(item), true, false, "push");
        return;
      }
      if (
        cardVideoRef.current?.anchorId === item.id &&
        !cardVideoRef.current.expanded
      ) {
        expandCardPlayback();
        return;
      }
      const state = usePlayback.getState();
      if (
        memory.layout === "recordCrate" &&
        (state.track?.id === item.id ||
          (inlineMusicAnchor.current?.anchorId === item.id &&
            state.track?.id === inlineMusicAnchor.current.mediaId))
      ) {
        usePlayback.setState({ expanded: true, queueVisible: false });
        return;
      }
      void open(
        item,
        wallFilter.active
          ? Math.max(0, wallFilter.originalIndex(item.id))
          : index,
      );
    },
    resolveSingle: resolveSingleForLayout,
    playInline:
      memory.layout === "recordCrate" || memory.layout === "screeningRoom"
        ? playInline
        : undefined,
    onBrowseMotion:
      memory.layout === "screeningRoom"
        ? (keepControls?: boolean) => stopCardPlayback(keepControls)
        : undefined,
    cardVideo: cardVideo ?? undefined,
    inlineMusic:
      inlineMusicAnchor.current &&
      usePlayback.getState().track?.id === inlineMusicAnchor.current.mediaId
        ? {
            anchorId: inlineMusicAnchor.current.anchorId,
            item: usePlayback.getState().track!,
          }
        : undefined,
    stopCardVideo: () => stopCardPlayback(),
    expandCardVideo: expandCardPlayback,
    openSingle: (item: MediaItem, index: number) =>
      open(
        item,
        wallFilter.active
          ? Math.max(0, wallFilter.originalIndex(item.id))
          : index,
        true,
      ),
    favorite,
    selected: (item: MediaItem) => focused?.item.id === item.id,
    clearFocus,
    select: (item: MediaItem, index: number) =>
      focusItem(
        item,
        wallFilter.active
          ? Math.max(0, wallFilter.originalIndex(item.id))
          : index,
      ),
    contextMenu: (
      item: MediaItem,
      index: number,
      event: Parameters<typeof openContext>[2],
    ) =>
      openContext(
        item,
        wallFilter.active
          ? Math.max(0, wallFilter.originalIndex(item.id))
          : index,
        event,
      ),
    interactive: !blocked,
    reducedMotion: settings.reducedMotion,
  };
  const wallEmpty = !media.ready
    ? { message: "正在加载…", loading: true }
    : media.errorCode === "auth-required"
      ? {
          message: "登录后查看此栏目",
          requiresNavigation: true,
          actionLabel: "登录音乐平台",
          action: () => setOverlay("music-account"),
        }
      : media.error && !media.total
        ? {
            message: "暂时无法加载内容",
            actionLabel: "重试",
            action: () => {
              media.source.retry();
            },
          }
        : (wallFilter.active ? wallFilter.total : media.total) === 0
          ? {
              message:
                wallFilter.query || searchTerm ? "没有匹配的媒体" : "暂无媒体",
            }
          : undefined;
  const wallNavigation = {
    content: contentNavigation,
    spineContent: contentNavigation,
    title,
    sourceKind: remoteMusic ? ("online" as const) : ("local" as const),
    empty: wallEmpty,
    filter: { query: wallFilter.query, clear: () => wallFilter.update("") },
  };
  const canReturnToParent =
    scope.view !== "comic" &&
    scope.view !== "novel" &&
    (parents.current.canBack ||
      Boolean(parentLibraryLocation(scope, activeLibrary?.roots)));
  const persistentWall = (
    <div
      className="layout-surface"
      inert={Boolean(viewer || playerExpanded || musicPreview)}
      data-background-locked={Boolean(viewer || playerExpanded || musicPreview)}
    >
      <ContentNavigationContext.Provider value={wallNavigation}>
        <BravaisWall {...layoutProps} />
      </ContentNavigationContext.Provider>
    </div>
  );
  return (
    <div
      className={`browser-shell layout-${memory.layout} ${currentType === "music" && !["favorites", "recent"].includes(scope.view) ? "music-browse" : ""} ${playingTrack ? "has-player" : ""}`}
      data-navigation={settings.navigationPosition}
    >
      <WindowTitleBar />
      <div className="browser-content" inert={blocked}>
        {booted && scope.view === "novel" ? (
          <OnlineNovels
            scope={scope}
            navigate={(next, mode = "root") =>
              navigate(next, true, false, mode)
            }
            onBack={popParentPage}
            resumeSearch={() => resumeSearch("novel")}
            memory={memory}
            remember={remember}
            local={() =>
              navigate(
                { view: "libraries", type: "novel" },
                true,
                false,
                "push",
              )
            }
            openLocal={(item) => void open(item, 0)}
            openLayout={() => setOverlay("layout")}
          />
        ) : booted && scope.view === "comic" ? (
          <OnlineComics
            scope={scope}
            navigate={(next, mode = "root") =>
              navigate(next, true, false, mode)
            }
            onBack={popParentPage}
            resumeSearch={() => resumeSearch("comic")}
            memory={memory}
            remember={remember}
            local={() =>
              navigate(
                { view: "libraries", type: "comic" },
                true,
                false,
                "push",
              )
            }
            openLocal={(item) => void open(item, 0)}
            openLayout={() => setOverlay("layout")}
          />
        ) : booted && wallView && scope.view !== "libraries" && !bootError ? (
          persistentWall
        ) : !booted ||
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
                  navigate(
                    {
                      view: "library",
                      libraryId: lib.id,
                      type: lib.type,
                    },
                    true,
                    false,
                    "push",
                  )
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
                        navigate(
                          {
                            view: "library",
                            libraryId: lib.id,
                            type: lib.type,
                          },
                          true,
                          false,
                          "push",
                        )
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
            <span className="empty-brand">Kaleid</span>
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
            inert={Boolean(
              viewer ||
              playerExpanded ||
              musicPreview ||
              (browseTransition.pending && !media.ready),
            )}
            data-background-locked={Boolean(
              viewer || playerExpanded || musicPreview,
            )}
            key={
              memory.layout === "bravais"
                ? "bravais"
                : `${key}:${memory.layout}:${JSON.stringify(query)}`
            }
          >
            {memory.layout === "bravais" ? (
              <ContentNavigationContext.Provider
                value={
                  (scope.view === "recent" && !musicWall) ||
                  currentType === "image"
                    ? null
                    : {
                        content: contentNavigation,
                        title,
                        spineContent: musicWall ? contentNavigation : undefined,
                      }
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
            ) : memory.layout === "archiveShelf" ? (
              <ArchiveShelf {...layoutProps} />
            ) : memory.layout === "recordCrate" ? (
              <RecordCrate {...layoutProps} />
            ) : memory.layout === "screeningRoom" ? (
              <ScreeningRoom {...layoutProps} />
            ) : memory.layout === "photoLightbox" ? (
              <PhotoLightbox {...layoutProps} />
            ) : (
              <StandardGrid {...layoutProps} />
            )}
          </div>
        )}
        <AutoHideNavigation
          edge={settings.navigationPosition}
          locked={Boolean(overlay)}
          alwaysAutoHide={scope.view === "comic" || scope.view === "novel"}
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
                Kaleid
              </button>
              <nav className="top-types" aria-label="媒体导航">
                {navigation}
              </nav>
              <div className="top-actions">{actions}</div>
            </header>
          )}
        </AutoHideNavigation>
        {canReturnToParent && (
          <nav className="browse-back-nav" aria-label="返回导航">
            <button
              type="button"
              className="text-button browse-back-button"
              aria-label="返回上一级"
              title="返回上一级"
              onClick={goBack}
            >
              <ChevronLeft size={17} />
            </button>
            <strong className="browse-back-title">{title}</strong>
          </nav>
        )}
        {contentNavigation &&
          scope.view !== "comic" &&
          scope.view !== "novel" &&
          (!wallView || scope.view === "libraries") && (
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
            onClick={() => navigate(navigationRetry, true, false, "replace")}
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
            {contextMenu.item.type === "comic" && !contextMenu.item.kind && (
              <button
                role="menuitem"
                onClick={() => {
                  const item = contextMenu.item;
                  setContextMenu(null);
                  void window.media.comicHub
                    .set("readLater", { kind: "local", mediaId: item.id }, true)
                    .then(() => useApp.getState().notify("已加入稍后阅读"))
                    .catch(report);
                }}
              >
                <BookmarkPlus size={15} />
                <span>加入稍后阅读</span>
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
            {contextMenu.item.type === "comic" && !contextMenu.item.kind && (
              <button
                role="menuitem"
                onClick={() => {
                  setComicOrganizer(contextMenu.item);
                  setContextMenu(null);
                }}
              >
                <PanelsTopLeft size={15} />
                <span>设为作品／整理章节</span>
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
        browseMusic={(next) => navigate(next, true, false, "push")}
        closeUI={closeSurface}
        closeDetail={() =>
          closeSurface(() => usePlayback.setState({ expanded: false }))
        }
      />
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
      {activeVideo && (
        <VideoPlayer
          item={activeVideo}
          autoPlay={!viewer?.historyRestore}
          sort={videoPlayback?.sort ?? memory.sort}
          floating={!inlineVideo}
          floatingReason={videoPiPReason}
          sharedSessionId={
            cardVideo?.expanded && cardVideo.item.id === activeVideo.id
              ? cardVideo.id
              : undefined
          }
          leave={() => {
            if (returnToCard()) return;
            if (cardVideoRef.current) {
              stopCardPlayback();
              setViewer(null);
              return;
            }
            if (settings.videoAutoPictureInPicture) {
              setVideoPiPReason("automatic");
              presentationSnapshot.current ??= snapshotRef.current();
              setViewer(null);
            } else {
              setVideoPlayback(null);
              const original = presentationSnapshot.current;
              if (original && !original.viewer) closeViewerDirect();
              else closeViewer();
              presentationSnapshot.current = null;
            }
          }}
          minimize={() => {
            setVideoPiPReason("manual");
            presentationSnapshot.current ??= snapshotRef.current();
            setViewer(null);
          }}
          restore={() => {
            setVideoPiPReason(undefined);
            presentationSnapshot.current ??= snapshotRef.current();
            setViewer({ item: activeVideo, index: 0 });
          }}
          close={() => {
            if (cardVideoRef.current) {
              stopCardPlayback();
              setViewer(null);
              return;
            }
            setVideoPlayback(null);
            const original = presentationSnapshot.current;
            if (inlineVideo) {
              if (original && !original.viewer) closeViewerDirect();
              else closeViewer();
            } else if (original?.viewer) closeViewer();
            presentationSnapshot.current = null;
          }}
          switchItem={(item) => {
            cardVideoRef.current = null;
            setCardVideo(null);
            presentationSnapshot.current ??= snapshotRef.current();
            setVideoPlayback({
              item,
              sort: videoPlayback?.sort ?? memory.sort,
            });
            if (inlineVideo) setViewer({ item, index: 0 });
          }}
        />
      )}
      {viewer && viewer.item.type !== "video" && (
        <Viewer
          videoSort={memory.sort}
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
      {comicOrganizer !== undefined && (
        <ComicLibraryPanel
          initialItem={comicOrganizer ?? undefined}
          close={() => setComicOrganizer(undefined)}
          onRead={(item) => {
            setComicOrganizer(undefined);
            void open(item, 0).catch(report);
          }}
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
            {LAYOUTS.filter((layout) => layoutsForView.includes(layout.id)).map(
              (layout) => (
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
              ),
            )}
          </div>
          {(scope.view === "library" || scope.view === "type") && (
            <div className="layout-browse-options">
              <label htmlFor="browse-sort">排序方式</label>
              <select
                id="browse-sort"
                value={memory.sort}
                onChange={(event) =>
                  changeSort(event.target.value as BrowseMemory["sort"])
                }
              >
                <option value="added">最近添加</option>
                <option value="name">名称</option>
                <option value="recent">最近打开</option>
              </select>
            </div>
          )}
          {currentType === "comic" && scope.view === "library" && (
            <button
              type="button"
              className="layout-comic-organizer"
              onClick={() => {
                setOverlay(null);
                setComicOrganizer(null);
              }}
            >
              <PanelsTopLeft size={17} />
              <span>漫画作品与章节</span>
              <ChevronRight size={15} />
            </button>
          )}
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
                  onClick={() => void openFolderChoice(folder.path)}
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
      <VideoExportTasks />
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
      <AppUpdatePrompt />
    </div>
  );
}
