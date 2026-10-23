import * as cheerio from "cheerio";
import {
  HubConnectionBuilder,
  HttpTransportType,
  HttpClient,
  HttpResponse,
  LogLevel,
  type HubConnection,
  type HttpRequest,
} from "@microsoft/signalr";
import { MessagePackHubProtocol } from "@microsoft/signalr-protocol-msgpack";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type {
  NovelSourceId,
  OnlineNovel,
  OnlineNovelDetails,
  NovelSearchPage,
  NovelChapter,
} from "../../shared/onlineNovels";
import { checkResponse, safeRemote, type ChapterContent } from "./content";

export const API_NODES = [
  "https://api.lightnovel.life",
  "https://cf-api.lightnovel.life",
];
export const SOURCE_DEFINITIONS = [
  {
    id: "lightnovelshelf" as const,
    name: "轻书架",
    url: "https://www.acgdmzy.com/home",
  },
  {
    id: "bilinovel" as const,
    name: "哔哩轻小说",
    url: "https://www.bilinovel.com/",
  },
];
export interface ProviderHost {
  request(
    id: NovelSourceId,
    url: string,
    init?: RequestInit,
  ): Promise<Response>;
  credentials(): { token?: string; refreshToken?: string; obtainedAt?: number };
  saveCredentials(value: {
    token?: string;
    refreshToken?: string;
    obtainedAt?: number;
  }): void;
  node(): string;
  browserSearch?(keyword: string, page: number): Promise<string>;
}
export interface NovelProvider {
  search(keyword: string, page: number): Promise<NovelSearchPage>;
  discover(kind: "latest" | "popular", page: number): Promise<NovelSearchPage>;
  details(id: string): Promise<OnlineNovelDetails>;
  chapter(id: string, chapter: NovelChapter): Promise<ChapterContent>;
  close(): Promise<void>;
}
class SessionHttpClient extends HttpClient {
  constructor(private host: ProviderHost) {
    super();
  }
  async send(request: HttpRequest) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (request.abortSignal?.aborted) controller.abort();
    if (request.abortSignal) request.abortSignal.onabort = abort;
    try {
      const response = await this.host.request(
        "lightnovelshelf",
        request.url!,
        {
          method: request.method,
          headers: request.headers,
          body: request.content,
          signal: controller.signal,
        },
      );
      return new HttpResponse(
        response.status,
        response.statusText,
        request.responseType === "arraybuffer"
          ? await response.arrayBuffer()
          : await response.text(),
      );
    } finally {
      if (request.abortSignal) request.abortSignal.onabort = null;
    }
  }
}
export function decodeEnvelope<T>(envelope: any): T {
  if (!envelope || envelope.Success !== true) {
    const msg = String(envelope?.Msg || "站点返回无效数据");
    const code =
      /unauthoriz|登录|认证/i.test(msg) || envelope?.Status === 401
        ? "auth-required"
        : /权限|permission|金币/i.test(msg)
          ? "permission"
          : "source";
    throw new Error(`[${code}] ${msg}`);
  }
  const data = envelope.Response;
  return data instanceof Uint8Array
    ? JSON.parse(gunzipSync(data).toString("utf8"))
    : data;
}

