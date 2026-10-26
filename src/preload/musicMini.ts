import { contextBridge, ipcRenderer } from "electron";
import type { MusicWindowBootstrap, MusicWindowState } from "../shared/music";

// Start this IPC while the renderer's JS/CSS is still loading, not in a React effect.
let initial: MusicWindowBootstrap | null = null;
let buffered: Partial<MusicWindowState> = {};
ipcRenderer.on("music:state", (_event, patch: Partial<MusicWindowState>) => {
  if (initial) initial = { ...initial, state: { ...initial.state, ...patch } };
  else buffered = { ...buffered, ...patch };
});
const bootstrap: Promise<MusicWindowBootstrap> = ipcRenderer
  .invoke("music:window-bootstrap")
  .then((value: MusicWindowBootstrap) => {
    initial = { ...value, state: { ...value.state, ...buffered } };
    buffered = {};
    return initial;
  });
// The React error boundary can still present a failure without an unhandled rejection.
void bootstrap.catch(() => {});
function listen<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld("music", {
  windowInitial: () => initial,
  windowBootstrap: () => bootstrap.then(() => initial),
  windowSnapshot: () => ipcRenderer.invoke("music:window-snapshot"),
  windowPin: (value?: boolean) => ipcRenderer.invoke("music:window-pin", value),
  windowReady: () => ipcRenderer.send("music:window-ready"),
  windowInteraction: (active: boolean) =>
    ipcRenderer.send("music:window-interaction", active),
  onWindowPointer: (callback: (inside: boolean) => void) =>
    listen("music:window-pointer", callback),
  onState: (callback: (state: Partial<MusicWindowState>) => void) =>
    listen("music:state", callback),
  command: (command: string, value?: number) =>
    ipcRenderer.send("music:command", command, value),
});
contextBridge.exposeInMainWorld("media", {
  appTheme: () => ipcRenderer.invoke("app:theme"),
  onTheme: (callback: (theme: "dark" | "light") => void) =>
    listen("app:theme", callback),
});
