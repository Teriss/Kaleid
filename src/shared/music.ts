import type { MediaItem, MusicSession } from "./types";
export const ACTIVE_MUSIC_PROVIDERS = ["netease", "qq", "ytm"] as const;
export const isActiveMusicProvider = (id: string) =>
  (ACTIVE_MUSIC_PROVIDERS as readonly string[]).includes(id);
export const isSupportedMusicId = (id = "") =>
  !id.startsWith("navidrome:") &&
  (!id.startsWith("online:") || isActiveMusicProvider(id.split(":")[1]));
export const isSupportedMusicItem = (item: MediaItem) =>
  isSupportedMusicId(item.id) &&
  (!item.sourceRef ||
    item.sourceRef.kind === "local" ||
    (item.sourceRef.kind === "online" &&
      isActiveMusicProvider(item.sourceRef.providerId)));

export type MusicProviderId =
  "netease" | "qq" | "kugou" | "bodian" | "ytm" | "spotify";
export type PlaybackSourceRef =
  | { kind: "local"; mediaId: string }
  | { kind: "online"; providerId: MusicProviderId; mediaId: string }
  | { kind: "navidrome"; serverId: string; mediaId: string }
  | { kind: "now-playing"; sessionId: string };
export interface MusicProviderSummary {
  id: MusicProviderId;
  name: string;
  capabilities: Record<string, boolean>;
}
export interface MusicCollection {
  providerId: string;
  id: string | number;
  name: string;
  type: string;
  coverUrl?: string;
  trackCount?: number;
  description?: string;
  [key: string]: unknown;
}
export interface MusicAPI {
  upgrade(): Promise<void>;
  playlists(): Promise<import("./types").MusicPlaylist[]>;
  savePlaylist(
    playlist: import("./types").MusicPlaylist,
  ): Promise<import("./types").MusicPlaylist>;
  deletePlaylist(id: string): Promise<void>;
  favorite(id: string, value: boolean): Promise<void>;
  opened(id: string): Promise<void>;
  special(
    kind: "favorites" | "recent",
    offset: number,
    limit: number,
  ): Promise<import("./types").QueryResult>;
  aiConfig(): Promise<{
    provider: "gemini" | "openai";
    url: string;
    model: string;
    configured: boolean;
  }>;
  saveAI(config: {
    provider: "gemini" | "openai";
    url: string;
    model: string;
    key: string;
  }): Promise<void>;
  generateTheme(lyrics: string, title: string): Promise<any>;
  models(): Promise<
    { name: string; bytes: number; installed: boolean; downloading: boolean }[]
  >;
  downloadModel(name: string): Promise<void>;
  navidromeConfig(): Promise<{
    url: string;
    username: string;
    serverId: string;
  } | null>;
  saveNavidrome(config: {
    url: string;
    username: string;
    password: string;
  }): Promise<void>;
  navidrome(operation: string, params?: Record<string, unknown>): Promise<any>;
  proxy(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    bodyText: string;
    headers: Record<string, string>;
  }>;
  http(
    provider: "netease" | "qq",
    endpoint: string,
    init?: { method?: string; body?: string },
  ): Promise<{ status: number; body: unknown }>;
  request(
    provider: MusicProviderId,
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<any>;
  resource(provider: string, url: string): Promise<string>;
  saveCatalog(items: MediaItem[]): Promise<void>;
  items(ids: string[]): Promise<MediaItem[]>;
  session(): Promise<{ session: MusicSession; items: MediaItem[] } | null>;
  saveSession(session: MusicSession, items: MediaItem[]): Promise<void>;
  window(action: "mini" | "close-mini"): Promise<void>;
  windowSnapshot(): Promise<MusicWindowState>;
  windowInitial(): MusicWindowBootstrap | null;
  windowBootstrap(): Promise<MusicWindowBootstrap>;
  windowReady(): void;
  windowPin(value?: boolean): Promise<boolean>;
  windowInteraction(active: boolean): void;
  onWindowPointer(callback: (inside: boolean) => void): () => void;
  publish(state: Partial<MusicWindowState>): void;
  onState(callback: (state: Partial<MusicWindowState>) => void): () => void;
  command(command: string, value?: number): void;
  onCommand(callback: (command: string, value?: number) => void): () => void;
}
export interface MusicWindowState {
  trackId: string;
  title: string;
  artist: string;
  playing: boolean;
  position: number;
  duration: number;
  cover?: string;
  updatedAt: number;
  volume: number;
  muted: boolean;
  repeat: import("./types").MusicRepeat;
  order: import("./types").MusicOrder;
  favorite: boolean;
  reducedMotion: boolean;
  lyrics: MusicWindowLyric[];
}
export interface MusicWindowBootstrap {
  state: MusicWindowState;
  pinned: boolean;
  theme: "dark" | "light";
}
export interface MusicWindowLyric {
  time: number;
  text: string;
  translation?: string;
  romanization?: string;
  words?: { time: number; duration: number; text: string }[];
}
export const EMPTY_MUSIC_WINDOW_STATE: MusicWindowState = {
  trackId: "",
  title: "",
  artist: "",
  playing: false,
  position: 0,
  duration: 0,
  updatedAt: 0,
  volume: 0.7,
  muted: false,
  repeat: "off",
  order: "sequential",
  favorite: false,
  reducedMotion: false,
  lyrics: [],
};
declare global {
  interface Window {
    music: MusicAPI;
  }
}
