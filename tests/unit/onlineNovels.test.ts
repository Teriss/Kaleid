import { describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  chapterEpub,
  checkResponse,
  safeRemote,
} from "../../src/main/onlineNovels/content";
import {
  NovelScriptRuntime,
  type NovelRuntimeHost,
} from "../../src/main/onlineNovels/novelRuntime";
import { NovelStore } from "../../src/main/onlineNovels/store";
import {
  ChapterRequests,
  rateLimitDelay,
} from "../../src/main/onlineNovels/chapterRequests";
import {
  canEnqueueNovelChapter,
  compareNovelTitles,
  novelDownloadLabel,
} from "../../src/shared/novelDownloads";
import type { NovelDownloadTask } from "../../src/shared/onlineNovels";

const fixture = `
class NovelSourceEntry extends NovelSource {
  constructor() {
    super({
      apiVersion: 1, id: "fixture-source", name: "测试源", version: "1.0.0",
      url: "https://example.org/",
      capabilities: { search: true, latest: true, popular: true, login: ["password"], exportEpub: false },
      settings: { node: { title: "节点", type: "input", default: "https://example.org/api" } },
    });
  }
  async search(keyword, page) {
    return { novels: [{ sourceId: this.meta.id, novelId: keyword, title: "作品" }], page, hasMore: false };
  }
  async discover(kind, page) { return { novels: [], page, hasMore: false }; }
  async details(novelId) { return { sourceId: this.meta.id, novelId, title: "作品", chapters: [] }; }
  async chapter() { return { title: "第一章", html: "<p>正文</p>", base: this.meta.url }; }
  async login() { await this.saveCredentials({ token: "saved" }); }
  async bytes() {
    const response = await host.request("https://example.org/file", { responseType: "bytes" });
    return response.body;
  }
}
`;
function runtime(host: NovelRuntimeHost = async () => true) {
  return new NovelScriptRuntime(
    fixture,
    { data: {}, settings: {}, credentials: {} },
    host,
  );
}

describe("小说源 QuickJS 运行器", () => {
  it("校验来源元数据并调用异步源方法", async () => {
    const source = runtime();
    try {
      await expect(source.open()).resolves.toMatchObject({
        id: "fixture-source",
        apiVersion: 1,
      });
      await expect(source.call("search", ["关键词", 2])).resolves.toMatchObject(
        {
          novels: [
            { sourceId: "fixture-source", novelId: "关键词", title: "作品" },
          ],
          page: 2,
          hasMore: false,
        },
      );
      await expect(
        source.call("login", ["user", "secret"]),
      ).resolves.toBeUndefined();
    } finally {
      source.dispose();
    }
  });
  it("在宿主请求与 QuickJS 之间保留二进制正文", async () => {
    const host = vi.fn(async () => ({
      status: 200,
      body: Uint8Array.from([0, 1, 2, 255]),
    }));
    const source = runtime(host);
    try {
      await source.open();
      await expect(source.call("bytes")).resolves.toEqual(
        Uint8Array.from([0, 1, 2, 255]),
      );
      expect(host).toHaveBeenCalledWith({
        op: "request",
        url: "https://example.org/file",
        options: { responseType: "bytes" },
      });
    } finally {
      source.dispose();
    }
  });
  it("拒绝缺少已声明功能方法的脚本", async () => {
    const invalid = new NovelScriptRuntime(
      fixture.replace(
        "async search(keyword, page) {",
        "async searchMissing(keyword, page) {",
      ),
      { data: {}, settings: {}, credentials: {} },
      async () => true,
    );
    try {
      await expect(invalid.open()).rejects.toThrow("缺少对应方法");
    } finally {
      invalid.dispose();
    }
  });
});

