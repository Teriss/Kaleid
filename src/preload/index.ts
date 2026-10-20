import { contextBridge, ipcRenderer } from "electron";
import type { AppAPI } from "../shared/types";
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
