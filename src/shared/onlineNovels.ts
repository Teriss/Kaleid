import type { MediaItem, Progress } from "./types";

export type NovelSourceId = "lightnovelshelf" | "bilinovel";
export interface OnlineNovelRef {
  sourceId: NovelSourceId;
  novelId: string;
}
export interface OnlineNovelChapterRef extends OnlineNovelRef {
  chapterId: string;
}
export interface NovelSourceInfo {
  id: NovelSourceId;
  name: string;
  url: string;
  enabled: boolean;
  logged: boolean;
  apiNode?: string;
  error?: string;
}
export interface OnlineNovel extends OnlineNovelRef {
  title: string;
  author?: string;
  cover?: string;
  description?: string;
  updatedAt?: string;
  favorite?: boolean;
  openedAt?: number;
}
export interface NovelChapter {
  id: string;
  title: string;
  volume: string;
  url?: string;
  order?: number;
  revision?: string;
  progress?: Progress;
  downloaded?: boolean;
}
export interface OnlineNovelDetails extends OnlineNovel {
  chapters: NovelChapter[];
  lastChapterId?: string;
  offline?: boolean;
  refreshError?: string;
  canExport?: boolean;
  exportCost?: number;
}
export interface NovelSearchPage {
  novels: OnlineNovel[];
  page: number;
  hasMore: boolean;
}
export interface NovelFollowState extends OnlineNovelRef {
  baseline: string[];
  newChapterIds: string[];
  checkedAt?: number;
  error?: string;
}
export type NovelHubList = "shelf" | "readLater" | "following";
export interface NovelDownloadTask extends OnlineNovelChapterRef {
  id: string;
  title: string;
  novelTitle: string;
  state: "queued" | "downloading" | "paused" | "completed" | "failed";
  createdAt: number;
  size?: number;
  error?: string;
}
export interface NovelBookmark extends OnlineNovelChapterRef {
  id: string;
  title: string;
  progress: Progress;
  createdAt: number;
}
export interface NovelReaderState {
  item: MediaItem;
  details: OnlineNovelDetails;
  bookmarks: NovelBookmark[];
  notice?: string;
}
export interface NovelExportQuote extends OnlineNovelRef {
  id: string;
  title: string;
  cost: number;
  expiresAt: number;
}
export const NOVEL_API_METHODS = [
  "sources",
  "settings",
  "login",
  "logout",
  "webLogin",
  "search",
  "discover",
  "details",
  "library",
  "hubSet",
  "following",
  "checkFollowing",
  "reader",
  "saveProgress",
  "bookmark",
  "deleteBookmark",
  "downloads",
  "enqueue",
  "downloadAction",
  "downloadDirectory",
  "exportQuote",
  "exportEpub",
  "clearCache",
] as const;
export interface OnlineNovelsAPI {
  sources(): Promise<NovelSourceInfo[]>;
  settings(
    id: NovelSourceId,
    value: { enabled?: boolean; apiNode?: string },
  ): Promise<void>;
  login(id: NovelSourceId, email: string, password: string): Promise<void>;
  logout(id: NovelSourceId): Promise<void>;
  webLogin(id: NovelSourceId): Promise<void>;
  search(
    id: NovelSourceId,
    keyword: string,
    page: number,
  ): Promise<NovelSearchPage>;
  discover(
    id: NovelSourceId,
    kind: "latest" | "popular",
    page: number,
  ): Promise<NovelSearchPage>;
  details(ref: OnlineNovelRef, refresh?: boolean): Promise<OnlineNovelDetails>;
  library(
    section: NovelHubList | "history" | "downloads",
  ): Promise<OnlineNovel[]>;
  hubSet(
    list: NovelHubList,
    ref: OnlineNovelRef,
    value: boolean,
  ): Promise<void>;
  following(): Promise<NovelFollowState[]>;
  checkFollowing(ref?: OnlineNovelRef): Promise<NovelFollowState[]>;
  reader(ref: OnlineNovelChapterRef): Promise<NovelReaderState>;
  saveProgress(
    ref: OnlineNovelChapterRef,
    progress: Progress,
    version?: number,
  ): Promise<void>;
  bookmark(
    ref: OnlineNovelChapterRef,
    progress: Progress,
  ): Promise<NovelBookmark[]>;
  deleteBookmark(ref: OnlineNovelRef, id: string): Promise<NovelBookmark[]>;
  downloads(): Promise<NovelDownloadTask[]>;
  enqueue(ref: OnlineNovelRef, chapterIds: string[]): Promise<void>;
  downloadAction(
    id: string,
    action: "pause" | "resume" | "cancel" | "delete",
  ): Promise<void>;
  downloadDirectory(choose?: boolean): Promise<string>;
  exportQuote(ref: OnlineNovelRef): Promise<NovelExportQuote>;
  exportEpub(quoteId: string): Promise<string | null>;
  clearCache(): Promise<void>;
  onChange(callback: () => void): () => void;
}
