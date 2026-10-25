import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type Session,
} from "electron";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import {
  HubConnectionBuilder,
  HttpClient,
  HttpResponse,
  HttpTransportType,
  LogLevel,
  type HubConnection,
  type HttpRequest,
} from "@microsoft/signalr";
import { MessagePackHubProtocol } from "@microsoft/signalr-protocol-msgpack";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { unzipSync, strFromU8 } from "fflate";
import { NETWORK_PROXY_KEYS } from "../../shared/networkProxy";
import type { NetworkProxyManager } from "../networkProxy";
import type {
  MediaItem,
  OnlineChangeEvent,
  Progress,
} from "../../shared/types";
import {
  NOVEL_API_METHODS,
  type NovelSourceId,
  type NovelSourceInfo,
  type OnlineNovelRef,
  type OnlineNovelChapterRef,
  type OnlineNovelDetails,
  type OnlineNovel,
  type NovelChapter,
  type NovelSearchPage,
  type NovelHubList,
  type NovelFollowState,
  type NovelDownloadTask,
  type NovelBookmark,
  type NovelExportQuote,
  type NovelReaderState,
} from "../../shared/onlineNovels";
import {
  NovelScriptRuntime,
  type NovelRuntimeMeta,
  type NovelRuntimeState,
} from "./novelRuntime";
import {
  chapterEpub,
  checkResponse,
  hash,
  safeRemote,
  type ChapterBundle,
} from "./content";
import { NovelStore } from "./store";
import { ChapterRequests, rateLimitDelay } from "./chapterRequests";
import { folderName, movePath, pruneEmptyFolders } from "../downloadPaths";
import { createChangeSender, type ChangeSender } from "../onlineChange";

interface SavedNovel extends OnlineNovelDetails {
  openedAt?: number;
}
async function coverType(data: Uint8Array) {
  const type = await fileTypeFromBuffer(data);
  if (!type?.mime.startsWith("image/")) throw new Error("封面不是图片");
  // A valid header alone does not make a complete, decodable cached image.
  await sharp(data, { failOn: "error" }).stats();
  return type.mime;
}
interface SourceSettings {
  [key: string]: unknown;
  enabled: boolean;
  apiNode?: string;
  credentials?: string;
  sourceUrl?: string;
  sourceHash?: string;
  update?: boolean;
}
interface SavedSource {
  id: NovelSourceId;
  script: string;
  url: string;
  hash: string;
  meta: NovelRuntimeMeta;
  settings: SourceSettings;
}
interface ActiveSource extends SavedSource {
  runtime: NovelScriptRuntime;
  runtimeState: NovelRuntimeState;
  logged: boolean;
}
interface BundleRecord {
  file: string;
  hash: string;
  version: number;
  requiredFont: boolean;
  size: number;
}
interface ProgressRecord {
  progress: Progress;
  version?: number;
}
interface SavedTask extends NovelDownloadTask {
  directory: string;
  bundle?: BundleRecord;
  retryCount?: number;
}
const bookKey = (ref: OnlineNovelRef) =>
  hash(JSON.stringify([ref.sourceId, ref.novelId]));
