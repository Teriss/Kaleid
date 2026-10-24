import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  type Session,
} from "electron";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { unzipSync, strFromU8 } from "fflate";
import type { MediaItem, Progress } from "../../shared/types";
import {
  NOVEL_API_METHODS,
  type NovelSourceId,
  type OnlineNovelRef,
  type OnlineNovelChapterRef,
  type OnlineNovelDetails,
  type OnlineNovel,
  type NovelHubList,
  type NovelFollowState,
  type NovelDownloadTask,
  type NovelBookmark,
  type NovelExportQuote,
  type NovelReaderState,
} from "../../shared/onlineNovels";
import {
  API_NODES,
  SOURCE_DEFINITIONS,
  LightNovelShelfProvider,
  BilinovelProvider,
  type NovelProvider,
  type ProviderHost,
} from "./providers";
import {
  chapterEpub,
  checkResponse,
  hash,
  safeRemote,
  type ChapterBundle,
} from "./content";
import { NovelStore } from "./store";

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
  enabled: boolean;
  apiNode?: string;
  credentials?: string;
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
  private providers = new Map<NovelSourceId, NovelProvider>();
  private logins = new Map<NovelSourceId, BrowserWindow>();
  private jobs = new Map<string, AbortController>();
  private builds = new Map<string, Promise<BundleRecord>>();
  private detailRequests = new Map<string, Promise<SavedNovel>>();
  private closed = false;
  private credentialsMemory:
    ReturnType<ProviderHost["credentials"]> | undefined;
  constructor(
    private getWindow: () => BrowserWindow | null,
    userData: string,
  ) {
    this.root = path.join(userData, "novel-online");
    mkdirSync(this.root, { recursive: true });
    this.store = new NovelStore(path.join(this.root, "library.sqlite"));
    for (const def of SOURCE_DEFINITIONS) {
      const ses = session.fromPartition(`persist:novel-${def.id}`);
      ses.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      this.sessions.set(def.id, ses);
    }
    const host: ProviderHost = {
      request: (id, url, init) => this.request(id, url, init),
      node: () => this.config("lightnovelshelf").apiNode || API_NODES[0],
      credentials: () => this.credentials(),
      saveCredentials: (data) => this.saveCredentials(data),
      browserSearch: (keyword, page) => this.browserSearch(keyword, page),
    };
    this.providers.set("lightnovelshelf", new LightNovelShelfProvider(host));
    this.providers.set("bilinovel", new BilinovelProvider(host));
    for (const task of this.store.all<SavedTask>("download"))
      if (["queued", "downloading"].includes(task.state)) {
        task.state = "paused";
        this.store.set("download", task.id, task);
      }
  }
  private changed() {
    if (!this.closed) this.getWindow()?.webContents.send("novel:change");
  }
  private source(id: NovelSourceId) {
    if (!SOURCE_DEFINITIONS.some((s) => s.id === id))
      throw new Error("无效小说源");
    return id;
  }
  private ref<T extends OnlineNovelRef>(ref: T): T {
    if (!ref || typeof ref !== "object") throw new Error("无效作品引用");
    this.source(ref.sourceId);
    if (
      typeof ref.novelId !== "string" ||
      !/^\d{1,16}$/.test(ref.novelId) ||
      !Number.isSafeInteger(Number(ref.novelId))
    )
      throw new Error("无效作品标识");
    if (
      "chapterId" in ref &&
      (typeof ref.chapterId !== "string" || !/^\d{1,16}$/.test(ref.chapterId))
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
    return this.store.get<SourceSettings>("source", id) || { enabled: true };
  }
  private provider(id: NovelSourceId) {
    this.source(id);
    if (!this.config(id).enabled)
      throw new Error("[disabled] 小说源已停用，已下载章节仍可阅读");
    return this.providers.get(id)!;
  }
  private credentials() {
    if (this.credentialsMemory) return this.credentialsMemory;
    const sealed = this.config("lightnovelshelf").credentials;
    if (!sealed) return {};
    try {
      return (this.credentialsMemory = JSON.parse(
        safeStorage.decryptString(Buffer.from(sealed, "base64")),
      ));
    } catch {
      return {};
    }
  }
  private saveCredentials(data: ReturnType<ProviderHost["credentials"]>) {
    if (
      (data.token || data.refreshToken) &&
      !safeStorage.isEncryptionAvailable()
    )
      throw new Error("系统凭据加密不可用，无法保存登录");
    const config = this.config("lightnovelshelf");
    config.credentials =
      data.token || data.refreshToken
        ? safeStorage.encryptString(JSON.stringify(data)).toString("base64")
        : undefined;
    this.credentialsMemory = data;
    this.store.set("source", "lightnovelshelf", config);
    this.changed();
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
    if (
      id === "lightnovelshelf" &&
      API_NODES.some((node) => new URL(node).origin === new URL(url).origin)
    ) {
      let visitor = this.store.get<string>("setting", "visitor");
      if (!visitor) {
        visitor = randomUUID();
        this.store.set("setting", "visitor", visitor);
      }
      headers.set("x-id", visitor);
    }
    try {
      return await this.sessions
        .get(id)!
        .fetch(url, { ...init, headers, signal });
    } catch (error) {
      throw new Error(`[network] ${message(error)}`);
    }
  }
  async sources() {
    return Promise.all(
      SOURCE_DEFINITIONS.map(async (def) => ({
        ...def,
        enabled: this.config(def.id).enabled,
        apiNode:
          def.id === "lightnovelshelf"
            ? this.config(def.id).apiNode || API_NODES[0]
            : undefined,
        logged:
          def.id === "lightnovelshelf"
            ? Boolean(this.credentials().refreshToken)
            : (
                await this.sessions.get(def.id)!.cookies.get({ url: def.url })
              ).some((c) => /uid|user|login|auth/i.test(c.name)),
      })),
    );
  }
  async settings(
    id: NovelSourceId,
    value: { enabled?: boolean; apiNode?: string },
  ) {
    this.source(id);
    if (
      !value ||
      typeof value !== "object" ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean")
    )
      throw new Error("无效设置");
    if (
      value.apiNode !== undefined &&
      (id !== "lightnovelshelf" || !API_NODES.includes(value.apiNode))
    )
      throw new Error("无效服务器节点");
    const config = this.config(id);
    this.store.set("source", id, {
      ...config,
      enabled: value.enabled ?? config.enabled,
      apiNode: value.apiNode ?? config.apiNode,
    });
    await this.providers.get(id)!.close();
    this.changed();
  }
  async login(id: NovelSourceId, email: string, password: string) {
    this.source(id);
    if (id !== "lightnovelshelf") throw new Error("请使用网页登录");
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email ||
      !password ||
      email.length > 256 ||
      password.length > 1024
    )
      throw new Error("请输入邮箱和密码");
    await (this.providers.get(id) as LightNovelShelfProvider).login(
      email,
      password,
    );
    this.changed();
  }
  async logout(id: NovelSourceId) {
    this.source(id);
    if (id === "lightnovelshelf") this.saveCredentials({});
    await this.sessions.get(id)!.clearStorageData();
    await this.providers.get(id)!.close();
    this.changed();
  }
  async webLogin(id: NovelSourceId) {
    this.source(id);
    const existing = this.logins.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const def = SOURCE_DEFINITIONS.find((s) => s.id === id)!;
    const win = new BrowserWindow({
      width: 1080,
      height: 800,
      parent: this.getWindow() || undefined,
      title: `${def.name} · 登录与验证`,
      webPreferences: {
        session: this.sessions.get(id),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.logins.set(id, win);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== new URL(def.url).origin)
        event.preventDefault();
    });
    win.on("closed", () => {
      this.logins.delete(id);
      this.changed();
    });
    await win.loadURL(def.url);
  }
  private async browserSearch(keyword: string, page: number): Promise<string> {
    if (this.searchWindows.size >= 2)
      throw new Error("[rate-limit] 正在搜索哔哩轻小说，请稍后重试");
    const origin = "https://www.bilinovel.com";
    // Fast path also permits deterministic response fixtures and ordinary HTML forms.
    const response = await this.request("bilinovel", `${origin}/search.html`);
    const html = await response.text();
    checkResponse(response.status, html);
    if (
      /href=["'][^"']*\/novel\/\d+\.html/.test(html) &&
      !/<input\b/i.test(html)
    )
      return html;
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        session: this.sessions.get("bilinovel"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.searchWindows.add(win);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, 45000);
    try {
      await win.loadURL(`${origin}/search.html`);
      const initial = await win.webContents.executeJavaScript(
        "document.documentElement.outerHTML",
      );
      checkResponse(200, initial);
      const initialLinks = await win.webContents.executeJavaScript(
        `JSON.stringify([...document.querySelectorAll('a[href*="/novel/"]')].map(a=>a.href))`,
      );
      const submitted = await win.webContents.executeJavaScript(`(()=>{
        const input=document.querySelector('input[type="search"],input[name="searchkey"],#searchkey,input[placeholder*="关键词"]');
        if(!input)return false;
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(keyword)});
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
        const button=document.querySelector('button[type="submit"],input[type="submit"],.search-btn,#search-submit,[onclick*="search"]');
        if(input.form)input.form.requestSubmit();else if(button)button.click();else{input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));}
        return true;
      })()`);
      if (!submitted)
        throw new Error(
          "[parse] 哔哩搜索页面缺少输入控件，请在源站检查搜索是否可用",
        );
      let result = "";
      for (let current = 1; current <= page; current++) {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (win.isDestroyed()) throw new Error("[network] 哔哩搜索超时");
          try {
            result = await win.webContents.executeJavaScript(
              "document.documentElement.outerHTML",
            );
          } catch {
            continue;
          } // Navigation briefly replaces the execution context.
          checkResponse(200, result);
          const ready = await win.webContents.executeJavaScript(
            `(()=>{const text=document.body.innerText;const links=JSON.stringify([...document.querySelectorAll('a[href*="/novel/"]')].map(a=>a.href));return links!==${JSON.stringify(initialLinks)}&&Boolean(document.querySelector('a[href*="/novel/"]'))||/没有找到|未找到|暂无结果|无搜索结果/.test(text);})()`,
          );
          if (ready) break;
        }
        if (!result || Date.now() >= deadline)
          throw new Error(
            "[network] 哔哩搜索没有返回结果，请在源站确认搜索可用后重试",
          );
        if (current === page) return result;
        const before = result;
        const clicked = await win.webContents.executeJavaScript(
          `(()=>{const next=[...document.querySelectorAll('a[href]')].find(a=>/下一页|下页/.test(a.textContent));if(!next)return false;next.click();return true;})()`,
        );
        if (!clicked) throw new Error("[parse] 已到搜索结果末页");
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          try {
            if (
              (await win.webContents.executeJavaScript(
                "document.documentElement.outerHTML",
              )) !== before
            )
              break;
          } catch {}
        }
      }
      return result;
    } finally {
      clearTimeout(timer);
      this.searchWindows.delete(win);
      if (!win.isDestroyed()) win.destroy();
    }
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
    const result = await this.provider(id).search(keyword.trim(), page);
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
    const result = await this.provider(id).discover(kind, page);
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
          this.store.delete("cache", chapterKey({ ...ref, chapterId: chapter.id }));
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
        downloaded: tasks.some(
          (t) =>
            t.id === chapterKey({ ...ref, chapterId: c.id }) &&
            t.state === "completed",
        ),
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
      const novel =
        this.store.get<SavedNovel>("book", key) ||
        this.store.get<OnlineNovel>("summary", key);
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
    const response = await this.request(id, safeRemote(url, base), {
      signal,
      // Chromium rejects the retired acgdmzy referrer for the current image host.
      // Resolve relative URLs against their document, independently of the site's request referrer.
      headers: {
        Referer:
          id === "lightnovelshelf" ? "https://www.lightnovel.app/" : base,
      },
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
    const content = await this.provider(ref.sourceId).chapter(
      ref.novelId,
      chapter,
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
      .map(({ directory: _d, bundle: _b, ...task }) => task);
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
  async enqueue(ref: OnlineNovelRef, chapterIds: string[]) {
    ref = this.ref(ref);
    if (
      !Array.isArray(chapterIds) ||
      chapterIds.length > 10000 ||
      !chapterIds.length
    )
      throw new Error("请选择要下载的章节");
    const details = await this.details(ref),
      directory = await this.downloadDirectory();
    for (const chapterId of [...new Set(chapterIds)]) {
      const chapter = details.chapters.find((c) => c.id === chapterId);
      if (!chapter) throw new Error("下载列表包含无效章节");
      const id = chapterKey({ ...ref, chapterId });
      if (this.store.get("download", id)) continue;
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
    } else {
      if (task.state === "completed") return;
      task.state = action === "pause" ? "paused" : "queued";
      task.error = undefined;
      this.store.set("download", id, task);
    }
    this.changed();
    this.pump();
  }
  private pump() {
    if (this.closed) return;
    for (const task of this.store.all<SavedTask>("download").reverse()) {
      if (this.jobs.size >= 2) break;
      if (task.state !== "queued" || this.jobs.has(task.id)) continue;
      if (
        [...this.jobs.keys()].some(
          (id) =>
            this.store.get<SavedTask>("download", id)?.sourceId ===
            task.sourceId,
        )
      )
        continue;
      const controller = new AbortController();
      this.jobs.set(task.id, controller);
      task.state = "downloading";
      this.store.set("download", task.id, task);
      this.changed();
      void this.runDownload(task, controller.signal).finally(() => {
        this.jobs.delete(task.id);
        this.pump();
      });
    }
  }
  private async runDownload(task: SavedTask, signal: AbortSignal) {
    try {
      const record = await this.buildBundle(task, signal);
      if (signal.aborted || this.closed) return;
      const data = await this.readBundle(record),
        file = path.join(task.directory, `${task.id}.epub`);
      await this.atomic(file, data);
      if (signal.aborted || this.closed) {
        await fs.rm(file, { force: true });
        return;
      }
      task.bundle = { ...record, file };
      task.size = record.size;
      task.state = "completed";
      task.error = undefined;
      this.store.set("download", task.id, task);
      this.changed();
    } catch (error) {
      if (!signal.aborted && !this.closed) {
        task.state = "failed";
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
    if (ref.sourceId !== "lightnovelshelf")
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
    const provider = this.provider(
      "lightnovelshelf",
    ) as LightNovelShelfProvider;
    const node = this.config("lightnovelshelf").apiNode || API_NODES[0];
    const response = await this.request(
      "lightnovelshelf",
      `${node}/api/book/download?bid=${quote.novelId}`,
      {
        headers: {
          Authorization: `Bearer ${await provider.token()}`,
          Accept: "application/epub+zip",
        },
      },
    );
    const data = new Uint8Array(await response.arrayBuffer());
    checkResponse(
      response.status,
      new TextDecoder().decode(data.slice(0, 2000)),
    );
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
          SOURCE_DEFINITIONS.find((s) => s.id === cover.sourceId)!.url,
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
    for (const c of this.jobs.values()) c.abort();
    for (const p of this.providers.values()) void p.close().catch(() => {});
    for (const win of this.logins.values()) win.destroy();
    for (const win of this.searchWindows) win.destroy();
    this.store.close();
  }
}
export function installOnlineNovels(getWindow: () => BrowserWindow | null) {
  const service = new OnlineNovelService(getWindow, app.getPath("userData"));
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
