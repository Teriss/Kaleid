import { describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  chapterEpub,
  checkResponse,
  safeRemote,
} from "../../src/main/onlineNovels/content";
import { NovelScriptRuntime, type NovelRuntimeHost } from "../../src/main/onlineNovels/novelRuntime";
import { NovelStore } from "../../src/main/onlineNovels/store";

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
  return new NovelScriptRuntime(fixture, { data: {}, settings: {}, credentials: {} }, host);
}

describe("小说源 QuickJS 运行器", () => {
  it("校验来源元数据并调用异步源方法", async () => {
    const source = runtime();
    try {
      await expect(source.open()).resolves.toMatchObject({ id: "fixture-source", apiVersion: 1 });
      await expect(source.call("search", ["关键词", 2])).resolves.toMatchObject({
        novels: [{ sourceId: "fixture-source", novelId: "关键词", title: "作品" }],
        page: 2,
        hasMore: false,
      });
      await expect(source.call("login", ["user", "secret"])).resolves.toBeUndefined();
    } finally {
      source.dispose();
    }
  });
  it("在宿主请求与 QuickJS 之间保留二进制正文", async () => {
    const host = vi.fn(async () => ({ status: 200, body: Uint8Array.from([0, 1, 2, 255]) }));
    const source = runtime(host);
    try {
      await source.open();
      await expect(source.call("bytes")).resolves.toEqual(Uint8Array.from([0, 1, 2, 255]));
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
      fixture.replace("async search(keyword, page) {", "async searchMissing(keyword, page) {"),
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
        { title: "章", base: "https://example.org", html: '<p>文</p><img src="/missing.jpg">' },
        async () => { throw new Error("断网"); },
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
    const content = { title: "章", base: "https://example.org", html: "<p>正文</p>" };
    const load = async () => ({ data: new Uint8Array(), type: "image/jpeg" });
    const a = await chapterEpub(content, load), b = await chapterEpub(content, load);
    expect(a.version).toBe(b.version);
    expect(unzipSync(a.data)["OEBPS/chapter.xhtml"]).toEqual(unzipSync(b.data)["OEBPS/chapter.xhtml"]);
  });
});

describe("响应与身份", () => {
  it("按阶段区分站点验证、认证、限流", () => {
    expect(() => checkResponse(403, "Attention Required! | Cloudflare")).toThrow("verification");
    expect(() => checkResponse(401, "")).toThrow("auth-required");
    expect(() => checkResponse(429, "")).toThrow("rate-limit");
  });
  it("限制资源协议与本机地址", () => {
    for (const url of ["file:///a", "javascript:alert(1)", "http://127.0.0.1/a", "http://192.168.1.1/a"])
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
