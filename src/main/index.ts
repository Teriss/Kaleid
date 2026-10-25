import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  shell,
  utilityProcess,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { byteRange, isWithin, normalized } from "./core";
import { EXTENSIONS } from "./core";
import { installMusic } from "./music";
import { installOnlineComics } from "./onlineComics";
import { installOnlineNovels } from "./onlineNovels";
import { installVideo } from "./video";
import { installVideoOverlay } from "./videoOverlay";
import { NetworkProxyManager } from "./networkProxy";
import type { MediaQuery, Settings } from "../shared/types";
import { normalizeReaderSettings } from "../shared/readerSettings";
import { DEFAULT_SETTINGS } from "../shared/types";
import { validateNetworkProxy } from "../shared/networkProxy";
import { installWindowControls } from "./windowControls";

const here = path.dirname(fileURLToPath(import.meta.url));
const testUserDataPath = process.env.MEDIA_BROWSER_TEST_DATA;
const appDataPath = app.getPath("appData");
const userDataPath = testUserDataPath || path.join(appDataPath, "Kaleid");
app.setPath("userData", userDataPath);
const applicationIcon = app.isPackaged
  ? path.join(process.resourcesPath, "kaleid-icon.png")
  : path.resolve(here, "../../build/kaleid-icon.png");
