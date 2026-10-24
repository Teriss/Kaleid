import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  DEFAULT_COMIC_REPOSITORY,
  type ComicAddressResult,
  type ComicRepositoryEntry,
  type ComicSourceInfo,
  type OnlineComicRef,
  type OnlineChapterRef,
  type OnlineComic,
  type OnlineComicDetails,
  type ComicSearchPage,
  type ComicThumbnailPage,
  type ComicDownloadTask,
  type OnlineComicsAPI,
  type ComicHubList,
  type ComicHubRef,
  type ComicFollowState,
} from "../../shared/onlineComics";
import type { ComicBookmark, Progress } from "../../shared/types";
import type { RuntimeState } from "./runtime";
import { OnlineComicStore, digest, comicKey, chapterKey } from "./store";
import { comicSections } from "./normalize";
import { prepareSourceRequest, sourceResponseCacheKey } from "./network";
import { parseThumbnail, cropThumbnail } from "./thumbnails";

interface Source {
  imageEpoch?: string;
  staging?: boolean;
  id: string;
  script: string;
  url: string;
  hash: string;
  enabled: boolean;
  meta: any;
  state: RuntimeState;
  token?: string;
  error?: string;
  update?: boolean;
}
interface SavedComic {
  ref: OnlineComicRef;
  details: OnlineComicDetails;
  favorite: boolean;
  opened?: number;
  lastChapterId?: string | null;
  preferences?: any;
}
interface HubRecord {
  ref: ComicHubRef;
  addedAt: number;
}
interface FollowRecord extends ComicFollowState {
  baselineChapterIds: string[];
}
interface Download extends ComicDownloadTask {
  directory: string;
  pages: { file: string; size: number; hash: string }[];
}
interface Asset extends OnlineChapterRef {
  url: string;
  index: number;
  thumbnail: boolean;
  preview?: boolean;
}
const pairs = (value: any): [string, any][] =>
  value?.$map || Object.entries(value || {});
const httpURL = (value: unknown) => {
  if (typeof value !== "string" || value.length > 16384)
    throw new Error("无效地址");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("仅支持 HTTP(S) 地址");
  return url.href;
};
const sourceURL = (value: unknown) => {
  const url = new URL(httpURL(value));
  const githubPath =
    url.hostname === "github.com"
      ? url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/)
      : null;
  if (githubPath) {
    const [, owner, repo, path] = githubPath;
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "refs" && ["heads", "tags"].includes(parts[1]))
      parts.splice(0, 2);
    const [ref, ...file] = parts;
    if (!ref || !file.length) return url.href;
    url.hostname = "raw.githubusercontent.com";
    url.pathname = `/${owner}/${repo}/${ref}/${file.join("/")}`;
  }
  return url.href;
};
const refCheck = (ref: OnlineComicRef) => {
  if (
    !ref ||
    typeof ref.sourceId !== "string" ||
    typeof ref.comicId !== "string" ||
    !ref.comicId ||
    ref.comicId.length > 4096
  )
    throw new Error("无效漫画标识");
};
const chapterCheck = (ref: OnlineChapterRef) => {
  refCheck(ref);
  if (
    ref.chapterId !== null &&
    (typeof ref.chapterId !== "string" || ref.chapterId.length > 4096)
  )
    throw new Error("无效章节标识");
};
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("下载已暂停"));
    if (signal.aborted) {
      void operation.catch(() => {});
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}
function chapters(
  value: any,
): { id: string | null; title: string; group?: string }[] {
  if (value == null) return [{ id: null, title: "正文" }];
  const result: { id: string | null; title: string; group?: string }[] = [];
  for (const [id, title] of pairs(value)) {
    if (title && typeof title === "object")
      for (const [child, label] of pairs(title))
        result.push({ id: String(child), title: String(label), group: id });
    else result.push({ id: String(id), title: String(title) });
  }
  if (new Set(result.map((c) => c.id)).size !== result.length)
    throw new Error("源返回了重复章节 ID");
  return result;
}
function clean(value: any): any {
  if (!value || typeof value !== "object") return value;
  if (value.$fn) return undefined;
  if (Array.isArray(value)) return value.map(clean);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, clean(v)]),
  );
}

export class OnlineComicService implements Omit<
  OnlineComicsAPI,
  "onChange" | "onUI"
