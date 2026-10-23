import { isSupportedMusicItem, isSupportedMusicId } from "../../shared/music";
import { musicItems, isRemote } from "./music/catalog";
import { create } from "zustand";
import { applyTheme } from "./theme";
import {
  DEFAULT_SETTINGS,
  type Library,
  type MediaItem,
  type MediaType,
  type MusicOrder,
  type MusicRepeat,
  type MusicSession,
  type ScanStatus,
  type Settings,
} from "../../shared/types";

interface AppState {
  libraries: Library[];
  counts: Record<MediaType, number>;
  scans: Record<string, ScanStatus>;
  settings: Settings;
  revision: number;
  toast: string;
  toastKind: "info" | "error";
  refresh(): Promise<void>;
  touch(): void;
  notify(text: string, kind?: "info" | "error"): void;
  setSettings(settings: Settings): Promise<void>;
}
let toastTimer: ReturnType<typeof setTimeout>;
export const useApp = create<AppState>((set, get) => ({
  libraries: [],
  counts: { image: 0, music: 0, video: 0, novel: 0, comic: 0 },
  scans: {},
  settings: DEFAULT_SETTINGS,
  revision: 0,
  toast: "",
  toastKind: "info",
  refresh: async () => {
    const [libraries, counts] = await Promise.all([
      window.media.libraries(),
      window.media.statistics(),
    ]);
    set({ libraries, counts, revision: get().revision + 1 });
  },
  touch: () => set({ revision: get().revision + 1 }),
  notify: (toast, toastKind = "info") => {
    clearTimeout(toastTimer);
    set({ toast, toastKind });
    toastTimer = setTimeout(() => set({ toast: "" }), 5000);
  },
  setSettings: async (settings) => {
    await window.media.saveSettings(settings);
    set({ settings });
    applyTheme(settings.theme);
  },
}));
export function report(error: unknown) {
  useApp
    .getState()
    .notify(
      error instanceof Error
        ? error.message.replace(
            /^Error invoking remote method '[^']+': (Error: )?/,
            "",
          )
        : String(error),
      "error",
    );
}
export async function act(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    report(error);
  }
}

let playbackGeneration = 0;
let browseOrigin: import("../../shared/navigation").BrowseLocation | undefined;
export const setPlaybackBrowseOrigin = (
  scope: import("../../shared/navigation").BrowseLocation,
) => {
  browseOrigin = scope;
};

