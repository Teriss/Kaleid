export type MediaType = "image" | "music" | "video" | "novel" | "comic";
export type MediaLayout =
  | "grid"
  | "bravais"
  | "spatial"
  | "gallery"
  | "verticalGallery"
  | "carousel"
  | "archiveShelf"
  | "recordCrate"
  | "screeningRoom"
  | "photoLightbox";
export type WallMode = "finite" | "infinite";
export type MusicRepeat = "off" | "all" | "one";
export type MusicOrder = "sequential" | "shuffle";
export interface MusicSession {
  origin?: PlaybackOrigin;
  trackId?: string;
  queueIds: string[];
  position: number;
  volume: number;
  muted: boolean;
  repeat: MusicRepeat;
  order: MusicOrder;
}
export interface PlaybackOrigin {
  trackId: string;
  scope: import("./navigation").BrowseLocation;
}
export interface MusicPlaylist {
  id: string;
  name: string;
  songIds: string[];
  createdAt: number;
  updatedAt: number;
}
export interface BrowseMemory {
  revealFocus?: boolean;
  focusRequest?: number;
  carouselPosition?: number;
  galleryOffset?: number;
  verticalGalleryOffset?: number;
  seam?: { anchor: number; hidden: boolean };
  spatialCamera?: { x: number; y: number };
  spatialScene?: "carousel" | "collection" | "explore" | "artist";
  layout: MediaLayout;
  sort: "name" | "added" | "recent";
  focusId?: string;
  focusIndex?: number;
  scrollTop?: number;
  wallFocusId?: string;
  wallMode?: WallMode;
  archiveShelfMode?: WallMode;
  showcaseMode?: WallMode;
  wallLayoutVersion?: number;
  wallManualScale?: boolean;
  wallStartSlotKey?: string;
  wallFocusedSlotKey?: string;
  camera?: { x: number; y: number; scale: number };
  wallCameras?: Partial<
    Record<WallMode, { x: number; y: number; scale: number }>
  >;
}
export interface Library {
  id: string;
  name: string;
  type: MediaType;
  roots: string[];
  count: number;
  createdAt: number;
}
export interface MediaItem {
  onlineNovelRef?: import("./onlineNovels").OnlineNovelChapterRef;
  novelRequiredFont?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  videoInfoVersion?: number;
  videoProbeError?: string;
  sourceRef?: import("./music").PlaybackSourceRef;
  remoteCover?: string;
  remoteAudio?: string;
  remoteData?: Record<string, any>;
  id: string;
  kind?: "folder" | "collection";
  folderCount?: number;
  type: MediaType;
  title: string;
  path: string;
  folder: string;
  ext: string;
  size: number;
  modifiedAt: number;
  resourceVersion?: number;
  addedAt: number;
  artist?: string;
  album?: string;
  duration?: number;
  replayGainDb?: number;
  loudnessGainDb?: number;
  width?: number;
  height?: number;
  cover?: string;
  favorite: boolean;
  missing: boolean;
  lastOpened?: number;
  progress?: Progress;
  comicInfo?: import("./comic").ComicInfo;
  libraryIds: string[];
}
export interface Progress {
  comicPageId?: string;
  comicOffset?: number;
  completed?: boolean;
  position?: number;
  duration?: number;
  cfi?: string;
  page?: number;
  scroll?: number;
  textOffset?: number;
  href?: string;
}
export interface MediaQuery {
  libraryId?: string;
  type?: MediaType;
  search?: string;
  favorite?: boolean;
  recent?: boolean;
  folder?: string;
  sort?: "name" | "added" | "recent";
  offset?: number;
  limit?: number;
  anchorId?: string;
  browse?: boolean;
}
export interface ResolvedTarget {
  id: string;
  path: string;
  title: string;
  kind: "media" | "folder";
  isDirectory?: boolean;
  type?: MediaType;
  favorite?: boolean;
  missing?: boolean;
  libraryIds: string[];
}
export interface IndexChange {
  version: number;
  libraryIds: string[];
  types: MediaType[];
  updated: MediaItem[];
  removedIds: string[];
  structural: boolean;
}
export interface QueryResult {
  sections?: { title: string; start: number; count: number }[];
  scene?: "carousel" | "collection";
  version?: number;
  items: MediaItem[];
  total: number;
  anchorIndex?: number;
}
export interface MediaMetric {
  id: string;
  aspect: number;
}
export interface ScanStatus {
  reason?: "manual" | "background";
  libraryId: string;
  status: "scanning" | "done" | "cancelled" | "error";
  found: number;
  processed: number;
  errors: number;
  current?: string;
  message?: string;
}
export interface FolderNode {
  path: string;
  count: number;
}
export interface ComicPage {
  id: string;
  name: string;
  url: string;
  width?: number;
  height?: number;
}
export interface ComicWork {
  id: string;
  title: string;
  chapterIds: string[];
  preferences?: Partial<import("./comic").ComicPreferences>;
  automatic?: boolean;
}
export interface ComicBookmark {
  id: string;
  mediaId: string;
  pageId: string;
  page: number;
  offset: number;
  createdAt: number;
}
export interface ComicContext {
  work?: ComicWork;
  chapters: MediaItem[];
  preferences: Partial<import("./comic").ComicPreferences>;
  bookmarks: ComicBookmark[];
}
export interface Settings {
  theme: "dark" | "light";
  videoAutoPictureInPicture: boolean;
  navigationAutoHide: boolean;
  reducedMotion: boolean;
  navigationPosition: "top" | "bottom" | "left" | "right";
  readerTheme: import("./readerColors").ReaderTheme;
  readerMode: "scroll" | "paged";
  readerFont: import("./readerColors").ReaderFont;
  fontSize: number;
  lineHeight: number;
  readerPadding: number;
  comicMode: "single" | "double" | "scroll";
  comicRtl: boolean;
  equalizerEnabled: boolean;
  equalizerPreset: string;
  equalizerBands: number[];
  loudnessNormalization: boolean;
  audioOutputDeviceId: string;
  sleepTimerMinutes: number;
  lyricsPresentation: "split" | "fullscreen" | "wall";
}
export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  videoAutoPictureInPicture: false,
  navigationAutoHide: true,
  reducedMotion: false,
  navigationPosition: "right",
  readerTheme: "paper",
  readerMode: "scroll",
  readerFont: "serif",
  fontSize: 20,
  lineHeight: 1.9,
  readerPadding: 6,
  comicMode: "single",
  comicRtl: false,
  equalizerEnabled: false,
  equalizerPreset: "flat",
  equalizerBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  loudnessNormalization: false,
  audioOutputDeviceId: "",
  sleepTimerMinutes: 0,
  lyricsPresentation: "split",
};
export interface AppAPI {
  windowState(): Promise<import("./windowControls").MainWindowState>;
  windowCommand(command: import("./windowControls").MainWindowCommand): Promise<void>;
  windowDrag(value: import("./windowControls").MainWindowDrag): Promise<void>;
  onWindowState(callback: (state: import("./windowControls").MainWindowState) => void): () => void;
  onWindowChromePointer(callback: (state: import("./windowControls").MainWindowChromePointer) => void): () => void;
  onlineNovels: import("./onlineNovels").OnlineNovelsAPI;
  onlineComics: import("./onlineComics").OnlineComicsAPI;
  comicHub: import("./onlineComics").ComicHubAPI;
  appTheme(): Promise<Settings["theme"]>;
  onTheme(callback: (theme: Settings["theme"]) => void): () => void;
  chooseFolders(): Promise<string[]>;
  libraries(): Promise<Library[]>;
  statistics(): Promise<Record<MediaType, number>>;
  createLibrary(input: {
    name: string;
    type: MediaType;
    roots: string[];
  }): Promise<Library>;
  addRoots(id: string, roots: string[]): Promise<void>;
  removeRoot(id: string, root: string): Promise<void>;
  renameLibrary(id: string, name: string): Promise<void>;
  removeLibrary(id: string): Promise<void>;
  scan(id: string): Promise<void>;
  reconcile(): Promise<void>;
  cancelScan(id: string): Promise<void>;
  query(query: MediaQuery): Promise<QueryResult>;
  item(id: string): Promise<MediaItem>;
  resolveBrowseLocation(
    libraryId: string,
    folder?: string,
  ): Promise<string | null>;
  layoutMetrics(query: MediaQuery): Promise<MediaMetric[]>;
  openExternal(id: string): Promise<void>;
  copyFiles(ids: string[]): Promise<void>;
  copyPaths(ids: string[]): Promise<void>;
  renameFile(id: string, name: string): Promise<void>;
  trashFiles(ids: string[]): Promise<{
    removed: string[];
    cleared: string[];
    errors: string[];
  }>;
  renameFolder(id: string, name: string): Promise<void>;
  folders(libraryId?: string): Promise<FolderNode[]>;
  favorite(id: string, value: boolean): Promise<void>;
  saveProgress(id: string, progress: Progress): Promise<void>;
  opened(id: string): Promise<void>;
  readText(
    id: string,
    encoding?: string,
  ): Promise<{ text: string; encoding: string }>;
  lyrics(id: string): Promise<string | null>;
  musicSession(): Promise<MusicSession | null>;
  saveMusicSession(session: MusicSession): Promise<void>;
  musicQueueIds(query: MediaQuery): Promise<string[]>;
  musicItems(ids: string[]): Promise<MediaItem[]>;
  analyzeLoudness(id: string): Promise<number | null>;
  musicPlaylists(): Promise<MusicPlaylist[]>;
  saveMusicPlaylist(playlist: MusicPlaylist): Promise<void>;
  deleteMusicPlaylist(id: string): Promise<void>;
  applyMusicCandidate(
    id: string,
    candidate: MusicMetadataCandidate,
    fields: string[],
  ): Promise<void>;
  restoreMusicMetadata(id: string): Promise<void>;
  searchMusicMetadata(id: string): Promise<MusicMetadataCandidate[]>;
  comicPages(id: string, session?: string): Promise<ComicPage[]>;
  comicPageMetrics(
    id: string,
    indices: number[],
  ): Promise<{ index: number; width?: number; height?: number }[]>;
  comicContext(id: string): Promise<ComicContext>;
  comicWorks(): Promise<ComicWork[]>;
  saveComicWork(work: ComicWork): Promise<ComicWork>;
  deleteComicWork(id: string): Promise<void>;
  saveComicPreferences(
    id: string,
    preferences: Partial<import("./comic").ComicPreferences>,
  ): Promise<void>;
  saveComicBookmark(bookmark: ComicBookmark): Promise<void>;
  deleteComicBookmark(id: string): Promise<void>;
  releaseComic(id: string, session?: string): Promise<void>;
  setVideoCover(id: string, data: string): Promise<void>;
  reveal(id: string): Promise<void>;
  settings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  clearCache(): Promise<void>;
  removeRecent(id: string): Promise<{ cleared: number; errors: string[] }>;
  clearRecent(): Promise<{ cleared: number; errors: string[] }>;
  onHistoryChange(callback: () => void): () => void;
  onIndexChange(callback: (change: IndexChange) => void): () => void;
  onScan(callback: (status: ScanStatus) => void): () => void;
}
export interface MusicMetadataCandidate {
  source: "netease" | "qq" | "kugou" | "amll";
  remoteId: string;
  platform?: "ncm" | "qq";
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  lyric?: string;
  score?: number;
}