describe("章节 EPUB", () => {
  it("打包插图、字体、注音和脚注，清除活动内容", async () => {
    const urls: string[] = [];
    const result = await chapterEpub(
      {
        title: "章 & 一",
        base: "https://example.org/book/",
        font: "/font.woff2",
        html: '<script>alert(1)</script><p onclick="bad()">正文<ruby>字<rt>zi</rt></ruby><a href="#note">注</a></p><img data-src="/a.jpg" onerror="bad()"><p id="note">脚注</p><iframe src="https://bad.org"></iframe><img src="/a.jpg">',
      },
      async (url) => {
        urls.push(url);
        return {
          data: new Uint8Array([1, 2, 3]),
          type: url.endsWith("woff2") ? "font/woff2" : "image/jpeg",
        };
      },
    );
    const zip = unzipSync(result.data),
      html = strFromU8(zip["OEBPS/chapter.xhtml"]),
      opf = strFromU8(zip["OEBPS/package.opf"]);
    expect(strFromU8(result.data.subarray(30, 38))).toBe("mimetype");
    expect(new DataView(result.data.buffer).getUint16(8, true)).toBe(0);
    expect(urls).toHaveLength(2);
    expect(result.requiredFont).toBe(true);
    expect(html).toContain("<ruby>");
    expect(html).toContain('href="#note"');
    expect(html).toContain('id="note"');
    expect(html).not.toMatch(/onclick|onerror|<script|<iframe|data-src/);
    expect(html).toContain("章 &amp; 一");
    expect(html).toContain("novel-source");
    expect(opf).toContain("font/woff2");
    expect(html).toMatch(/<img[^>]+\/>/);
  });
  it("插图不完整时不生成完成包", async () => {
    await expect(
      chapterEpub(
        {
          title: "章",
          base: "https://example.org",
          html: '<p>文</p><img src="/missing.jpg">',
        },
        async () => {
          throw new Error("断网");
        },
      ),
    ).rejects.toThrow("断网");
  });
  it("HTML 验证页不能伪装为图片", async () => {
    await expect(
      chapterEpub(
        { title: "章", base: "https://example.org", html: '<img src="/x">' },
        async () => ({ data: new Uint8Array([1]), type: "text/html" }),
      ),
    ).rejects.toThrow("内容类型");
  });
  it("固定内容生成稳定版本与包内路径", async () => {
    const content = {
      title: "章",
      base: "https://example.org",
      html: "<p>正文</p>",
    };
    const load = async () => ({ data: new Uint8Array(), type: "image/jpeg" });
    const a = await chapterEpub(content, load),
      b = await chapterEpub(content, load);
    expect(a.version).toBe(b.version);
    expect(unzipSync(a.data)["OEBPS/chapter.xhtml"]).toEqual(
      unzipSync(b.data)["OEBPS/chapter.xhtml"],
    );
  });
});

