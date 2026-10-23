// Runs the same interaction contract against the comic and novel adapters.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-reading-search-"),
);
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    env,
    timeout: 30000,
  });
  await app.evaluate(({ ipcMain }) => {
    globalThis.__readingRequests = [];
    globalThis.__readingFailure = false;
    const cover =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="260"><rect width="180" height="260" fill="#618b82"/><circle cx="90" cy="100" r="48" fill="#e2cfa2"/></svg>',
      );
    for (const kind of ["comic", "novel"]) {
      ipcMain.removeHandler(`${kind}:call`);
      ipcMain.handle(`${kind}:call`, async (_event, method, args = []) => {
        const ids =
          kind === "comic"
            ? ["comic-one", "comic-two"]
            : ["lightnovelshelf", "bilinovel"];
        const sources = ids.map((id, index) => ({
          id,
          key: id,
          name: index === 0 ? "测试源甲" : "测试源乙",
          version: "1",
          enabled: true,
          logged: false,
          url: "https://example.org",
          hash: id,
          capabilities: {
            search: true,
            categories: false,
            favorites: false,
            favoriteFolders: false,
            login: [],
          },
          explore: [],
          categoryOptions: [],
          rankingOptions: [],
          searchOptions: [
            {
              label: "语言",
              type: "select",
              options: [
                { value: "all", text: "全部" },
                { value: "zh", text: "中文" },
              ],
              default: "all",
            },
          ],
          settings: {},
          settingValues: {},
        }));
        if (method === "sources") return sources;
        if (["downloads", "following", "library"].includes(method)) return [];
        if (method === "downloadDirectory") return "/fixture";
        const item = (id, query, index) => ({
          sourceId: id,
          ...(kind === "comic"
            ? { comicId: String(index) }
            : { novelId: String(index) }),
          title: `${query} · ${index}`,
          cover,
        });
        if (method === "search") {
          const [id, query] = args,
            page = kind === "comic" ? args[3] : args[2];
          globalThis.__readingRequests.push({ kind, id, query, page });
          if (globalThis.__readingFailure && id === ids[1])
            throw new Error("[network] fixture source failure");
          if (query === "slow")
            await new Promise((resolve) => setTimeout(resolve, 450));
          const items = [
            item(id, query, page * 10 + 1),
            item(id, query, page * 10 + 2),
          ];
          return kind === "comic"
            ? {
                comics: items,
                maxPage: 3,
                next: page < 3 ? String(page + 1) : null,
              }
            : { novels: items, page, hasMore: page < 3 };
        }
        if (method === "details")
          return {
            ...item(
              args[0].sourceId,
              "详情",
              Number(args[0].comicId || args[0].novelId),
            ),
            chapters: [],
            favorite: false,
          };
        return [];
      });
    }
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const report = [];
  for (const [kind, label] of [
    ["comic", "漫画"],
    ["novel", "小说"],
  ]) {
    await page.locator(".chrome-edge-right").hover();
    await page
      .getByRole("button", { name: `浏览${label}`, exact: true })
      .first()
      .click();
    await page.mouse.move(5, 220);
    await page
      .getByRole("navigation", { name: `${label}页面`, exact: true })
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: `聚合搜索${label}`, exact: true })
      .fill("initial");
    await page
      .locator(".comic-search-form")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".comic-aggregate-group").length === 2,
    );
    await app.evaluate(() => {
      globalThis.__readingFailure = true;
    });
    await page
      .getByRole("textbox", { name: `聚合搜索${label}`, exact: true })
      .fill("partial");
    await page
      .locator(".comic-search-form")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".comic-aggregate-group").length === 1,
    );
    if (kind === "comic")
      await page.locator(".comic-aggregate-failures > summary").click();
    else await page.locator(".novel-error").waitFor();
    await app.evaluate(() => {
      globalThis.__readingFailure = false;
    });
    await page
      .locator(kind === "comic" ? ".comic-aggregate-failure" : ".novel-error")
      .getByRole("button", {
        name: kind === "comic" ? "重试" : "重试此源",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".comic-aggregate-group").length === 2,
    );
    await page
      .getByRole("button", { name: "查看此源全部结果", exact: true })
      .first()
      .click();
    await page.locator(".online-layout .standard-grid").waitFor();
    assert.equal(
      await page
        .locator(".comic-search-panel")
        .evaluate((el) => el.classList.contains("is-visible")),
      false,
    );
    await page.keyboard.press("Control+f");
    await page
      .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".comic-search-panel .online-source-selector").count(),
      0,
    );
    if (kind === "comic")
      assert.equal(await page.getByLabel("语言", { exact: true }).count(), 1);
    await page
      .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
      .fill("single-only");
    await page
      .locator(".comic-search-form")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".online-layout")
        ?.textContent?.includes("single-only"),
    );
    const requests = await app.evaluate(() => globalThis.__readingRequests);
    assert.equal(
      requests
        .filter((r) => r.kind === kind && r.query === "single-only")
        .every(
          (r) => r.id === (kind === "comic" ? "comic-one" : "lightnovelshelf"),
        ),
      true,
    );
    await page.keyboard.press("Control+f");
    await page
      .getByLabel("结果加载方式", { exact: true })
      .selectOption("waterfall");
    await page.keyboard.press("Escape");
    // Both adapters load from the visible waterfall sentinel. Clicking its
    // transient fallback button races the observer removing that button.
    await page.waitForFunction(() =>
      document
        .querySelector(".online-layout")
        ?.textContent?.includes("single-only · 21"),
    );
    await page.keyboard.press("Control+f");
    await page
      .getByLabel("结果加载方式", { exact: true })
      .selectOption("pagination");
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator(".comic-search-panel")
        .evaluate((el) => el.classList.contains("is-visible")),
      false,
    );
    await page.keyboard.press("Control+f");
    await page
      .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
      .fill("unsent draft");
    await page.keyboard.press("Escape");
    await page.locator(".online-layout .poster-hit").first().click();
    await page.getByRole("heading", { name: /详情/ }).waitFor();
    await page.keyboard.press("Alt+ArrowLeft");
    await page.locator(".online-layout .standard-grid").waitFor();
    assert.equal(
      await page
        .locator(".comic-search-panel")
        .evaluate((el) => el.classList.contains("is-visible")),
      false,
    );
    await page.keyboard.press("Control+f");
    assert.equal(
      await page
        .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
        .inputValue(),
      "unsent draft",
    );
    await page.keyboard.press("Escape");
    await page.screenshot({
      animations: "disabled",
      path: `artifacts/novel-verification/${kind}-shared-search.png`,
    });
    report.push(
      `${label}: aggregate, fixed single source, hidden panel, filters, pagination/waterfall, partial failure retry and parent draft restoration`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: report }));
} finally {
  if (app) await app.close();
}
