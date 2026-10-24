import { contextBridge, ipcRenderer } from "electron";
import type { AppAPI } from "../shared/types";
import type { VideoAPI } from "../shared/video";
import { NOVEL_API_METHODS } from "../shared/onlineNovels";
const video = {
  windowGesture: (
    id: string,
    value: Parameters<VideoAPI["windowGesture"]>[1],
  ) => ipcRenderer.invoke("video:call", "windowGesture", id, value),
  present: (
    id: string,
    mode: "card" | "embedded" | "floating",
    reason?: "manual" | "automatic",
  ) => ipcRenderer.invoke("video:call", "present", id, mode, reason),
  pin: (id: string, value: boolean) =>
    ipcRenderer.invoke("video:call", "pin", id, value),
  musicFocus: () => ipcRenderer.invoke("video:call", "musicFocus"),
  audioFocusAck: (serial: number) =>
    ipcRenderer.invoke("video:call", "audioFocusAck", serial),
  onAudioFocus: (callback: (serial: number) => void) => {
    const listener = (_event: unknown, serial: number) => callback(serial);
    ipcRenderer.on("video:audio-focus", listener);
    return () => ipcRenderer.removeListener("video:audio-focus", listener);
  },
  overlay: (state: Parameters<VideoAPI["overlay"]>[0]) =>
    ipcRenderer.invoke("video:overlay", state),
  open: (input: Parameters<VideoAPI["open"]>[0]) =>
    ipcRenderer.invoke("video:call", "open", input),
  close: (id: string) => ipcRenderer.invoke("video:call", "close", id),
  command: (id: string, command: Parameters<VideoAPI["command"]>[1]) =>
    ipcRenderer.invoke("video:call", "command", id, command),
  bounds: (id: string, bounds: Parameters<VideoAPI["bounds"]>[1]) =>
    ipcRenderer.invoke("video:call", "bounds", id, bounds),
  subtitle: (id: string) => ipcRenderer.invoke("video:call", "subtitle", id),
  queue: (id: string, sort: string) =>
    ipcRenderer.invoke("video:call", "queue", id, sort),
  export: (input: Parameters<VideoAPI["export"]>[0]) =>
    ipcRenderer.invoke("video:call", "export", input),
  exports: () => ipcRenderer.invoke("video:call", "exports"),
  cancelExport: (id: string) =>
    ipcRenderer.invoke("video:call", "cancelExport", id),
  revealExport: (id: string) =>
    ipcRenderer.invoke("video:call", "revealExport", id),
  onExports: (callback: Parameters<VideoAPI["onExports"]>[0]) => {
    const listener = (_event: unknown, jobs: Parameters<typeof callback>[0]) =>
      callback(jobs);
    ipcRenderer.on("video:exports", listener);
    return () => ipcRenderer.removeListener("video:exports", listener);
  },
  onState: (callback: Parameters<VideoAPI["onState"]>[0]) => {
    const listener = (_event: unknown, state: Parameters<typeof callback>[0]) =>
      callback(state);
    ipcRenderer.on("video:state", listener);
    return () => ipcRenderer.removeListener("video:state", listener);
  },
  onInput: (callback: Parameters<VideoAPI["onInput"]>[0]) => {
    const listener = (
      _event: unknown,
      action: Parameters<typeof callback>[0],
    ) => callback(action);
    ipcRenderer.on("video:input", listener);
    return () => ipcRenderer.removeListener("video:input", listener);
  },
} satisfies VideoAPI;
contextBridge.exposeInMainWorld("video", video);
const methods = [
  "chooseFolders",
  "libraries",
  "statistics",
  "createLibrary",
  "addRoots",
  "removeRoot",
  "renameLibrary",
  "removeLibrary",
  "scan",
  "reconcile",
  "cancelScan",
  "query",
  "item",
  "resolveBrowseLocation",
  "layoutMetrics",
  "musicQueueIds",
  "musicItems",
  "analyzeLoudness",
  "openExternal",
  "copyFiles",
  "copyPaths",
  "renameFile",
  "trashFiles",
  "renameFolder",
  "folders",
  "favorite",
  "saveProgress",
  "opened",
  "readText",
  "lyrics",
  "musicSession",
  "saveMusicSession",
  "musicPlaylists",
  "saveMusicPlaylist",
  "deleteMusicPlaylist",
  "applyMusicCandidate",
  "restoreMusicMetadata",
  "searchMusicMetadata",
  "comicPages",
  "comicPageMetrics",
  "comicContext",
  "comicWorks",
  "saveComicWork",
  "deleteComicWork",
  "saveComicPreferences",
  "saveComicBookmark",
  "deleteComicBookmark",
  "releaseComic",
  "setVideoCover",
  "reveal",
  "settings",
  "saveSettings",
  "clearCache",
  "removeRecent",
  "clearRecent",
];
const api: Record<string, any> = Object.fromEntries(
  methods.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke("media:call", method, args),
  ]),
);
api.onlineNovels = Object.fromEntries(
  NOVEL_API_METHODS.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke("novel:call", method, args),
  ]),
);
api.onlineNovels.onChange = (callback: () => void) => {
  const listener = () => callback();
  ipcRenderer.on("novel:change", listener);
  return () => ipcRenderer.removeListener("novel:change", listener);
};
api.onlineComics = Object.fromEntries(
  [
    "categories",
    "ranking",
    "settingAction",
    "sources",
    "repositories",
    "repository",
    "openAddress",
    "removeRepository",
    "install",
    "importFile",
    "enable",
    "uninstall",
    "checkUpdates",
    "update",
    "settings",
    "search",
    "explore",
    "category",
    "details",
    "thumbnails",
    "login",
    "logout",
    "favorite",
    "library",
    "hubList",
    "hubSet",
    "following",
    "checkFollowing",
    "readerItem",
    "pages",
    "context",
    "saveProgress",
    "preferences",
    "bookmark",
    "deleteBookmark",
    "release",
    "downloads",
    "enqueue",
    "downloadAction",
    "downloadDirectory",
    "respondUI",
  ].map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke("comic:call", method, args),
  ]),
);
for (const [method, channel] of [
  ["onChange", "comic:change"],
  ["onUI", "comic:ui"],
]) {
  api.onlineComics[method] = (callback: (data?: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}
api.comicHub = {
  list: (list: import("../shared/onlineComics").ComicHubList) =>
    api.onlineComics.hubList(list),
  set: (
    list: import("../shared/onlineComics").ComicHubList,
    ref: import("../shared/onlineComics").ComicHubRef,
    value: boolean,
  ) => api.onlineComics.hubSet(list, ref, value),
  following: () => api.onlineComics.following(),
  checkFollowing: (ref?: import("../shared/onlineComics").OnlineComicRef) =>
    api.onlineComics.checkFollowing(ref),
  onChange: (callback: () => void) => api.onlineComics.onChange(callback),
};
api.appTheme = () => ipcRenderer.invoke("app:theme");
api.windowState = () => ipcRenderer.invoke("app:window-state");
api.windowCommand = (command: Parameters<AppAPI["windowCommand"]>[0]) => ipcRenderer.invoke("app:window-command", command);
api.windowDrag = (value: Parameters<AppAPI["windowDrag"]>[0]) => ipcRenderer.invoke("app:window-drag", value);
api.onWindowState = (callback: Parameters<AppAPI["onWindowState"]>[0]) => {
  const listener = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state);
  ipcRenderer.on("app:window-state", listener);
  return () => ipcRenderer.removeListener("app:window-state", listener);
};
api.onWindowChromePointer = (callback: Parameters<AppAPI["onWindowChromePointer"]>[0]) => {
  let active = true;
  const listener = (_event: unknown, state: Parameters<typeof callback>[0]) => { if (active) callback(state); };
  ipcRenderer.on("app:window-chrome-pointer", listener);
  void ipcRenderer.invoke("app:window-chrome-pointer").then((state) => { if (active) callback(state); }).catch(() => {});
  return () => { active = false; ipcRenderer.removeListener("app:window-chrome-pointer", listener); };
};
api.onTheme = (callback: (theme: "dark" | "light") => void) => {
  const listener = (_event: unknown, theme: "dark" | "light") =>
    callback(theme);
  ipcRenderer.on("app:theme", listener);
  return () => ipcRenderer.removeListener("app:theme", listener);
};
api.onScan = (callback: (status: unknown) => void) => {
  const listener = (_event: unknown, status: unknown) => callback(status);
  ipcRenderer.on("library:scan", listener);
  return () => ipcRenderer.removeListener("library:scan", listener);
};
api.onIndexChange = (callback: (change: unknown) => void) => {
  const listener = (_event: unknown, change: unknown) => callback(change);
  ipcRenderer.on("library:index-change", listener);
  return () => ipcRenderer.removeListener("library:index-change", listener);
};
api.onHistoryChange = (callback: () => void) => {
  const listener = () => callback();
  ipcRenderer.on("library:history-change", listener);
  return () => ipcRenderer.removeListener("library:history-change", listener);
};
contextBridge.exposeInMainWorld("media", api as unknown as AppAPI);

const musicMethods = [
  "upgrade",
  "playlists",
  "savePlaylist",
  "deletePlaylist",
  "favorite",
  "opened",
  "special",
  "aiConfig",
  "saveAI",
  "generateTheme",
  "models",
  "downloadModel",
  "navidromeConfig",
  "saveNavidrome",
  "navidrome",
  "proxy",
  "http",
  "request",
  "resource",
  "saveCatalog",
  "items",
  "session",
  "saveSession",
  "window",
];
const music: Record<string, any> = Object.fromEntries(
  musicMethods.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke("music:call", method, args),
  ]),
);
music.publish = (state: unknown) => ipcRenderer.send("music:publish", state);
music.command = (command: string, value?: number) =>
  ipcRenderer.send("music:command", command, value);
for (const [method, channel] of [
  ["onState", "music:state"],
  ["onCommand", "music:command"],
])
  music[method] = (callback: (...args: any[]) => void) => {
    const listener = (_event: unknown, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
contextBridge.exposeInMainWorld("music", music);