describe("响应与身份", () => {
  it("按阶段区分站点验证、认证、限流", () => {
    expect(() =>
      checkResponse(403, "Attention Required! | Cloudflare"),
    ).toThrow("verification");
    expect(() => checkResponse(401, "")).toThrow("auth-required");
    expect(() => checkResponse(429, "")).toThrow("rate-limit");
  });
  it("限制资源协议与本机地址", () => {
    for (const url of [
      "file:///a",
      "javascript:alert(1)",
      "http://127.0.0.1/a",
      "http://192.168.1.1/a",
    ])
      expect(() => safeRemote(url, "https://example.org")).toThrow();
  });
  it("独立数据库保存各源身份，删除不波及进度", () => {
    const db = new NovelStore(":memory:");
    try {
      db.set("shelf", "light:42", { title: "同名书" });
      db.set("shelf", "bili:42", { title: "同名书" });
      db.set("progress", "light:42:100", { cfi: "epubcfi(/6/2)" });
      db.delete("shelf", "light:42");
      expect(db.all("shelf")).toHaveLength(1);
      expect(db.get("progress", "light:42:100")).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe("小说下载排序与状态", () => {
  it("按整数和真正的小数数值排序，支持长数字及全角数字", () => {
    const volumes = [
      "113",
      "11.5",
      "2",
      "13",
      "1",
      "11.10",
      "11.05",
      "12",
      "10",
      "11",
      "3",
    ];
    const titles = volumes.map((volume) => `作品 ${volume}`);
    expect([...titles].sort(compareNovelTitles)).toEqual(
      [
        "1",
        "2",
        "3",
        "10",
        "11",
        "11.05",
        "11.10",
        "11.5",
        "12",
        "13",
        "113",
      ].map((n) => `作品 ${n}`),
    );
    expect([...titles].sort((a, b) => -compareNovelTitles(a, b))).toEqual(
      [...titles].sort(compareNovelTitles).reverse(),
    );
    expect(
      compareNovelTitles("作品 9007199254740992", "作品 9007199254740993"),
    ).toBeLessThan(0);
    expect(compareNovelTitles("作品 １１．５", "作品 12")).toBeLessThan(0);
    expect(
      compareNovelTitles(
        "作品 1.000000000000000001",
        "作品 1.000000000000000002",
      ),
    ).toBeLessThan(0);
    const equal = ["作品 01", "作品 1.0", "作品 1", "作品 1"];
    expect([...equal].sort(compareNovelTitles)).toEqual(equal);
    expect(compareNovelTitles("作品 2 卷 3", "作品 2 卷 12")).toBeLessThan(0);
    expect(compareNovelTitles("阿 10", "波 1")).toBeLessThan(0);
  });

  it("只有成功任务显示已下载，失败任务可补下", () => {
    const task = (state: NovelDownloadTask["state"], extra = {}) =>
      ({ state, ...extra }) as NovelDownloadTask;
    expect(novelDownloadLabel(task("completed"))).toBe("已下载");
    expect(novelDownloadLabel(task("failed"))).toBe("下载失败");
    expect(novelDownloadLabel(task("queued"))).toBe("排队中");
    expect(
      novelDownloadLabel(task("queued", { retryAt: 123, error: "限流" })),
    ).toBe("等待重试");
    expect(novelDownloadLabel(task("downloading"))).toBe("下载中");
    expect(novelDownloadLabel(task("paused"))).toBe("已暂停");
    expect(canEnqueueNovelChapter(undefined)).toBe(true);
    expect(canEnqueueNovelChapter(task("failed"))).toBe(true);
    for (const state of [
      "completed",
      "queued",
      "downloading",
      "paused",
    ] as const)
      expect(canEnqueueNovelChapter(task(state))).toBe(false);
  });
});

describe("小说来源限流", () => {
  it("识别旧版来源的秒数提示及标准限流，排除永久失败", () => {
    expect(rateLimitDelay(new Error("[source] 请在 5 秒后重试。"))).toBe(5500);
    expect(rateLimitDelay("请在 12 秒后重试")).toBe(12500);
    expect(rateLimitDelay("[rate-limit] 请求过于频繁")).toBe(5500);
    expect(rateLimitDelay("HTTP 429")).toBe(5500);
    expect(rateLimitDelay("[network] 请求失败 HTTP 404")).toBeUndefined();
    expect(rateLimitDelay("阅读等级不足，需要达到 Lv.6")).toBeUndefined();
  });

  it("阅读与下载共享串行请求和 5.5 秒间隔，其他来源可继续", async () => {
    vi.useFakeTimers();
    const queue = new ChapterRequests();
    try {
      let finish!: () => void;
      const first = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const second = vi.fn(async () => "第二章");
      const reading = queue.run("lightnovelshelf", first);
      const downloading = queue.run("lightnovelshelf", second);
      await vi.advanceTimersByTimeAsync(6000);
      expect(second).not.toHaveBeenCalled();
      await expect(
        queue.run("another-source", async () => "其他来源"),
      ).resolves.toBe("其他来源");
      finish();
      await reading;
      await vi.advanceTimersByTimeAsync(5500);
      await downloading;
      expect(second).toHaveBeenCalledOnce();
      const third = vi.fn(async () => "第三章");
      const next = queue.run("lightnovelshelf", third);
      await vi.advanceTimersByTimeAsync(5499);
      expect(third).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(third).toHaveBeenCalledOnce();
    } finally {
      queue.close();
      vi.useRealTimers();
    }
  });

  it("限流冷却作用于同来源的后续书籍请求", async () => {
    vi.useFakeTimers();
    const queue = new ChapterRequests();
    try {
      await expect(
        queue.run("fixture", async () => {
          throw new Error("请在 8 秒后重试");
        }),
      ).rejects.toThrow("8 秒");
      const request = vi.fn(async () => true);
      const next = queue.run("fixture", request);
      await vi.advanceTimersByTimeAsync(8499);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(request).toHaveBeenCalledOnce();
    } finally {
      queue.close();
      vi.useRealTimers();
    }
  });

  it("暂停、取消及服务关闭能中断等待，且不会发出请求", async () => {
    vi.useFakeTimers();
    const queue = new ChapterRequests();
    try {
      await queue.run("lightnovelshelf", async () => true);
      const request = vi.fn(async () => true);
      const controller = new AbortController();
      const paused = queue.run("lightnovelshelf", request, controller.signal);
      const stopped = expect(paused).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await stopped;
      const pending = queue.run("lightnovelshelf", request);
      const closed = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      queue.close();
      await closed;
      await vi.advanceTimersByTimeAsync(10000);
      expect(request).not.toHaveBeenCalled();
    } finally {
      queue.close();
      vi.useRealTimers();
    }
  });
});