const chapterKey = (ref: OnlineNovelChapterRef) =>
  hash(JSON.stringify([ref.sourceId, ref.novelId, ref.chapterId]));
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export class OnlineNovelService {
  readonly root: string;
  readonly store: NovelStore;
  private sessions = new Map<NovelSourceId, Session>();
  private sourcesById = new Map<NovelSourceId, SavedSource>();
  private active = new Map<NovelSourceId, ActiveSource>();
  private hubs = new Map<
    NovelSourceId,
    { hub: HubConnection; token: string; client: HttpClient }
  >();
  private logins = new Map<NovelSourceId, BrowserWindow>();
  private jobs = new Map<string, AbortController>();
  private chapterRequests = new ChapterRequests();
  private pumpTimer?: ReturnType<typeof setTimeout>;
  private builds = new Map<string, Promise<BundleRecord>>();
  private detailRequests = new Map<string, Promise<SavedNovel>>();
  private closed = false;
  private readonly change: ChangeSender = createChangeSender((event) => {
    if (!this.closed) this.getWindow()?.webContents.send("novel:change", event);
  });
  constructor(
    private getWindow: () => BrowserWindow | null,
    userData: string,
    private networkProxy: NetworkProxyManager,
  ) {
    this.root = path.join(userData, "novel-online");
    mkdirSync(this.root, { recursive: true });
    this.store = new NovelStore(path.join(this.root, "library.sqlite"));
    for (const raw of this.store.all<SavedSource>("source-script")) {
      try {
        if (
          raw?.meta?.apiVersion !== 1 ||
          raw.id !== raw.meta.id ||
          typeof raw.script !== "string"
        )
          continue;
        this.sourcesById.set(raw.id, raw);
        this.ensureSession(raw.id);
      } catch {}
    }
    for (const task of this.store.all<SavedTask>("download"))
      if (["queued", "downloading"].includes(task.state)) {
        task.state = "paused";
        task.retryAt = undefined;
        this.store.set("download", task.id, task);
      }
    void this.migrateDownloadFiles().catch(() => {});
  }
  private changed(event?: OnlineChangeEvent) {
    this.change.send(event);
  }
  private source(id: NovelSourceId) {
    if (
      typeof id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) ||
      !this.sourcesById.has(id)
    )
      throw new Error("无效小说源");
    return id;
  }
  private ref<T extends OnlineNovelRef>(ref: T): T {
    if (!ref || typeof ref !== "object") throw new Error("无效作品引用");
    if (
      typeof ref.sourceId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(ref.sourceId)
    )
      throw new Error("无效作品来源标识");
    if (
      typeof ref.novelId !== "string" ||
      !ref.novelId.trim() ||
      ref.novelId.length > 4096
    )
      throw new Error("无效作品标识");
    if (
      "chapterId" in ref &&
      (typeof ref.chapterId !== "string" ||
        !ref.chapterId.trim() ||
        ref.chapterId.length > 4096)
    )
      throw new Error("无效章节标识");
    return {
      sourceId: ref.sourceId,
      novelId: ref.novelId,
      ...("chapterId" in ref ? { chapterId: ref.chapterId } : {}),
    } as T;
  }
  private config(id: NovelSourceId): SourceSettings {
    this.source(id);
    const saved = this.store.get<SourceSettings>("source", id);
    return saved
      ? { ...saved, enabled: saved.enabled !== false }
      : { enabled: true };
  }
  private async scriptRuntime(id: NovelSourceId) {
    this.source(id);
    if (!this.config(id).enabled)
      throw new Error("[disabled] 小说源已停用，已下载章节仍可阅读");
    const previous = this.active.get(id);
    if (previous) return previous;
    const record = this.sourcesById.get(id)!;
    const settings = this.config(id);
    let credentials: Record<string, unknown> = {};
    if (settings.credentials) {
      try {
        credentials = JSON.parse(
          safeStorage.decryptString(
            Buffer.from(settings.credentials, "base64"),
          ),
        );
      } catch {}
    }
    const state: NovelRuntimeState = {
      data: this.store.get("source-data", id) || {},
      settings: { ...settings },
      credentials,
    };
    const runtime = new NovelScriptRuntime(record.script, state, (message) =>
      this.runtimeHost(id, message),
    );
    try {
      const meta = await runtime.open();
      if (meta.id !== id) throw new Error("小说源脚本标识与已安装来源不匹配");
      const active = {
        ...record,
        meta,
        runtime,
        runtimeState: state,
        logged: false,
      };
      this.active.set(id, active);
      return active;
    } catch (error) {
      runtime.dispose();
      throw error;
    }
  }
  private sourcePage(
    id: NovelSourceId,
    value: any,
    page: number,
  ): NovelSearchPage {
    if (
      !value ||
      !Array.isArray(value.novels) ||
      value.novels.length > 300 ||
      typeof value.hasMore !== "boolean"
    )
      throw new Error("[parse] 小说源列表返回格式无效");
    const novels = value.novels.map((item: any) => {
      if (
        !item ||
        typeof item !== "object" ||
        item.novelId == null ||
        typeof item.title !== "string" ||
        !item.title.trim()
      )
        throw new Error("[parse] 小说源列表包含无效作品");
      const novelId = String(item.novelId);
      if (!novelId.trim() || novelId.length > 4096 || item.title.length > 1000)
        throw new Error("[parse] 小说源作品标识或标题无效");
      const cover =
        typeof item.cover === "string" && item.cover
          ? safeRemote(item.cover, this.sourcesById.get(id)!.meta.url)
          : undefined;
      return {
        sourceId: id,
        novelId,
        title: item.title,
        author: typeof item.author === "string" ? item.author : undefined,
        cover,
        description:
          typeof item.description === "string" ? item.description : undefined,
        updatedAt:
          typeof item.updatedAt === "string" ? item.updatedAt : undefined,
      } satisfies OnlineNovel;
    });
    return { novels, page, hasMore: value.hasMore };
  }
  private sourceDetails(
    id: NovelSourceId,
    novelId: string,
    value: any,
  ): OnlineNovelDetails {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.title !== "string" ||
      !value.title.trim() ||
      !Array.isArray(value.chapters) ||
      value.chapters.length > 100_000
    )
      throw new Error("[parse] 小说源详情返回格式无效");
    const chapters = value.chapters.map((chapter: any) => {
      if (
        !chapter ||
        typeof chapter !== "object" ||
        chapter.id == null ||
        typeof chapter.title !== "string"
      )
        throw new Error("[parse] 小说源目录包含无效章节");
      const id = String(chapter.id);
      if (!id.trim() || id.length > 4096 || chapter.title.length > 1000)
        throw new Error("[parse] 小说源章节标识或标题无效");
      return {
        id,
        title: chapter.title,
        volume: typeof chapter.volume === "string" ? chapter.volume : "正文",
        url: typeof chapter.url === "string" ? chapter.url : undefined,
        order:
          typeof chapter.order === "number" && Number.isFinite(chapter.order)
            ? chapter.order
            : undefined,
        revision:
          typeof chapter.revision === "string" ? chapter.revision : undefined,
      } satisfies NovelChapter;
    });
    const cover =
      typeof value.cover === "string" && value.cover
        ? safeRemote(value.cover, this.sourcesById.get(id)!.meta.url)
        : undefined;
    return {
      sourceId: id,
      novelId,
      title: value.title,
      author: typeof value.author === "string" ? value.author : undefined,
      cover,
      description:
        typeof value.description === "string" ? value.description : undefined,
      updatedAt:
        typeof value.updatedAt === "string" ? value.updatedAt : undefined,
      canExport: value.canExport === true,
      exportCost:
        Number.isSafeInteger(value.exportCost) && value.exportCost >= 0
          ? value.exportCost
          : undefined,
      chapters,
    };
  }
  private sourceChapter(id: NovelSourceId, value: any) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.title !== "string" ||
      typeof value.html !== "string" ||
      value.html.length > 64 * 1024 * 1024
    )
      throw new Error("[parse] 小说源正文返回格式无效或内容过大");
    const base = safeRemote(
      typeof value.base === "string" ? value.base : "",
      this.sourcesById.get(id)!.meta.url,
    );
    return {
      title: value.title.slice(0, 1000),
      html: value.html,
      base,
      font:
        typeof value.font === "string" && value.font
          ? safeRemote(value.font, base)
          : undefined,
    };
  }
  private provider(id: NovelSourceId) {
    return {
      search: async (keyword: string, page: number) =>
        this.sourcePage(
          id,
          await (
            await this.scriptRuntime(id)
          ).runtime.call("search", [keyword, page]),
          page,
        ),
      discover: async (kind: "latest" | "popular", page: number) =>
        this.sourcePage(
          id,
          await (
            await this.scriptRuntime(id)
          ).runtime.call("discover", [kind, page]),
          page,
        ),
      details: async (novelId: string) =>
        this.sourceDetails(
          id,
          novelId,
          await (
            await this.scriptRuntime(id)
          ).runtime.call("details", [novelId]),
        ),
      chapter: async (novelId: string, chapter: NovelChapter) =>
        this.sourceChapter(
          id,
          await (
            await this.scriptRuntime(id)
          ).runtime.call("chapter", [novelId, chapter]),
        ),
      close: async () => this.closeSourceRuntime(id),
    };
  }
  private async closeSourceRuntime(id: NovelSourceId) {
    const current = this.active.get(id);
    if (current) {
      try {
        await current.runtime.evaluate(
          "typeof __source.close === 'function' ? Promise.resolve(__source.close()) : true",
        );
      } catch {}
      this.active.delete(id);
      current.runtime.dispose();
    }
    const connection = this.hubs.get(id);
    if (connection) {
      this.hubs.delete(id);
      await connection.hub.stop().catch(() => {});
    }
  }
  private ensureSession(id: NovelSourceId) {
    let current = this.sessions.get(id);
    if (current) return current;
    current = this.networkProxy.getSession(
      `persist:novel-${id}`,
      NETWORK_PROXY_KEYS.novel.source(id),
      NETWORK_PROXY_KEYS.novel.default,
    );
    current.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    this.sessions.set(id, current);
    return current;
  }
  async request(
    id: NovelSourceId,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (this.closed) throw new Error("服务已关闭");
    this.source(id);
    safeRemote(url, url);
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const headers = new Headers(init.headers);
    const sourceSession = this.ensureSession(id);
    try {
      await this.networkProxy.ready(sourceSession);
      return await sourceSession.fetch(url, { ...init, headers, signal });
    } catch (error) {
      throw new Error(`[network] ${message(error)}`);
    }
  }
  private async runtimeHost(
    id: NovelSourceId,
    message: Record<string, any>,
  ): Promise<any> {
    if (!message || typeof message !== "object")
      throw new Error("无效小说源宿主请求");
    if (id.startsWith("staging-"))
      throw new Error("小说源校验期间不能调用宿主接口");
    if (message.op === "credentials") {
      const value =
        message.value && typeof message.value === "object" ? message.value : {};
      if (
        Object.values(value).some(
          (item) => !["string", "number", "boolean"].includes(typeof item),
        )
      )
        throw new Error("登录凭据格式无效");
      if (Object.keys(value).length && !safeStorage.isEncryptionAvailable())
        throw new Error("系统凭据加密不可用，无法保存登录");
      const config = this.config(id);
      config.credentials = Object.keys(value).length
        ? safeStorage.encryptString(JSON.stringify(value)).toString("base64")
        : undefined;
      this.store.set("source", id, config);
      this.active.get(id)!.runtimeState.credentials = value;
      this.changed();
      return true;
    }
    if (message.op === "data") {
      this.store.set("source-data", id, message.value || {});
      return true;
    }
    if (message.op === "delay") {
      const ms = Math.max(0, Math.min(60_000, Number(message.ms) || 0));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return true;
    }
    if (message.op === "request") {
      if (typeof message.url !== "string")
        throw new Error("小说源请求网址无效");
      const response = await this.request(
        id,
        message.url,
        message.options || {},
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body:
          message.options?.responseType === "bytes"
            ? bytes
            : iconv.decode(
                Buffer.from(bytes),
                /charset=([\w-]+)/i.exec(
                  response.headers.get("content-type") || "",
                )?.[1] || "utf-8",
              ),
      };
    }
    if (message.op === "query") {
      if (
        typeof message.html !== "string" ||
        message.html.length > 16 * 1024 * 1024
      )
        throw new Error("HTML 内容过大");
      const $ = cheerio.load(message.html);
      if (Array.isArray(message.remove))
        $(
          message.remove
            .filter((x: unknown) => typeof x === "string")
            .join(","),
        ).remove();
      const selectors = Array.isArray(message.selectors)
        ? message.selectors
        : [];
      if (
        selectors.length > 40 ||
        selectors.some(
          (item: unknown) => typeof item !== "string" || item.length > 512,
        )
      )
        throw new Error("HTML 查询无效");
      return Object.fromEntries(
        selectors.map((selector: string) => [
          selector,
          $(selector)
            .toArray()
            .slice(0, 1000)
            .map((node) => ({
              text: $(node).text().trim(),
              html: $(node).html() || "",
              tag: (node as any).name || "",
              attrs: { ...(node as any).attribs },
            })),
        ]),
      );
    }
    if (message.op === "digest")
      return createHash("sha256")
        .update(String(message.value || ""))
        .digest("hex");
    if (message.op === "gunzip")
      return new Uint8Array(gunzipSync(Buffer.from(message.value)));
    if (message.op === "gunzipJson")
      return JSON.parse(
        gunzipSync(Buffer.from(message.value)).toString("utf8"),
      );
    if (message.op === "visitor") {
      let visitor = this.store.get<string>("setting", "visitor");
      if (!visitor) {
        visitor = randomUUID();
        this.store.set("setting", "visitor", visitor);
      }
      return visitor;
    }
    if (message.op === "cookieStatus") {
      const url = safeRemote(
        String(message.url || ""),
        this.sourcesById.get(id)!.meta.url,
      );
      const cookies = await this.ensureSession(id).cookies.get({ url });
      const pattern =
        typeof message.pattern === "string"
          ? new RegExp(message.pattern, "i")
          : null;
      return cookies.some((cookie) => !pattern || pattern.test(cookie.name));
    }
    if (message.op === "signalr")
      return this.signalr(id, message.options || {});
    if (message.op === "browser")
      return this.browser(id, message.options || {});
    throw new Error("未知小说源宿主接口");
  }
  private async signalr(id: NovelSourceId, options: Record<string, any>) {
    if (typeof options.url !== "string" || typeof options.method !== "string")
      throw new Error("SignalR 请求参数无效");
    let connection = this.hubs.get(id);
    if (
      !connection ||
      connection.token !== String(options.accessToken || "") ||
      connection.hub.state !== "Connected"
    ) {
      if (connection) {
        this.hubs.delete(id);
        await connection.hub.stop().catch(() => {});
      }
      const sourceId = id;
      const service = this;
      const client = new (class extends HttpClient {
        async send(request: HttpRequest) {
          const controller = new AbortController();
          if (request.abortSignal?.aborted) controller.abort();
          else if (request.abortSignal)
            request.abortSignal.onabort = () => controller.abort();
          try {
            const response = await service.request(sourceId, request.url!, {
              method: request.method,
              headers: request.headers,
              body: request.content,
              signal: controller.signal,
            });
            const body =
              request.responseType === "arraybuffer"
                ? await response.arrayBuffer()
                : await response.text();
            return new HttpResponse(response.status, response.statusText, body);
          } finally {
            if (request.abortSignal) request.abortSignal.onabort = null;
          }
        }
      })();
      const hub = new HubConnectionBuilder()
        .withUrl(options.url, {
          accessTokenFactory: async () => String(options.accessToken || ""),
          transport: HttpTransportType.LongPolling,
          httpClient: client,
        })
        .withHubProtocol(new MessagePackHubProtocol())
        .configureLogging(LogLevel.None)
        .build();
      hub.serverTimeoutInMilliseconds = 30_000;
      try {
        await this.withTimeout(
          hub.start(),
          30_000,
          "[network] SignalR 连接超时",
        );
      } catch (error) {
        await hub.stop().catch(() => {});
        throw error;
      }
      connection = { hub, token: String(options.accessToken || ""), client };
      this.hubs.set(id, connection);
    }
    return this.withTimeout(
      connection.hub.invoke(
        options.method,
        options.params || {},
        options.invokeOptions || { UseGzip: true },
      ),
      30_000,
      "[network] 轻书架请求超时，请重试",
    );
  }
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    reason: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), ms);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
  private async browser(id: NovelSourceId, options: Record<string, any>) {
    const address = safeRemote(
      String(options.url || ""),
      this.sourcesById.get(id)!.meta.url,
    );
    const base = new URL(address).origin;
    const sourceSession = this.ensureSession(id);
    await this.networkProxy.ready(sourceSession);
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        session: sourceSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.searchWindows.add(win);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin !== base) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, 45_000);
    try {
      await win.loadURL(address);
      const initial = await win.webContents.executeJavaScript(
        "document.documentElement.outerHTML",
      );
      checkResponse(200, initial);
      const selectors = (
        Array.isArray(options.inputSelectors) ? options.inputSelectors : []
      ).filter((x: unknown) => typeof x === "string");
      const submitted = await win.webContents.executeJavaScript(
        `(()=>{const sels=${JSON.stringify(selectors)};let input=sels.map(s=>document.querySelector(s)).find(Boolean);if(!input)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(String(options.keyword || ""))});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));if(input.form)input.form.requestSubmit();else{const button=document.querySelector(${JSON.stringify(String(options.submitSelector || "button[type=submit],input[type=submit]"))});if(button)button.click();else input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}return true;})()`,
      );
      if (!submitted) throw new Error("[parse] 小说源搜索页面缺少搜索框");
      let html = "";
      const page = Math.max(1, Math.min(100, Number(options.page) || 1));
      for (let current = 1; current <= page; current++) {
        const deadline = Date.now() + 25_000;
        const previousHtml = html;
        const previousUrl =
          current > 1
            ? await win.webContents.executeJavaScript("location.href")
            : "";
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (win.isDestroyed())
            throw new Error("[network] 小说源浏览器搜索超时");
          html = await win.webContents.executeJavaScript(
            "document.documentElement.outerHTML",
          );
          checkResponse(200, html);
          const currentUrl =
            await win.webContents.executeJavaScript("location.href");
          if (
            current > 1 &&
            currentUrl === previousUrl &&
            html === previousHtml
          )
            continue;
          const ready = await win.webContents.executeJavaScript(
            `(()=>document.querySelector(${JSON.stringify(String(options.resultSelector || "a[href]"))})||/没有找到|未找到|暂无结果|无搜索结果/.test(document.body.innerText))()`,
          );
          if (ready) break;
        }
        if (!html || Date.now() >= deadline)
          throw new Error("[network] 小说源搜索未返回结果");
        if (current === page) return html;
        const clicked = await win.webContents.executeJavaScript(
          `(()=>{const n=document.querySelector(${JSON.stringify(String(options.nextSelector || "a[rel=next]"))});if(!n)return false;n.click();return true})()`,
        );
        if (!clicked) throw new Error("[parse] 已到搜索末页");
      }
      return html;
    } finally {
      clearTimeout(timer);
      this.searchWindows.delete(win);
      if (!win.isDestroyed()) win.destroy();
    }
  }
  async sources() {
    return Promise.all(
      [...this.sourcesById.values()].map(async (source) => {
        const config = this.config(source.id);
        const cookies = await this.ensureSession(source.id).cookies.get({
          url: source.meta.url,
        });
        let logged = Boolean(config.credentials);
        try {
          const active = await this.scriptRuntime(source.id);
          logged = Boolean(await active.runtime.call("isLogged"));
        } catch {
          logged ||= cookies.some((cookie) =>
            /uid|user|login|auth/i.test(cookie.name),
          );
        }
        const settingValues = Object.fromEntries(
          Object.entries(source.meta.settings).flatMap(([key, schema]) => {
            const value =
              (config as Record<string, unknown>)[key] ?? schema.default;
            return value === undefined ? [] : [[key, value]];
          }),
        );
        return {
          id: source.id,
          name: source.meta.name,
          url: source.meta.url,
          version: source.meta.version,
          enabled: config.enabled,
          logged,
          apiNode:
            typeof config.apiNode === "string" ? config.apiNode : undefined,
          error: (source as any).error,
          update: Boolean(config.update),
          settings: source.meta.settings,
          settingValues,
          capabilities: source.meta.capabilities,
        };
      }),
    );
  }
  async settings(
    id: NovelSourceId,
    value: { enabled?: boolean; apiNode?: string; [key: string]: unknown },
  ) {
    this.source(id);
    if (
      !value ||
      typeof value !== "object" ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean")
    )
      throw new Error("无效设置");
    const config = this.config(id);
    const metadata = this.sourcesById.get(id)!.meta;
    for (const [key, settingValue] of Object.entries(value)) {
      if (key === "enabled") continue;
      const schema = metadata.settings[key];
      if (!schema || ["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("未知小说源设置");
      if (schema.type === "input" && typeof settingValue !== "string")
        throw new Error(`${schema.title || key} 必须是文本`);
      if (schema.type === "switch" && typeof settingValue !== "boolean")
        throw new Error(`${schema.title || key} 必须是开关`);
      if (
        schema.type === "select" &&
        !(schema.options || []).some(
          (option: any) =>
            (typeof option === "string" ? option : option?.value) ===
            settingValue,
        )
      )
        throw new Error(`${schema.title || key} 选项无效`);
      if (typeof settingValue === "string" && settingValue.length > 2048)
        throw new Error(`${schema.title || key} 内容过长`);
      if (
        schema.validator &&
        typeof settingValue === "string" &&
        !new RegExp(schema.validator).test(settingValue)
      )
        throw new Error(`${schema.title || key} 格式无效`);
    }
    this.store.set("source", id, {
      ...config,
      enabled: value.enabled ?? config.enabled,
      ...Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "enabled"),
      ),
    });
    await this.closeSourceRuntime(id);
    this.changed();
  }
  async login(id: NovelSourceId, email: string, password: string) {
    this.source(id);
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email ||
      !password ||
      email.length > 256 ||
      password.length > 1024
    )
      throw new Error("请输入邮箱和密码");
    const active = await this.scriptRuntime(id);
    if (!active.meta.capabilities.login.includes("password"))
      throw new Error("此小说源不支持邮箱密码登录");
    await active.runtime.call("login", [email, password]);
    this.changed();
  }
  async logout(id: NovelSourceId) {
    this.source(id);
    const config = this.config(id);
    config.credentials = undefined;
    this.store.set("source", id, config);
    await this.ensureSession(id).clearStorageData();
    await this.closeSourceRuntime(id);
    this.changed();
  }
  async webLogin(id: NovelSourceId) {
    this.source(id);
    const existing = this.logins.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const def = this.sourcesById.get(id)!;
    const sourceSession = this.ensureSession(id);
    await this.networkProxy.ready(sourceSession);
    const win = new BrowserWindow({
      width: 1080,
      height: 800,
      parent: this.getWindow() || undefined,
      title: `${def.meta.name} · 登录与验证`,
      webPreferences: {
        session: sourceSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.logins.set(id, win);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== new URL(def.meta.url).origin)
        event.preventDefault();
    });
    win.on("closed", () => {
      this.logins.delete(id);
      this.changed();
    });
    await win.loadURL((def.meta as any).loginUrl || def.meta.url);
  }
  async repositories() {
    return this.store.get<string[]>("setting", "repositories") || [];
  }
  private async fetchSource(url: string) {
    const parsed = new URL(url);
    const githubBlob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(parsed.pathname);
    const normalized =
      parsed.hostname === "github.com" && githubBlob
        ? `https://raw.githubusercontent.com/${githubBlob[1]}/${githubBlob[2]}/${githubBlob[3]}`
        : url;
    const address = safeRemote(normalized, normalized);
    const repositorySession = this.networkProxy.getSession(
      "novel-source-repositories",
      NETWORK_PROXY_KEYS.novel.repositories,
    );
    await this.networkProxy.ready(repositorySession);
    const response = await repositorySession.fetch(address, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`小说源请求失败 (${response.status})`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024)
      throw new Error("小说源文件超过 4 MiB");
    if (/^\s*(?:<!doctype html|<html\b)/i.test(text))
      throw new Error("链接返回网页，请使用 JS 原始文件地址");
    return { text, url: response.url || address };
  }
  private async sourceIndex(text: string, base: string) {
    let entries: any;
    try {
      entries = JSON.parse(text);
    } catch {
      throw new Error("小说源仓库不是有效 JSON");
    }
    if (!Array.isArray(entries) && entries && Array.isArray(entries.sources))
      entries = entries.sources;
    if (!Array.isArray(entries) || !entries.length || entries.length > 5000)
      throw new Error("小说源仓库格式无效");
    return entries.map((entry: any) => {
      if (!entry || typeof entry !== "object")
        throw new Error("小说源仓库包含无效条目");
      const raw = entry.url || entry.fileName || entry.filename;
      if (typeof raw !== "string" || !raw)
        throw new Error("小说源仓库条目缺少 JS 地址");
      const url = safeRemote(new URL(raw, base).href, base);
      const existing = [...this.sourcesById.values()].find(
        (source) => source.url === url || (entry.id && source.id === entry.id),
      );
      return {
        name: String(entry.name || entry.id || raw),
        url,
        id: typeof entry.id === "string" ? entry.id : undefined,
        version: typeof entry.version === "string" ? entry.version : undefined,
        description:
          typeof entry.description === "string" ? entry.description : undefined,
        installedId: existing?.id,
      };
    });
  }
  async openAddress(address: string) {
    if (
      typeof address !== "string" ||
      !address.trim() ||
      address.length > 16_384
    )
      throw new Error("请输入有效小说源网址");
    const fetched = await this.fetchSource(address.trim());
    const text = fetched.text.trimStart();
    if (
      text.startsWith("[") ||
      (text.startsWith("{") && /\"sources\"\s*:/.test(text))
    ) {
      const entries = await this.sourceIndex(fetched.text, fetched.url);
      const repositories = await this.repositories();
      if (!repositories.includes(fetched.url))
        this.store.set("setting", "repositories", [
          ...repositories,
          fetched.url,
        ]);
      return { kind: "repository" as const, entries };
    }
    const source = await this.installScript(fetched.text, fetched.url);
    return { kind: "source" as const, source };
  }
  async install(address: string) {
    const fetched = await this.fetchSource(address);
    if (
      fetched.text.trimStart().startsWith("[") ||
      /\"sources\"\s*:/.test(fetched.text.slice(0, 4096))
    )
      throw new Error("这是仓库索引，请先读取并选择一个来源");
    return this.installScript(fetched.text, fetched.url);
  }
  async importFile() {
    const result = await dialog.showOpenDialog(this.getWindow()!, {
      title: "导入小说源或源集合",
      properties: ["openFile"],
      filters: [{ name: "小说源文件", extensions: ["json", "js"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("所选小说源不是文件");
    if (stat.size > 4 * 1024 * 1024) throw new Error("小说源文件超过 4 MiB");

    if (path.extname(file).toLowerCase() === ".js") {
      const source = await this.installScript(
        await fs.readFile(file, "utf8"),
        "",
      );
      return { sources: [source], errors: [] };
    }

    let entries: any;
    try {
      entries = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      throw new Error("本地小说源集合不是有效 JSON");
    }
    if (!Array.isArray(entries) && entries && Array.isArray(entries.sources))
      entries = entries.sources;
    if (!Array.isArray(entries) || !entries.length || entries.length > 5000)
      throw new Error("本地小说源集合格式无效");

    const baseDirectory = path.dirname(file);
    const realBaseDirectory = await fs.realpath(baseDirectory);
    const sources: NovelSourceInfo[] = [];
    const errors: string[] = [];
    const importedFiles = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const label =
        entry && typeof entry === "object"
          ? String(
              entry.name ||
                entry.id ||
                entry.fileName ||
                entry.filename ||
                `第 ${index + 1} 个来源`,
            )
          : `第 ${index + 1} 个来源`;
      try {
        const relativeFile = entry?.fileName || entry?.filename;
        if (
          typeof relativeFile !== "string" ||
          !relativeFile.trim() ||
          path.isAbsolute(relativeFile)
        ) {
          throw new Error("缺少有效的相对 JS 文件名");
        }
        const resolvedFile = path.resolve(baseDirectory, relativeFile);
        const relativeToBase = path.relative(baseDirectory, resolvedFile);
        if (
          !relativeToBase ||
          relativeToBase === ".." ||
          relativeToBase.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeToBase)
        ) {
          throw new Error("JS 文件必须位于集合 JSON 所在目录内");
        }
        if (path.extname(resolvedFile).toLowerCase() !== ".js")
          throw new Error("集合条目必须指向 .js 文件");

        const realFile = await fs.realpath(resolvedFile);
        const realRelativeFile = path.relative(realBaseDirectory, realFile);
        if (
          !realRelativeFile ||
          realRelativeFile === ".." ||
          realRelativeFile.startsWith(`..${path.sep}`) ||
          path.isAbsolute(realRelativeFile)
        ) {
          throw new Error("JS 文件必须位于集合 JSON 所在目录内");
        }
        if (importedFiles.has(realFile)) continue;
        importedFiles.add(realFile);

        const scriptStat = await fs.stat(realFile);
        if (!scriptStat.isFile()) throw new Error("JS 来源不是文件");
        if (scriptStat.size > 4 * 1024 * 1024)
          throw new Error("小说源脚本超过 4 MiB");
        sources.push(
          await this.installScript(await fs.readFile(realFile, "utf8"), ""),
        );
      } catch (error) {
        errors.push(`${label}：${message(error)}`);
      }
    }
    return { sources, errors };
  }
  private async installScript(script: string, url: string, updateId?: string) {
    const stageId = `staging-${randomUUID()}`;
    const stage: SavedSource = {
      id: stageId,
      script,
      url,
      hash: hash(script),
      meta: {} as NovelRuntimeMeta,
      settings: { enabled: true },
    };
    this.sourcesById.set(stageId, stage);
    const state: NovelRuntimeState = {
      data: {},
      settings: {},
      credentials: {},
    };
    const runtime = new NovelScriptRuntime(script, state, (message) =>
      this.runtimeHost(stageId, message),
    );
    let meta: NovelRuntimeMeta;
    try {
      meta = await runtime.open();
    } finally {
      runtime.dispose();
      this.sourcesById.delete(stageId);
      const stageSession = this.sessions.get(stageId);
      this.sessions.delete(stageId);
      if (stageSession) await stageSession.clearStorageData().catch(() => {});
    }
    const id = meta.id;
    const old = this.sourcesById.get(id);
    if (updateId && updateId !== id)
      throw new Error("更新脚本的小说源标识发生变化");
    const config = old
      ? { ...this.config(id), update: undefined }
      : { enabled: true };
    const record: SavedSource = {
      id,
      script,
      url: url || meta.url,
      hash: hash(script),
      meta,
      settings: config,
    };
    this.store.set("source-script", id, {
      id,
      script,
      url: record.url,
      hash: record.hash,
      meta,
    });
    if (!old) this.store.set("source", id, config);
    this.sourcesById.set(id, record);
    this.ensureSession(id);
    await this.closeSourceRuntime(id);
    this.changed();
    return (await this.sources()).find((source) => source.id === id)!;
  }
  async checkUpdates() {
    await Promise.all(
      [...this.sourcesById.values()].map(async (source) => {
        const updateUrl = source.meta.updateUrl || source.url;
        if (!updateUrl) return;
        try {
          const { text } = await this.fetchSource(updateUrl);
          const config = this.config(source.id);
          config.update = hash(text) !== source.hash;
          this.store.set("source", source.id, config);
        } catch (error) {
          (source as any).error = message(error);
        }
      }),
    );
    this.changed();
    return this.sources();
  }
  async update(id: NovelSourceId) {
    const source = this.sourcesById.get(this.source(id))!;
    const updateUrl = source.meta.updateUrl || source.url;
    if (!updateUrl)
      throw new Error("此本地来源没有更新地址，请从新脚本文件重新导入");
    const { text, url } = await this.fetchSource(updateUrl);
    return this.installScript(text, url, id);
  }
  async uninstall(id: NovelSourceId) {
    this.source(id);
    for (const task of this.store.all<SavedTask>("download"))
      if (
        task.sourceId === id &&
        ["queued", "downloading"].includes(task.state)
      ) {
        this.jobs.get(task.id)?.abort();
        task.state = "paused";
        task.error = undefined;
        this.store.set("download", task.id, task);
      }
    await this.closeSourceRuntime(id);
    await this.ensureSession(id).clearStorageData();
    this.sourcesById.delete(id);
    this.store.delete("source-script", id);
    this.store.delete("source", id);
    this.store.delete("source-data", id);
    this.changed();
  }
  private searchWindows = new Set<BrowserWindow>();
  private present<T extends OnlineNovel>(novel: T): T {
    const copy = { ...novel };
    if (copy.cover && !copy.cover.startsWith("media:")) {
      const id = hash(copy.cover);
      this.store.set("cover", id, { sourceId: copy.sourceId, url: copy.cover });
      copy.cover = `media://novel/cover/${id}`;
    }
    return copy;
  }
  async search(id: NovelSourceId, keyword: string, page: number) {
    if (typeof keyword !== "string" || !keyword.trim() || keyword.length > 300)
      throw new Error("请输入搜索内容");
    this.page(page);
    if (!this.sourcesById.get(this.source(id))!.meta.capabilities.search)
      throw new Error("此小说源不支持搜索");
    const result = (await this.provider(id).search(
      keyword.trim(),
      page,
    )) as NovelSearchPage;
    result.novels.forEach((n) => this.cacheSummary(n));
    return { ...result, novels: result.novels.map((n) => this.present(n)) };
  }
  private page(page: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
      throw new Error("无效页码");
  }
  async discover(id: NovelSourceId, kind: "latest" | "popular", page: number) {
    this.page(page);
    if (!["latest", "popular"].includes(kind)) throw new Error("无效发现栏目");
    if (!this.sourcesById.get(this.source(id))!.meta.capabilities[kind])
      throw new Error(
        `此小说源不支持${kind === "latest" ? "最近更新" : "热门作品"}`,
      );
    const result = (await this.provider(id).discover(
      kind,
      page,
    )) as NovelSearchPage;
    result.novels.forEach((n) => this.cacheSummary(n));
    return { ...result, novels: result.novels.map((n) => this.present(n)) };
  }
  private cacheSummary(novel: OnlineNovel) {
    this.store.set("summary", bookKey(novel), novel);
  }
  private fetchDetails(ref: OnlineNovelRef): Promise<SavedNovel> {
    const key = bookKey(ref);
    const pending = this.detailRequests.get(key);
    if (pending) return pending;
    // A cold reader can request the same book as the detail view. Share the
    // network work, then let each caller decorate the saved data independently.
    const request = (async () => {
      const fetched = await this.provider(ref.sourceId).details(ref.novelId);
      if (this.closed) throw new Error("服务已关闭");
      const saved = this.store.get<SavedNovel>("book", key);
      for (const chapter of fetched.chapters) {
        const old = saved?.chapters.find((c) => c.id === chapter.id);
        if (
          old &&
          ((old.revision &&
            chapter.revision &&
            old.revision !== chapter.revision) ||
            (saved?.updatedAt &&
              fetched.updatedAt &&
              saved.updatedAt !== fetched.updatedAt))
        )
          this.store.delete(
            "cache",
            chapterKey({ ...ref, chapterId: chapter.id }),
          );
      }
      const record = { ...saved, ...fetched };
      this.store.set("book", key, record);
      this.cacheSummary(record);
      return record;
    })().finally(() => this.detailRequests.delete(key));
    this.detailRequests.set(key, request);
    return request;
  }
  async details(
    ref: OnlineNovelRef,
    refresh = false,
  ): Promise<OnlineNovelDetails> {
    ref = this.ref(ref);
    let saved = this.store.get<SavedNovel>("book", bookKey(ref));
    let offline = false;
    let refreshError: string | undefined;
    if (!saved || refresh) {
      try {
        saved = await this.fetchDetails(ref);
      } catch (error) {
        if (!saved) throw error;
        offline = true;
        refreshError = message(error);
      }
    }
    const tasks = this.store.all<SavedTask>("download");
    const downloaded = new Set(
      tasks.filter((task) => task.state === "completed").map((task) => task.id),
    );
    return this.present({
      ...saved!,
      offline,
      refreshError,
      favorite: Boolean(this.store.get("shelf", bookKey(ref))),
      chapters: saved!.chapters.map((c) => ({
        ...c,
        progress: this.store.get<ProgressRecord>(
          "progress",
          chapterKey({ ...ref, chapterId: c.id }),
        )?.progress,
        downloaded: downloaded.has(chapterKey({ ...ref, chapterId: c.id })),
      })),
    });
  }
  async library(section: NovelHubList | "history" | "downloads") {
    if (
      !["shelf", "readLater", "following", "history", "downloads"].includes(
        section,
      )
    )
      throw new Error("无效书架栏目");
    const refs =
      section === "downloads"
        ? this.store
            .all<SavedTask>("download")
            .filter((t) => t.state === "completed")
        : this.store.all<OnlineNovelRef>(section);
    const seen = new Set<string>();
    const novels = refs.flatMap((ref) => {
      const key = bookKey(ref);
      if (seen.has(key)) return [];
      seen.add(key);
      // Summary records omit chapter bodies, keeping large completed libraries
      // cheap to enumerate. Older records without a summary still fall back.
      const novel =
        this.store.get<OnlineNovel>("summary", key) ||
        this.store.get<SavedNovel>("book", key);
      return novel
        ? [
            this.present({
              ...novel,
              favorite: Boolean(this.store.get("shelf", key)),
            }),
          ]
        : [];
    });
    return section === "history"
      ? novels.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
      : novels;
  }
  async removeHistory(ref?: OnlineNovelRef) {
    const refs = ref
      ? [this.ref(ref)]
      : this.store.all<OnlineNovelRef>("history");
    for (const item of refs) {
      const key = bookKey(item);
      this.store.delete("history", key);
      const saved = this.store.get<SavedNovel>("book", key);
      if (saved?.openedAt) {
        delete saved.openedAt;
        this.store.set("book", key, saved);
      }
    }
    if (!ref) this.store.clear("history");
    this.changed();
  }
  async hubSet(list: NovelHubList, ref: OnlineNovelRef, value: boolean) {
    ref = this.ref(ref);
    if (
      !["shelf", "readLater", "following"].includes(list) ||
      typeof value !== "boolean"
    )
      throw new Error("无效书架操作");
    const key = bookKey(ref);
    if (value) {
      const details = await this.details(ref);
      if (list === "following") {
        if (!this.store.get(list, key))
          this.store.set(list, key, {
            ...ref,
            baseline: details.chapters.map((c) => c.id),
            newChapterIds: [],
          } satisfies NovelFollowState);
      } else this.store.set(list, key, { ...ref });
    } else this.store.delete(list, key);
    this.changed();
  }
  async following() {
    return this.store.all<NovelFollowState>("following");
  }
  async checkFollowing(ref?: OnlineNovelRef) {
    if (ref) ref = this.ref(ref);
    const states = await this.following();
    for (const state of states) {
      if (ref && bookKey(state) !== bookKey(ref)) continue;
      try {
        const details = await this.details(state, true);
        if (details.refreshError) throw new Error(details.refreshError);
        state.newChapterIds = [
          ...new Set([
            ...state.newChapterIds,
            ...details.chapters
              .filter((c) => !state.baseline.includes(c.id))
              .map((c) => c.id),
          ]),
        ];
        state.baseline = details.chapters.map((c) => c.id);
        state.error = undefined;
        state.checkedAt = Date.now();
      } catch (error) {
        state.error = message(error);
      }
      this.store.set("following", bookKey(state), state);
    }
    this.changed();
    return states;
  }
  private async readBundle(record: BundleRecord) {
    const data = await fs.readFile(record.file);
    if (data.length !== record.size || hash(data) !== record.hash)
      throw new Error("离线章节损坏或不完整，请重新下载");
    return data;
  }
  private async asset(
    id: NovelSourceId,
    url: string,
    base: string,
    signal?: AbortSignal,
  ) {
    const referer = this.sourcesById.get(id)!.meta.assetReferer || base;
    const response = await this.request(id, safeRemote(url, base), {
      signal,
      headers: { Referer: referer },
    });
    const data = new Uint8Array(await response.arrayBuffer());
    checkResponse(
      response.status,
      new TextDecoder().decode(data.slice(0, 3000)),
    );
    if (data.length > 64 * 1024 * 1024 || !data.length)
      throw new Error("资源为空或超过大小限制");
    const detected = await fileTypeFromBuffer(data);
    let type =
      detected?.mime ||
      response.headers.get("content-type")?.split(";")[0] ||
      "application/octet-stream";
    if (/\.woff2?(?:[?#]|$)/i.test(url) && type === "application/octet-stream")
      type = /\.woff2/i.test(url) ? "font/woff2" : "font/woff";
    return { data, type };
  }
  private bundle(ref: OnlineNovelChapterRef): Promise<BundleRecord> {
    ref = this.ref(ref);
    const key = chapterKey(ref);
    const pending = this.builds.get(key);
    if (pending) return pending;
    const job = this.buildBundle(ref).finally(() => this.builds.delete(key));
    this.builds.set(key, job);
    return job;
  }
  private async buildBundle(
    ref: OnlineNovelChapterRef,
    signal?: AbortSignal,
  ): Promise<BundleRecord> {
    const key = chapterKey(ref),
      task = this.store.get<SavedTask>("download", key);
    if (task?.state === "completed" && task.bundle) {
      try {
        await this.readBundle(task.bundle);
        return task.bundle;
      } catch (error) {
        task.state = "failed";
        task.error = message(error);
        this.store.set("download", key, task);
        this.changed();
      }
    }
    const cached = this.store.get<BundleRecord>("cache", key);
    if (cached) {
      try {
        await this.readBundle(cached);
        return cached;
      } catch {
        this.store.delete("cache", key);
      }
    }
    const details = await this.details(ref);
    const chapter = details.chapters.find((c) => c.id === ref.chapterId);
    if (!chapter) throw new Error("章节已被移除，请刷新目录");
    const content = await this.chapterRequests.run(
      ref.sourceId,
      () => this.provider(ref.sourceId).chapter(ref.novelId, chapter),
      signal,
    );
    signal?.throwIfAborted();
    const bundle: ChapterBundle = await chapterEpub(content, (url) =>
      this.asset(ref.sourceId, url, content.base, signal),
    );
    signal?.throwIfAborted();
    if (this.closed) throw new Error("服务已关闭");
    const file = path.join(this.root, "cache", `${key}.epub`);
    await this.atomic(file, bundle.data);
    const record = {
      file,
      hash: hash(bundle.data),
      size: bundle.data.length,
      version: bundle.version,
      requiredFont: bundle.requiredFont,
    };
    this.store.set("cache", key, record);
    return record;
  }
  async reader(ref: OnlineNovelChapterRef): Promise<NovelReaderState> {
    ref = this.ref(ref);
    const details = await this.details(ref);
    const bundle = await this.bundle(ref);
    const key = bookKey(ref),
      chapter = details.chapters.find((c) => c.id === ref.chapterId)!;
    const stored = this.store.get<ProgressRecord>("progress", chapterKey(ref));
    const changed =
      stored?.version !== undefined && stored.version !== bundle.version;
    const progress = changed
      ? { ...stored.progress, cfi: undefined }
      : stored?.progress;
    const saved = this.store.get<SavedNovel>("book", key)!;
    saved.lastChapterId = ref.chapterId;
    saved.openedAt = Date.now();
    this.store.set("book", key, saved);
    this.store.set("history", key, { ...ref });
    const follow = this.store.get<NovelFollowState>("following", key);
    if (follow) {
      follow.newChapterIds = follow.newChapterIds.filter(
        (id) => id !== ref.chapterId,
      );
      this.store.set("following", key, follow);
    }
    this.changed();
    const item: MediaItem = {
      id: `novel-online:${chapterKey(ref)}`,
      type: "novel",
      title: `${details.title} · ${chapter.title}`,
      path: "",
      folder: "",
      ext: "epub",
      size: bundle.size,
      modifiedAt: bundle.version,
      resourceVersion: bundle.version,
      addedAt: 0,
      favorite: Boolean(details.favorite),
      missing: false,
      libraryIds: [],
      cover: details.cover,
      remoteCover: details.cover,
      onlineNovelRef: { ...ref },
      novelRequiredFont: bundle.requiredFont,
      progress,
    };
    return {
      item,
      details,
      bookmarks: this.bookmarks(ref),
      notice: changed ? "章节内容已更新，已尝试恢复最近的阅读位置" : undefined,
    };
  }
  async saveProgress(
    ref: OnlineNovelChapterRef,
    progress: Progress,
    version?: number,
  ) {
    ref = this.ref(ref);
    if (
      !progress ||
      typeof progress !== "object" ||
      JSON.stringify(progress).length > 16000
    )
      throw new Error("无效进度");
    const clean: Progress = {};
    for (const field of [
      "scroll",
      "position",
      "duration",
      "page",
      "textOffset",
    ] as const)
      if (
        typeof progress[field] === "number" &&
        Number.isFinite(progress[field]) &&
        progress[field]! >= 0
      )
        clean[field] = progress[field];
    for (const field of ["cfi", "href"] as const)
      if (
        typeof progress[field] === "string" &&
        progress[field]!.length <= 4096
      )
        clean[field] = progress[field];
    clean.completed = Boolean(progress.completed);
    this.store.set("progress", chapterKey(ref), { progress: clean, version });
  }
  private bookmarks(ref: OnlineNovelRef) {
    return this.store
      .all<NovelBookmark>("bookmark")
      .filter((b) => bookKey(b) === bookKey(ref));
  }
  async bookmark(ref: OnlineNovelChapterRef, progress: Progress) {
    ref = this.ref(ref);
    if (!progress || JSON.stringify(progress).length > 16000)
      throw new Error("无效书签");
    const details = await this.details(ref),
      id = randomUUID();
    this.store.set("bookmark", id, {
      ...ref,
      id,
      title:
        details.chapters.find((c) => c.id === ref.chapterId)?.title || "书签",
      progress,
      createdAt: Date.now(),
    });
    this.changed();
    return this.bookmarks(ref);
  }
  async deleteBookmark(ref: OnlineNovelRef, id: string) {
    ref = this.ref(ref);
    if (typeof id !== "string") throw new Error("无效书签");
    // Older records are also supported if their storage key predates the public id.
    const record = this.store.get<NovelBookmark>("bookmark", id);
    if (record && bookKey(record) === bookKey(ref))
      this.store.delete("bookmark", id);
    this.changed();
    return this.bookmarks(ref);
  }
  async downloads() {
    return this.store
      .all<SavedTask>("download")
      .map(({ directory: _d, bundle: _b, retryCount: _r, ...task }) => task);
  }
  async revealDownload(id: string) {
    const task = this.store.get<SavedTask>("download", id);
    if (!task) throw new Error("下载任务不存在");
    if (task.bundle?.file) {
      shell.showItemInFolder(task.bundle.file);
      return;
    }
    const failure = await shell.openPath(task.directory);
    if (failure) throw new Error(failure);
  }
  async downloadDirectory(choose = false) {
    let directory =
      this.store.get<string>("setting", "downloads") ||
      path.join(this.root, "downloads");
    if (choose) {
      const result = await dialog.showOpenDialog(this.getWindow()!, {
        title: "选择小说下载目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (!result.canceled && result.filePaths[0]) {
        directory = result.filePaths[0];
        this.store.set("setting", "downloads", directory);
      }
    }
    return directory;
  }
  /** `<download root>/<source name>/<novel title>`, unique per novel. */
  private taskFolderOccupants(tasks: SavedTask[]) {
    const occupants = new Map<string, Set<string>>();
    for (const task of tasks) {
      let folder = task.bundle?.file || task.directory;
      while (folder) {
        const key = folder.replace(/\\/g, "/").toLowerCase();
        const ids = occupants.get(key) || new Set<string>();
        ids.add(task.novelId);
        occupants.set(key, ids);
        const parent = path.dirname(folder);
        if (parent === folder) break;
        folder = parent;
      }
    }
    return occupants;
  }
  private novelFolderFor(
    root: string,
    ref: OnlineNovelRef,
    title: string,
    tasks = this.store.all<SavedTask>("download"),
    occupants = this.taskFolderOccupants(tasks),
  ) {
    const base = path.join(
      root,
      folderName(this.sourcesById.get(ref.sourceId)?.meta.name, "未知来源"),
      folderName(title, bookKey(ref).slice(0, 8)),
    );
    // Two novels of one source may share a title; never mix their chapters.
    let folder = base;
    for (let index = 2; index < 100; index++) {
      const clash = [
        ...(occupants.get(folder.replace(/\\/g, "/").toLowerCase()) || []),
      ].some((novelId) => novelId !== ref.novelId);
      if (!clash) return folder;
      folder = `${base} (${index})`;
    }
    return folder;
  }
  async enqueue(ref: OnlineNovelRef, chapterIds: string[]) {
    ref = this.ref(ref);
    if (
      !Array.isArray(chapterIds) ||
      chapterIds.length > 10000 ||
      !chapterIds.length
    )
      throw new Error("请选择要下载的章节");
    const details = await this.details(ref),
      root = await this.downloadDirectory();
    // Readable layout: <download root>/<source name>/<novel title>/<chapter>.epub
    const directory = this.novelFolderFor(root, ref, details.title);
    const chapters = [...new Set(chapterIds)].map((chapterId) => {
      const chapter = details.chapters.find((c) => c.id === chapterId);
      if (!chapter) throw new Error("下载列表包含无效章节");
      return chapter;
    });
    for (const chapter of chapters) {
      const chapterId = chapter.id;
      const id = chapterKey({ ...ref, chapterId });
      const existing = this.store.get<SavedTask>("download", id);
      if (existing) {
        if (existing.state === "failed") this.requeue(existing);
        continue;
      }
      this.store.set("download", id, {
        ...ref,
        chapterId,
        id,
        title: chapter.title,
        novelTitle: details.title,
        state: "queued",
        createdAt: Date.now(),
        directory,
      } satisfies SavedTask);
    }
    this.changed();
    this.pump();
  }
  private requeue(task: SavedTask) {
    task.state = "queued";
    task.error = undefined;
    task.retryAt = undefined;
    task.retryCount = 0;
    this.store.set("download", task.id, task);
  }
  async retryFailed() {
    const failed = this.store
      .all<SavedTask>("download")
      .filter((task) => task.state === "failed");
    for (const task of failed) this.requeue(task);
    this.changed();
    this.pump();
    return failed.length;
  }
  getDownloadConcurrency() {
    const saved = Number(
      this.store.get<number>("setting", "download-concurrency"),
    );
    return Number.isInteger(saved) && saved >= 1 && saved <= 5 ? saved : 1;
  }
  setDownloadConcurrency(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 5)
      throw new Error("并发下载数必须在 1 到 5 之间");
    this.store.set("setting", "download-concurrency", value);
    this.changed();
    this.pump();
    return value;
  }
  async downloadAction(
    id: string,
    action: "pause" | "resume" | "cancel" | "delete",
  ) {
    if (
      typeof id !== "string" ||
      !["pause", "resume", "cancel", "delete"].includes(action)
    )
      throw new Error("无效下载操作");
    const task = this.store.get<SavedTask>("download", id);
    if (!task) return;
    this.jobs.get(id)?.abort();
    if (action === "delete" || action === "cancel") {
      if (action === "cancel" && task.state === "completed") return;
      if (task.bundle) await fs.rm(task.bundle.file, { force: true });
      this.store.delete("download", id);
      // Drop the novel and source folders once their last EPUB is gone.
      const root = await this.downloadDirectory().catch(() => "");
      await pruneEmptyFolders(task.directory, root).catch(() => {});
    } else {
      if (task.state === "completed") return;
      task.state = action === "pause" ? "paused" : "queued";
      task.error = undefined;
      task.retryAt = undefined;
      task.retryCount = 0;
      this.store.set("download", id, task);
    }
    this.changed();
    this.pump();
  }
  private pump() {
    if (this.closed) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    let nextWake = Infinity;
    for (const task of this.store.all<SavedTask>("download").reverse()) {
      if (this.jobs.size >= this.getDownloadConcurrency()) break;
      if (task.state !== "queued" || this.jobs.has(task.id)) continue;
      if (
        [...this.jobs.keys()].some(
          (id) =>
            this.store.get<SavedTask>("download", id)?.sourceId ===
            task.sourceId,
        )
      )
        continue;
      const readyAt = Math.max(
        task.retryAt || 0,
        this.chapterRequests.availableAt(task.sourceId),
      );
      if (readyAt > Date.now()) {
        nextWake = Math.min(nextWake, readyAt);
        continue;
      }
      const controller = new AbortController();
      this.jobs.set(task.id, controller);
      task.state = "downloading";
      task.retryAt = undefined;
      this.store.set("download", task.id, task);
      this.changed();
      void this.runDownload(task, controller.signal).finally(() => {
        this.jobs.delete(task.id);
        this.pump();
      });
    }
    if (Number.isFinite(nextWake)) {
      this.pumpTimer = setTimeout(
        () => this.pump(),
        Math.max(1, nextWake - Date.now()),
      );
      this.pumpTimer.unref();
    }
  }
  /** `<chapter title>.epub`, kept unique against the novel's other chapters. */
  private downloadFile(task: SavedTask) {
    const stem = folderName(task.title, task.id.slice(0, 8));
    const owned = new Set(
      this.store
        .all<SavedTask>("download")
        .flatMap((other) =>
          other.id !== task.id && other.bundle?.file
            ? [other.bundle.file.toLowerCase()]
            : [],
        ),
    );
    let file = path.join(task.directory, `${stem}.epub`);
    for (let index = 2; owned.has(file.toLowerCase()); index++) {
      if (index > 99) throw new Error("同名章节过多，无法命名下载文件");
      file = path.join(task.directory, `${stem} (${index}).epub`);
    }
    return file;
  }
  /**
   * Older versions wrote `<hash>.epub` straight into the download root, which
   * reads as garbage in Explorer. Point unfinished tasks at the readable
   * layout and move finished EPUBs into it.
   */
  private async migrateDownloadFiles() {
    const hashed = /^[0-9a-f]{64}$/;
    const all = this.store.all<SavedTask>("download");
    if (!all.length) return;
    let root: string;
    try {
      root = await this.downloadDirectory();
    } catch {
      return;
    }
    const folders = new Map<string, string>();
    const claimedFolders = new Set<string>();
    const occupants = this.taskFolderOccupants(all);
    const folderFor = (task: SavedTask) => {
      const key = bookKey(task);
      let folder = folders.get(key);
      if (!folder) {
        const base = this.novelFolderFor(
          root,
          task,
          task.novelTitle,
          all,
          occupants,
        );
        // Tasks are a snapshot, so guard against two novels claiming one name.
        folder = base;
        for (let index = 2; claimedFolders.has(folder.toLowerCase()); index++)
          folder = `${base} (${index})`;
        folders.set(key, folder);
        claimedFolders.add(folder.toLowerCase());
      }
      return folder;
    };
    let moved = false;
    // Unfinished tasks own no file yet, so relocating them is a path fix.
    for (const task of all) {
      if (task.bundle?.file) continue;
      const directory = folderFor(task);
      if (task.directory === directory) continue;
      task.directory = directory;
      this.store.set("download", task.id, task);
      moved = true;
    }
    const taken = new Set(
      all.flatMap((task) =>
        task.bundle?.file ? [task.bundle.file.toLowerCase()] : [],
      ),
    );
    for (const task of all) {
      const old = task.bundle?.file;
      if (!old || !hashed.test(path.basename(old, ".epub"))) continue;
      const directory = folderFor(task),
        stem = folderName(task.title, task.id.slice(0, 8));
      let file = path.join(directory, `${stem}.epub`);
      for (let index = 2; taken.has(file.toLowerCase()); index++)
        file = path.join(directory, `${stem} (${index}).epub`);
      taken.delete(old.toLowerCase());
      try {
        await movePath(old, file);
      } catch {
        continue;
      }
      taken.add(file.toLowerCase());
      task.directory = directory;
      task.bundle = { ...task.bundle!, file };
      this.store.set("download", task.id, task);
      moved = true;
    }
    if (moved) this.changed();
  }
  private async runDownload(task: SavedTask, signal: AbortSignal) {
    try {
      const record = await this.buildBundle(task, signal);
      if (signal.aborted || this.closed) return;
      const data = await this.readBundle(record),
        file = this.downloadFile(task);
      await this.atomic(file, data);
      if (signal.aborted || this.closed) {
        await fs.rm(file, { force: true });
        return;
      }
      task.bundle = { ...record, file };
      task.size = record.size;
      task.state = "completed";
      task.error = undefined;
      task.retryAt = undefined;
      task.retryCount = undefined;
      this.store.set("download", task.id, task);
      this.changed();
    } catch (error) {
      if (!signal.aborted && !this.closed) {
        const delay = rateLimitDelay(error);
        const retry = delay !== undefined && (task.retryCount || 0) < 3;
        task.state = retry ? "queued" : "failed";
        task.retryAt = retry ? Date.now() + delay! : undefined;
        if (retry) task.retryCount = (task.retryCount || 0) + 1;
        task.error = message(error);
        this.store.set("download", task.id, task);
        this.changed();
      }
    }
  }
  private async atomic(file: string, data: Uint8Array) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.part`;
    try {
      await fs.writeFile(temp, data);
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  async exportQuote(ref: OnlineNovelRef) {
    ref = this.ref(ref);
    for (const old of this.store.all<NovelExportQuote>("quote"))
      if (old.expiresAt < Date.now()) this.store.delete("quote", old.id);
    const source = await this.scriptRuntime(ref.sourceId);
    if (!source.meta.capabilities.exportEpub)
      throw new Error("此源不支持原生 EPUB 导出");
    const details = await this.details(ref, true);
    if (details.refreshError) throw new Error(details.refreshError);
    if (!details.canExport)
      throw new Error("[permission] 当前账号没有原生 EPUB 下载权限");
    const quote: NovelExportQuote = {
      ...ref,
      id: randomUUID(),
      title: details.title,
      cost: details.exportCost || 0,
      expiresAt: Date.now() + 120000,
    };
    this.store.set("quote", quote.id, quote);
    return quote;
  }
  async exportEpub(quoteId: string) {
    const quote = this.store.get<NovelExportQuote>("quote", quoteId);
    if (!quote || quote.expiresAt < Date.now())
      throw new Error("下载报价已过期，请重新确认");
    // Claim synchronously, before any awaited validation or file dialog, so a
    // double click cannot spend the same confirmation twice.
    this.store.delete("quote", quoteId);
    const details = await this.details(quote, true);
    if (
      details.refreshError ||
      !details.canExport ||
      details.exportCost !== quote.cost
    )
      throw new Error("下载费用或权限发生变化，请重新确认");
    const result = await dialog.showSaveDialog(this.getWindow()!, {
      title: "保存源站原生 EPUB",
      defaultPath: `${quote.title.replace(/[<>:"/\\|?*]/g, "_")}.epub`,
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const current = await this.details(quote, true);
    if (
      quote.expiresAt < Date.now() ||
      current.refreshError ||
      !current.canExport ||
      current.exportCost !== quote.cost
    )
      throw new Error("下载费用、权限或报价有效期发生变化，请重新确认");
    const source = await this.scriptRuntime(quote.sourceId);
    const downloaded = await source.runtime.call("downloadEpub", [
      quote.novelId,
    ]);
    const data =
      downloaded instanceof ArrayBuffer
        ? new Uint8Array(downloaded)
        : new Uint8Array(downloaded);
    if (!data.length) throw new Error("源站返回了空 EPUB");
    let validEpub = false;
    try {
      const archive = unzipSync(data, {
        filter: (entry) =>
          entry.name === "mimetype" || entry.name === "META-INF/container.xml",
      });
      validEpub = Boolean(
        archive["META-INF/container.xml"] &&
        archive.mimetype &&
        strFromU8(archive.mimetype).trim() === "application/epub+zip",
      );
    } catch {}
    if (!validEpub)
      throw new Error("源站未返回有效 EPUB，若已扣费请先检查站点记录再重试");
    await this.atomic(result.filePath, data);
    return result.filePath;
  }
  async resource(request: Request): Promise<Response> {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD",
      "Content-Type": "application/epub+zip",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers });
    const url = new URL(request.url),
      match = /^\/(chapter|cover)\/([a-f0-9]{64})$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404, headers });
    try {
      if (match[1] === "chapter") {
        const cached = this.store.get<BundleRecord>("cache", match[2]),
          task = this.store.get<SavedTask>("download", match[2]);
        const record = task?.state === "completed" ? task.bundle : cached;
        if (!record) throw new Error("章节尚未加载");
        const data = await this.readBundle(record);
        return new Response(request.method === "HEAD" ? null : data, {
          headers,
        });
      }
      const cover = this.store.get<{ sourceId: NovelSourceId; url: string }>(
        "cover",
        match[2],
      );
      if (!cover) throw new Error("封面不存在");
      const file = path.join(this.root, "cache", `${match[2]}.cover`);
      let data: Uint8Array;
      let mime: string;
      try {
        data = await fs.readFile(file);
        mime = await coverType(data);
      } catch {
        const asset = await this.asset(
          cover.sourceId,
          cover.url,
          this.sourcesById.get(cover.sourceId)!.meta.url,
        );
        data = asset.data;
        mime = await coverType(data);
        await this.atomic(file, data);
      }
      return new Response(
        request.method === "HEAD" ? null : Buffer.from(data),
        { headers: { ...headers, "Content-Type": mime } },
      );
    } catch (error) {
      return new Response(message(error), {
        status: 503,
        headers: { ...headers, "Content-Type": "text/plain;charset=utf-8" },
      });
    }
  }
  async clearCache() {
    // Completed tasks may still be finishing their promise cleanup after the IPC
    // update reaches the renderer. Give that cleanup a turn before checking.
    for (
      let attempt = 0;
      attempt < 20 && (this.builds.size || this.jobs.size);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.builds.size || this.jobs.size)
      throw new Error("正在处理小说章节，请完成或暂停下载后再清理缓存");
    await fs.rm(path.join(this.root, "cache"), {
      recursive: true,
      force: true,
    });
    this.store.clear("cache");
  }
  close() {
    this.closed = true;
    clearTimeout(this.pumpTimer);
    this.chapterRequests.close();
    this.change.dispose();
    for (const c of this.jobs.values()) c.abort();
    for (const id of this.active.keys())
      void this.closeSourceRuntime(id).catch(() => {});
    for (const win of this.logins.values()) win.destroy();
    for (const win of this.searchWindows) win.destroy();
    this.store.close();
  }
}
export function installOnlineNovels(
  getWindow: () => BrowserWindow | null,
  networkProxy: NetworkProxyManager,
) {
  const service = new OnlineNovelService(
    getWindow,
    app.getPath("userData"),
    networkProxy,
  );
  const allowed = new Set<string>(NOVEL_API_METHODS);
  ipcMain.handle("novel:call", (event, method: string, args: unknown[]) => {
    if (
      event.sender !== getWindow()?.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !allowed.has(method) ||
      !Array.isArray(args) ||
      args.length > 5
    )
      throw new Error("无效小说请求");
    return (
      service[method as keyof OnlineNovelService] as (...args: any[]) => unknown
    ).apply(service, args);
  });
  app.once("will-quit", () => service.close());
  return service;
}