protocol.registerSchemesAsPrivileged([
  ...["music", "folia-ytm", "folia-spotify"].map((scheme) => ({
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  })),
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
let window: BrowserWindow | null = null;
const bindWindowControls = installWindowControls(() => window);
let appTheme: Settings["theme"] = "dark";
const networkProxy = new NetworkProxyManager(DEFAULT_SETTINGS.networkProxy);
function synchronizeTheme(theme: Settings["theme"]) {
  appTheme = theme === "light" ? "light" : "dark";
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win === window) {
      win.setBackgroundColor(appTheme === "light" ? "#eeefec" : "#141414");
    } else if (win.webContents.getURL().endsWith("#music-mini")) {
      win.setBackgroundColor(appTheme === "light" ? "#eeefec" : "#141414");
    }
    win.webContents.send("app:theme", appTheme);
  }
}
let requestId = 0;
const pending = new Map<
  number,
  {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const selectedFolders = new Set<string>();
const workerNetworkRequests = new Map<string, AbortController>();
const MATCHING_NETWORK_HOSTS = new Set([
  "music.163.com",
  "c.y.qq.com",
  "y.gtimg.cn",
  "api.amll.dev",
]);
let service: ReturnType<typeof utilityProcess.fork>;
let readyResolve: () => void;
let readyReject: (error: Error) => void;
let serviceFailure: Error | undefined;
const ready = new Promise<void>((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
void ready.catch(() => {});
const readyTimeout = setTimeout(
  () => readyReject(new Error("媒体库进程启动超时，请重启应用")),
  30000,
);
readyTimeout.unref();
async function call(method: string, ...args: any[]): Promise<any> {
  await ready;
  if (serviceFailure) throw serviceFailure;
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("后台处理超时，请重试"));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    service.postMessage({ id, method, args });
  });
}
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".epub": "application/epub+zip",
  ".woff2": "font/woff2",
};
async function serveFile(file: string, request: Request) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) return new Response("Not a file", { status: 404 });
  const range = byteRange(request.headers.get("range"), stat.size);
  const mime =
    MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  };
  if (range === false)
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${stat.size}` },
    });
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  if (request.method === "HEAD" || !stat.size)
    return new Response(null, { status: range ? 206 : 200, headers });
  const stream = createReadStream(file, { start, end });
  request.signal.addEventListener("abort", () => stream.destroy(), {
    once: true,
  });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
}
async function validatedRoots(roots: unknown) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 50)
    throw new Error("请选择至少一个文件夹");
  const result: string[] = [];
  for (const value of roots) {
    if (typeof value !== "string") throw new Error("无效目录");
    const real = await fs.realpath(value);
    if (!selectedFolders.has(normalized(real)))
      throw new Error("请通过目录选择器添加文件夹");
    if (!(await fs.stat(real)).isDirectory()) throw new Error("无效目录");
    result.push(normalized(real));
  }
  return [...new Set(result)];
}
function validateSettings(input: Settings): Settings {
  const reader = normalizeReaderSettings(
    input as Settings & { readerBackgroundColor?: unknown },
  );
  return {
    networkProxy: validateNetworkProxy(input.networkProxy),
    theme: input.theme === "light" ? "light" : "dark",
    navigationAutoHide: input.navigationAutoHide !== false,
    videoAutoPictureInPicture: input.videoAutoPictureInPicture === true,
    comicAutoLanguageFilters: Object.fromEntries(
      Object.entries(input.comicAutoLanguageFilters || {}).filter(
        ([sourceId, language]) =>
          typeof sourceId === "string" &&
          sourceId.length <= 200 &&
          ["chinese", "english", "japanese"].includes(String(language)),
      ),
    ) as Settings["comicAutoLanguageFilters"],
    reducedMotion: Boolean(input.reducedMotion),
    navigationPosition: ["top", "bottom", "left", "right"].includes(
      input.navigationPosition,
    )
      ? input.navigationPosition
      : "right",
    ...reader,
    comicMode: ["single", "double", "scroll"].includes(input.comicMode)
      ? input.comicMode
      : "single",
    comicRtl: Boolean(input.comicRtl),
    equalizerEnabled: Boolean(input.equalizerEnabled),
    equalizerPreset:
      typeof input.equalizerPreset === "string"
        ? input.equalizerPreset.slice(0, 40)
        : "flat",
    equalizerBands: Array.from({ length: 10 }, (_, index) =>
      Math.max(-12, Math.min(12, Number(input.equalizerBands?.[index]) || 0)),
    ),
    loudnessNormalization: Boolean(input.loudnessNormalization),
    audioOutputDeviceId:
      typeof input.audioOutputDeviceId === "string"
        ? input.audioOutputDeviceId.slice(0, 300)
        : "",
    sleepTimerMinutes: Math.max(
      0,
      Math.min(480, Math.round(Number(input.sleepTimerMinutes) || 0)),
    ),
    lyricsPresentation: ["split", "fullscreen", "wall"].includes(
      input.lyricsPresentation,
    )
      ? input.lyricsPresentation
      : "split",
  };
}
void app
  .whenReady()
  .then(async () => {
    process.env.MEDIA_BROWSER_VIDEO_RUNTIME = app.isPackaged
      ? path.join(process.resourcesPath, "video-runtime")
      : path.resolve(here, "../../artifacts/video-runtime");
    process.env.MEDIA_BROWSER_COMIC_RUNTIME = app.isPackaged
      ? path.join(process.resourcesPath, "comic-runtime")
      : path.resolve(here, "../../artifacts/comic-runtime");
    const musicService = installMusic(
      () => window,
      call,
      () => appTheme,
      networkProxy,
    );
    const onlineComics = installOnlineComics(() => window, here, networkProxy);
    const onlineNovels = installOnlineNovels(() => window, networkProxy);
    const videoOverlay = installVideoOverlay(() => window);
    const videoService = installVideo(() => window, call, videoOverlay);
    service = utilityProcess.fork(path.join(here, "worker.js"), [], {
      env: { ...process.env, MEDIA_BROWSER_DATA: app.getPath("userData") },
      serviceName: "Media Library",
    });
    service.on("message", (message: any) => {
      if (message.event === "ready") {
        clearTimeout(readyTimeout);
        readyResolve();
        return;
      }
      if (message.event === "index-change") {
        window?.webContents.send("library:index-change", message.data);
        return;
      }
      if (message.event === "scan") {
        window?.webContents.send("library:scan", message.data);
        return;
      }
      if (message.event === "network-cancel") {
        workerNetworkRequests.get(String(message.requestId))?.abort();
        return;
      }
      if (message.event === "network-request") {
        const requestId = String(message.requestId || "");
        if (!requestId) return;
        if (workerNetworkRequests.size >= 32) {
          service.postMessage({
            event: "network-response",
            requestId,
            error: "在线请求过多",
          });
          return;
        }
        const controller = new AbortController();
        workerNetworkRequests.set(requestId, controller);
        void (async () => {
          try {
            const url = new URL(String(message.url || ""));
            if (
              url.protocol !== "https:" ||
              !MATCHING_NETWORK_HOSTS.has(url.hostname) ||
              message.key !== "music.matching"
            )
              throw new Error("在线匹配地址不受支持");
            const response = await networkProxy.fetch("music.matching", url, {
              method: message.method === "POST" ? "POST" : "GET",
              headers: message.headers,
              body: typeof message.body === "string" ? message.body : undefined,
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(30000),
              ]),
            });
            const body = await response.arrayBuffer();
            if (body.byteLength > 8 * 1024 * 1024)
              throw new Error("在线匹配响应过大");
            service.postMessage({
              event: "network-response",
              requestId,
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body,
            });
          } catch (error) {
            service.postMessage({
              event: "network-response",
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            workerNetworkRequests.delete(requestId);
          }
        })();
        return;
      }
      const job = pending.get(message.id);
      if (!job) return;
      clearTimeout(job.timer);
      pending.delete(message.id);
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.result);
    });
    service.on("exit", (code) => {
      serviceFailure = new Error(`媒体库进程已退出 (${code})，请重启应用`);
      for (const controller of workerNetworkRequests.values())
        controller.abort();
      workerNetworkRequests.clear();
      clearTimeout(readyTimeout);
      readyReject(serviceFailure);
      for (const job of pending.values()) {
        clearTimeout(job.timer);
        job.reject(serviceFailure);
      }
      pending.clear();
    });
    protocol.handle("app", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.host !== "local") return new Response(null, { status: 403 });
        const root = path.resolve(here, "../renderer");
        const target = path.resolve(
          root,
          "." +
            decodeURIComponent(
              url.pathname === "/" ? "/index.html" : url.pathname,
            ),
        );
        if (!isWithin(root, target)) return new Response(null, { status: 403 });
        return await serveFile(target, request);
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    protocol.handle("media", async (request) => {
      if (new URL(request.url).host === "novel")
        return onlineNovels.resource(request);
      if (new URL(request.url).host === "comic")
        return onlineComics.resource(request);
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Expose-Headers":
          "Content-Length, Content-Range, Accept-Ranges",
      };
      try {
        if (request.method === "OPTIONS")
          return new Response(null, { status: 204, headers: cors });
        const url = new URL(request.url);
        const match = /^\/([a-f0-9]{32})\/(file|cover|page)(?:\/(\d+))?$/.exec(
          url.pathname,
        );
        if (
          url.host !== "asset" ||
          !match ||
          !["GET", "HEAD"].includes(request.method)
        )
          return new Response(null, { status: 403, headers: cors });
        const resource = await call(
          "resource",
          match[1],
          match[2],
          match[3] ? Number(match[3]) : undefined,
        );
        return await serveFile(resource.path, request);
      } catch {
        return new Response(null, { status: 404, headers: cors });
      }
    });
    const forwarded = new Set([
      "libraries",
      "statistics",
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
      "resolveIds",
      "resolvePaths",
      "resolveTrash",
      "renameTarget",
      "forgetPaths",
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
      "settings",
      "saveSettings",
      "clearCache",
    ]);
    function deduplicatePaths(targets: { path: string }[]) {
      const ordered = [...targets].sort(
        (a, b) => a.path.length - b.path.length,
      );
      const accepted: { path: string }[] = [];
      for (const target of ordered)
        if (
          !accepted.some(
            (parent) =>
              normalized(parent.path) === normalized(target.path) ||
              isWithin(parent.path, target.path),
          )
        )
          accepted.push(target);
      return accepted;
    }
    async function copyTargets(targets: { path: string }[], pathsOnly = false) {
      targets = deduplicatePaths(targets);
      const urls = targets.map((target) => pathToFileURL(target.path).href);
      if (pathsOnly)
        await clipboard.writeText(
          targets.map((target) => target.path).join("\r\n"),
        );
      else
        await clipboard.write([
          new ClipboardItem({ "text/uri-list": urls.join("\r\n") }),
        ]);
    }
    ipcMain.handle("media:call", async (event, method: string, args: any[]) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("无效调用来源");
      if (!Array.isArray(args)) throw new Error("无效参数");
      if (method === "removeRecent" || method === "clearRecent") {
        const id = method === "removeRecent" ? args[0] : undefined;
        if (
          method === "removeRecent" &&
          (typeof id !== "string" || !id || id.length > 1024)
        )
          throw new Error("无效的历史标识");
        let cleared = 0;
        const errors: string[] = [];
        const remote =
          typeof id === "string" && /^(online|navidrome):/.test(id);
        if (!id || !remote) {
          try {
            cleared += await call("clearRecent", id);
          } catch (error) {
            errors.push(`本地历史：${String(error)}`);
          }
        }
        if (!id || remote) {
          try {
            cleared += musicService.clearRecent(id);
          } catch (error) {
            errors.push(`音乐历史：${String(error)}`);
          }
        }
        if (cleared) window?.webContents.send("library:history-change");
        return { cleared, errors };
      }
      if (method === "chooseFolders") {
        const result = await dialog.showOpenDialog(window!, {
          title: "选择媒体文件夹",
          properties: ["openDirectory", "multiSelections"],
        });
        const folders = result.canceled
          ? []
          : await Promise.all(result.filePaths.map((p) => fs.realpath(p)));
        folders.forEach((p) => selectedFolders.add(normalized(p)));
        return folders;
      }
      if (method === "createLibrary") {
        const input = args[0];
        if (
          !input ||
          typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.length > 80 ||
          !Object.hasOwn(EXTENSIONS, input.type)
        )
          throw new Error("无效的媒体库名称或类型");
        return call(method, {
          name: input.name,
          type: input.type,
          roots: await validatedRoots(input.roots),
        });
      }
      if (method === "reveal")
        return shell.showItemInFolder(await call("reveal", args[0]));
      if (method === "openExternal") {
        const [target] = await call("resolvePaths", [args[0]]);
        if (!target) throw new Error("找不到该媒体");
        const result = await shell.openPath(target.path);
        if (result) throw new Error(result);
        return;
      }
      if (method === "copyFiles") {
        const targets = await call("resolvePaths", args[0]);
        await copyTargets(targets);
        return;
      }
      if (method === "copyPaths") {
        await copyTargets(await call("resolvePaths", args[0]), true);
        return;
      }
      if (method === "renameFile" || method === "renameFolder")
        return call("renameTarget", args[0], args[1]);
      if (method === "trashFiles") {
        const targets = await call("resolveIds", args[0]);
        const errors: string[] = [];
        const seen = new Set<string>();
        const removedPaths: string[] = [];
        const clearedPaths: string[] = [];
        const orderedTargets = [
          ...(targets as { id: string; path: string; title: string }[]),
        ].sort((a, b) => a.path.length - b.path.length);
        for (const target of orderedTargets) {
          let checked: any;
          try {
            [checked] = await call("resolveTrash", [target.id]);
            if ([...seen].some((existing) => isWithin(existing, checked.path)))
              continue;
            if (checked.missing) {
              seen.add(checked.path);
              clearedPaths.push(checked.path);
              continue;
            }
            await shell.trashItem(checked.path);
            seen.add(checked.path);
            removedPaths.push(checked.path);
          } catch (error) {
            if (checked?.path) {
              const cleanup = await call("forgetPaths", [checked.path]);
              if (!cleanup.errors.length && cleanup.removed.length) {
                clearedPaths.push(checked.path);
                continue;
              }
            }
            errors.push(`${target.title}：${String(error)}`);
          }
        }
        const moved = removedPaths.length
          ? await call("forgetPaths", removedPaths)
          : { removed: [], errors: [] };
        const cleared = clearedPaths.length
          ? await call("forgetPaths", clearedPaths)
          : { removed: [], errors: [] };
        return {
          removed: moved.removed,
          cleared: cleared.removed,
          errors: [...errors, ...moved.errors, ...cleared.errors],
        };
      }
      if (!forwarded.has(method)) throw new Error("不支持的操作");
      if (method === "clearCache") {
        await onlineComics.clearCache();
        await onlineNovels.clearCache();
      }
      if (method === "addRoots") args[1] = await validatedRoots(args[1]);
      if (method === "saveSettings") {
        args[0] = {
          ...validateSettings(args[0]),
          theme: args[0]?.theme === "light" ? "light" : "dark",
        };
        const previous = (await call("settings")) as Settings;
        await networkProxy.setSettings(args[0].networkProxy);
        try {
          await call(method, ...args);
        } catch (error) {
          await networkProxy.setSettings(previous.networkProxy).catch(() => {});
          throw error;
        }
        synchronizeTheme(args[0].theme);
        return;
      }
      if (method === "query") {
        const q = args[0] as MediaQuery;
        if (
          !q ||
          typeof q !== "object" ||
          (q.search && typeof q.search !== "string")
        )
          throw new Error("无效查询");
      }
      return call(method, ...args);
    });
    ipcMain.handle("app:theme", (event) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("无效主题来源");
      return appTheme;
    });
    const startupSettings = (await call("settings")) as Settings;
    await networkProxy.setSettings(startupSettings.networkProxy);
    appTheme = startupSettings.theme === "light" ? "light" : "dark";
    function createWindow() {
      window = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1000,
        minHeight: 680,
        backgroundColor: appTheme === "light" ? "#eeefec" : "#141414",
        title: "Kaleid",
        icon: applicationIcon,
        autoHideMenuBar: true,
        frame: false,
        titleBarStyle: "hidden",
        titleBarOverlay: false,
        webPreferences: {
          preload: path.join(here, "../preload/index.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      // The app has no native menu bar; keep Alt from revealing an empty menu strip.
      window.setMenu(null);
      bindWindowControls(window);
      videoOverlay.bindWindow(window);
      videoService.bindWindow(window);
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      window.webContents.session.webRequest.onBeforeRequest(
        (details, callback) => {
          const url = new URL(details.url);
          const dev = process.env.ELECTRON_RENDERER_URL;
          const allowed =
            [
              "app:",
              "media:",
              "music:",
              "folia-ytm:",
              "folia-spotify:",
              "blob:",
              "data:",
              "devtools:",
            ].includes(url.protocol) ||
            Boolean(dev && url.origin === new URL(dev).origin) ||
            Boolean(
              dev && url.protocol === "ws:" && url.host === new URL(dev).host,
            );
          callback({ cancel: !allowed });
        },
      );
      if (process.env.ELECTRON_RENDERER_URL)
        void window.loadURL(process.env.ELECTRON_RENDERER_URL);
      else void window.loadURL("app://local/");
      window.on("focus", () => {
        void call("reconcile").catch((error) =>
          console.error("Media reconcile failed:", error),
        );
      });
      window.on("closed", () => {
        musicService.closeWindows();
        window = null;
      });
    }
    createWindow();
    app.on("activate", () => {
      if (!window) createWindow();
      void call("reconcile").catch((error) =>
        console.error("Media reconcile failed:", error),
      );
    });
  })
  .catch((error) => {
    console.error("Application startup failed:", error);
    app.quit();
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => service?.kill());
