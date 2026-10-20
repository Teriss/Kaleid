import type { MediaItem, MusicSession } from "./types";

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
  window(
    action: "mini" | "lyrics" | "close-mini" | "close-lyrics",
  ): Promise<void>;
  publish(state: MusicWindowState): void;
  onState(callback: (state: MusicWindowState) => void): () => void;
  command(command: string, value?: number): void;
  onCommand(callback: (command: string, value?: number) => void): () => void;
}
export interface MusicWindowState {
  title: string;
  artist: string;
  lyric: string;
  playing: boolean;
  position: number;
  duration: number;
  cover?: string;
}
declare global {
  interface Window {
    music: MusicAPI;
  }
}
