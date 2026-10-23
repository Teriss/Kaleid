// Real Electron IPC, protocol, storage and reader regression with deterministic source responses.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-novels-"));
const env = {
  ...process.env,
  MEDIA_BROWSER_TEST_DATA: path.join(temporary, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const artifacts = path.resolve("artifacts/novel-verification");
await fs.mkdir(artifacts, { recursive: true });
const mediaRoot = path.join(temporary, "media");
await fs.mkdir(mediaRoot);
const wav = Buffer.alloc(44 + 8000 * 2 * 60);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
await fs.writeFile(path.join(mediaRoot, "后台静音测试.wav"), wav);
const protocolModule = import.meta
  .resolve("@microsoft/signalr-protocol-msgpack");
const launch = () =>
  _electron.launch({
    executablePath:
      process.env.KALEID_TEST_EXECUTABLE ||
      path.resolve("node_modules/electron/dist/electron.exe"),
    args: process.env.KALEID_TEST_EXECUTABLE ? [] : ["."],
    env,
    timeout: 30000,
  });
async function fixtures(application, offline = false) {
  await application.evaluate(
    async ({ session }, { protocolModule, offline }) => {
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(process.cwd() + "/package.json");
      const {
        MessagePackHubProtocol,
      } = require("@microsoft/signalr-protocol-msgpack");
      const { gzipSync } = process.getBuiltinModule("node:zlib");
      const protocol = new MessagePackHubProtocol();
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIac3/DwAFAQJYvkAuygAAAABJRU5ErkJggg==",
        "base64",
      );
      globalThis.__novelFixture = {
        offline,
        added: false,
        blocked: false,
        slow: false,
        failImage: false,
        exports: 0,
      };
      const body = () =>
        Array.from(
          { length: 100 },
          (_, i) =>
            `<p>第 ${i + 1} 段：在线轻小说的测试正文，用于验证翻页、滚动与阅读进度。雨后的街道安静而明亮，我们在图书馆里翻开新的故事。</p>`,
        ).join("");
      const image = () =>
        new Response(png, { headers: { "Content-Type": "image/png" } });
      const bili = session.fromPartition("persist:novel-bilinovel");
      bili.fetch = async (raw, init) => {
        const state = globalThis.__novelFixture;
        if (state.offline) throw new Error("fixture offline");
        const url = new URL(String(raw));
        if (state.blocked)
          return new Response("Attention Required! | Cloudflare", {
            status: 403,
          });
        if (url.pathname.endsWith(".png")) {
          if (state.failImage) throw new Error("fixture image missing");
          return image();
        }
        if (state.slow)
          await new Promise((resolve) => setTimeout(resolve, 500));
        if (url.pathname.endsWith("/catalog"))
          return new Response(
            `<h2>第一卷</h2><a href="/novel/42/100.html">序章</a><h2>第二卷</h2><a href="/novel/42/101.html">第二章</a>${state.added ? '<a href="/novel/42/102.html">新章节</a>' : ""}`,
          );
        if (/^\/novel\/42\/\d+(?:_\d+)?\.html$/.test(url.pathname))
          return new Response(
            `<h1>序章</h1><div id="TextContent">${body()}<ruby>字<rt>zi</rt></ruby><img src="https://img.example.org/illustration.png"></div>`,
          );
        if (url.pathname === "/novel/42.html")
          return new Response(
            '<h1>测试轻小说</h1><meta property="og:novel:author" content="作者"><meta property="og:image" content="https://img.example.org/cover.png"><meta property="description" content="测试简介">',
          );
        return new Response(
          '<ul><li><a href="/novel/42.html"><img src="https://img.example.org/cover.png" alt="测试轻小说"></a></li></ul>',
        );
      };
      const queues = [],
        waiters = [];
      let polls = 0;
      const deliver = (data) => {
        const waiter = waiters.shift();
        if (waiter) waiter(data);
        else queues.push(data);
      };
      const lns = session.fromPartition("persist:novel-lightnovelshelf");
      lns.fetch = async (raw, init = {}) => {
        const state = globalThis.__novelFixture;
        if (state.offline) throw new Error("fixture offline");
        const url = new URL(String(raw)),
          method = init.method || "GET";
        if (url.pathname.endsWith(".png")) return image();
        if (url.pathname.endsWith("/negotiate")) {
          polls = 0;
          queues.length = 0;
          return Response.json({
            negotiateVersion: 1,
            connectionId: "fixture",
            connectionToken: "fixture",
            availableTransports: [
              { transport: "LongPolling", transferFormats: ["Text", "Binary"] },
            ],
          });
        }
        if (url.pathname.endsWith("/api/user/login")) {
          const payload = JSON.parse(String(init.body));
          const expected = process
            .getBuiltinModule("node:crypto")
            .createHash("sha256")
            .update("fixture-password-not-stored", "utf8")
            .digest("hex");
          if (
            method !== "POST" ||
            payload.email !== "fixture@example.org" ||
            payload.password !== expected
          )
            return Response.json({
              Success: false,
              Status: 401,
              Msg: "密码错误",
            });
          return Response.json({
            Success: true,
            Response: {
              Token: "fixture-token",
              RefreshToken: "fixture-refresh",
            },
          });
        }
        if (url.pathname.endsWith("/api/user/refresh_token"))
          return Response.json({ Success: true, Response: "fixture-token" });
        if (url.pathname.endsWith("/api/book/download")) {
          state.exports++;
          return new Response("not a zip");
        }
        if (method === "DELETE") {
          deliver(null);
          return new Response();
        }
        if (method === "POST") {
          if (typeof init.body === "string" && init.body.includes('"protocol"'))
            deliver(Buffer.from("{}\x1e"));
          else {
            const data = Buffer.from(init.body),
              buffer = data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength,
              );
            const messages = protocol.parseMessages(buffer, { log() {} });
            for (const m of messages) {
              if (m.type !== 1) continue;
              let response;
              if (m.target === "GetNovelContent")
                response = {
                  Chapter: {
                    Id: 200,
                    Title: "轻书架章节",
                    Content: body(),
                    SortNum: 1,
                  },
                };
              else if (m.target === "GetBookInfo")
                response = {
                  Book: {
                    Id: 88,
                    Title: "轻书架测试卷",
                    Author: "作者",
                    Cover: "https://img.example.org/lns.png",
                    Introduction: "简介",
                    CanDownload: true,
                    DownloadCost: 5,
                    Chapters: [{ Id: 200, Title: "轻书架章节", SortNum: 1 }],
                  },
                };
              else
                response = {
                  Page: 1,
                  TotalPages: 1,
                  Data: [
                    {
                      Id: 88,
                      Type: "Novel",
                      Title: "轻书架测试卷",
                      Cover: "https://img.example.org/lns.png",
                    },
                  ],
                };
              deliver(
                Buffer.from(
                  protocol.writeMessage({
                    type: 3,
                    invocationId: m.invocationId,
                    result: {
                      Success: true,
                      Response: new Uint8Array(
                        gzipSync(JSON.stringify(response)),
                      ),
                    },
                  }),
                ),
              );
            }
          }
          return new Response();
        }
        if (polls++ === 0) return new Response(new Uint8Array());
        const data = queues.length
          ? queues.shift()
          : await new Promise((resolve, reject) => {
              const done = (data) => {
                init.signal?.removeEventListener("abort", abort);
                resolve(data);
              };
              const abort = () => {
                const i = waiters.indexOf(done);
                if (i >= 0) waiters.splice(i, 1);
                reject(new Error("aborted"));
              };
              waiters.push(done);
              init.signal?.addEventListener("abort", abort, { once: true });
            });
        return data === null
          ? new Response(null, { status: 204 })
          : new Response(data);
      };
    },
    { protocolModule, offline },
  );
}
let application;
async function waitForAPI(page, predicate, argument, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await page.evaluate(predicate, argument);
    if (value) return value;
    await page.waitForTimeout(50);
  }
  throw new Error("API condition did not become true within timeout");
}
const results = [];
try {
  application = await launch();
  await fixtures(application);
  let page = await application.firstWindow();
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.stack || e.message));
  await application.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [root],
    });
  }, mediaRoot);
  await page.evaluate(async () => {
    const roots = await window.media.chooseFolders();
    const library = await window.media.createLibrary({
      name: "小说后台音乐测试",
      type: "music",
      roots,
    });
    await window.media.scan(library.id);
  });
  const song = await waitForAPI(
    page,
    async () =>
      (await window.media.query({ type: "music", limit: 10 })).items[0] ||
      false,
  );

  await page.evaluate(async (song) => {
    const session = {
      trackId: song.id,
      queueIds: [song.id],
      position: 0,
      volume: 0,
      muted: true,
      repeat: "off",
      order: "sequential",
    };
    await window.media.saveMusicSession(session);
    await window.music.saveSession(session, [song]);
  }, song);
  await page.reload();
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  await page.getByRole("button", { name: "音乐快捷设置", exact: true }).hover();
  await page
    .getByRole("button", { name: "播放音乐", exact: true })
    .first()
    .click({ force: true });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return audio && !audio.paused && audio.currentTime > 0;
  });
  // Capture the existing comic hub and compare the shared presentation in the same app.
  await page
    .getByRole("button", { name: "浏览漫画", exact: true })
    .first()
    .click({ force: true });
  await page.locator(".online-comics .comic-home-row").first().waitFor();
  const comicRowStyle = await page
    .locator(".comic-home-row")
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.borderRadius, s.padding, s.backgroundColor, s.flexShrink];
    });
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "comic-reference-dark.png"),
  });
  await page
    .getByRole("button", { name: "浏览小说", exact: true })
    .first()
    .click({ force: true });
  await page.locator(".novel-source-pills").first().waitFor();
  await page.mouse.move(900, 500);
  await page
    .getByRole("button", { name: "音乐快捷设置", exact: true })
    .waitFor({ state: "visible" });
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "home-dark.png"),
  });
  assert.equal(await page.locator(".novel-nav, .novel-heading").count(), 0);
  const historySection = page.locator(".comic-home-row").filter({
    has: page.getByRole("button", { name: "最近阅读 0", exact: true }),
  });
  await page.getByRole("button", { name: "最近阅读 0", exact: true }).click();
  assert.equal(
    await historySection.evaluate((el) =>
      el.classList.contains("is-collapsed"),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("novel:home-collapsed")).history,
    ),
    true,
  );
  await page
    .getByRole("button", { name: "小说源排序与激活", exact: true })
    .click();
  const quick = page.getByRole("dialog", {
    name: "小说源排序与激活",
    exact: true,
  });
  await quick.getByRole("combobox").selectOption("name-asc");
  const sourceCheck = quick.getByRole("checkbox").first();
  await sourceCheck.click();
  await page.waitForFunction(
    () => document.querySelectorAll(".novel-source-pills button").length === 1,
  );
  await sourceCheck.click();
  await page.waitForFunction(
    () => document.querySelectorAll(".novel-source-pills button").length === 2,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^小说源 2/ }).click();
  await page.getByRole("heading", { name: "小说源", exact: true }).waitFor();
  assert.equal(await page.locator(".online-source-row").count(), 2);
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "sources-dark.png"),
  });
  await page
    .locator(".online-source-row")
    .filter({ hasText: "轻书架" })
    .getByRole("button", { name: "源设置", exact: true })
    .click();
  await page.getByRole("combobox", { name: "轻书架服务器节点" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "返回小说", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "最近阅读 0", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await page.mouse.move(5, 220);
  await page.getByRole("navigation", { name: "小说页面" }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "menu-dark.png"),
  });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator(".comic-main-menu-layer").getAttribute("aria-hidden"),
    "true",
  );
  // A keyboard-accessible trigger supplements the same edge gesture as comics.
  await page.getByRole("button", { name: "打开小说菜单", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("navigation", { name: "小说页面" }).waitFor();
  await page.keyboard.press("Escape");
  results.push(
    "comic hub layout, persistent collapse, source sorting/enabling, manager and keyboard drawer",
  );
  assert.deepEqual(
    await page
      .locator(".comic-home-row")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.borderRadius, s.padding, s.backgroundColor, s.flexShrink];
      }),
    comicRowStyle,
  );
  const lns = await page.evaluate(() =>
    window.media.onlineNovels.discover("lightnovelshelf", "latest", 1),
  );
  assert.equal(lns.novels[0].novelId, "88");
  const lnsReader = await page.evaluate(() =>
    window.media.onlineNovels.reader({
      sourceId: "lightnovelshelf",
      novelId: "88",
      chapterId: "200",
    }),
  );
  assert.equal(lnsReader.item.ext, "epub");
  await page.locator(".comic-source-management-entry").click();
  await page
    .locator(".online-source-row")
    .filter({ hasText: "轻书架" })
    .getByRole("button", { name: "邮箱密码登录", exact: true })
    .click();
  await page.getByLabel("邮箱", { exact: true }).fill("fixture@example.org");
  await page.getByLabel("密码", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "密码错误" }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.media.onlineNovels.sources())).find(
      (s) => s.id === "lightnovelshelf",
    ).logged,
    false,
  );
  await page
    .getByLabel("密码", { exact: true })
    .fill("fixture-password-not-stored");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await waitForAPI(page, async () =>
    (await window.media.onlineNovels.sources()).some(
      (s) => s.id === "lightnovelshelf" && s.logged,
    ),
  );
  await page.getByRole("button", { name: "返回小说", exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.media.onlineNovels.sources())).find(
      (s) => s.id === "lightnovelshelf",
    ).logged,
    true,
  );
  const encrypted = await application.evaluate(({ app }) => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const path = process.getBuiltinModule("node:path");
    const db = new DatabaseSync(
      path.join(app.getPath("userData"), "novel-online", "library.sqlite"),
      { readOnly: true },
    );
    try {
      const row = db
        .prepare(
          "SELECT value FROM records WHERE kind='source' AND id='lightnovelshelf'",
        )
        .get();
      return (
        !/fixture-token|fixture-refresh|fixture-password/.test(row.value) &&
        Boolean(JSON.parse(row.value).credentials)
      );
    } finally {
      db.close();
    }
  });
  assert.equal(encrypted, true);
  results.push(
    "official SHA-256 login payload, encrypted credentials and password never persisted",
  );
  results.push("SignalR MessagePack + gzip list/details/chapter");
  const ref = { sourceId: "bilinovel", novelId: "42" };
  await page.getByRole("button", { name: "打开小说菜单", exact: true }).click();
  await page
    .getByRole("navigation", { name: "小说页面" })
    .getByRole("button", { name: "搜索", exact: true })
    .press("Enter");
  await page.getByRole("textbox", { name: "聚合搜索小说" }).fill("测试");
  await page
    .locator(".comic-search-form")
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".novel-aggregate .comic-hub-card").length ===
      2,
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "search-dark.png"),
  });
  results.push("aggregate search with both sources");
  await application.evaluate(() => {
    globalThis.__novelFixture.blocked = true;
  });
  await page.getByRole("button", { name: "刷新小说页面" }).click();
  await page
    .locator(".novel-error")
    .filter({ hasText: "verification" })
    .waitFor();
  assert.equal(
    await page.locator(".novel-aggregate .comic-hub-card").count(),
    1,
  );
  results.push("partial aggregate failure preserves successful source");
  await application.evaluate(() => {
    globalThis.__novelFixture.blocked = false;
  });
  await page
    .locator(".novel-error")
    .getByRole("button", { name: "重试此源" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".novel-aggregate .comic-hub-card").length ===
      2,
  );
  await page
    .getByRole("button", { name: "查看此源全部结果", exact: true })
    .first()
    .click();
  await page.locator(".novel-results-layout .standard-grid").waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "single-search-dark.png"),
  });
  assert.equal(
    await page
      .locator(".comic-search-panel")
      .evaluate((el) => el.classList.contains("is-visible")),
    false,
  );
  await page.getByRole("button", { name: "修改搜索", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索当前小说源" }).waitFor();
  assert.equal(
    await page.locator(".comic-search-panel .online-source-selector").count(),
    0,
  );
  await page
    .getByRole("combobox", { name: "单源结果布局" })
    .selectOption("archiveShelf");
  await page
    .getByRole("combobox", { name: "单源结果布局" })
    .selectOption("grid");
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .locator(".comic-search-panel")
      .evaluate((el) => el.classList.contains("is-visible")),
    false,
  );
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.locator(".novel-aggregate .comic-hub-card").first().waitFor();
  results.push(
    "single-source result grid, search panel and aggregate parent restoration",
  );
  await page
    .locator(".comic-aggregate-group")
    .filter({ has: page.getByRole("button", { name: /^哔哩轻小说 .*条预览/ }) })
    .getByRole("button", { name: "测试轻小说", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "测试轻小说", exact: true })
    .waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "detail-dark.png"),
  });
  assert.equal(await page.locator(".comic-detail-hero").count(), 1);
  assert.equal(await page.locator(".novel-volume").count(), 2);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.activeElement
        ?.closest("[data-hub-id]")
        ?.getAttribute("data-hub-id") === "bilinovel:42",
  );
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { name: "测试轻小说", exact: true })
    .waitFor();
  results.push("detail volume layout and return-to-card focus");
  await page.getByRole("button", { name: "加入书架", exact: true }).click();
  await page.getByRole("button", { name: "加入追更", exact: true }).click();
  assert.deepEqual(
    (await page.evaluate(() => window.media.onlineNovels.following()))[0]
      .newChapterIds,
    [],
  );
  await application.evaluate(() => {
    globalThis.__novelFixture.added = true;
  });
  const follows = await page.evaluate(() =>
    window.media.onlineNovels.checkFollowing(),
  );
  assert.deepEqual(follows[0].newChapterIds, ["102"]);
  results.push("following establishes baseline and detects new chapter ids");
  await page
    .locator('[data-hub-id="chapter:100"] > button:not(.icon-button)')
    .click();
  await page
    .locator(".epub-container iframe,.epub-host iframe,.reader iframe")
    .first()
    .waitFor({ timeout: 20000 });
  await page.waitForFunction(() => {
    const doc = document.querySelector(".reader iframe")?.contentDocument;
    return doc?.body?.textContent?.includes("测试正文");
  });
  assert.equal(
    await page.evaluate(() => !document.querySelector("audio").paused),
    true,
  );
  results.push("background local music continues while reading online novels");
  assert.equal(
    await page
      .locator(".reader-topbar, .reader-footer, .reader-bottom-panel")
      .count(),
    0,
  );
  await page.getByLabel("阅读进度文本", { exact: true }).waitFor();
  await page.mouse.move(650, 5);
  assert.equal(await page.locator(".reader-bottom-panel").count(), 0);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "阅读菜单", exact: true }).waitFor();
  await page.getByRole("button", { name: "添加书签", exact: true }).click();
  await page.getByRole("button", { name: "目录与书签", exact: true }).click();
  await page.locator(".reader-toc").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".reader-toc").count(), 0);
  assert.equal(await page.locator(".reader").count(), 1);
  await page.waitForTimeout(200);
  let state = await page.evaluate(
    (ref) => window.media.onlineNovels.reader({ ...ref, chapterId: "100" }),
    ref,
  );
  assert.equal(state.bookmarks.length, 1);
  const cover = await page.evaluate(async (url) => {
    const r = await fetch(url);
    return { ok: r.ok, type: r.headers.get("content-type") };
  }, state.details.cover);
  assert.equal(cover.type, "image/png");
  await application.evaluate(async ({ app }, url) => {
    const fs = process.getBuiltinModule("node:fs/promises"),
      path = process.getBuiltinModule("node:path");
    await fs.writeFile(
      path.join(
        app.getPath("userData"),
        "novel-online",
        "cache",
        new URL(url).pathname.split("/").at(-1) + ".cover",
      ),
      // PNG signature and dimensions are intact; the pixel data is truncated.
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ", "base64"),
    );
  }, state.details.cover);
  assert.equal(
    await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      return (
        response.ok && response.headers.get("content-type") === "image/png"
      );
    }, state.details.cover),
    true,
  );

  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "reader-dark.png"),
  });
  // Reaching the end by seeking must stay in this chapter; the next reading action crosses the volume boundary.
  await page
    .getByRole("combobox", { name: "小说翻页模式", exact: true })
    .selectOption("paged");
  await page.waitForFunction(
    () =>
      document.querySelector(".epub-host")?.dataset.readerIndexed === "true",
  );
  await page
    .getByRole("spinbutton", { name: "阅读进度百分比", exact: true })
    .fill("100");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(
        document.querySelector(".epub-host").dataset.readerLocation || "{}",
      ).atEnd,
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "跳转章节", exact: true })
      .inputValue(),
    "100",
  );
  await page.getByRole("button", { name: "关闭阅读菜单", exact: true }).click();
  await application.evaluate(() => {
    globalThis.__novelFixture.failImage = true;
  });
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "重试切章", exact: true }).waitFor();
  assert.equal(
    (
      await page.getByLabel("阅读进度文本", { exact: true }).textContent()
    ).startsWith("1/"),
    true,
  );
  await application.evaluate(() => {
    globalThis.__novelFixture.failImage = false;
  });
  await page.getByRole("button", { name: "重试切章", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".reader-corner-progress")
      ?.textContent?.startsWith("2/"),
  );

  await page.waitForFunction(
    () =>
      JSON.parse(
        document.querySelector(".epub-host").dataset.readerLocation || "{}",
      ).atStart,
  );
  // Going back opens the previous chapter at its end, rather than resuming an unrelated old CFI.
  await page.waitForFunction(
    () =>
      document.querySelector(".epub-host")?.dataset.readerPositioned === "true",
  );
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() =>
    document
      .querySelector(".reader-corner-progress")
      ?.textContent?.startsWith("1/"),
  );
  await page.waitForFunction(
    () =>
      JSON.parse(
        document.querySelector(".epub-host").dataset.readerLocation || "{}",
      ).atEnd &&
      document.querySelector(".epub-host")?.dataset.readerPositioned === "true",
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() =>
    document
      .querySelector(".reader-corner-progress")
      ?.textContent?.startsWith("2/"),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      document.querySelector(".epub-host")?.dataset.readerIndexed === "true" &&
      document.querySelector(".epub-host")?.dataset.readerPositioned === "true",
  );
  await page
    .getByRole("spinbutton", { name: "阅读进度百分比", exact: true })
    .fill("45");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.waitForFunction(() => {
    const location = JSON.parse(
      document.querySelector(".epub-host").dataset.readerLocation || "{}",
    );
    return location.whole > 0.1 && location.whole < 0.9;
  });
  await page
    .getByRole("combobox", { name: "小说翻页模式", exact: true })
    .selectOption("scroll");
  await page.waitForFunction(
    () =>
      document.querySelector(".epub-host")?.dataset.readerMode === "scroll" &&
      document.querySelector(".epub-host")?.dataset.readerPositioned ===
        "true" &&
      document.querySelector(".epub-host")?.dataset.readerIndexed === "true",
  );
  assert.equal(
    await page.locator(".epub-host").evaluate((el) => {
      const location = JSON.parse(el.dataset.readerLocation || "{}");
      return location.whole > 0.1 && location.whole < 0.9;
    }),
    true,
    "changing modes preserves the current chapter position instead of reapplying its entry point",
  );
  await page
    .getByRole("spinbutton", { name: "阅读进度百分比", exact: true })
    .fill("100");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(
        document.querySelector(".epub-host").dataset.readerLocation || "{}",
      ).atEnd,
  );
  await page.getByRole("button", { name: "关闭阅读菜单", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".epub-host")?.dataset.readerMode === "scroll",
  );
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() =>
    document
      .querySelector(".reader-corner-progress")
      ?.textContent?.startsWith("3/"),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".epub-host")?.dataset.readerPositioned === "true",
  );
  // A sustained wheel burst that entered this chapter must not immediately
  // cross its far boundary as well, even with very large deltas.
  for (let index = 0; index < 6; index++) await page.mouse.wheel(0, 50000);
  assert.equal(await page.getByText("— 本书完 —", { exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await page
    .getByRole("spinbutton", { name: "阅读进度百分比", exact: true })
    .fill("100");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(
        document.querySelector(".epub-host").dataset.readerLocation || "{}",
      ).atEnd,
  );
  await page.getByRole("button", { name: "关闭阅读菜单", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".epub-host")?.dataset.readerMode === "scroll",
  );
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 500);
  await page.getByText("— 本书完 —", { exact: true }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "reader-immersive.png"),
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 760, height: 780 });
  await page.waitForFunction(() => {
    const host = document.querySelector(".epub-host");
    const frame = host?.querySelector("iframe");
    return frame && frame.clientWidth <= host.clientWidth + 2;
  });
  assert.equal(
    await page.locator(".reader-panel-controls").evaluate((el) => {
      const controls = [...el.children].map((child) =>
        child.getBoundingClientRect(),
      );
      return controls.every((a, index) =>
        controls
          .slice(index + 1)
          .every(
            (b) =>
              Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 ||
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1,
          ),
      );
    }),
    true,
    "reader controls wrap without overlapping in a narrow window",
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "reader-menu-narrow.png"),
  });
  assert.equal(
    await page
      .getByRole("dialog", { name: "阅读菜单", exact: true })
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.x >= 0 &&
          r.y >= 0 &&
          r.right <= innerWidth &&
          r.bottom <= innerHeight
        );
      }),
    true,
  );
  await page.getByRole("button", { name: "关闭阅读菜单", exact: true }).click();
  await page.setViewportSize({ width: 2160, height: 1413 });
  results.push(
    "automatic paged/scroll chapter boundaries, reverse entry, resource failure retry and final chapter",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "返回媒体库", exact: true }).click();
  await page
    .getByRole("heading", { name: "测试轻小说", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement
        ?.closest("[data-hub-id]")
        ?.getAttribute("data-hub-id") === "chapter:100",
  );
  results.push(
    "EPUB reader, cover proxy, bookmarks, chapter navigation and return",
  );
  await page.evaluate(async (ref) => {
    await window.media.onlineNovels.saveProgress(
      { ...ref, chapterId: "100" },
      { cfi: "epubcfi(/6/2!/4/2/1:4)", textOffset: 4, scroll: 0.25 },
    );
    await window.media.onlineNovels.enqueue(ref, ["100", "101"]);
    await window.media.onlineNovels.enqueue(ref, ["100"]);
  }, ref);
  await waitForAPI(
    page,
    async () => {
      const t = await window.media.onlineNovels.downloads();
      return t.length === 2 && t.every((t) => t.state === "completed");
    },
    { timeout: 20000 },
  );
  const saved = await page.evaluate(
    (ref) => window.media.onlineNovels.reader({ ...ref, chapterId: "100" }),
    ref,
  );
  assert.equal(saved.item.progress.textOffset, 4);
  results.push("deduplicated complete chapter downloads and shared progress");
  await application.evaluate(() => {
    globalThis.__novelFixture.slow = true;
  });
  await page.evaluate(async (ref) => {
    await window.media.onlineNovels.details(ref, true);
    await window.media.onlineNovels.enqueue(ref, ["102"]);
  }, ref);
  await waitForAPI(page, async () =>
    (await window.media.onlineNovels.downloads()).some(
      (t) => t.chapterId === "102" && t.state === "downloading",
    ),
  );
  let extra = (
    await page.evaluate(() => window.media.onlineNovels.downloads())
  ).find((t) => t.chapterId === "102");
  await page.evaluate(
    (id) => window.media.onlineNovels.downloadAction(id, "pause"),
    extra.id,
  );
  assert.equal(
    (await page.evaluate(() => window.media.onlineNovels.downloads())).find(
      (t) => t.chapterId === "102",
    ).state,
    "paused",
  );
  await application.evaluate(() => {
    globalThis.__novelFixture.slow = false;
  });
  await page.evaluate(
    (id) => window.media.onlineNovels.downloadAction(id, "resume"),
    extra.id,
  );
  await waitForAPI(page, async () =>
    (await window.media.onlineNovels.downloads()).some(
      (t) => t.chapterId === "102" && t.state === "completed",
    ),
  );
  await page.evaluate(async (id) => {
    await window.media.onlineNovels.downloadAction(id, "delete");
    await window.media.onlineNovels.clearCache();
  }, extra.id);
  await application.evaluate(() => {
    globalThis.__novelFixture.failImage = true;
  });
  await page.evaluate(
    (ref) => window.media.onlineNovels.enqueue(ref, ["102"]),
    ref,
  );
  await waitForAPI(page, async () =>
    (await window.media.onlineNovels.downloads()).some(
      (t) => t.chapterId === "102" && t.state === "failed",
    ),
  );
  await application.evaluate(() => {
    globalThis.__novelFixture.failImage = false;
  });
  await page.evaluate(
    (id) => window.media.onlineNovels.downloadAction(id, "resume"),
    extra.id,
  );
  await waitForAPI(page, async () =>
    (await window.media.onlineNovels.downloads()).some(
      (t) => t.chapterId === "102" && t.state === "completed",
    ),
  );
  const quote = await page.evaluate(() =>
    window.media.onlineNovels.exportQuote({
      sourceId: "lightnovelshelf",
      novelId: "88",
    }),
  );
  assert.equal(quote.cost, 5);
  assert.equal(
    await application.evaluate(() => globalThis.__novelFixture.exports),
    0,
  );
  results.push(
    "pause/resume, missing illustration fails atomically, retry, quote never invokes billable export",
  );
  await application.evaluate(
    ({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    },
    path.join(temporary, "native.epub"),
  );
  const exportResults = await page.evaluate(async (id) => {
    const outcomes = await Promise.allSettled([
      window.media.onlineNovels.exportEpub(id),
      window.media.onlineNovels.exportEpub(id),
    ]);
    return outcomes.map((result) =>
      result.status === "rejected"
        ? String(result.reason)
        : "unexpected success",
    );
  }, quote.id);
  assert.equal(
    exportResults.some((value) => value.includes("未返回有效 EPUB")),
    true,
  );
  assert.equal(
    exportResults.some((value) => value.includes("报价已过期")),
    true,
  );
  assert.equal(
    await application.evaluate(() => globalThis.__novelFixture.exports),
    1,
  );
  results.push(
    "one-time export confirmation rejects duplicate calls and invalid source EPUB",
  );
  await page.evaluate(async () => {
    const s = await window.media.settings();
    await window.media.saveSettings({ ...s, theme: "light" });
  });
  await page.reload();
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  await page
    .getByRole("button", { name: "浏览小说", exact: true })
    .first()
    .click({ force: true });
  await page.locator(".novel-source-pills button").first().waitFor();
  await page.mouse.move(600, 500);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".comic-home-row")].every(
      (el) =>
        ![...el.children].some(
          (child) =>
            child.getBoundingClientRect().bottom >
            el.getBoundingClientRect().bottom + 1,
        ),
    ),
  );
  await page
    .locator(".main-chrome.chrome-hidden")
    .waitFor({ state: "attached" });
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "home-light.png"),
  });
  await page.setViewportSize({ width: 760, height: 780 });
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "home-narrow.png"),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator(".comic-source-management-entry").click();
  await page.getByRole("heading", { name: "小说源", exact: true }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "sources-light-narrow.png"),
  });
  await page.getByRole("button", { name: "返回小说", exact: true }).click();
  await page.mouse.move(5, 220);
  await page
    .getByRole("navigation", { name: "小说页面" })
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await page.getByRole("region", { name: "搜索历史", exact: true }).waitFor();
  assert.equal(
    await page.locator(".comic-search-history-term").first().textContent(),
    "测试",
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "search-light-narrow.png"),
  });
  await page.locator(".comic-search-history-term").first().click();
  await page.locator(".novel-aggregate .comic-hub-card").first().waitFor();
  await page
    .locator(".comic-aggregate-group")
    .filter({ has: page.getByRole("button", { name: /^哔哩轻小说 .*条预览/ }) })
    .getByRole("button", { name: "测试轻小说", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "测试轻小说", exact: true })
    .waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "detail-light-narrow.png"),
  });
  await page.mouse.move(5, 220);
  await page
    .getByRole("navigation", { name: "小说页面" })
    .getByRole("button", { name: "已下载", exact: true })
    .click();
  await page.locator(".novel-downloads").waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "downloads-light-narrow.png"),
  });
  results.push("light theme and narrow viewport");
  await application.evaluate(() => {
    globalThis.__novelFixture.slow = true;
  });
  await page.evaluate(
    async ({ id, ref }) => {
      await window.media.onlineNovels.downloadAction(id, "delete");
      await window.media.onlineNovels.clearCache();
      await window.media.onlineNovels.enqueue(ref, ["102"]);
    },
    { id: extra.id, ref },
  );
  await page.evaluate(() =>
    window.media.onlineNovels.settings("bilinovel", { enabled: false }),
  );
  await application.close();
  application = await launch();
  await fixtures(application, true);
  page = await application.firstWindow();
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  state = await page.evaluate(
    (ref) => window.media.onlineNovels.reader({ ...ref, chapterId: "100" }),
    ref,
  );
  assert.equal(
    (await page.evaluate(() => window.media.onlineNovels.downloads())).find(
      (t) => t.chapterId === "102",
    ).state,
    "paused",
  );
  assert.equal(state.item.progress.textOffset, 4);
  assert.equal(state.bookmarks.length, 1);
  assert.equal(
    await page.evaluate(
      async (item) =>
        (
          await fetch(
            `media://novel/chapter/${item.id.replace("novel-online:", "")}`,
          )
        ).ok,
      state.item,
    ),
    true,
  );
  const downloads = await page.evaluate(() =>
    window.media.onlineNovels.downloads(),
  );
  await page.evaluate(
    (id) => window.media.onlineNovels.downloadAction(id, "delete"),
    downloads.find((t) => t.chapterId === "100").id,
  );
  assert.equal(
    (await page.evaluate(() => window.media.onlineNovels.library("shelf")))
      .length,
    1,
  );
  await page.evaluate(
    async ({ ref, id }) => {
      await window.media.onlineNovels.deleteBookmark(ref, id);
    },
    { ref, id: state.bookmarks[0].id },
  );
  assert.equal(
    (
      await page.evaluate(
        (ref) => window.media.onlineNovels.reader({ ...ref, chapterId: "101" }),
        ref,
      )
    ).bookmarks.length,
    0,
  );
  results.push(
    "offline restart, disabled source, delete downloads preserves shelf/progress, bookmark deletion",
  );
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ passed: results, artifacts }, null, 2));
} catch (error) {
  if (application) {
    const failedPage = await application.firstWindow();
    await failedPage
      .screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
    console.error(
      "Reader failure state:",
      await failedPage
        .evaluate(() => ({
          host: { ...document.querySelector(".epub-host")?.dataset },
          progress: document.querySelector(".reader-corner-progress")
            ?.textContent,
          alert: [...document.querySelectorAll('[role="alert"]')].map(
            (el) => el.textContent,
          ),
        }))
        .catch(() => undefined),
    );
  }
  throw error;
} finally {
  if (application) await application.close();
}