> {
  readonly store: OnlineComicStore;
  private sourcesMap = new Map<string, Source>();
  private child: ReturnType<typeof utilityProcess.fork>;
  private requests = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private serial = 0;
  private loading = new Map<string, Promise<Source>>();
  private initialized = new Set<string>();
  private initializing = new Map<string, Promise<void>>();
  private comicInfo = new WeakMap<
    Source,
    { token: string; comicId: string; pending: boolean; result: Promise<any> }
  >();
  private chapterTails = new Map<string, Promise<unknown>>();
  private sourceAbort = new Map<string, AbortController>();
  private jobs = new Map<string, AbortController>();
  private backgroundSources = new Set<string>();
  private followStartupTimer?: ReturnType<typeof setTimeout>;
  private ui = new Map<
    string,
    {
      sourceId: string;
      token: string;
      resolve(value: any): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private webLogins = new Map<
    BrowserWindow,
    { sourceId: string; token: string }
  >();
  private loadingUI = new Map<string, string>();
  private running = new Set<string>();
  private runningJobs = new Map<string, Promise<void>>();
  private cacheWrites = 0;
  private resourcePending = new Map<string, Promise<Buffer>>();
  private requestTails = new Map<string, Promise<unknown>>();
  private thumbnailRequests = new Map<string, Promise<ComicThumbnailPage>>();
  private thumbnailOriginals = new Map<string, Promise<Buffer>>();
  private sourceResponseCache = new Map<
    string,
    { sourceId: string; time: number; status: number; headers: Record<string, string>; body: Uint8Array }
  >();
  private sourceResponseCacheBytes = 0;
  private imageQueue: {
    sourceId: string;
    priority: number;
    run(): Promise<Buffer>;
    resolve(value: Buffer): void;
    reject(error: unknown): void;
  }[] = [];
  private activeImages = new Map<
    string,
    { read: number; background: number }
  >();
  private closed = false;
  private childDead = false;
  private sessions = new Map<string, string>();
  private sourceSessionSetup = new WeakMap<object, Promise<void>>();
  constructor(
    private getWindow: () => BrowserWindow | null,
    private here: string,
    readonly root: string,
  ) {
    this.store = new OnlineComicStore(path.join(root, "comic-online.sqlite"));
    for (const record of this.store.all("source")) {
      try {
        const state = record.secret
          ? JSON.parse(
              safeStorage.decryptString(Buffer.from(record.secret, "base64")),
            )
          : { data: {}, settings: {}, logged: false };
        this.sourcesMap.set(record.id, {
          ...record,
          state: { ...state, cookies: [] },
          token: undefined,
        });
      } catch {
        this.sourcesMap.set(record.id, {
          ...record,
          state: { data: {}, settings: {}, logged: false, cookies: [] },
          token: undefined,
          error: "账号数据无法解密，请重新登录",
        });
      }
    }
    for (const task of this.store.all<Download>("download"))
      if (["queued", "downloading"].includes(task.state)) {
        task.state = "paused";
        this.store.set("download", task.id, task);
      }
    this.child = utilityProcess.fork(
      path.join(here, "comicSourceWorker.js"),
      [],
      { serviceName: "Comic Sources" },
    );
    this.child.on("message", (message: any) => {
      void this.message(message);
    });
    this.child.on("exit", () => {
      this.childDead = true;
      for (const source of this.sourcesMap.values()) {
        this.sourceAbort.get(source.id)?.abort();
        this.dismissSourceUI(source);
        source.token = undefined;
        source.error = "漫画源进程已退出，请重启应用";
      }
      for (const request of this.requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("漫画源进程已退出"));
      }
      this.requests.clear();
      this.changed();
    });
    this.followStartupTimer = setTimeout(() => {
      void this.checkFollowing().catch(() => {});
    }, 15000);
  }
  private changed() {
    if (!this.closed) this.getWindow()?.webContents.send("comic:change");
  }
  private save(source: Source) {
    if (source.staging) return;
    const { state, token: _token, ...record } = source;
    let secret = "";
    if (
      Object.keys(state.data).length ||
      Object.keys(state.settings).length ||
      state.logged
    ) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("系统加密不可用，无法保存漫画源账号与设置");
      secret = safeStorage
        .encryptString(
          JSON.stringify({
            data: state.data,
            settings: state.settings,
            logged: state.logged,
          }),
        )
        .toString("base64");
    }
    this.store.set("source", source.id, {
      ...record,
      meta: clean(record.meta),
      secret,
    });
  }
  private async message(message: any) {
    if (this.closed) return;
    if (message.event === "instance-exit") {
      const source = this.sourcesMap.get(message.sourceId);
      if (source && source.token === message.token) {
        this.sourceAbort.get(source.id)?.abort();
        this.dismissSourceUI(source);
        this.initialized.delete(message.token);
        source.token = undefined;
        source.error =
          "源运行环境已退出，重试将重新创建：" + String(message.error);
        this.changed();
      }
      return;
    }
    if (message.event === "host") {
      try {
        const source = this.sourcesMap.get(message.sourceId);
        if (!source || source.token !== message.token)
          throw new Error("源实例已失效");
        const value = await this.host(source, message.message);
        if (source.token !== message.token) throw new Error("源实例已失效");
        if (!this.closed && !this.childDead)
          this.child.postMessage({ hostResponse: message.request, value });
      } catch (error) {
        if (!this.closed && !this.childDead) {
          try {
            this.child.postMessage({
              hostResponse: message.request,
              error: String(error),
            });
          } catch {
            /* The utility process can exit while a host request settles. */
          }
        }
      }
      return;
    }
    const source = this.sourcesMap.get(message.sourceId);
    if (source && message.token === source.token && message.state) {
      source.state = message.state;
      try {
        this.save(source);
      } catch (error) {
        message.error = String(error);
      }
    }
    const task = this.requests.get(message.id);
    if (!task) return;
    this.requests.delete(message.id);
    clearTimeout(task.timer);
    if (!source || message.token !== source.token)
      task.reject(new Error("源实例已失效"));
    else if (message.error) task.reject(new Error(message.error));
    else task.resolve(message.result);
  }
  private rpc(source: Source, operation: string, ...args: any[]): Promise<any> {
    if (this.closed) return Promise.reject(new Error("漫画源服务已关闭"));
    if (this.childDead)
      return Promise.reject(new Error("漫画源进程已退出，请重启应用"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error("漫画源处理超时"));
      }, 185000);
      this.requests.set(id, { resolve, reject, timer });
      try {
        this.child.postMessage({
          id,
          sourceId: source.id,
          token: source.token,
          operation,
          args,
        });
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(new Error(String(error)));
      }
    });
  }
  private source(id: string) {
    const source = this.sourcesMap.get(id);
    if (!source) throw new Error("漫画源尚未安装");
    return source;
  }
  private sourceSession(source: Source) {
    const ses = session.fromPartition(`persist:comic-${source.id}`);
    if (!this.sourceSessionSetup.has(ses)) {
      ses.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      ses.setPermissionCheckHandler(() => false);
      this.sourceSessionSetup.set(ses, ses.setProxy({ mode: "system" }));
      if (/\bkey\s*=\s*['"]ehentai['"]/.test(source.script)) {
        ses.webRequest.onBeforeSendHeaders(
          { urls: ["https://exhentai.org/*"] },
          (details, callback) => {
            const headers = details.requestHeaders || {};
            const requestUrl = new URL(details.url);
            const safeHeaders = Object.fromEntries(
              Object.entries(headers).filter(([key]) =>
                /^(accept|accept-language|referer|user-agent|sec-fetch-.*|sec-ch-ua.*)$/i.test(key),
              ),
            );
            for (const key of Object.keys(safeHeaders)) {
              if (key.toLowerCase() === "referer") {
                safeHeaders[key] = String(safeHeaders[key]).split(/[?#]/, 1)[0];
              }
            }
            const cookieNames = String(headers.Cookie || headers.cookie || "")
              .split(";")
              .map((pair) => pair.slice(0, pair.indexOf("=")).trim())
              .filter(Boolean);
            console.info("[ExHentai request diagnostics]", JSON.stringify({
              requestId: details.id,
              url: `${requestUrl.origin}${requestUrl.pathname}`,
              queryKeys: [...new Set(requestUrl.searchParams.keys())],
              method: details.method,
              resourceType: details.resourceType,
              headers: safeHeaders,
              cookieNames,
            }));
            callback({ requestHeaders: details.requestHeaders });
          },
        );
        ses.webRequest.onHeadersReceived(
          { urls: ["https://exhentai.org/*"] },
          (details, callback) => {
            const responseUrl = new URL(details.url);
            const responseHeaders = details.responseHeaders || {};
            const safeHeaders = Object.fromEntries(
              Object.entries(responseHeaders).filter(([key]) =>
                /^(content-type|content-length|content-encoding|server|cf-ray|cf-mitigated|location|date)$/i.test(key),
              ),
            );
            const setCookieValues = Object.entries(responseHeaders)
              .filter(([key]) => key.toLowerCase() === "set-cookie")
              .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
            const setCookieNames = setCookieValues
              .map((value) => String(value).split("=", 1)[0].trim())
              .filter(Boolean);
            console.info("[ExHentai response diagnostics]", JSON.stringify({
              requestId: details.id,
              url: `${responseUrl.origin}${responseUrl.pathname}`,
              queryKeys: [...new Set(responseUrl.searchParams.keys())],
              statusCode: details.statusCode,
              headers: safeHeaders,
              setCookieNames,
            }));
            callback({ responseHeaders: details.responseHeaders });
          },
        );
      }
    }
    return ses;
  }
  private async ready(id: string, init = true): Promise<Source> {
    const source = this.source(id);
    if (!source.enabled) throw new Error("漫画源已停用");
    if (this.loading.has(id)) await this.loading.get(id);
    if (!source.token) {
      const promise = (async () => {
        source.token = randomUUID();
        this.sourceAbort.get(source.id)?.abort();
        this.sourceAbort.set(source.id, new AbortController());
        source.state.cookies = await this.sourceSession(source).cookies.get({});
        try {
          source.meta = await this.rpc(
            source,
            "load",
            source.script,
            source.state,
          );
          if (source.meta.key === "ehentai") {
            const ses = this.sourceSession(source);
            const forumCookies = await ses.cookies.get({
              url: "https://forums.e-hentai.org",
            });
            for (const cookie of forumCookies) {
              await ses.cookies.set({
                url: "https://exhentai.org",
                name: cookie.name,
                value: cookie.value,
                domain: ".exhentai.org",
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                expirationDate: cookie.expirationDate,
                sameSite: cookie.sameSite,
              });
            }
            source.state.cookies = await ses.cookies.get({});
            const exhentaiCookieNames = new Set(
              (await ses.cookies.get({ url: "https://exhentai.org" })).map(
                (cookie) => cookie.name,
              ),
            );
            if (
              source.state.logged &&
              (!exhentaiCookieNames.has("ipb_member_id") ||
                !exhentaiCookieNames.has("ipb_pass_hash"))
            )
              source.state.logged = false;
            await this.rpc(source, "state", {
              logged: source.state.logged,
              cookies: source.state.cookies,
            });
          }
          source.error = undefined;
          this.save(source);
          return source;
        } catch (error) {
          this.sourceAbort.get(source.id)?.abort();
          this.dismissSourceUI(source);
          source.token = undefined;
          source.error = String(error);
          throw error;
        }
      })();
      this.loading.set(id, promise);
      try {
        await promise;
      } finally {
        this.loading.delete(id);
      }
    }
    if (init && !this.initialized.has(source.token!)) {
      const token = source.token!;
      let promise = this.initializing.get(token);
      if (!promise) {
        promise = this.rpc(source, "initialize").then(async () => {
          source.meta = await this.rpc(source, "inspect");
          this.initialized.add(token);
        });
        this.initializing.set(token, promise);
      }
      try {
        await promise;
      } catch (error) {
        source.error = String(error);
        throw error;
      } finally {
        this.initializing.delete(token);
      }
    }
    return source;
  }
  private dismissSourceUI(source: Source) {
    for (const key of this.loadingUI.keys())
      if (key.startsWith(source.id + ":")) this.loadingUI.delete(key);
    for (const [win, login] of this.webLogins)
      if (login.sourceId === source.id && !win.isDestroyed()) win.close();
    for (const [id, request] of this.ui)
      if (request.sourceId === source.id) {
        clearTimeout(request.timer);
        request.resolve(null);
        this.getWindow()?.webContents.send("comic:ui", {
          id,
          sourceId: source.id,
          kind: "dismiss",
        });
        this.ui.delete(id);
      }
  }
  private async unload(source: Source) {
    this.comicInfo.delete(source);
    this.sourceAbort.get(source.id)?.abort();
    this.dismissSourceUI(source);
    if (source.token) {
      try {
        const result = await this.rpc(source, "unload");
        if (result?.engineTeardownWarning)
          source.error =
            "源引擎释放异常，已丢弃独立运行环境；重新启用可创建新实例";
      } catch {
        /* Runtime may already have exited. */
      }
      this.initialized.delete(source.token);
    }
    source.token = undefined;
  }
  private async nativeHttpRequest(
    ses: ReturnType<typeof session.fromPartition>,
    url: string,
    init: RequestInit,
    diagnostics = false,
  ) {
    // Venera's `http_client: dart:io` selects a native HTTP stack. Use Node's
    // native fetch when the OS route is direct, while keeping cookies in this
    // source's Electron Session. For PAC/system proxy routes retain Electron's
    // session transport so the configured proxy is still honored.
    const proxy = (await ses.resolveProxy(url)).split(/[;,]/, 1)[0].trim();
    if (proxy && proxy.toUpperCase() !== "DIRECT")
      return ses.fetch(url, {
        ...init,
        credentials: "include",
        redirect: "follow",
      });

    const origin = new URL(url).origin;
    let currentUrl = url;
    let method = String(init.method || "GET").toUpperCase();
    let body = init.body;
    for (let redirects = 0; redirects <= 20; redirects++) {
      const headers = new Headers(init.headers);
      const cookies = new Map(
        (await ses.cookies.get({ url: currentUrl })).map((cookie) => [
          cookie.name,
          cookie.value,
        ]),
      );
      if (new URL(currentUrl).origin === origin) {
        for (const pair of (headers.get("cookie") || "").split(";")) {
          const equal = pair.indexOf("=");
          if (equal > 0)
            cookies.set(
              pair.slice(0, equal).trim(),
              pair.slice(equal + 1).trim(),
            );
        }
      }
      headers.delete("cookie");
      if (cookies.size)
        headers.set(
          "cookie",
          [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        );
      if (diagnostics) {
        const requestUrl = new URL(currentUrl);
        const safeHeaders = Object.fromEntries(
          [...headers.entries()].filter(([key]) =>
            /^(accept|accept-language|referer|user-agent|sec-fetch-.*|sec-ch-ua.*)$/i.test(key),
          ),
        );
        if (safeHeaders.referer)
          safeHeaders.referer = safeHeaders.referer.split(/[?#]/, 1)[0];
        console.info("[ExHentai request diagnostics]", JSON.stringify({
          transport: "native-http",
          url: `${requestUrl.origin}${requestUrl.pathname}`,
          queryKeys: [...new Set(requestUrl.searchParams.keys())],
          method,
          headers: safeHeaders,
          cookieNames: [...cookies.keys()],
        }));
      }
      const response = await fetch(currentUrl, {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
        signal: init.signal,
        redirect: "manual",
      });
      if (diagnostics) {
        const responseUrl = new URL(currentUrl);
        const safeHeaders = Object.fromEntries(
          [...response.headers.entries()].filter(([key]) =>
            /^(content-type|content-length|content-encoding|server|cf-ray|cf-mitigated|location|date)$/i.test(key),
          ),
        );
        const responseHeaders = response.headers as Headers & {
          getSetCookie?: () => string[];
        };
        const setCookieNames = (responseHeaders.getSetCookie?.() || [])
          .map((value) => value.split("=", 1)[0].trim())
          .filter(Boolean);
        console.info("[ExHentai response diagnostics]", JSON.stringify({
          transport: "native-http",
          url: `${responseUrl.origin}${responseUrl.pathname}`,
          queryKeys: [...new Set(responseUrl.searchParams.keys())],
          statusCode: response.status,
          headers: safeHeaders,
          setCookieNames,
        }));
      }
      const responseHeaders = response.headers as Headers & {
        getSetCookie?: () => string[];
      };
      const setCookies = responseHeaders.getSetCookie?.() ||
        (response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")!]
          : []);
      for (const rawCookie of setCookies) {
        const [pair, ...attributes] = rawCookie.split(";");
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        const fields = new Map<string, string>();
        for (const attribute of attributes) {
          const index = attribute.indexOf("=");
          fields.set(
            (index < 0 ? attribute : attribute.slice(0, index))
              .trim()
              .toLowerCase(),
            index < 0 ? "" : attribute.slice(index + 1).trim(),
          );
        }
        const maxAge = Number(fields.get("max-age"));
        if (Number.isFinite(maxAge) && maxAge <= 0) {
          await ses.cookies.remove(currentUrl, name);
          continue;
        }
        const expires = fields.get("expires");
        const expirationDate = Number.isFinite(maxAge)
          ? Date.now() / 1000 + maxAge
          : expires && Number.isFinite(Date.parse(expires))
            ? Date.parse(expires) / 1000
            : undefined;
        await ses.cookies.set({
          url: currentUrl,
          name,
          value,
          domain: fields.get("domain") || undefined,
          path: fields.get("path") || undefined,
          secure: fields.has("secure"),
          httpOnly: fields.has("httponly"),
          expirationDate,
        });
      }
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location)
        return response;
      if (redirects === 20) throw new Error("HTTP 重定向次数超过限制");
      await response.body?.cancel();
      if (
        response.status === 303 ||
        ([301, 302].includes(response.status) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error("HTTP 重定向次数超过限制");
  }
  private async host(source: Source, m: any): Promise<any> {
    const ses = this.sourceSession(source);
    switch (m.method) {
      case "http": {
        const url = httpURL(m.url);
        await this.sourceSessionSetup.get(ses);
        const prepared = prepareSourceRequest(m.headers || {}, m.extra || {});
        const headers = prepared.headers;
        if (
          !m.serialized &&
          Object.entries(m.headers || {}).some(
            ([key, value]) =>
              key.toLowerCase() === "prevent-parallel" &&
              String(value) === "true",
          )
        ) {
          const key = `${source.id}:${new URL(url).origin}${new URL(url).pathname}`;
          const previous = this.requestTails.get(key) || Promise.resolve();
          const result = previous
            .catch(() => {})
            .then(() => this.host(source, { ...m, serialized: true }));
          this.requestTails.set(key, result);
          void result
            .finally(() => {
              if (this.requestTails.get(key) === result)
                this.requestTails.delete(key);
            })
            .catch(() => {});
          return result;
        }
        const storedCookies = await ses.cookies.get({ url });
        const cookies = new Map(
          storedCookies.map((cookie) => [
            cookie.name,
            cookie.value,
          ]),
        );
        if (source.meta.key === "ehentai" && new URL(url).hostname === "exhentai.org") {
          const proxyRoute = (await ses.resolveProxy(url)).split(/[;,]/, 1)[0].trim();
          console.info("[ExHentai session diagnostics]", JSON.stringify({
            url: `${new URL(url).origin}${new URL(url).pathname}`,
            queryKeys: [...new Set(new URL(url).searchParams.keys())],
            proxyRoute: proxyRoute.toUpperCase().startsWith("DIRECT") ? "direct" : "proxy",
            sourceRequestedTransport: prepared.httpClient || "default",
            selectedTransport:
              prepared.httpClient === "dart:io" &&
              (proxyRoute.toUpperCase().startsWith("DIRECT") || !proxyRoute)
                ? "native-http"
                : "electron-session",
            cookies: storedCookies.map((cookie) => ({
              name: cookie.name,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite,
              expirationDate: cookie.expirationDate,
            })),
            explicitCookieNames: (headers.get("cookie") || "")
              .split(";")
              .map((pair) => pair.slice(0, pair.indexOf("=")).trim())
              .filter(Boolean),
          }));
        }
        for (const pair of (headers.get("cookie") || "").split(";")) {
          const equal = pair.indexOf("=");
          if (equal > 0)
            cookies.set(
              pair.slice(0, equal).trim(),
              pair.slice(equal + 1).trim(),
            );
        }
        if (cookies.size)
          headers.set(
            "cookie",
            [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
          );
        const signal = AbortSignal.any([
          this.sourceAbort.get(source.id)!.signal,
          ...(m.requestTag && this.jobs.has(m.requestTag)
            ? [this.jobs.get(m.requestTag)!.signal]
            : []),
          AbortSignal.timeout(45000),
        ]);
        const method = String(m.http_method || "GET").toUpperCase();
        let body = m.data;
        if (
          body &&
          typeof body === "object" &&
          !(body instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(body)
        ) {
          if (
            headers
              .get("content-type")
              ?.includes("application/x-www-form-urlencoded")
          )
            body = new URLSearchParams(body).toString();
          else {
            body = JSON.stringify(body);
            if (!headers.has("content-type"))
              headers.set("content-type", "application/json");
          }
        }
        const cacheable = method === "GET" && body == null;
        const cacheKey = cacheable
          ? sourceResponseCacheKey(source.id, url, headers)
          : "";
        if (cacheable && prepared.cacheTime === "no") {
          const old = this.sourceResponseCache.get(cacheKey);
          if (old) {
            this.sourceResponseCacheBytes -= old.body.byteLength;
            this.sourceResponseCache.delete(cacheKey);
          }
        } else if (cacheable) {
          const cached = this.sourceResponseCache.get(cacheKey);
          const lifetime = prepared.cacheTime === "long" ? 6 * 60 * 60 * 1000 : 5000;
          if (cached && Date.now() - cached.time < lifetime) {
            this.sourceResponseCache.delete(cacheKey);
            this.sourceResponseCache.set(cacheKey, { ...cached, time: Date.now() });
            return {
              status: cached.status ?? 200,
              headers: cached.headers,
              body: m.bytes ? cached.body.slice().buffer : new TextDecoder().decode(cached.body),
              cookies: await ses.cookies.get({}),
            };
          }
          if (cached) {
            this.sourceResponseCacheBytes -= cached.body.byteLength;
            this.sourceResponseCache.delete(cacheKey);
          }
        }
        // Match the source API's transport selection. Venera uses its default
        // client for ExHentai's Network.get(url, {}); only explicit
        // http_client: dart:io requests opt into the native request path.
        const useNativeHttp = prepared.httpClient === "dart:io";
        const response = useNativeHttp
          ? await this.nativeHttpRequest(ses, url, {
              method,
              headers,
              body: ["GET", "HEAD"].includes(method) ? undefined : body,
              signal,
            }, source.meta.key === "ehentai")
          : await ses.fetch(url, {
              method,
              headers,
              body: ["GET", "HEAD"].includes(method) ? undefined : body,
              signal,
              credentials: "include",
              redirect: "follow",
            });
        const length = Number(response.headers.get("content-length"));
        if (length > 64 * 1024 * 1024) throw new Error("源响应超过 64 MiB");
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > 64 * 1024 * 1024) {
                await reader.cancel();
                throw new Error("源响应超过 64 MiB");
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        const contentBytes = Uint8Array.from(Buffer.concat(chunks));
        if (source.meta.key === "ehentai" && new URL(url).hostname === "exhentai.org") {
          const responseUrl = new URL(url);
          console.info("[ExHentai response body diagnostics]", JSON.stringify({
            transport: useNativeHttp ? "native-http" : "electron-session",
            url: `${responseUrl.origin}${responseUrl.pathname}`,
            queryKeys: [...new Set(responseUrl.searchParams.keys())],
            statusCode: response.status,
            bodyBytes: contentBytes.byteLength,
          }));
        }
        const data = contentBytes.slice().buffer;
        const responseHeaders = Object.fromEntries(response.headers);
        const jsonResponse = /\bjson\b/i.test(response.headers.get("content-type") || "");
        let wellFormedJson = true;
        if (jsonResponse && contentBytes.byteLength > 0) {
          try { JSON.parse(new TextDecoder().decode(contentBytes)); } catch { wellFormedJson = false; }
        }
        if (
          cacheable &&
          response.status === 200 &&
          wellFormedJson &&
          contentBytes.byteLength > 0 &&
          contentBytes.byteLength < 1024 * 1024
        ) {
          const cacheEntry = {
            sourceId: source.id,
            time: Date.now(),
            headers: responseHeaders,
            body: contentBytes.slice(),
            status: response.status,
          };
          const old = this.sourceResponseCache.get(cacheKey);
          if (old) this.sourceResponseCacheBytes -= old.body.byteLength;
          this.sourceResponseCache.delete(cacheKey);
          this.sourceResponseCache.set(cacheKey, cacheEntry);
          this.sourceResponseCacheBytes += cacheEntry.body.byteLength;
          while (this.sourceResponseCacheBytes > 10 * 1024 * 1024 && this.sourceResponseCache.size) {
            const [oldestKey, oldest] = this.sourceResponseCache.entries().next().value!;
            this.sourceResponseCache.delete(oldestKey);
            this.sourceResponseCacheBytes -= oldest.body.byteLength;
          }
        }
        return {
          status: response.status,
          headers: responseHeaders,
          body: m.bytes ? data : new TextDecoder().decode(data),
          cookies: await ses.cookies.get({}),
        };
      }
      case "cookie": {
        const url = httpURL(m.url);
        if (m.function === "set")
          for (const cookie of m.cookies || []) {
            const requested = new URL(url);
            const domain = String(cookie.domain || "")
              .replace(/^\./, "")
              .toLowerCase();
            const requestedHost = requested.hostname.toLowerCase();
            // Electron validates that a cookie's domain belongs to its URL.
            // Source APIs commonly submit cookies for several domains in one
            // call (ehentai does this for e-hentai.org and exhentai.org), so
            // honor each cookie's own domain instead of reusing that call URL.
            const cookieUrl =
              domain &&
              requestedHost !== domain &&
              !requestedHost.endsWith(`.${domain}`)
                ? `${requested.protocol}//${domain}${requested.port ? `:${requested.port}` : ""}${cookie.path || "/"}`
                : url;
            await ses.cookies.set({
              url: cookieUrl,
              name: String(cookie.name),
              value: String(cookie.value),
              ...(cookie.domain ? { domain: cookie.domain } : {}),
              path: cookie.path || "/",
              ...(cookie.secure ? { secure: true } : {}),
              ...(cookie.httpOnly ? { httpOnly: true } : {}),
              ...(Number.isFinite(Number(cookie.expirationDate))
                ? { expirationDate: Number(cookie.expirationDate) }
                : {}),
              ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
            });
          }
        if (m.function === "delete")
          for (const cookie of await ses.cookies.get({ url }))
            await ses.cookies.remove(url, cookie.name);
        return ses.cookies.get({});
      }
      case "setClipboard":
        clipboard.writeText(String(m.text));
        return null;
      case "persist":
        source.state = m.state;
        this.save(source);
        return null;
      case "getClipboard":
        return clipboard.readText();
      case "UI": {
        if (this.backgroundSources.has(source.id)) return null;
        const loadingKey = `${source.id}:${m.id}`;
        if (m.function === "cancelLoading") {
          const id = this.loadingUI.get(loadingKey);
          if (id) {
            const pending = this.ui.get(id);
            if (pending) {
              clearTimeout(pending.timer);
              pending.resolve(false);
              this.ui.delete(id);
            }
            this.loadingUI.delete(loadingKey);
            this.getWindow()?.webContents.send("comic:ui", {
              id,
              sourceId: source.id,
              kind: "dismiss",
            });
          }
          return null;
        }
        if (m.function === "launchUrl") {
          await shell.openExternal(httpURL(m.url));
          return null;
        }
        if (m.function === "showMessage") {
          this.getWindow()?.webContents.send("comic:ui", {
            id: randomUUID(),
            sourceId: source.id,
            kind: "message",
            message: String(m.message),
          });
          return null;
        }
        return new Promise((resolve) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            this.ui.delete(id);
            this.getWindow()?.webContents.send("comic:ui", {
              id,
              sourceId: source.id,
              kind: "dismiss",
            });
            resolve(null);
          }, 120000);
          this.ui.set(id, {
            sourceId: source.id,
            token: source.token!,
            resolve,
            timer,
          });
          if (m.function === "showLoading") this.loadingUI.set(loadingKey, id);
          let image: string | undefined;
          if (m.image instanceof ArrayBuffer)
            image = `data:image/png;base64,${Buffer.from(m.image).toString("base64")}`;
          else if (typeof m.image === "string")
            image = this.assetURL({
              sourceId: source.id,
              comicId: "_ui",
              chapterId: null,
              index: 0,
              thumbnail: true,
              url: m.image,
            });
          this.getWindow()?.webContents.send("comic:ui", {
            id,
            sourceId: source.id,
            kind: m.function,
            cancelable: !!m.onCancel,
            title: m.title,
            content: m.content,
            options: m.options,
            actions: m.actions?.map((a: any) => ({
              text: a.text,
              style: a.style,
            })),
            image,
          });
        });
      }
      default:
        throw new Error(`未知宿主调用 ${m.method}`);
    }
  }
  private info(source: Source): ComicSourceInfo {
    return {
      ...clean(source.meta),
      id: source.id,
      url: source.url,
      hash: source.hash,
      enabled: source.enabled,
      logged: source.state.logged,
      settingValues: source.state.settings,
      error: source.error,
      update: source.update,
    };
  }
  sources = async () =>
    [...this.sourcesMap.values()]
      .filter((s) => !s.staging)
      .map((s) => this.info(s));
  repositories = async (): Promise<string[]> =>
    this.store.get("preferences", "repositories") || [DEFAULT_COMIC_REPOSITORY];
  private async rememberRepository(url: string) {
    this.store.set("preferences", "repositories", [
      ...new Set([...(await this.repositories()), url]),
    ]);
  }
  private parseRepository = async (
    url: string,
    text: string,
  ): Promise<ComicRepositoryEntry[]> => {
    if (text.length > 4 * 1024 * 1024) throw new Error("源仓库过大");
    let entries: any;
    try {
      entries = JSON.parse(text);
    } catch {
      throw new Error("源地址不是有效的 JSON 仓库索引");
    }
    if (!Array.isArray(entries) || entries.length > 5000)
      throw new Error("无效源仓库格式：预期为漫画源列表");
    const result = entries.map((entry: any) => {
      if (!entry || typeof entry !== "object")
        throw new Error("源仓库中包含无效条目");
      const rawScriptURL = entry.url || entry.fileName || entry.filename;
      if (typeof rawScriptURL !== "string" || !rawScriptURL)
        throw new Error("源仓库条目缺少脚本地址");
      const scriptURL = sourceURL(
        entry.url ? new URL(entry.url, url).href : new URL(rawScriptURL, url).href,
      );
      return {
        name: String(entry.name || entry.key || rawScriptURL),
        url: scriptURL,
        version: entry.version,
        description: entry.description,
        key: entry.key,
        installedId: [...this.sourcesMap.values()].find(
          (s) => s.url === scriptURL || (entry.key && s.meta.key === entry.key),
        )?.id,
      };
    });
    await this.rememberRepository(url);
    return result;
  };
  repository = async (address: string): Promise<ComicRepositoryEntry[]> => {
    const url = sourceURL(address);
    const response = await session
      .fromPartition("comic-repositories")
      .fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    if (!response.ok) throw new Error(`源仓库请求失败 (${response.status})`);
    return this.parseRepository(url, await response.text());
  };
  openAddress = async (address: string): Promise<ComicAddressResult> => {
    const url = sourceURL(address);
    const response = await session
      .fromPartition("comic-repositories")
      .fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    if (!response.ok) throw new Error(`源地址请求失败 (${response.status})`);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error("源文件超过 4 MiB");
    const contentType = response.headers.get("content-type") || "";
    const trimmed = text.trimStart();
    if (contentType.includes("text/html") || /^<!doctype html|^<html\b/i.test(trimmed))
      throw new Error("链接返回了网页而不是漫画源脚本，请使用 Raw 或 jsDelivr 脚本链接");
    let parsed: unknown;
    if (trimmed.startsWith("[")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("仓库索引 JSON 格式错误");
      }
      if (!Array.isArray(parsed)) throw new Error("无效源仓库格式");
      return { kind: "repository", entries: await this.parseRepository(url, text) };
    }
    try {
      const installed = await this.installScript(text, url);
      return { kind: "source", source: installed };
    } catch (error) {
      throw new Error(`漫画源初始化失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };
  removeRepository = async (url: string) => {
    this.store.set(
      "preferences",
      "repositories",
      (await this.repositories()).filter((item) => item !== url),
    );
  };
  private async script(url: string) {
    const r = await session
      .fromPartition("comic-repositories")
      .fetch(sourceURL(url), {
        signal: AbortSignal.timeout(30000),
        cache: "no-store",
      });
    if (!r.ok) throw new Error(`源脚本请求失败 (${r.status})`);
    const text = await r.text();
    if (text.length > 4 * 1024 * 1024) throw new Error("源脚本过大");
    const trimmed = text.trimStart();
    if (/^<!doctype html|^<html\b/i.test(trimmed))
      throw new Error("脚本链接返回了网页，请使用 Raw 或 jsDelivr 链接");
    return text;
  }
  private async installScript(script: string, url: string, previous?: Source) {
    const candidate: Source = {
      staging: true,
      id: randomUUID(),
      script,
      url,
      hash: digest(script),
      enabled: true,
      meta: {},
      state: { data: {}, settings: {}, logged: false, cookies: [] },
    };
    this.sourcesMap.set(candidate.id, candidate);
    const cleanup = async () => {
      await this.unload(candidate);
      this.sourcesMap.delete(candidate.id);
      await this.sourceSession(candidate).clearStorageData();
    };
    try {
      await this.ready(candidate.id, false);
      const duplicate =
        previous ||
        [...this.sourcesMap.values()].find(
          (s) => !s.staging && s.meta.key === candidate.meta.key,
        );
      if (duplicate) {
        if (candidate.meta.key !== duplicate.meta.key)
          throw new Error("更新脚本的源标识发生变化");
        await this.unload(candidate);
        candidate.state = structuredClone(duplicate.state);
        const ses = this.sourceSession(candidate);
        for (const cookie of await this.sourceSession(duplicate).cookies.get(
          {},
        )) {
          if (!cookie.domain) continue;
          const url =
            (cookie.secure ? "https://" : "http://") +
            cookie.domain.replace(/^\./, "") +
            (cookie.path || "/");
          await ses.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expirationDate: cookie.expirationDate,
          });
        }
        await this.ready(candidate.id, true);
        const meta = candidate.meta,
          state = candidate.state;
        await cleanup();
        const resumable = this.store
          .all<Download>("download")
          .filter(
            (task) =>
              task.sourceId === duplicate.id &&
              ["queued", "downloading"].includes(task.state),
          );
        for (const task of resumable)
          await this.downloadAction(task.id, "pause");
        await this.unload(duplicate);
        Object.assign(duplicate, {
          script,
          url: url || duplicate.url,
          hash: digest(script),
          meta,
          state,
          error: undefined,
          update: false,
        });
        this.save(duplicate);
        for (const task of resumable)
          await this.downloadAction(task.id, "resume");
        this.changed();
        return this.info(duplicate);
      }
      const stableId = digest("venera:" + candidate.meta.key).slice(0, 32);
      const state = candidate.state,
        meta = candidate.meta;
      await cleanup();
      const source: Source = {
        ...candidate,
        id: stableId,
        token: undefined,
        staging: false,
        state,
        meta,
        url: url || meta.url || "",
      };
      this.sourcesMap.set(source.id, source);
      this.save(source);
      this.changed();
      return this.info(source);
    } catch (error) {
      if (this.sourcesMap.has(candidate.id)) await cleanup();
      throw error;
    }
  }

  install = async (url: string) =>
    this.installScript(await this.script(url), httpURL(url));
  importFile = async () => {
    const result = await dialog.showOpenDialog(this.getWindow()!, {
      title: "导入 Venera 漫画源",
      filters: [{ name: "JavaScript 漫画源", extensions: ["js"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return null;
    const stat = await fs.stat(result.filePaths[0]);
    if (stat.size > 4 * 1024 * 1024) throw new Error("漫画源脚本过大");
    return this.installScript(
      await fs.readFile(result.filePaths[0], "utf8"),
      "",
    );
  };
  enable = async (id: string, enabled: boolean) => {
    const s = this.source(id);
    if (typeof enabled !== "boolean") throw new Error("无效状态");
    if (!enabled) {
      for (const task of this.store.all<Download>("download"))
        if (
          task.sourceId === id &&
          ["queued", "downloading"].includes(task.state)
        )
          await this.downloadAction(task.id, "pause");
      await this.unload(s);
    }
    s.enabled = enabled;
    this.save(s);
    this.changed();
  };
  uninstall = async (id: string) => {
    const s = this.source(id);
    for (const job of this.store.all<Download>("download"))
      if (job.sourceId === id && ["queued", "downloading"].includes(job.state))
        await this.downloadAction(job.id, "pause");
    await this.unload(s);
    await this.sourceSession(s).clearStorageData();
    this.sourcesMap.delete(id);
    this.store.delete("source", id);
    this.changed();
  };
  checkUpdates = async () => {
    await Promise.allSettled(
      [...this.sourcesMap.values()]
        .filter((s) => s.url)
        .map(async (s) => {
          try {
            const script = await this.script(s.url);
            s.update = digest(script) !== s.hash;
            s.error = undefined;
          } catch (error) {
            s.error = String(error);
          }
        }),
    );
    this.changed();
    return this.sources();
  };
  update = async (id: string) => {
    const s = this.source(id);
    return this.installScript(await this.script(s.url), s.url, s);
  };
  settings = async (id: string, values: Record<string, unknown>) => {
    const s = this.source(id);
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("无效源设置");
    for (const [key, value] of Object.entries(values)) {
      const spec = s.meta.settings?.[key];
      if (!spec || ["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("未知源设置");
      if (
        spec.validator &&
        typeof value === "string" &&
        !new RegExp(spec.validator).test(value)
      )
        throw new Error(`${spec.title || key} 格式无效`);
    }
    await this.unload(s);
    s.state.settings = { ...s.state.settings, ...values };
    this.save(s);
    this.changed();
  };
  settingAction = async (id: string, key: string) => {
    const s = await this.ready(id);
    if (
      !Object.hasOwn(s.meta.settings || {}, key) ||
      s.meta.settings[key].type !== "callback"
    )
      throw new Error("未知设置操作");
    await this.rpc(
      s,
      "evaluate",
      `__source.settings[${JSON.stringify(key)}].callback()`,
    );
    this.changed();
  };
  private async invoke(id: string, method: string, args: any[] = []) {
    return this.rpc(await this.ready(id), "call", method, args);
  }
  private loadComicInfo(source: Source, comicId: string, refresh = false) {
    const previous = this.comicInfo.get(source);
    if (
      previous &&
      previous.token === source.token &&
      previous.comicId === comicId &&
      (!refresh || previous.pending)
    )
      return previous.result;

    // Some sources populate instance fields in loadInfo (e.g. Hitomi's gallery
    // cache). Prime those once per current comic/runtime, and share an in-flight
    // detail request with the reader instead of requesting it again per chapter.
    const entry = {
      token: source.token!,
      comicId,
      pending: true,
      result: this.rpc(source, "call", "comic.loadInfo", [comicId]),
    };
    this.comicInfo.set(source, entry);
    entry.result = entry.result.then(
      (raw) => {
        entry.pending = false;
        // Concurrent detail views can finish out of order. The last completed
        // loadInfo owns the source's mutable comic context.
        if (source.token === entry.token) this.comicInfo.set(source, entry);
        return raw;
      },
      (error) => {
        if (this.comicInfo.get(source) === entry) this.comicInfo.delete(source);
        throw error;
      },
    );
    return entry.result;
  }
  private async paged(
    id: string,
    base: string,
    args: any[],
    page: number,
    next?: string | null,
  ) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new Error("无效页码");
    const s = await this.ready(id);
    const numbered = await this.rpc(s, "has", `${base}.load`);
    return this.page(
      id,
      await this.rpc(s, "call", `${base}.${numbered ? "load" : "loadNext"}`, [
        ...args,
        numbered ? page : (next ?? null),
      ]),
    );
  }
  search = async (
    id: string,
    keyword: string,
    options: unknown[],
    page: number,
    next?: string | null,
  ) =>
    this.paged(
      id,
      "search",
      [String(keyword).slice(0, 4096), options],
      page,
      next,
    );
  explore = async (
    id: string,
    index: number,
    page: number,
    next?: string | null,
  ) => {
    const s = await this.ready(id);
    if (!Number.isInteger(index) || !s.meta.explore[index])
      throw new Error("未知探索栏目");
    const type = s.meta.explore[index].type;
    const numbered = await this.rpc(
      s,
      "evaluate",
      `typeof __source.explore[${index}].load==='function'`,
    );
    const argument =
      type === "singlePageWithMultiPart"
        ? null
        : type === "mixed"
          ? page - 1
          : numbered
            ? page
            : (next ?? null);
    const result = this.page(
      id,
      await this.rpc(
        s,
        "evaluate",
        `__source.explore[${index}].${numbered ? "load" : "loadNext"}(${JSON.stringify(argument)})`,
      ),
    );
    return type === "singlePageWithMultiPart"
      ? { ...result, maxPage: 1, next: null }
      : result;
  };
  category = async (
    id: string,
    category: string,
    param: any,
    options: unknown[],
    page: number,
    next?: string | null,
  ) => this.paged(id, "categoryComics", [category, param, options], page, next);
  categories = async (id: string) => {
    const s = await this.ready(id);
    return clean(
      await this.rpc(
        s,
        "evaluate",
        "(async()=>{let c=__source.category;if(!c)return null;return {...c,parts:await Promise.all((c.parts||[]).map(async p=>({...p,items:p.type==='dynamic'?await p.loader():null})))}})()",
      ),
    );
  };
  ranking = async (
    id: string,
    option: string,
    page: number,
    next?: string | null,
  ) => {
    const s = await this.ready(id);
    const numbered = await this.rpc(s, "has", "categoryComics.ranking.load");
    return this.page(
      id,
      await this.rpc(
        s,
        "call",
        numbered
          ? "categoryComics.ranking.load"
          : "categoryComics.ranking.loadWithNext",
        [option, numbered ? page : (next ?? null)],
      ),
    );
  };
  private assetURL(asset: Asset) {
    const token = digest(
      JSON.stringify([
        asset.sourceId,
        asset.comicId,
        asset.chapterId,
        asset.index,
        asset.thumbnail ? asset.url : "page",
        ...(asset.preview ? ["preview"] : []),
      ]),
    );
    this.store.set("asset", token, asset);
    return `media://comic/${token}`;
  }
  private comic(id: string, raw: any): OnlineComic {
    const comic: OnlineComic = {
      sourceId: id,
      comicId: String(raw.id ?? raw.comicId),
      title: String(raw.title || "未命名漫画"),
      subtitle: raw.subtitle || raw.subTitle,
      description: raw.description,
      tags: clean(raw.tags),
      favoriteId: raw.favoriteId,
      cover: "",
    };
    if (raw.cover)
      comic.cover = this.assetURL({
        sourceId: id,
        comicId: comic.comicId,
        chapterId: null,
        index: 0,
        url: raw.cover,
        thumbnail: true,
      });
    if (raw.favoriteId != null)
      this.store.set("favoriteId", comicKey(comic), raw.favoriteId);
    return comic;
  }
  private page(id: string, raw: any): ComicSearchPage {
    const sections = comicSections(raw).map((section) => ({
      ...section,
      comics: section.comics.map((c) => this.comic(id, c)),
    }));
    return {
      comics: sections.flatMap((s) => s.comics),
      sections,
      maxPage: raw?.maxPage,
      next: raw?.next,
    };
  }
  private thumbnailURLs(ref: OnlineComicRef, urls: unknown): string[] {
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string"))
      throw new Error("源返回了无效的预览图片列表");
    // Keep opaque image keys intact: onThumbnailLoad may resolve them to URLs.
    return urls.map((url) => this.assetURL({ ...ref, chapterId: null, index: 0, url, thumbnail: true, preview: true }));
  }
  thumbnails = async (ref: OnlineComicRef, next: string | null = null): Promise<ComicThumbnailPage> => {
    refCheck(ref);
    if (next !== null && (typeof next !== "string" || next.length > 16384))
      throw new Error("无效预览分页游标");
    const source = await this.ready(ref.sourceId);
    const token = source.token;
    const key = JSON.stringify([token, comicKey(ref), next]);
    const pending = this.thumbnailRequests.get(key);
    if (pending) return pending;
    const result = (async () => {
      await this.loadComicInfo(source, ref.comicId);
      const raw = await this.rpc(source, "call", "comic.loadThumbnails", [ref.comicId, next]);
      if (source.token !== token) throw new Error("漫画源实例已失效");
      const cursor = raw?.next ?? null;
      if (cursor !== null && (typeof cursor !== "string" || cursor.length > 16384))
        throw new Error("源返回了无效的预览分页游标");
      if (cursor !== null && cursor === next) throw new Error("源返回了重复的预览分页游标");
      return { thumbnails: this.thumbnailURLs(ref, raw?.thumbnails), next: cursor };
    })().finally(() => this.thumbnailRequests.delete(key));
    this.thumbnailRequests.set(key, result);
    return result;
  };
  details = async (
    ref: OnlineComicRef,
    refresh = false,
  ): Promise<OnlineComicDetails> => {
    refCheck(ref);
    const saved = this.store.get<SavedComic>("comic", comicKey(ref));
    if (saved && !refresh && (
      (typeof saved.details.hasChapters === "boolean" && typeof saved.details.hasThumbnailLoader === "boolean") ||
      !this.sourcesMap.get(ref.sourceId)?.enabled
    )) return this.decorate(saved);
    try {
      const source = await this.ready(ref.sourceId);
      const raw = await this.loadComicInfo(
        source,
        ref.comicId,
        refresh,
      );
      const card = this.comic(ref.sourceId, { ...raw, id: ref.comicId });
      const details: OnlineComicDetails = {
        ...card,
        chapters: chapters(raw.chapters),
        hasChapters: raw.chapters != null,
        // A broken static thumbnail must not prevent normal reading, or shift
        // the remaining preview page numbers. Invalid entries fail per tile.
        thumbnails: Array.isArray(raw.thumbnails)
          ? this.thumbnailURLs(ref, raw.thumbnails.map((url: unknown) => typeof url === "string" ? url : ""))
          : undefined,
        hasThumbnailLoader: await this.rpc(source, "has", "comic.loadThumbnails"),
        updateTime: raw.updateTime,
        isFavorite: raw.isFavorite,
        favorite: saved?.favorite || false,
      };
      const record: SavedComic = {
        ...saved,
        ref,
        details,
        favorite: saved?.favorite || false,
      };
      this.store.set("comic", comicKey(ref), record);
      return this.decorate(record);
    } catch (error) {
      if (saved)
        return {
          ...this.decorate(saved),
          offline: true,
          refreshError: String(error).replace(/^Error:\s*/, ""),
        };
      throw error;
    }
  };
  private decorate(saved: SavedComic): OnlineComicDetails {
    return {
      ...saved.details,
      hasChapters: saved.details.hasChapters ?? !(saved.details.chapters.length === 1 && saved.details.chapters[0].id === null),
      hasThumbnailLoader: saved.details.hasThumbnailLoader ?? false,
      favorite: saved.favorite,
      lastChapterId: saved.lastChapterId,
      chapters: saved.details.chapters.map((c) => ({
        ...c,
        progress: this.store.get(
          "progress",
          chapterKey({ ...saved.ref, chapterId: c.id }),
        ),
        downloaded:
          this.store.get<Download>(
            "download",
            chapterKey({ ...saved.ref, chapterId: c.id }),
          )?.state === "completed",
      })),
    };
  }
  favorite = async (ref: OnlineComicRef, value: boolean) => {
    await this.details(ref);
    const saved = this.store.get<SavedComic>("comic", comicKey(ref))!;
    saved.favorite = !!value;
    this.store.set("comic", comicKey(ref), saved);
    this.changed();
  };
  library = async (section: "shelf" | "history" | "downloads") =>
    this.store
      .all<SavedComic>("comic")
      .filter((c) =>
        section === "shelf"
          ? c.favorite
          : section === "history"
            ? c.opened
            : this.store
                .all<Download>("download")
                .some(
                  (d) =>
                    comicKey(d) === comicKey(c.ref) && d.state === "completed",
                ),
      )
      .sort((a, b) => (b.opened || 0) - (a.opened || 0))
      .map((c) => c.details);
  hubList = async (list: ComicHubList): Promise<ComicHubRef[]> => {
    if (!["readLater", "following"].includes(list))
      throw new Error("未知漫画清单");
    return this.store
      .all<HubRecord>(`hub:${list}`)
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((record) => record.ref);
  };
  hubSet = async (
    list: ComicHubList,
    ref: ComicHubRef,
    value: boolean,
  ) => {
    if (!["readLater", "following"].includes(list))
      throw new Error("未知漫画清单");
    if (
      !ref ||
      (ref.kind === "local"
        ? typeof ref.mediaId !== "string" || !ref.mediaId
        : ref.kind !== "online" ||
          typeof ref.sourceId !== "string" ||
          typeof ref.comicId !== "string" ||
          !ref.comicId)
    )
      throw new Error("无效漫画标识");
    if (list === "following" && ref.kind !== "online")
      throw new Error("追更仅支持在线漫画");
    const id = digest(JSON.stringify(ref));
    if (!value) {
      this.store.delete(`hub:${list}`, id);
      if (list === "following") this.store.delete("follow", id);
      this.changed();
      return;
    }
    const previous = this.store.get<HubRecord>(`hub:${list}`, id);
    this.store.set(`hub:${list}`, id, {
      ref,
      addedAt: previous?.addedAt ?? Date.now(),
    });
    if (list === "following" && ref.kind === "online") {
      const saved = this.store.get<SavedComic>("comic", comicKey(ref));
      this.store.set("follow", id, {
        ref,
        addedAt: previous?.addedAt ?? Date.now(),
        baselineChapterIds: saved?.details.chapters.map((c) => c.id ?? "") ?? [],
        newChapterIds: [],
      });
    }
    this.changed();
  };
  following = async (): Promise<ComicFollowState[]> =>
    this.store
      .all<FollowRecord>("follow")
      .map(({ baselineChapterIds: _baseline, ...state }) => state)
      .sort((a, b) => b.addedAt - a.addedAt);
  checkFollowing = async (only?: OnlineComicRef) => {
    const all = this.store.all<FollowRecord>("follow");
    const queue = all.filter(
      (state) => !only || comicKey(state.ref) === comicKey(only),
    );
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const state = queue[next++];
        const source = this.sourcesMap.get(state.ref.sourceId);
        if (!source?.enabled) {
          state.error = source ? "漫画源已停用" : "漫画源已卸载";
          this.store.set("follow", digest(JSON.stringify({ kind: "online", ...state.ref })), state);
          continue;
        }
        this.backgroundSources.add(source.id);
        try {
          const details = await this.details(state.ref, true);
          if (details.offline && details.refreshError)
            throw new Error(details.refreshError);
          const chapterIds = details.chapters.map((chapter) => chapter.id ?? "");
          const unseen = chapterIds.filter(
            (id) => !state.baselineChapterIds.includes(id),
          );
          state.newChapterIds = [...new Set([...state.newChapterIds, ...unseen])]
            .filter((id) => {
              const progress = this.store.get<Progress>(
                "progress",
                chapterKey({ ...state.ref, chapterId: id || null }),
              );
              return !progress?.completed;
            });
          state.baselineChapterIds = chapterIds;
          state.checkedAt = Date.now();
          state.error = undefined;
        } catch (error) {
          state.error = String(error).replace(/^Error:\s*/, "");
        } finally {
          this.backgroundSources.delete(source.id);
        }
        this.store.set("follow", digest(JSON.stringify({ kind: "online", ...state.ref })), state);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
    this.changed();
    return this.following();
  };
  login = async (id: string, kind: string, values: string[]) => {
    const s = await this.ready(id, false);
    const token = s.token;
    if (kind !== "webview" && !this.initialized.has(token!)) {
      try {
        await this.ready(id, true);
      } catch {
        /* Login may repair an authenticated initialization request. */
      }
    }
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
      throw new Error("无效登录参数");
    if (kind === "password") {
      const result = await this.rpc(
        s,
        "call",
        "account.login",
        values.slice(0, 2),
      );
      if (result == null || result === false) throw new Error("登录失败");
    } else if (kind === "cookies") {
      const valid = await this.rpc(
        s,
        "call",
        "account.loginWithCookies.validate",
        [values],
      );
      if (!valid) throw new Error("Cookie 验证失败");
    } else if (kind === "webview") await this.webLogin(s);
    else throw new Error("不支持的登录方式");
    if (s.token !== token || !s.enabled || this.sourcesMap.get(id) !== s)
      throw new Error("源实例已失效");
    s.state.logged = true;
    s.imageEpoch = randomUUID();
    await this.rpc(s, "state", {
      logged: true,
      cookies: await this.sourceSession(s).cookies.get({}),
    });
    this.save(s);
    this.changed();
  };
  private async webLogin(s: Source) {
    const token = s.token!;
    const config = await this.rpc(
      s,
      "evaluate",
      "({url:__source.account.loginWithWebview.url})",
    );
    await this.sourceSessionSetup.get(this.sourceSession(s));
    await new Promise<void>((resolve, reject) => {
      const win = new BrowserWindow({
        width: 1000,
        height: 760,
        parent: this.getWindow() || undefined,
        title: `${s.meta.name} · 登录`,
        webPreferences: {
          partition: `persist:comic-${s.id}`,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      this.webLogins.set(win, { sourceId: s.id, token });
      let finished = false,
        checking = false;
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) void win.loadURL(url);
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event, url) => {
        if (!/^https?:/.test(url)) event.preventDefault();
      });
      const check = async () => {
        if (finished || checking || win.isDestroyed()) return;
        checking = true;
        try {
          if (
            s.token !== token ||
            !s.enabled ||
            this.sourcesMap.get(s.id) !== s
          )
            throw new Error("源实例已失效");
          const valid = await this.rpc(
            s,
            "call",
            "account.loginWithWebview.checkStatus",
            [win.webContents.getURL(), win.webContents.getTitle()],
          );
          if (!valid || finished) return;
          const storage = await win.webContents.executeJavaScript(
            "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))",
          );
          if (s.token !== token || finished) throw new Error("源实例已失效");
          s.state.data._localStorage = JSON.parse(storage);
          s.state.cookies = await this.sourceSession(s).cookies.get({});
          await this.rpc(s, "state", {
            data: s.state.data,
            cookies: s.state.cookies,
          });
          if (
            await this.rpc(s, "has", "account.loginWithWebview.onLoginSuccess")
          )
            await this.rpc(
              s,
              "call",
              "account.loginWithWebview.onLoginSuccess",
            );
          // Login callbacks may write cookies after validating the webview.
          // Refresh the runtime snapshot after the callback has completed so
          // subsequent source calls and persisted login state see those writes.
          s.state.cookies = await this.sourceSession(s).cookies.get({});
          await this.rpc(s, "state", { cookies: s.state.cookies });
          finished = true;
          resolve();
          win.close();
        } catch (error) {
          if (!finished) {
            finished = true;
            reject(error);
            win.close();
          }
        } finally {
          checking = false;
        }
      };
      win.webContents.on("did-finish-load", () => {
        void check();
      });
      win.webContents.on("page-title-updated", () => {
        void check();
      });
      win.webContents.on("did-navigate-in-page", () => {
        void check();
      });
      const poll = setInterval(() => {
        void check();
      }, 500);
      win.on("close", () => {
        if (!finished) {
          finished = true;
          reject(new Error("已取消登录"));
        }
      });
      win.on("closed", () => {
        clearInterval(poll);
        this.webLogins.delete(win);
        if (!finished) {
          finished = true;
          reject(new Error("已取消登录"));
        }
      });
      void win.loadURL(httpURL(config.url)).catch((error) => {
        if (!finished) {
          finished = true;
          reject(error);
          if (!win.isDestroyed()) win.close();
        }
      });
    });
  }
  logout = async (id: string) => {
    const s = await this.ready(id, false);
    if (await this.rpc(s, "has", "account.logout"))
      await this.rpc(s, "call", "account.logout");
    s.state.logged = false;
    s.imageEpoch = randomUUID();
    await this.sourceSession(s).clearStorageData();
    await this.rpc(s, "state", { logged: false, cookies: [] });
    this.save(s);
    this.changed();
  };
  respondUI = async (id: string, value: unknown) => {
    const request = this.ui.get(id);
    if (!request) return;
    if (this.sourcesMap.get(request.sourceId)?.token !== request.token)
      throw new Error("源交互已过期");
    this.ui.delete(id);
    clearTimeout(request.timer);
    request.resolve(value);
  };

  readerItem = async (ref: OnlineChapterRef) => {
    chapterCheck(ref);
    const details = await this.details(ref);
    const chapter = details.chapters.find((c) => c.id === ref.chapterId);
    if (!chapter) throw new Error("章节不存在");
    return {
      id: `comic-online:${chapterKey(ref)}`,
      type: "comic" as const,
      title: chapter.title,
      path: "",
      folder: "",
      ext: "online",
      size: 0,
      modifiedAt: 0,
      addedAt: 0,
      missing: false,
      favorite: details.favorite,
      libraryIds: [],
      progress: chapter.progress,
      remoteData: { comicRef: ref },
      cover: details.cover,
    };
  };
  pages = async (ref: OnlineChapterRef, sessionId?: string) => {
    chapterCheck(ref);
    if (sessionId) this.sessions.set(chapterKey(ref), sessionId);
    const download = this.store.get<Download>("download", chapterKey(ref));
    let urls: string[];
    if (download?.state === "completed")
      urls = download.pages.map((_p, index) => `offline:${index}`);
    else {
      const result = await this.loadChapter(ref);
      if (
        !Array.isArray(result?.images) ||
        result.images.some((url: any) => typeof url !== "string")
      )
        throw new Error("源返回了无效的章节图片");
      urls = result.images;
    }
    return urls.map((url, index) => ({
      id: `${ref.chapterId ?? "body"}:${index}`,
      name: `${index + 1}`,
      url: this.assetURL({ ...ref, url, index, thumbnail: false }),
    }));
  };
  private loadChapter(ref: OnlineChapterRef) {
    const previous = this.chapterTails.get(ref.sourceId) || Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(async () => {
        let s: Source;
        try {
          s = await this.ready(ref.sourceId);
        } catch (error) {
          throw new Error(
            `漫画源初始化失败：${String(error).replace(/^(?:Error:\s*)+/, "")}`,
          );
        }
        try {
          await this.loadComicInfo(s, ref.comicId);
        } catch (error) {
          throw new Error(
            `加载作品信息失败：${String(error).replace(/^(?:Error:\s*)+/, "")}`,
          );
        }
        try {
          return await this.rpc(s, "call", "comic.loadEp", [
            ref.comicId,
            ref.chapterId,
          ]);
        } catch (error) {
          throw new Error(
            `加载章节图片列表失败：${String(error).replace(/^(?:Error:\s*)+/, "")}`,
          );
        }
      });
    this.chapterTails.set(ref.sourceId, result);
    void result
      .finally(() => {
        if (this.chapterTails.get(ref.sourceId) === result)
          this.chapterTails.delete(ref.sourceId);
      })
      .catch(() => {});
    return result;
  }
  context = async (ref: OnlineChapterRef) => {
    const details = await this.details(ref);
    const record = this.store.get<SavedComic>("comic", comicKey(ref))!;
    return {
      work: {
        id: comicKey(ref),
        title: details.title,
        chapterIds: details.chapters.map(
          (c) => `comic-online:${chapterKey({ ...ref, chapterId: c.id })}`,
        ),
      },
      chapters: await Promise.all(
        details.chapters.map((c) =>
          this.readerItem({ ...ref, chapterId: c.id }),
        ),
      ),
      preferences: record.preferences || {},
      bookmarks: this.store
        .all<any>("bookmark")
        .filter((b) => b.chapterKey === chapterKey(ref))
        .map((b) => b.bookmark),
    };
  };
  saveProgress = async (ref: OnlineChapterRef, progress: Progress) => {
    chapterCheck(ref);
    if (
      !progress ||
      (progress.page != null &&
        (!Number.isSafeInteger(progress.page) || progress.page < 0)) ||
      (progress.comicOffset != null &&
        (!Number.isFinite(progress.comicOffset) ||
          progress.comicOffset < 0 ||
          progress.comicOffset > 1))
    )
      throw new Error("无效阅读位置");
    await this.details(ref);
    this.store.set("progress", chapterKey(ref), progress);
    const record = this.store.get<SavedComic>("comic", comicKey(ref))!;
    record.opened = Date.now();
    record.lastChapterId = ref.chapterId;
    this.store.set("comic", comicKey(ref), record);
  };
  preferences = async (ref: OnlineComicRef, preferences: any) => {
    await this.details(ref);
    const record = this.store.get<SavedComic>("comic", comicKey(ref))!;
    record.preferences = clean(preferences);
    this.store.set("comic", comicKey(ref), record);
  };
  bookmark = async (ref: OnlineChapterRef, bookmark: ComicBookmark) => {
    chapterCheck(ref);
    if (
      typeof bookmark?.id !== "string" ||
      !Number.isSafeInteger(bookmark.page) ||
      bookmark.page < 0 ||
      !Number.isFinite(bookmark.offset) ||
      bookmark.offset < 0 ||
      bookmark.offset > 1
    )
      throw new Error("无效书签");
    this.store.set("bookmark", bookmark.id, {
      chapterKey: chapterKey(ref),
      bookmark,
    });
  };
  deleteBookmark = async (id: string) => {
    this.store.delete("bookmark", id);
  };
  release = async (ref: OnlineChapterRef, sessionId?: string) => {
    if (!sessionId || this.sessions.get(chapterKey(ref)) === sessionId)
      this.sessions.delete(chapterKey(ref));
  };
  private schedule(
    sourceId: string,
    priority: number,
    run: () => Promise<Buffer>,
  ) {
    return new Promise<Buffer>((resolve, reject) => {
      this.imageQueue.push({ sourceId, priority, run, resolve, reject });
      this.pumpImages();
    });
  }
  private pumpImages() {
    this.imageQueue.sort((a, b) => a.priority - b.priority);
    for (let i = 0; i < this.imageQueue.length;) {
      const task = this.imageQueue[i],
        active = this.activeImages.get(task.sourceId) || {
          read: 0,
          background: 0,
        };
      const total = [...this.activeImages.values()].reduce(
        (sum, value) => sum + value.read + value.background,
        0,
      );
      if (total >= 8) break;
      if (task.priority > 0 ? active.background >= 2 : active.read >= 4) {
        i++;
        continue;
      }
      this.imageQueue.splice(i, 1);
      const key = task.priority ? "background" : "read";
      active[key]++;
      this.activeImages.set(task.sourceId, active);
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          active[key]--;
          this.pumpImages();
        });
    }
  }
  private thumbnailOriginalKey(source: Source, url: string) {
    return digest(JSON.stringify([source.hash, source.id, source.imageEpoch || "", source.state.settings, url]));
  }
  private async loadImage(
    asset: Asset,
    priority: number,
    jobId?: string,
    refresh = false,
  ): Promise<Buffer> {
    if (asset.preview) {
      const parsed = parseThumbnail(asset.url);
      const source = await this.ready(asset.sourceId);
      const key = this.thumbnailOriginalKey(source, parsed.url);
      const file = path.join(this.root, "comic-online", "cache", key);
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(file);
      } catch {
        let pending = this.thumbnailOriginals.get(key);
        if (!pending) {
          pending = this.loadImage({ ...asset, preview: false, url: parsed.url }, priority, jobId, refresh).then(async (data) => {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, data);
            return data;
          });
          this.thumbnailOriginals.set(key, pending);
        }
        try { buffer = await pending; }
        finally { if (this.thumbnailOriginals.get(key) === pending) this.thumbnailOriginals.delete(key); }
      }
      return cropThumbnail(buffer, parsed.crop);
    }
    return this.schedule(asset.sourceId, priority, async () => {
      if (jobId && this.jobs.get(jobId)?.signal.aborted)
        throw new Error("下载已暂停");
      const source = await this.ready(asset.sourceId);
      const result = await this.rpc(source, "image", {
        ...asset,
        priority,
        jobId,
        refresh,
      });
      const buffer = Buffer.from(result);
      await sharp(buffer, {
        limitInputPixels: 80_000_000,
      }).metadata();
      return buffer;
    });
  }
  private async trimCache() {
    const directory = path.join(this.root, "comic-online", "cache");
    const entries = await Promise.all(
      (await fs.readdir(directory))
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .map(async (name) => {
          try {
            const file = path.join(directory, name);
            const stat = await fs.stat(file);
            return { file, size: stat.size, time: stat.mtimeMs };
          } catch {
            return { file: "", size: 0, time: 0 };
          }
        }),
    );
    let size = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (size <= 512 * 1024 * 1024) break;
      if (entry.file) {
        await fs.rm(entry.file, { force: true });
        size -= entry.size;
      }
    }
  }
  async clearCache() {
    const directory = path.join(this.root, "comic-online", "cache");
    const names = await fs
      .readdir(directory)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .map((name) => fs.rm(path.join(directory, name), { force: true })),
    );
  }
  resource = async (request: Request): Promise<Response> => {
    try {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      const token = new URL(request.url).pathname.slice(1);
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("无效资源");
      const asset = this.store.get<Asset>("asset", token);
      if (!asset) throw new Error("资源不存在");
      let buffer: Buffer | undefined;
      const cover =
        asset.thumbnail && !asset.preview &&
        this.store.get<string>("downloadCover", comicKey(asset));
      if (cover) {
        try {
          buffer = await fs.readFile(cover);
        } catch {
          /* Use the network/cache when a saved cover was removed. */
        }
      }
      const downloaded =
        !asset.thumbnail &&
        this.store.get<Download>("download", chapterKey(asset));
      if (downloaded && downloaded.pages[asset.index]) {
        const page = downloaded.pages[asset.index];
        try {
          buffer = await fs.readFile(
            path.join(downloaded.directory, page.file),
          );
          if (
            buffer.length !== page.size ||
            digest(buffer.toString("base64")) !== page.hash
          )
            throw new Error("下载文件损坏");
        } catch {
          buffer = undefined;
          if (asset.url.startsWith("offline:"))
            throw new Error("下载文件已丢失或损坏，请重新下载");
        }
      }
      const source = this.sourcesMap.get(asset.sourceId);
      const sourceHash = source
        ? digest(
            JSON.stringify([
              source.hash,
              source.imageEpoch || "",
              source.state.settings,
            ]),
          )
        : "offline";
      const cachePath = path.join(
        this.root,
        "comic-online",
        "cache",
        digest(`${token}:${sourceHash}:${asset.url}`),
      );
      const refreshPreview = !!(asset.preview && source?.enabled && new URL(request.url).searchParams.has("retry"));
      if (refreshPreview && source) {
        // An explicit image retry must refresh both the tile and its original
        // sprite, including bytes a browser decoder previously rejected.
        await fs.rm(cachePath, { force: true });
        await fs.rm(path.join(this.root, "comic-online", "cache",
          this.thumbnailOriginalKey(source, parseThumbnail(asset.url).url)), { force: true });
      }
      if (!buffer) {
        try {
          buffer = await fs.readFile(cachePath);
        } catch {
          let promise = this.resourcePending.get(cachePath);
          if (!promise) {
            promise = this.loadImage(asset, 0, undefined, refreshPreview).then(async (data) => {
              await fs.mkdir(path.dirname(cachePath), { recursive: true });
              await fs.writeFile(cachePath, data);
              if (++this.cacheWrites % 50 === 0)
                void this.trimCache().catch(() => {});
              return data;
            });
            this.resourcePending.set(cachePath, promise);
          }
          try {
            buffer = await promise;
          } finally {
            this.resourcePending.delete(cachePath);
          }
        }
      }
      const metadata = await sharp(buffer).metadata();
      const mime =
        metadata.format === "jpeg"
          ? "image/jpeg"
          : `image/${metadata.format || "png"}`;
      return new Response(
        request.method === "HEAD" ? null : Uint8Array.from(buffer),
        {
          headers: {
            "Content-Type": mime,
            "Content-Length": String(buffer.length),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        },
      );
    } catch {
      return new Response(null, {
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
  };
  downloads = async (): Promise<ComicDownloadTask[]> =>
    this.store
      .all<Download>("download")
      .map(({ directory: _directory, pages: _pages, ...task }) => task);
  private async intact(task: Download) {
    if (
      !task.total ||
      task.pages.length !== task.total ||
      task.pages.some((p) => !p)
    )
      return false;
    for (const page of task.pages) {
      try {
        const data = await fs.readFile(path.join(task.directory, page.file));
        if (
          data.length !== page.size ||
          digest(data.toString("base64")) !== page.hash
        )
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  downloadDirectory = async (choose = false): Promise<string> => {
    let directory =
      this.store.get<string>("preferences", "downloadDirectory") ||
      path.join(this.root, "comic-online", "downloads");
    if (choose) {
      const result = await dialog.showOpenDialog(this.getWindow()!, {
        title: "漫画下载位置（仅影响新下载）",
        properties: ["openDirectory", "createDirectory"],
      });
      if (!result.canceled) {
        directory = result.filePaths[0];
        this.store.set("preferences", "downloadDirectory", directory);
      }
    }
    return directory;
  };
  enqueue = async (ref: OnlineComicRef, chapterIds: (string | null)[]) => {
    if (!Array.isArray(chapterIds) || chapterIds.length > 20000)
      throw new Error("无效下载章节");
    const details = await this.details(ref);
    const directory = await this.downloadDirectory();
    for (const chapterId of chapterIds) {
      const chapter = details.chapters.find((c) => c.id === chapterId);
      if (!chapter) throw new Error("下载章节不存在");
      const chapterRef = { ...ref, chapterId },
        id = chapterKey(chapterRef);
      const old = this.store.get<Download>("download", id);
      if (
        old &&
        (["downloading", "queued"].includes(old.state) ||
          (old.state === "completed" && (await this.intact(old))))
      )
        continue;
      this.store.set("download", id, {
        ...chapterRef,
        id,
        title: chapter.title,
        comicTitle: details.title,
        state: "queued",
        done: old?.done || 0,
        total: old?.total || 0,
        createdAt: old?.createdAt || Date.now(),
        directory: old?.directory || path.join(directory, comicKey(ref), id),
        pages: old?.pages || [],
      });
    }
    this.changed();
    this.pumpDownloads();
    if (details.cover && !this.store.get("downloadCover", comicKey(ref))) {
      try {
        const response = await this.resource(new Request(details.cover));
        if (response.ok) {
          const file = path.join(
            this.root,
            "comic-online",
            "covers",
            comicKey(ref),
          );
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
          this.store.set("downloadCover", comicKey(ref), file);
        }
      } catch {
        /* Cover failure does not prevent chapter downloads. */
      }
    }
  };
  downloadAction = async (
    id: string,
    action: "pause" | "resume" | "cancel" | "delete",
  ) => {
    const task = this.store.get<Download>("download", id);
    if (!task) throw new Error("下载任务不存在");
    if (action === "cancel" && task.state === "completed") return;
    if (action === "pause") {
      this.jobs.get(id)?.abort();
      task.state = "paused";
      this.store.set("download", id, task);
    } else if (action === "resume") {
      if (task.state === "completed" && (await this.intact(task))) return;
      task.state = "queued";
      task.error = undefined;
      this.store.set("download", id, task);
    } else if (action === "cancel" || action === "delete") {
      this.jobs.get(id)?.abort();
      task.state = "paused";
      this.store.set("download", id, task);
      await this.runningJobs.get(id);
      Object.assign(task, this.store.get<Download>("download", id) || task);
      if (
        action === "cancel" &&
        task.done === task.total &&
        task.total &&
        (await this.intact(task))
      ) {
        task.state = "completed";
        this.store.set("download", id, task);
        this.changed();
        return;
      }
      try {
        const files = await fs
          .readdir(task.directory)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
        for (const file of files.filter((file) =>
          /^\d{6,}\.image(?:\.part)?$/.test(file),
        ))
          await fs.rm(path.join(task.directory, file), { force: true });
        await fs.rmdir(task.directory).catch((e: any) => {
          if (e.code !== "ENOENT") throw e;
        });
        this.store.delete("download", id);
      } catch (error) {
        task.state = "failed";
        task.error = `删除失败：${String(error)}`;
        this.store.set("download", id, task);
        throw error;
      }
    } else throw new Error("未知下载操作");
    this.changed();
    this.pumpDownloads();
  };
  private pumpDownloads() {
    if (this.closed) return;
    for (const task of this.store.all<Download>("download")) {
      if (this.running.size >= 2) break;
      if (task.state !== "queued" || this.running.has(task.id)) continue;
      this.running.add(task.id);
      const controller = new AbortController();
      this.jobs.set(task.id, controller);
      const promise = this.download(task, controller.signal).finally(() => {
        this.running.delete(task.id);
        this.jobs.delete(task.id);
        this.runningJobs.delete(task.id);
        this.pumpDownloads();
      });
      this.runningJobs.set(task.id, promise);
    }
  }
  private async download(task: Download, signal: AbortSignal) {
    const active = () =>
      !this.closed &&
      !signal.aborted &&
      this.store.get<Download>("download", task.id)?.state === "downloading";
    task.state = "downloading";
    this.store.set("download", task.id, task);
    this.changed();
    try {
      const result = await abortable(this.loadChapter(task), signal);
      if (!active()) return;
      if (
        !Array.isArray(result?.images) ||
        !result.images.length ||
        result.images.some((x: any) => typeof x !== "string")
      )
        throw new Error("章节没有有效图片");
      const urls: string[] = result.images;
      task.total = urls.length;
      await fs.mkdir(task.directory, { recursive: true });
      // A process interruption can leave an uncommitted page. Only committed
      // pages with matching hashes participate in restart/resume.
      for (const file of await fs.readdir(task.directory)) {
        if (/^\d{6,}\.image\.part$/.test(file))
          await fs.rm(path.join(task.directory, file), { force: true });
      }
      for (let index = 0; index < urls.length; index++) {
        if (!active()) return;
        const old = task.pages[index];
        if (old) {
          try {
            const data = await fs.readFile(path.join(task.directory, old.file));
            if (
              data.length === old.size &&
              digest(data.toString("base64")) === old.hash
            )
              continue;
          } catch {
            /* Re-fetch damaged/missing pages. */
          }
        }
        let buffer: Buffer | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!active()) return;
          try {
            buffer = await this.loadImage(
              {
                sourceId: task.sourceId,
                comicId: task.comicId,
                chapterId: task.chapterId,
                index,
                url: urls[index],
                thumbnail: false,
              },
              1,
              task.id,
            );
            break;
          } catch (error) {
            if (attempt === 2 || !active()) throw error;
            const fresh = await abortable(this.loadChapter(task), signal);
            if (fresh.images?.[index]) urls[index] = fresh.images[index];
          }
        }
        if (!active() || !buffer) return;
        const file = `${String(index + 1).padStart(6, "0")}.image`;
        const temp = path.join(task.directory, `${file}.part`);
        try {
          await fs.writeFile(temp, buffer);
          if (!active()) return;
          await fs.rename(temp, path.join(task.directory, file));
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        task.pages[index] = {
          file,
          size: buffer.length,
          hash: digest(buffer.toString("base64")),
        };
        task.done = task.pages.filter(Boolean).length;
        if (!active()) return;
        this.store.set("download", task.id, task);
        this.changed();
      }
      if (!active()) return;
      task.pages = task.pages.slice(0, urls.length);
      task.done = task.total;
      task.state = "completed";
      task.error = undefined;
      this.store.set("download", task.id, task);
      this.changed();
    } catch (error) {
      if (active()) {
        task.state = "failed";
        task.error = String(error);
        this.store.set("download", task.id, task);
        this.changed();
      }
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.followStartupTimer);
    for (const controller of this.jobs.values()) controller.abort();
    for (const controller of this.sourceAbort.values()) controller.abort();
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("服务关闭"));
    }
    this.requests.clear();
    for (const request of this.ui.values()) {
      clearTimeout(request.timer);
      request.resolve(null);
    }
    for (const win of this.webLogins.keys()) win.destroy();
    this.child.kill();
    this.store.close();
  }
}

export function installOnlineComics(
  getWindow: () => BrowserWindow | null,
  here: string,
) {
  const service = new OnlineComicService(
    getWindow,
    here,
    app.getPath("userData"),
  );
  const allowed = new Set<keyof OnlineComicsAPI>([
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
    "settingAction",
    "search",
    "explore",
    "category",
    "categories",
    "ranking",
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
  ]);
  ipcMain.handle(
    "comic:call",
    (event, method: keyof OnlineComicsAPI, args: any[]) => {
      if (
        event.sender !== getWindow()?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !allowed.has(method) ||
        !Array.isArray(args)
      )
        throw new Error("无效漫画请求");
      return (
        service[method as keyof OnlineComicService] as (...args: any[]) => any
      )(...args);
    },
  );
  app.once("will-quit", () => service.close());
  return service;
}
