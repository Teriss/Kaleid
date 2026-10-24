import type {
  ComicBookmark,
  ComicContext,
  ComicPage,
  MediaItem,
  OnlineChangeEvent,
  Progress,
} from "./types";
import type { ComicPreferences } from "./comic";

export interface OnlineComicRef {
  sourceId: string;
  comicId: string;
}
export interface OnlineChapterRef extends OnlineComicRef {
  chapterId: string | null;
}
export type ComicHubRef =
  { kind: "local"; mediaId: string } | ({ kind: "online" } & OnlineComicRef);
export type ComicHubList = "readLater" | "following";
export interface ComicFollowState {
  ref: OnlineComicRef;
  addedAt: number;
  checkedAt?: number;
  newChapterIds: string[];
  error?: string;
}
export interface ComicHubAPI {
  list(list: ComicHubList): Promise<ComicHubRef[]>;
  set(list: ComicHubList, ref: ComicHubRef, value: boolean): Promise<void>;
  following(): Promise<ComicFollowState[]>;
  checkFollowing(ref?: OnlineComicRef): Promise<ComicFollowState[]>;
  onChange(callback: (event?: OnlineChangeEvent) => void): () => void;
}
export interface SourceOption {
  label: string;
  type: string;
  options: (string | { value: string; text?: string })[];
  default?: unknown;
}
export interface ComicSourceInfo {
  id: string;
  key: string;
  name: string;
  version: string;
  enabled: boolean;
  url: string;
  hash: string;
  logged: boolean;
  enableTagsTranslate?: boolean;
  error?: string;
  update?: boolean;
  capabilities: {
    search: boolean;
    categories: boolean;
    favorites: boolean;
    favoriteFolders: boolean;
    login: string[];
  };
  explore: { title: string; type: string }[];
  categories: any;
  categoryOptions: SourceOption[];
  rankingOptions: string[];
  searchOptions: SourceOption[];
  settings: Record<
    string,
    {
      title?: string;
      type: string;
      options?: any[];
      default?: any;
      validator?: string;
    }
  >;
  settingValues: Record<string, unknown>;
  cookieFields?: string[];
}
export interface ComicRepositoryEntry {
  name: string;
  url: string;
  version?: string;
  description?: string;
  key?: string;
  installedId?: string;
}
export type ComicAddressResult =
  | { kind: "repository"; entries: ComicRepositoryEntry[] }
  | { kind: "source"; source: ComicSourceInfo };
