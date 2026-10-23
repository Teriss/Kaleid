import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import { unzipSync, strFromU8 } from "fflate";
import {
  chapterEpub,
  checkResponse,
  safeRemote,
} from "../../src/main/onlineNovels/content";
import {
  parseBiliList,
  parseBiliDetails,
  parseBiliCatalog,
  parseBiliChapter,
  BilinovelProvider,
  LightNovelShelfProvider,
  decodeEnvelope,
  type ProviderHost,
} from "../../src/main/onlineNovels/providers";
import { NovelStore } from "../../src/main/onlineNovels/store";

const list =
  '<ul><li><a href="/novel/42.html"><img src="https://img.example.org/42.jpg" alt="测试小说"/></a><h3><a href="/novel/42.html">测试小说</a></h3><span class="author">作者</span></li></ul><a class="next" href="/wenku/0/2.html">下一页</a>';
const catalog =
  '<h1>测试小说</h1><h2>第一卷</h2><a href="/novel/42/100.html">序章</a><a href="/novel/42/100.html">重复导航</a><h2>第二卷</h2><a href="/novel/42/101.html">第二章</a>';
const host = (request: ProviderHost["request"]): ProviderHost => ({
  request,
  node: () => "https://api.lightnovel.life",
  credentials: () => ({}),
  saveCredentials: () => {},
});
describe("哔哩解析", () => {
  it("从封面和标题链接去重并保留分页", () => {
    const page = parseBiliList(list, 1);
    expect(page.novels).toHaveLength(1);
    expect(page.novels[0]).toMatchObject({
      novelId: "42",
      title: "测试小说",
      author: "作者",
    });
    expect(page.hasMore).toBe(true);
  });
  it("空结果和结构错误可区分", () => {
    expect(parseBiliList("<p>搜索结果：没有找到</p>", 1).novels).toEqual([]);
    expect(() => parseBiliList("<p>Unknown gateway</p>", 1)).toThrow("结构");
  });
  it("提取详情及按源顺序保留卷和章节", () => {
    expect(
      parseBiliDetails(
        '<h1>测试小说</h1><meta property="og:novel:author" content="作者">',
        "42",
      ),
    ).toMatchObject({ title: "测试小说", author: "作者" });
    expect(
      parseBiliCatalog(catalog, "42").map((c) => [c.id, c.volume]),
    ).toEqual([
      ["100", "第一卷"],
      ["101", "第二卷"],
    ]);
    expect(
      parseBiliCatalog(
        '<a href="vol_9.html">第一卷</a><a href="100.html">序章</a>',
        "42",
      )[0],
    ).toMatchObject({
      id: "100",
      volume: "第一卷",
      url: "https://www.bilinovel.com/novel/42/100.html",
    });
  });
  it("识别同章下一页，排除下一章", () => {
    expect(
      parseBiliChapter(
        '<h1>序章</h1><div id="TextContent"><p>第一页</p></div><a href="100_2.html">下一页</a>',
        "https://www.bilinovel.com/novel/42/100.html",
        "100",
      ).nextPage,
    ).toContain("100_2.html");
    expect(
      parseBiliChapter(
        '<div id="TextContent">末页</div><a rel="next" href="101.html">下一章</a>',
        "https://www.bilinovel.com/novel/42/100.html",
        "100",
      ).nextPage,
    ).toBeUndefined();
  });
  it("合并多页且保持图片顺序", async () => {
    const provider = new BilinovelProvider(
      host(
        async (_id, url) =>
          new Response(
            url.includes("_2")
              ? '<div id="TextContent"><p>第二页</p><img src="/b.jpg"></div>'
              : '<div id="TextContent"><p>第一页</p><img src="/a.jpg"></div><a href="100_2.html">下一页</a>',
          ),
      ),
    );
    const result = await provider.chapter("42", {
      id: "100",
      title: "章",
      volume: "卷",
    });
    expect(result.html.indexOf("a.jpg")).toBeLessThan(
      result.html.indexOf("b.jpg"),
    );
    expect(result.html).toContain("第二页");
  });
  it("拒绝循环分页与重复正文", async () => {
    const provider = new BilinovelProvider(
      host(
        async () =>
          new Response(
            '<div id="TextContent">相同内容</div><a href="100_2.html">下一页</a>',
          ),
      ),
    );
    await expect(
      provider.chapter("42", { id: "100", title: "章", volume: "卷" }),
    ).rejects.toThrow(/重复|循环/);
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
describe("轻书架登录协议", () => {
  it.each(["correct horse battery staple", " 空格与中文🔑 ", "a".repeat(64)])(
    "与官方 Web Crypto 密码摘要一致：用例 %#",
    async (password) => {
      const saved = vi.fn();
      let loginRequest: { url: string; init?: RequestInit } | undefined;
      const provider = new LightNovelShelfProvider({
        ...host(async (_source, url, init) => {
          loginRequest = { url, init };
          return Response.json({
            Success: true,
            Response: { Token: "access-token", RefreshToken: "refresh-token" },
          });
        }),
        saveCredentials: saved,
      });
      await provider.login("reader@example.org", password);
      const expected = Buffer.from(
        await webcrypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(password),
        ),
      ).toString("hex");
      expect(loginRequest?.url).toBe(
        "https://api.lightnovel.life/api/user/login",
      );
      expect(loginRequest?.init?.method).toBe("POST");
      expect(JSON.parse(String(loginRequest?.init?.body))).toEqual({
        email: "reader@example.org",
        password: expected,
      });
      expect(expected).toMatch(/^[0-9a-f]{64}$/);
      expect(saved).toHaveBeenCalledWith({
        token: "access-token",
        refreshToken: "refresh-token",
        obtainedAt: expect.any(Number),
      });
      expect(JSON.stringify(saved.mock.calls)).not.toContain(password);
      expect(JSON.stringify(saved.mock.calls)).not.toContain(expected);
    },
  );
  it("错误密码保留服务端错误且不替换已有凭据", async () => {
    const saved = vi.fn();
    const provider = new LightNovelShelfProvider({
      ...host(async () =>
        Response.json({ Success: false, Status: 401, Msg: "密码错误" }),
      ),
      saveCredentials: saved,
    });
    await expect(
      provider.login("reader@example.org", "incorrect-password"),
    ).rejects.toThrow("[auth-required] 密码错误");
    expect(saved).not.toHaveBeenCalled();
  });
});

describe("响应与身份", () => {
  it("解码轻书架压缩信封和权限错误", () => {
    const data = { Data: [{ Id: 42 }], TotalPages: 1 };
    expect(
      decodeEnvelope({
        Success: true,
        Response: new Uint8Array(gzipSync(JSON.stringify(data))),
      }),
    ).toEqual(data);
    expect(() =>
      decodeEnvelope({
        Success: false,
        Status: 401,
        Msg: "user is unauthorized",
      }),
    ).toThrow("auth-required");
  });
  it("按阶段区分站点验证、认证、限流", () => {
    expect(() =>
      checkResponse(403, "Attention Required! | Cloudflare"),
    ).toThrow("verification");
    expect(() => checkResponse(401, "")).toThrow("auth-required");
    expect(() => checkResponse(429, "")).toThrow("rate-limit");
  });
  it("限制资源协议与本机地址", () => {
    for (const u of [
      "file:///a",
      "javascript:alert(1)",
      "http://127.0.0.1/a",
      "http://192.168.1.1/a",
    ])
      expect(() => safeRemote(u, "https://example.org")).toThrow();
  });
  it("轻书架章节 ID 与排序变化不会错误绑定进度", async () => {
    const provider = new LightNovelShelfProvider(
      host(async () => new Response()),
    );
    provider.invoke = async () =>
      ({ Chapter: { Id: 101, Content: "正文" } }) as never;
    await expect(
      provider.chapter("42", {
        id: "100",
        order: 1,
        title: "章",
        volume: "卷",
      }),
    ).rejects.toThrow("顺序已变化");
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