export class LightNovelShelfProvider implements NovelProvider {
  private hub?: HubConnection;
  private connecting?: Promise<HubConnection>;
  private refreshing?: Promise<string>;
  constructor(private host: ProviderHost) {}
  async http<T>(route: string, body: unknown): Promise<T> {
    const response = await this.host.request(
      "lightnovelshelf",
      `${this.host.node()}${route}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    checkResponse(response.status, text);
    try {
      return decodeEnvelope<T>(JSON.parse(text));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("[parse] 轻书架返回了非 JSON 数据");
      throw error;
    }
  }
  async token() {
    const credentials = this.host.credentials();
    if (credentials.token && Date.now() - (credentials.obtainedAt || 0) < 3_000)
      return credentials.token;
    if (!credentials.refreshToken) return "";
    if (!this.refreshing)
      this.refreshing = this.http<string>("/api/user/refresh_token", {
        token: credentials.refreshToken,
      })
        .then((token) => {
          this.host.saveCredentials({
            ...credentials,
            token,
            obtainedAt: Date.now(),
          });
          return token;
        })
        .catch((error) => {
          if (/auth-required|404|失效|无效/.test(String(error)))
            this.host.saveCredentials({});
          throw error;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    return this.refreshing;
  }
  async login(email: string, password: string) {
    const data = await this.http<{ Token: string; RefreshToken: string }>(
      "/api/user/login",
      // The official login form submits the UTF-8 SHA-256 digest, not the input password.
      // https://github.com/LightNovelShelf/Web/blob/master/src/pages/Login/Login.vue
      {
        email,
        password: createHash("sha256").update(password, "utf8").digest("hex"),
      },
    );
    if (!data.Token || !data.RefreshToken)
      throw new Error("[parse] 登录响应缺少凭据");
    this.host.saveCredentials({
      token: data.Token,
      refreshToken: data.RefreshToken,
      obtainedAt: Date.now(),
    });
    await this.close();
  }
  private connect(): Promise<HubConnection> {
    if (this.hub?.state === "Connected") return Promise.resolve(this.hub);
    if (this.connecting) return this.connecting;
    const hub = new HubConnectionBuilder()
      .withUrl(`${this.host.node()}/hub/api`, {
        accessTokenFactory: () => this.token(),
        transport: HttpTransportType.LongPolling,
        httpClient: new SessionHttpClient(this.host),
      })
      .withHubProtocol(new MessagePackHubProtocol())
      .configureLogging(LogLevel.None)
      .build();
    hub.serverTimeoutInMilliseconds = 30_000;
    this.hub = hub;
    this.connecting = hub
      .start()
      .then(() => hub)
      .catch((error) => {
        if (/429/.test(String(error)))
          throw new Error("[rate-limit] 轻书架请求过于频繁，请稍后重试");
        throw new Error(`[network] 轻书架连接失败：${String(error)}`);
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async invoke<T>(
    method: string,
    params: object,
    retryAuthentication = true,
  ): Promise<T> {
    const hub = await this.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return decodeEnvelope<T>(
        await Promise.race([
          hub.invoke(method, params, { UseGzip: true }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("[network] 轻书架请求超时，请重试")),
              30000,
            );
          }),
        ]),
      );
    } catch (error) {
      if (/429/.test(String(error)))
        throw new Error("[rate-limit] 轻书架请求过于频繁，请稍后重试");
      if (/unauthorized|unauthoriz|登录/i.test(String(error))) {
        const credentials = this.host.credentials();
        if (retryAuthentication && credentials.refreshToken) {
          this.host.saveCredentials({
            ...credentials,
            token: undefined,
            obtainedAt: undefined,
          });
          await this.close();
          return this.invoke<T>(method, params, false);
        }
        throw new Error(
          "[auth-required] 此功能需要有效的轻书架账号与访问权限，请使用邮箱密码登录",
        );
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private list(data: any, page: number): NovelSearchPage {
    if (!Array.isArray(data?.Data))
      throw new Error("[parse] 轻书架列表结构已变化");
    return {
      novels: data.Data.filter((b: any) => !b.Type || b.Type === "Novel").map(
        (b: any): OnlineNovel => ({
          sourceId: "lightnovelshelf",
          novelId: String(b.Id),
          title: b.Title,
          author: b.Author || undefined,
          cover: b.Cover ? safeRemote(b.Cover, this.host.node()) : undefined,
          updatedAt: b.LastUpdatedAt,
        }),
      ),
      page,
      hasMore: page < Number(data.TotalPages || 1),
    };
  }
  async search(keyword: string, page: number) {
    return this.list(
      await this.invoke("GetBookList", {
        KeyWords: keyword,
        Page: page,
        Size: 24,
        Type: "Novel",
      }),
      page,
    );
  }
  async discover(kind: "latest" | "popular", page: number) {
    if (!this.host.credentials().refreshToken && kind === "latest") {
      const result = this.list(
        await this.invoke("GetLatestBookList", {
          Page: 1,
          Size: 6,
          Type: "Novel",
        }),
        1,
      );
      return { ...result, hasMore: false };
    }
    return this.list(
      await this.invoke("GetBookList", {
        Page: page,
        Size: 24,
        Type: "Novel",
        Order: kind === "popular" ? "view" : "latest",
      }),
      page,
    );
  }
  async details(id: string): Promise<OnlineNovelDetails> {
    const data = await this.invoke<any>("GetBookInfo", { Id: Number(id) });
    const b = data?.Book;
    if (!b?.Id || !Array.isArray(b.Chapters))
      throw new Error("[parse] 轻书架详情结构已变化");
    return {
      sourceId: "lightnovelshelf",
      novelId: String(b.Id),
      title: b.Title,
      author: b.Author,
      cover: b.Cover ? safeRemote(b.Cover, this.host.node()) : undefined,
      description: cheerio.load(b.Introduction || "").text(),
      updatedAt: b.LastUpdatedAt,
      canExport:
        Boolean(b.CanDownload) &&
        Number.isSafeInteger(b.DownloadCost) &&
        b.DownloadCost >= 0,
      exportCost:
        Number.isSafeInteger(b.DownloadCost) && b.DownloadCost >= 0
          ? b.DownloadCost
          : undefined,
      chapters: b.Chapters.map((c: any) => ({
        id: String(c.Id),
        title: c.Title,
        order: c.SortNum,
        volume: b.Title,
        revision: c.UpdatedAt || c.CreatedAt,
      })),
    };
  }
  async chapter(id: string, chapter: NovelChapter): Promise<ChapterContent> {
    const data = await this.invoke<any>("GetNovelContent", {
      Bid: Number(id),
      SortNum: chapter.order,
    });
    if (
      typeof data?.Chapter?.Content !== "string" ||
      !data.Chapter.Content.trim()
    )
      throw new Error("[parse] 轻书架未返回正文");
    if (String(data.Chapter.Id) !== chapter.id)
      throw new Error("[parse] 章节顺序已变化，请刷新目录");
    return {
      title: data.Chapter.Title,
      html: data.Chapter.Content,
      base: this.host.node(),
      font: data.Chapter.Font,
    };
  }
  async close() {
    const hub = this.hub;
    this.hub = undefined;
    if (hub) await hub.stop();
  }
}

const BILI = "https://www.bilinovel.com";
export function parseBiliList(html: string, page: number): NovelSearchPage {
  const $ = cheerio.load(html);
  const found = new Map<string, OnlineNovel>();
  $("a[href]").each((_i, node) => {
    const a = $(node),
      href = a.attr("href") || "",
      match = new URL(href, BILI).pathname.match(/^\/novel\/(\d+)\.html$/);
    if (!match || found.has(match[1])) return;
    const card = a.closest(
      "li, article, .book-li, .book-item, .bookbox, .book-img-text",
    );
    const img = a.find("img").first().length
      ? a.find("img").first()
      : card.find("img").first();
    const title =
      a.attr("title") ||
      a.find("h2,h3,h4,.book-name").first().text().trim() ||
      img.attr("alt") ||
      a.text().trim();
    if (!title) return;
    const cover =
      img.attr("data-src") || img.attr("data-original") || img.attr("src");
    found.set(match[1], {
      sourceId: "bilinovel",
      novelId: match[1],
      title,
      author:
        card.find(".author,.book-author").first().text().trim() || undefined,
      cover: cover ? safeRemote(cover, BILI) : undefined,
    });
  });
  const next =
    $('a[rel="next"],.next,a.next').filter(
      (_i, n) => !$(n).hasClass("disabled") && Boolean($(n).attr("href")),
    ).length > 0 ||
    $("a")
      .toArray()
      .some(
        (n) =>
          /下一页|下页/.test($(n).text()) && /\d/.test($(n).attr("href") || ""),
      );
  if (!found.size && !/没有|未找到|无结果|0\s*条|暂无|搜索结果/i.test($.text()))
    throw new Error("[parse] 哔哩列表结构已变化");
  return { novels: [...found.values()], page, hasMore: next };
}
export function parseBiliDetails(
  html: string,
  id: string,
): Omit<OnlineNovelDetails, "chapters"> {
  const $ = cheerio.load(html);
  const meta = (name: string) =>
    $(`meta[property="${name}"],meta[name="${name}"]`).attr("content");
  const title = meta("og:novel:book_name") || $("h1").first().text().trim();
  if (!title) throw new Error("[parse] 哔哩详情缺少书名");
  const cover =
    meta("og:image") ||
    $(".book-img img,.book-cover img,#bookimg img,.book-layout img")
      .first()
      .attr("src");
  return {
    sourceId: "bilinovel",
    novelId: id,
    title,
    author:
      meta("og:novel:author") ||
      $(".book-author,.author").first().text().trim(),
    description:
      meta("og:description") ||
      meta("description") ||
      $(".book-intro,.book-dec,#bookintro").text().trim(),
    updatedAt: meta("og:novel:update_time") || meta("article:modified_time"),
    cover: cover ? safeRemote(cover, BILI) : undefined,
  };
}
export function parseBiliCatalog(html: string, id: string): NovelChapter[] {
  const $ = cheerio.load(html),
    chapters: NovelChapter[] = [];
  let volume = "正文";
  const seen = new Set<string>();
  $("h2,h3,h4,dt,.volume-title,.volume-name,.chapter-bar,a[href]").each(
    (_i, n) => {
      const el = $(n),
        text = el.text().trim(),
        href = el.attr("href") || "";
      const chapterURL = new URL(href, `${BILI}/novel/${id}/catalog`);
      const match =
        chapterURL.origin === BILI
          ? chapterURL.pathname.match(
              new RegExp(`^/novel/${id}/(\\d+)\\.html$`),
            )
          : null;
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        chapters.push({
          id: match[1],
          title: text || "插图",
          volume,
          url: chapterURL.href,
        });
      } else if (
        text &&
        (/^h[234]$|^dt$/.test(n.type === "tag" ? n.name : "") ||
          el.is(".volume-title,.volume-name,.chapter-bar") ||
          /\/novel\/\d+\/(?:vol_|v)\d+/.test(chapterURL.pathname))
      )
        volume = text;
    },
  );
  if (!chapters.length)
    throw new Error(
      "[parse] 哔哩目录没有可读章节，可能需要登录或站点结构已变化",
    );
  return chapters;
}
export function parseBiliChapter(
  html: string,
  url: string,
  chapterId: string,
): ChapterContent {
  const $ = cheerio.load(html);
  const body = $(
    "#TextContent,#acontent,#acontent1,#chaptercontent,.read-content,.chapter-content,.article-content",
  ).first();
  if (!body.length) throw new Error("[parse] 哔哩正文结构已变化或该章节不可用");
  body
    .find("script,.ads,.ad,.dag,.read-page,.page-del,.chapter-control")
    .remove();
  const next = $('a[rel="next"],#next_url,#nextpage,a')
    .toArray()
    .find((n) => {
      const el = $(n),
        href = el.attr("href");
      if (
        !href ||
        (!/下一页|下页/.test(el.text()) &&
          !el.is('[rel="next"],#next_url,#nextpage'))
      )
        return false;
      return new RegExp(`/${chapterId}_\\d+\\.html$`).test(
        new URL(href, url).pathname,
      );
    });
  return {
    title: $("h1,.read-title,.chapter-title").first().text().trim(),
    html: body.html() || "",
    base: url,
    nextPage: next ? safeRemote($(next).attr("href")!, url) : undefined,
  };
}
export class BilinovelProvider implements NovelProvider {
  constructor(private host: ProviderHost) {}
  private async html(url: string) {
    const response = await this.host.request("bilinovel", url, {
      headers: { Referer: BILI + "/" },
    });
    const buffer = await response.arrayBuffer();
    const charset =
      /charset=([\w-]+)/i.exec(
        response.headers.get("content-type") || "",
      )?.[1] || "utf-8";
    const text = new TextDecoder(charset).decode(buffer);
    checkResponse(response.status, text);
    return text;
  }
  async search(keyword: string, page: number) {
    // The current site uses a scripted search page. Submit its own controls in an
    // isolated source window rather than guessing an obsolete search endpoint.
    if (this.host.browserSearch)
      return parseBiliList(await this.host.browserSearch(keyword, page), page);
    throw new Error("[parse] 此宿主未提供哔哩站内搜索窗口");
  }
  async discover(kind: "latest" | "popular", page: number) {
    return parseBiliList(
      await this.html(
        kind === "popular"
          ? `${BILI}/top/allvisit/${page}.html`
          : `${BILI}/wenku/0/${page}.html`,
      ),
      page,
    );
  }
  async details(id: string) {
    const detail = parseBiliDetails(
      await this.html(`${BILI}/novel/${id}.html`),
      id,
    );
    return {
      ...detail,
      chapters: parseBiliCatalog(
        await this.html(`${BILI}/novel/${id}/catalog`),
        id,
      ),
    };
  }
  async chapter(id: string, chapter: NovelChapter) {
    let url = chapter.url || `${BILI}/novel/${id}/${chapter.id}.html`;
    const pages: string[] = [],
      seen = new Set<string>();
    for (let count = 0; count < 100; count++) {
      if (seen.has(url)) throw new Error("[parse] 站点章节分页出现循环");
      seen.add(url);
      const part = parseBiliChapter(await this.html(url), url, chapter.id);
      if (!part.html.trim()) throw new Error("[parse] 站点返回空正文");
      if (pages.includes(part.html))
        throw new Error("[parse] 站点返回重复分页正文");
      pages.push(part.html);
      if (!part.nextPage)
        return { title: chapter.title, html: pages.join("\n"), base: url };
      const next = new URL(part.nextPage);
      if (
        next.origin !== BILI ||
        !new RegExp(`^/novel/${id}/${chapter.id}_\\d+\\.html$`).test(
          next.pathname,
        )
      )
        throw new Error("[parse] 章节分页地址无效");
      url = next.href;
    }
    throw new Error("[parse] 章节分页超过限制");
  }
  async close() {}
}