export interface OnlineComic extends OnlineComicRef {
  title: string;
  cover: string;
  subtitle?: string;
  description?: string;
  tags?: any;
  tagDisplay?: ComicTagDisplayGroup[];
  favoriteId?: string;
  maxPage?: number;
  stars?: number;
  uploadTime?: string;
}
export interface OnlineChapter {
  id: string | null;
  title: string;
  group?: string;
  progress?: Progress;
  downloaded?: boolean;
}
export interface OnlineComicDetails extends OnlineComic {
  chapters: OnlineChapter[];
  tagDisplay?: ComicTagDisplayGroup[];
  uploader?: string;
  uploadTime?: string;
  stars?: number;
  maxPage?: number;
  hasChapters: boolean;
  thumbnails?: string[];
  hasThumbnailLoader: boolean;
  updateTime?: string;
  isFavorite?: boolean;
  favorite: boolean;
  lastChapterId?: string | null;
  offline?: boolean;
  refreshError?: string;
}
export interface ComicTagDisplayGroup {
  namespace: string;
  label: string;
  tags: { value: string; label: string }[];
}
export interface ComicTagTarget {
  action?: "search" | "category" | string;
  keyword?: string;
  param?: string | null;
  page?: string;
  attributes?: {
    keyword?: string;
    param?: string | null;
    options?: unknown[];
    [key: string]: unknown;
  };
}
export interface ComicThumbnailPage {
  thumbnails: string[];
  next: string | null;
}
export interface ComicSearchPage {
  comics: OnlineComic[];
  maxPage?: number;
  next?: string | null;
  sections?: { title: string; comics: OnlineComic[] }[];
}
export interface ComicDownloadTask extends OnlineChapterRef {
  id: string;
  title: string;
  comicTitle: string;
  state: "queued" | "downloading" | "paused" | "completed" | "failed";
  done: number;
  total: number;
  error?: string;
  createdAt: number;
}
export interface ComicUIRequest {
  id: string;
  sourceId: string;
  kind: string;
  cancelable?: boolean;
  title?: string;
  content?: string;
  message?: string;
  options?: string[];
  actions?: { text: string; style?: string }[];
  image?: string;
}
export interface OnlineComicsAPI {
  sources(): Promise<ComicSourceInfo[]>;
  repositories(): Promise<string[]>;
  repository(url: string): Promise<ComicRepositoryEntry[]>;
  openAddress(url: string): Promise<ComicAddressResult>;
  removeRepository(url: string): Promise<void>;
  install(url: string): Promise<ComicSourceInfo>;
  importFile(): Promise<ComicSourceInfo | null>;
  enable(id: string, enabled: boolean): Promise<void>;
  uninstall(id: string): Promise<void>;
  checkUpdates(): Promise<ComicSourceInfo[]>;
  update(id: string): Promise<ComicSourceInfo>;
  settings(id: string, values: Record<string, unknown>): Promise<void>;
  settingAction(id: string, key: string): Promise<void>;
  search(
    id: string,
    keyword: string,
    options: unknown[],
    page: number,
    next?: string | null,
  ): Promise<ComicSearchPage>;
  explore(
    id: string,
    index: number,
    page: number,
    next?: string | null,
  ): Promise<ComicSearchPage>;
  category(
    id: string,
    category: string,
    param: any,
    options: unknown[],
    page: number,
    next?: string | null,
  ): Promise<ComicSearchPage>;
  categories(id: string): Promise<any>;
  ranking(
    id: string,
    option: string,
    page: number,
    next?: string | null,
  ): Promise<ComicSearchPage>;
  details(ref: OnlineComicRef, refresh?: boolean): Promise<OnlineComicDetails>;
  tagTarget(
    ref: OnlineComicRef,
    namespace: string,
    tag: string,
  ): Promise<ComicTagTarget | null>;
  thumbnails(
    ref: OnlineComicRef,
    next?: string | null,
  ): Promise<ComicThumbnailPage>;
  login(id: string, kind: string, values: string[]): Promise<void>;
  logout(id: string): Promise<void>;
  favorite(ref: OnlineComicRef, value: boolean): Promise<void>;
  library(section: "shelf" | "history" | "downloads"): Promise<OnlineComic[]>;
  removeHistory(ref?: OnlineComicRef): Promise<void>;
  hubList(list: ComicHubList): Promise<ComicHubRef[]>;
  hubSet(list: ComicHubList, ref: ComicHubRef, value: boolean): Promise<void>;
  following(): Promise<ComicFollowState[]>;
  checkFollowing(ref?: OnlineComicRef): Promise<ComicFollowState[]>;
  readerItem(ref: OnlineChapterRef): Promise<MediaItem>;
  pages(ref: OnlineChapterRef, session?: string): Promise<ComicPage[]>;
  context(ref: OnlineChapterRef): Promise<ComicContext>;
  saveProgress(ref: OnlineChapterRef, progress: Progress): Promise<void>;
  preferences(
    ref: OnlineComicRef,
    preferences: Partial<ComicPreferences>,
  ): Promise<void>;
  bookmark(ref: OnlineChapterRef, bookmark: ComicBookmark): Promise<void>;
  deleteBookmark(id: string): Promise<void>;
  release(ref: OnlineChapterRef, session?: string): Promise<void>;
  downloads(): Promise<ComicDownloadTask[]>;
  enqueue(ref: OnlineComicRef, chapterIds: (string | null)[]): Promise<void>;
  downloadAction(
    id: string,
    action: "pause" | "resume" | "cancel" | "delete",
  ): Promise<void>;
  downloadDirectory(choose?: boolean): Promise<string>;
  revealDownload(id: string): Promise<void>;
  respondUI(id: string, value: unknown): Promise<void>;
  onChange(callback: (event?: OnlineChangeEvent) => void): () => void;
  onUI(callback: (request: ComicUIRequest) => void): () => void;
}

export interface ComicReaderAdapter {
  pages(item: MediaItem, session: string): Promise<ComicPage[]>;
  context(item: MediaItem): Promise<ComicContext>;
  saveProgress(item: MediaItem, progress: Progress): Promise<void>;
  preferences(item: MediaItem, preferences: ComicPreferences): Promise<void>;
  bookmark(item: MediaItem, bookmark: ComicBookmark): Promise<void>;
  deleteBookmark(id: string): Promise<void>;
  item(id: string): Promise<MediaItem>;
  release(item: MediaItem, session: string): Promise<void>;
  local: boolean;
}