interface Playback {
  origin?: import("../../shared/types").PlaybackOrigin;
  track: MediaItem | null;
  queue: MediaItem[];
  queueIds: string[];
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  repeat: MusicRepeat;
  order: MusicOrder;
  muted: boolean;
  lyricPreview: string;
  seek: { value: number; serial: number };
  expanded: boolean;
  queueVisible: boolean;
  matchOpen: boolean;
  play(track: MediaItem, queue?: MediaItem[]): void;
  setQueueIds(ids: string[]): void;
  restore(session: MusicSession, tracks: MediaItem[]): void;
  reorderQueue(from: number, to: number): void;
  removeQueueId(id: string): void;
  clearQueue(): void;
  toggle(): void;
  next(direction?: number): void;
  seekTo(value: number): void;
}
export const usePlayback = create<Playback>((set, get) => ({
  track: null,
  queue: [],
  queueIds: [],
  playing: false,
  position: 0,
  duration: 0,
  volume: 0.7,
  repeat: "off",
  order: "sequential",
  muted: false,
  lyricPreview: "",
  seek: { value: 0, serial: 0 },
  expanded: false,
  queueVisible: false,
  matchOpen: false,
  play: (track, queue) => {
    if (!isSupportedMusicItem(track)) {
      useApp.getState().notify("该音乐来源已停用");
      return;
    }
    if (track.missing) {
      useApp.getState().notify("文件不可用，请检查来源文件夹", "error");
      return;
    }
    ++playbackGeneration;
    const previous = get();
    const same = previous.track?.id === track.id;
    const eligible = queue?.filter((m) => m.type === "music" && !m.kind);
    const supported = eligible?.filter(isSupportedMusicItem);
    if (supported && supported.length !== eligible!.length)
      useApp.getState().notify("已跳过停用来源的队列条目");
    if (!same) window.dispatchEvent(new Event("music-stop-and-clear"));
    set({
      track,
      origin: browseOrigin
        ? { trackId: track.id, scope: structuredClone(browseOrigin) }
        : previous.origin,
      queue: supported ?? previous.queue,
      queueIds:
        supported?.map((m) => m.id) ??
        (previous.queueIds.includes(track.id) ? previous.queueIds : [track.id]),
      playing: true,
      position: 0,
      duration: track.duration ?? 0,
      ...(same ? { seek: { value: 0, serial: previous.seek.serial + 1 } } : {}),
    });
    persistMusicSession();
    if (isRemote(track)) void window.music.opened(track.id).catch(report);
    if (!isRemote(track))
      void act(async () => {
        await window.media.opened(track.id);
        useApp.getState().touch();
      });
  },
  setQueueIds: (ids) => {
    const unique = [...new Set(ids)]
      .filter(isSupportedMusicId)
      .slice(0, 100000);
    if (ids.some((id) => !isSupportedMusicId(id)))
      useApp.getState().notify("已跳过停用来源的队列条目");
    set({ queueIds: unique });
    persistMusicSession();
  },
  restore: (session, tracks) => {
    const queueIds = session.queueIds.filter(isSupportedMusicId);
    if (queueIds.length !== session.queueIds.length)
      useApp.getState().notify("已跳过停用来源的队列条目");
    tracks = tracks.filter(isSupportedMusicItem);
    session = {
      ...session,
      queueIds,
      trackId:
        session.trackId && isSupportedMusicId(session.trackId)
          ? session.trackId
          : undefined,
    };
    const track = tracks.find((entry) => entry.id === session.trackId) ?? null;
    set({
      track,
      origin: session.origin,
      queue: tracks,
      queueIds: session.queueIds,
      playing: false,
      position: 0,
      duration: track?.duration ?? 0,
      volume: session.volume,
      muted: session.muted,
      repeat: session.repeat,
      order: session.order,
    });
  },
  reorderQueue: (from, to) => {
    const queueIds = [...get().queueIds];
    if (
      from < 0 ||
      from >= queueIds.length ||
      to < 0 ||
      to >= queueIds.length ||
      from === to
    )
      return;
    const [id] = queueIds.splice(from, 1);
    queueIds.splice(to, 0, id);
    set({ queueIds });
    persistMusicSession();
  },
  removeQueueId: (id) => {
    const queueIds = get().queueIds.filter((entry) => entry !== id);
    set({ queueIds, queue: get().queue.filter((entry) => entry.id !== id) });
    persistMusicSession();
  },
  clearQueue: () => {
    ++playbackGeneration;
    window.dispatchEvent(new Event("music-stop-and-clear"));
    set({
      origin: undefined,
      expanded: false,
      queueVisible: false,
      matchOpen: false,
      lyricPreview: "",
      queue: [],
      queueIds: [],
      track: null,
      playing: false,
      position: 0,
      duration: 0,
    });
    persistMusicSession();
  },
  toggle: () => {
    if (!get().track) return;
    set({ playing: !get().playing });
    persistMusicSession();
  },
  next: async (direction = 1) => {
    const generation = playbackGeneration;
    const { track, queueIds, order, repeat } = get();
    if (!queueIds.length) return;
    const index = Math.max(
      0,
      queueIds.findIndex((id) => id === track?.id),
    );
    if (direction > 0 && repeat === "off" && index >= queueIds.length - 1) {
      set({ playing: false, position: 0 });
      persistMusicSession();
      return;
    }
    const nextIndex =
      order === "shuffle" && direction > 0 && queueIds.length > 1
        ? (index + 1 + Math.floor(Math.random() * (queueIds.length - 1))) %
          queueIds.length
        : (index + direction + queueIds.length) % queueIds.length;
    const nextId = queueIds[nextIndex];
    const loaded = get().queue.find((song) => song.id === nextId);
    const [song] = loaded ? [loaded] : await musicItems([nextId]);
    if (song && generation === playbackGeneration) {
      const origin = get().origin;
      get().play(song);
      if (origin) {
        set({ origin: { ...origin, trackId: song.id } });
        persistMusicSession();
      }
    }
  },
  seekTo: (value) =>
    set({ seek: { value, serial: get().seek.serial + 1 }, position: value }),
}));
let musicSessionTimer: ReturnType<typeof setTimeout> | undefined;
export function persistMusicSession() {
  if (musicSessionTimer) clearTimeout(musicSessionTimer);
  musicSessionTimer = setTimeout(() => {
    const state = usePlayback.getState();
    const session = {
      origin: state.origin,
      trackId: state.track?.id,
      queueIds: state.queueIds,
      position: 0,
      volume: state.volume,
      muted: state.muted,
      repeat: state.repeat,
      order: state.order,
    };
    void window.music
      .saveSession(
        session,
        state.queue.filter((item) => isRemote(item)),
      )
      .catch(report);
    if (!state.track || !isRemote(state.track))
      void window.media
        .saveMusicSession({
          ...session,
          queueIds: session.queueIds.filter(
            (id) => !id.startsWith("online:") && !id.startsWith("navidrome:"),
          ),
        })
        .catch(report);
  }, 180);
}
usePlayback.subscribe((state, previous) => {
  if (
    state.volume !== previous.volume ||
    state.muted !== previous.muted ||
    state.repeat !== previous.repeat ||
    state.order !== previous.order
  )
    persistMusicSession();
});
export const resource = (item: MediaItem, variant = "file") =>
  item.onlineNovelRef
    ? variant === "cover" || variant === "thumbnail"
      ? item.remoteCover || item.cover || ""
      : `media://novel/chapter/${item.id.replace(/^novel-online:/, "")}?v=${item.resourceVersion || 0}`
    : (item.remoteData?.comicRef || item.remoteData?.novel) &&
        (variant === "cover" || variant === "thumbnail")
      ? item.remoteCover || item.cover || ""
      : isRemote(item)
        ? variant === "cover" || variant === "thumbnail"
          ? (item.remoteCover ?? "")
          : (item.remoteAudio ?? "")
        : `media://asset/${item.id}/${variant}?v=${item.resourceVersion ?? item.modifiedAt}`;
export function time(seconds = 0) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
export function bytes(size: number) {
  return size >= 1024 ** 3
    ? `${(size / 1024 ** 3).toFixed(1)} GB`
    : size >= 1024 ** 2
      ? `${(size / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
}
