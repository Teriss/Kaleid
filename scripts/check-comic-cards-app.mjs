import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import JSZip from "jszip";
import sharp from "sharp";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-rich-cards-"));
const localRoot = path.join(root, "comics");
await fs.mkdir(localRoot);
const localBook = new JSZip();
localBook.file(
  "001.png",
  await sharp({
    create: { width: 180, height: 260, channels: 3, background: "#759b82" },
  })
    .png()
    .toBuffer(),
);
await fs.writeFile(
  path.join(localRoot, "本地示例.cbz"),
  await localBook.generateAsync({ type: "nodebuffer" }),
);
const output = path.resolve("artifacts/comic-rich-cards");
await fs.mkdir(output, { recursive: true });
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: ["out/main/index.js"], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => window.media?.onlineComics);
  await app.evaluate(({ ipcMain, BrowserWindow }, downloadRoot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false);
      window.setSize(1440, 1000);
      window.hide();
    }
    globalThis.__richDetails = 0;
    globalThis.__readingHomeSearches = [];
    const cover =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="260"><rect width="180" height="260" fill="#334e62"/><circle cx="90" cy="90" r="45" fill="#b6d6d5"/><path d="M0 260L90 150L180 260" fill="#527484"/></svg>',
      );
    const source = {
      id: "rich-fixture",
      key: "rich-fixture",
      name: "富卡片检查源",
      version: "1",
      enabled: true,
      logged: false,
      url: "https://example.org",
      hash: "fixture",
      capabilities: {
        search: true,
        categories: true,
        favorites: false,
        favoriteFolders: false,
        login: [],
      },
      explore: [{ title: "分组推荐", type: "singlePageWithMultiPart" }],
      categories: {},
      categoryOptions: [],
      rankingOptions: [],
      searchOptions: [],
      settings: {},
      settingValues: {},
    };
    const sources = [
      source,
      {
        ...source,
        id: "rich-fixture-two",
        key: "rich-fixture-two",
        name: "第二检查源",
      },
    ];
    const items = [
      {
        comicId: "translated",
        title: "统一卡片示例 · 长标题显示两行并省略多余文字",
        subtitle: "备用标题 · 单行显示",
        maxPage: 24,
        stars: 4.32,
        uploadTime: "2026-10-24 16:05",
        tagDisplay: [
          {
            namespace: "language",
            label: "语言",
            tags: [
              { value: "chinese", label: "汉语" },
              { value: "translated", label: "翻译" },
            ],
          },
          {
            namespace: "other",
            label: "其他",
            tags: [
              { value: "archive", label: "蔚蓝档案" },
              { value: "teacher", label: "老师" },
              { value: "artist", label: "sumika komori" },
            ],
          },
        ],
      },
      {
        comicId: "array",
        title: "列表标签数组",
        subtitle: "数组标签也采用相同布局",
        maxPage: 38,
        stars: 3.5,
        tags: ["language:chinese", "genre:slice_of_life"],
        tagDisplay: [],
        description:
          "SYNOPSIS_MUST_NOT_APPEAR: This is a long summary of an adventure story. ".repeat(
            8,
          ),
      },
      {
        comicId: "map",
        title: "分组标签 Map",
        subtitle: "时间和分类不混入标签区",
        maxPage: 52,
        stars: 4,
        tags: {
          $map: [
            ["genre", ["adventure", "2026-08-04"]],
            ["Category", ["Manga"]],
            ["artist", ["example"]],
          ],
        },
        description: "1",
      },
      {
        comicId: "empty",
        title: "源没有提供标签",
        description: "SYNOPSIS_MUST_NOT_APPEAR",
        tags: [],
      },
    ].map((item) => ({ ...item, sourceId: source.id, cover }));
    ipcMain.removeHandler("comic:call");
    ipcMain.handle("comic:call", async (_event, method, args = []) => {
      if (method === "sources") return sources;
      if (method === "library") return items.slice(0, 3);
      if (method === "hubList")
        return [{ kind: "online", sourceId: source.id, comicId: "translated" }];
      if (method === "following")
        return [
          {
            ref: { sourceId: source.id, comicId: "translated" },
            addedAt: 1,
            newChapterIds: [],
          },
        ];
      if (method === "details") {
        globalThis.__richDetails++;
        return {
          ...items.find((item) => item.comicId === args[0].comicId),
          chapters: [],
          hasChapters: false,
          hasThumbnailLoader: false,
          favorite: false,
        };
      }
      if (
        method === "search" ||
        method === "category" ||
        method === "explore"
      ) {
        if (method === "search")
          globalThis.__readingHomeSearches.push({
            kind: "comic",
            id: args[0],
            query: args[1],
          });
        const comics = items.map((item) => ({ ...item, sourceId: args[0] }));
        return {
          comics,
          maxPage: 1,
          next: null,
          sections: [{ title: "分组推荐", comics }],
        };
      }
      if (method === "categories")
        return { parts: [{ name: "分类", categories: ["日常"] }] };
      if (method === "downloadDirectory") return downloadRoot;
      return [];
    });
    const novelSources = sources.map((source, index) => ({
      ...source,
      id: `novel-fixture-${index}`,
      capabilities: {
        search: true,
        latest: true,
        popular: true,
        login: [],
        exportEpub: false,
      },
    }));
    const novel = (id, title = "小说预览") => ({
      sourceId: id,
      novelId: "sample",
      title,
      author: "作者",
      cover,
    });
    ipcMain.removeHandler("novel:call");
    ipcMain.handle("novel:call", async (_event, method, args = []) => {
      if (method === "sources") return novelSources;
      if (method === "library")
        return args[0] === "history" ? [novel(novelSources[0].id)] : [];
      if (method === "downloadDirectory") return downloadRoot;
      if (method === "details")
        return { ...novel(args[0].sourceId), chapters: [] };
      if (method === "latest" || method === "popular")
        return { novels: [novel(args[0])], page: 1, hasMore: false };
      if (method === "search") {
        globalThis.__readingHomeSearches.push({
          kind: "novel",
          id: args[0],
          query: args[1],
        });
        return { novels: [novel(args[0], args[1])], page: 1, hasMore: false };
      }
      return [];
    });
  }, root);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, localRoot);
  await page.evaluate(async () => {
    const library = await window.media.createLibrary({
      name: "本地漫画检查",
      type: "comic",
      roots: await window.media.chooseFolders(),
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Local fixture scan timed out"));
      }, 15000);
      const unsubscribe = window.media.onScan((status) => {
        if (status.libraryId !== library.id || status.status === "scanning")
          return;
        clearTimeout(timeout);
        unsubscribe();
        status.status === "done"
          ? resolve()
          : reject(new Error(status.message || status.status));
      });
      void window.media.scan(library.id).catch(reject);
    });
  });
  await page.waitForFunction(
    async () =>
      (await window.media.query({ type: "comic" })).items.length === 1,
  );
  const localId = await page.evaluate(async () => {
    const item = (await window.media.query({ type: "comic" })).items[0];
    await window.media.opened(item.id);
    return item.id;
  });
  await page.evaluate(async () =>
    window.media.saveSettings({
      ...(await window.media.settings()),
      reducedMotion: true,
    }),
  );
  await page.reload();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".chrome-edge-right").hover();
  await page
    .getByRole("button", { name: "浏览漫画", exact: true })
    .first()
    .click();
  await page.mouse.move(700, 300);
  await page.locator(".comic-hub-card.is-rich").first().waitFor();
  const report = [];
  async function capture(name, rect) {
    const png = await app.evaluate(
      async ({ BrowserWindow }, rect) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.showInactive();
        try {
          await window.webContents.executeJavaScript(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          const image = await window.capturePage(rect, { stayAwake: true });
          return image.toPNG().toString("base64");
        } finally {
          window.hide();
        }
      },
      rect &&
        Object.fromEntries(
          Object.entries(rect).map(([key, value]) => [key, Math.round(value)]),
        ),
    );
    await fs.writeFile(
      path.join(output, name + ".png"),
      Buffer.from(png, "base64"),
    );
  }
  async function inspect(name, scope = ".online-comics") {
    const cards = page.locator(`${scope} .comic-result-content`);
    await cards.first().waitFor();
    const data = await cards.evaluateAll((nodes) =>
      nodes.map((node) => {
        const bounds = (selector) => {
          const el = node.querySelector(selector);
          if (!el) return undefined;
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          title: node.querySelector(".comic-result-title").textContent,
          text: node.textContent,
          cover: bounds(".comic-result-cover"),
          tags: bounds(".comic-result-tags"),
          rating: bounds(".comic-result-rating"),
          time: bounds(".comic-result-time"),
          direction: getComputedStyle(node.querySelector(".comic-result-meta"))
            .flexDirection,
        };
      }),
    );
    for (const card of data) {
      assert(
        !card.text.includes("SYNOPSIS_MUST_NOT_APPEAR"),
        `${name}: synopsis leaked`,
      );
      assert(
        !card.text.includes("2001/01/01"),
        `${name}: numeric description became a date`,
      );
      assert.equal(
        Math.round(card.cover.width),
        118,
        `${name}: inconsistent cover`,
      );
      assert(
        Math.abs(card.cover.height - 175) <= 2,
        `${name}: inconsistent card height ${card.cover.height}`,
      );
      assert.equal(
        card.direction,
        "column",
        `${name}: footer must have separate rows`,
      );
      if (card.rating && card.time)
        assert(
          card.time.y >= card.rating.y + card.rating.height,
          `${name}: time must follow rating`,
        );
    }
    const text = await cards.allTextContents();
    assert(
      text.some((value) => value.includes("汉语")),
      `${name}: translated tags missing`,
    );
    assert.equal(
      await page
        .locator(`${scope} .comic-result-tag`)
        .filter({ hasText: "2026-08-04" })
        .count(),
      0,
    );
    report.push({ name, cards: data.length });
    console.log(`${name}: ${data.length} cards passed`);
  }
  async function navigate(label) {
    await page.mouse.move(5, 360);
    await page
      .getByRole("navigation", { name: "漫画页面", exact: true })
      .getByRole("button", { name: label, exact: true })
      .click();
    await page.mouse.move(700, 300);
  }
  await inspect("首页各横排");
  const recent = page
    .locator(".comic-home-row")
    .filter({ has: page.getByRole("button", { name: /最近阅读/ }) });
  assert.equal(await recent.locator(".comic-hub-card").count(), 4);
  assert.equal(await recent.locator(".comic-hub-card.is-rich").count(), 0);
  assert.equal(
    Math.round(
      (await recent.locator(".comic-hub-cover").first().boundingBox()).width,
    ),
    112,
  );
  await page.getByRole("button", { name: "搜索漫画", exact: true }).waitFor();
  await capture("home");
  await page.locator(".comic-hub-card.is-rich").first().hover();
  await capture(
    "card",
    await page.locator(".comic-hub-card.is-rich").first().boundingBox(),
  );
  await page
    .locator(".comic-home-row")
    .filter({ has: page.getByRole("button", { name: /最近阅读/ }) })
    .getByRole("button", { name: /查看全部/ })
    .click();
  await inspect("历史网格", ".online-layout");
  assert.equal(await page.locator(".online-layout .poster").count(), 4);
  assert.equal(
    await page.locator(".online-layout .comic-result-card").count(),
    4,
  );
  const localCard = page.locator(`[data-media-id="${localId}"]`);
  assert.equal(
    await localCard.locator(".comic-result-title").textContent(),
    "本地示例",
  );
  assert.equal(
    await localCard
      .locator(
        ".comic-result-tag,.comic-result-subtitle,.comic-result-rating,.comic-result-time",
      )
      .count(),
    0,
  );
  await capture("mixed-history");
  const detailRequestsBeforeLocal = await app.evaluate(
    () => globalThis.__richDetails,
  );
  await localCard.locator(".poster-hit").click();
  await page.locator(".comic-viewer .comic-image img").first().waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".comic-viewer .comic-image img")?.naturalWidth >
      0,
  );
  assert.equal(
    await app.evaluate(() => globalThis.__richDetails),
    detailRequestsBeforeLocal,
  );
  await page.keyboard.press("Escape");
  await page.locator(".comic-viewer").waitFor({ state: "detached" });
  await localCard.waitFor();
  report.push({ name: "本地历史富卡片打开与返回", passed: true });
  for (const label of ["本地收藏", "稍后阅读", "追更", "已下载"]) {
    await navigate(label);
    await inspect(label, ".online-layout");
  }
  await navigate("发现");
  await inspect("发现分组");
  await navigate("分类");
  await page.getByRole("button", { name: "日常", exact: true }).click();
  await inspect("分类结果", ".online-layout");
  await navigate("首页");
  await page.getByRole("button", { name: "搜索漫画", exact: true }).click();
  await page
    .getByRole("textbox", { name: "聚合搜索漫画", exact: true })
    .waitFor();
  assert(
    await page
      .getByRole("textbox", { name: "聚合搜索漫画", exact: true })
      .evaluate((node) => node === document.activeElement),
  );
  const before = await app.evaluate(() => globalThis.__richDetails);
  await page
    .getByRole("textbox", { name: "聚合搜索漫画", exact: true })
    .fill("示例");
  await page
    .locator(".comic-search-form")
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await inspect("聚合预览", ".comic-aggregate-group");
  await capture("aggregate");
  await page
    .getByRole("button", { name: "查看此源全部结果", exact: true })
    .first()
    .click();
  await inspect("单源搜索", ".online-layout");
  await capture("single");
  await navigate("首页");
  await page.getByRole("button", { name: "搜索漫画", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "第二检查源", exact: true })
    .uncheck();
  await page
    .getByRole("textbox", { name: "聚合搜索漫画", exact: true })
    .fill("单源直达");
  await page
    .locator(".comic-search-form")
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await page.locator(".online-layout .standard-grid").waitFor();
  assert.equal(await page.locator(".comic-aggregate-group").count(), 0);
  const comicSearches = await app.evaluate(() =>
    globalThis.__readingHomeSearches.filter(
      (request) => request.kind === "comic" && request.query === "单源直达",
    ),
  );
  assert.equal(comicSearches.length, 1);
  assert.equal(comicSearches[0].id, "rich-fixture");
  report.push({
    name: "漫画首页搜索与单源直达",
    requests: comicSearches.length,
  });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(0, 0);
    window.setSize(740, 850);
  });
  await page.waitForFunction(() => window.innerWidth < 800);
  await inspect("窄窗口", ".online-layout");
  await capture("narrow");
  assert.equal(
    await app.evaluate(() => globalThis.__richDetails),
    before,
    "Search cards must not fetch missing metadata",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  await page.locator(".chrome-edge-right").hover();
  await page
    .getByRole("button", { name: "浏览小说", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "搜索小说", exact: true }).waitFor();
  const novelRecent = page
    .locator(".comic-home-row")
    .filter({ has: page.getByRole("button", { name: /最近阅读/ }) });
  assert.equal(await novelRecent.locator(".comic-hub-card.is-rich").count(), 0);
  await capture("novel-home");
  await page.getByRole("button", { name: "搜索小说", exact: true }).click();
  await page
    .getByRole("textbox", { name: "聚合搜索小说", exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "聚合搜索小说", exact: true })
    .fill("多源小说");
  await page
    .locator(".comic-search-form")
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".comic-aggregate-group").length === 2,
  );
  await page.mouse.move(5, 360);
  await page
    .getByRole("navigation", { name: "小说页面", exact: true })
    .getByRole("button", { name: "首页", exact: true })
    .click();
  await page.getByRole("button", { name: "搜索小说", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "第二检查源", exact: true })
    .uncheck();
  await page
    .getByRole("textbox", { name: "聚合搜索小说", exact: true })
    .fill("小说单源直达");
  await page
    .locator(".comic-search-form")
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await page.locator(".online-layout .standard-grid").waitFor();
  assert.equal(await page.locator(".comic-aggregate-group").count(), 0);
  const novelSearches = await app.evaluate(() =>
    globalThis.__readingHomeSearches.filter(
      (request) => request.kind === "novel" && request.query === "小说单源直达",
    ),
  );
  assert.equal(novelSearches.length, 1);
  assert.equal(novelSearches[0].id, "novel-fixture-0");
  report.push({
    name: "小说首页搜索、多源预览与单源直达",
    requests: novelSearches.length,
  });
  await page.getByRole("button", { name: "返回小说首页", exact: true }).click();
  await page.getByRole("button", { name: "搜索小说", exact: true }).waitFor();
  for (const [kind, label, entries] of [
    [
      "comic",
      "漫画",
      [
        ["本地收藏", "button"],
        ["发现", "escape"],
        ["分类", "mouse"],
        ["搜索", "escape"],
        ["稍后阅读", "escape"],
        ["追更", "mouse"],
        ["已下载", "button"],
      ],
    ],
    [
      "novel",
      "小说",
      [
        ["书架", "button"],
        ["发现", "escape"],
        ["最近阅读", "mouse"],
        ["搜索", "escape"],
        ["稍后阅读", "button"],
        ["追更", "escape"],
        ["已下载", "mouse"],
      ],
    ],
  ]) {
    await page.locator(".chrome-edge-right").hover();
    await page
      .getByRole("button", { name: `浏览${label}`, exact: true })
      .first()
      .click();
    const home = page.getByRole("button", {
      name: `搜索${label}`,
      exact: true,
    });
    const menu = page.getByRole("navigation", {
      name: `${label}页面`,
      exact: true,
    });
    const openMenuPage = async (name) => {
      await page.mouse.move(5, 360);
      await menu.getByRole("button", { name, exact: true }).click();
      await page.mouse.move(700, 300);
      await home.waitFor({ state: "detached" });
    };
    for (const [name, method] of entries) {
      await openMenuPage(name);
      if (method === "button")
        await page
          .getByRole("button", { name: `返回${label}首页`, exact: true })
          .click();
      else if (method === "mouse")
        await page.evaluate(() =>
          window.dispatchEvent(
            new MouseEvent("mouseup", {
              button: 3,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      else await page.keyboard.press("Escape");
      await home.waitFor();
      report.push({ name: `${label}${name}返回首页`, method });
    }
    await openMenuPage(kind === "comic" ? "发现" : "最近阅读");
    if (kind === "comic")
      await page
        .locator(".comic-explore-sections .comic-hub-cover")
        .first()
        .click();
    else await page.locator(".online-layout .poster-hit").first().click();
    await page.locator(".online-detail.comic-detail-loaded").waitFor();
    await page.keyboard.press("Escape");
    await page
      .locator(".online-detail.comic-detail-loaded")
      .waitFor({ state: "detached" });
    assert.equal(await home.count(), 0, `${label}详情应回到作品列表`);
    await page.keyboard.press("Escape");
    await home.waitFor();
    report.push({ name: `${label}详情保留返回列表层级`, passed: true });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app?.close();
}
