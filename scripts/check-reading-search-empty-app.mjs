// Deterministic Electron regression: browse data and global layouts cannot leak into search.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-empty-search-"));
const artifacts = path.resolve("artifacts/reading-search-empty");
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
    args: ["."], env, timeout: 30000,
  });
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.__emptySearchRequests = [];
    globalThis.__releaseEmptySearch = [];
    const cover = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="260"><rect width="180" height="260" fill="#618b82"/></svg>');
    for (const kind of ["comic", "novel"]) {
      const id = kind === "comic" ? "comic-fixture" : "lightnovelshelf";
      ipcMain.removeHandler(`${kind}:call`);
      ipcMain.handle(`${kind}:call`, async (_event, method, args = []) => {
        if (method === "sources") return [{
          id, key: id, name: "空搜索测试源", version: "1", enabled: true,
          logged: false, hash: id, url: "https://example.org",
          capabilities: { search: true, categories: false, favorites: false, favoriteFolders: false, login: [] },
          explore: [{ title: "测试发现", type: "multiPageComicList" }],
          categoryOptions: [], rankingOptions: [], searchOptions: [], settings: {}, settingValues: {},
        }];
        if (method === "downloadDirectory") return "/fixture";
        if (["explore", "discover", "search"].includes(method)) {
          const query = method === "search" ? args[1] : "未搜索的发现内容";
          globalThis.__emptySearchRequests.push({ kind, method, query });
          if (query === "迟到结果") await new Promise(resolve => globalThis.__releaseEmptySearch.push(resolve));
          const items = Array.from({ length: 8 }, (_, index) => ({
            sourceId: id,
            ...(kind === "comic" ? { comicId: String(index) } : { novelId: String(index) }),
            title: `${query} · ${index + 1}`, cover,
          }));
          return kind === "comic" ? { comics: items, maxPage: 2, next: "2" } : { novels: items, page: 1, hasMore: true };
        }
        return [];
      });
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.showInactive();
    }
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  await page.evaluate(async () => {
    localStorage.setItem("layout:type:comic", "archiveShelf");
    localStorage.setItem("layout:type:novel", "archiveShelf");
    await window.media.saveSettings({ ...(await window.media.settings()), reducedMotion: true });
  });
  await page.reload();
  const navigateSection = async (label, section) => {
    if (label === "漫画") await page.mouse.move(20, 400);
    else await page.getByRole("button", { name: `打开${label}菜单`, exact: true }).evaluate(button => button.click());
    await page.getByRole("navigation", { name: `${label}页面`, exact: true }).getByRole("button", { name: section, exact: true }).click();
  };
  const assertEmpty = async label => {
    await page.getByRole("region", { name: "搜索历史", exact: true }).waitFor();
    assert.equal(await page.locator(".online-layout,.comic-aggregate-group,.online-pagination,.online-loading,.online-error,.novel-error").count(), 0, `${label}: empty search contains only form and history`);
    assert.equal(await page.getByRole("button", { name: "显示方式", exact: true, includeHidden: true }).count(), 0, `${label}: global layout picker is absent`);
    assert.equal(await page.getByRole("button", { name: `${label}显示方式`, exact: true, includeHidden: true }).count(), 0);
  };
  const submit = async (label, query, single = false) => {
    if (single) await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: single ? `搜索当前${label}源` : `聚合搜索${label}`, exact: true }).fill(query);
    await page.locator(".comic-search-form").getByRole("button", { name: "搜索", exact: true }).click();
  };
  const searchCalls = kind => app.evaluate(({}, kind) => globalThis.__emptySearchRequests.filter(request => request.kind === kind && request.method === "search").length, kind);
  const release = () => app.evaluate(() => { for (const resolve of globalThis.__releaseEmptySearch.splice(0)) resolve(); });
  for (const [kind, label] of [["comic", "漫画"], ["novel", "小说"]]) {
    await page.locator(".chrome-edge-right").hover();
    await page.getByRole("button", { name: `浏览${label}`, exact: true }).evaluate(button => button.click());
    await page.mouse.move(500, 400);
    await page.locator(".comic-home").waitFor();
    await navigateSection(label, "发现");
    await page.locator(".online-layout .archive-shelf").waitFor();
    await page.waitForFunction(() => document.querySelector(".online-layout")?.textContent.includes("未搜索的发现内容"));
    const before = await searchCalls(kind);
    await navigateSection(label, "搜索");
    await assertEmpty(label);
    assert.equal(await searchCalls(kind), before);
    await page.getByRole("textbox", { name: `聚合搜索${label}`, exact: true }).fill("尚未提交");
    await assertEmpty(label);
    assert.equal(await searchCalls(kind), before, `${label}: typing never starts a search`);
    await page.screenshot({ path: path.join(artifacts, `${kind}-empty.png`), animations: "disabled" });
    await submit(label, "明确搜索");
    await page.locator(".comic-aggregate-group").waitFor();
    assert.equal(await page.locator(".online-layout").count(), 0, `${label}: aggregate search uses source groups`);
    await page.getByRole("button", { name: "查看此源全部结果", exact: true }).first().click();
    await page.locator(".online-layout .standard-grid").waitFor();
    assert.equal(await page.getByRole("button", { name: "显示方式", exact: true, includeHidden: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: `${label}显示方式`, exact: true, includeHidden: true }).count(), 0);
    assert.equal(await page.locator(".online-layout .archive-shelf").count(), 0, `${label}: single-source default is independent of global shelf`);
    await page.keyboard.press("Control+f");
    assert.equal(await page.getByLabel("单源结果布局", { exact: true }).inputValue(), "grid");
    await page.locator(".comic-search-form").getByRole("button", { name: "清除", exact: true }).click();
    await assertEmpty(label);
    assert.equal(await page.getByLabel("单源结果布局", { exact: true }).count(), 0);
    await submit(label, "迟到结果", true);
    await page.waitForFunction(() => document.querySelector(".online-loading"));
    await page.keyboard.press("Control+f");
    await page.locator(".comic-search-form").getByRole("button", { name: "清除", exact: true }).click();
    await release();
    await page.waitForTimeout(200);
    await assertEmpty(label);
    await navigateSection(label, "搜索");
    await submit(label, "迟到结果");
    await page.waitForFunction(() => document.querySelector(".online-loading"));
    await page.locator(".comic-search-form").getByRole("button", { name: "清除", exact: true }).click();
    await release();
    // Flush the released IPC responses and rendering before the final assertion.
    await page.waitForTimeout(200);
    await assertEmpty(label);
    const after = await searchCalls(kind);
    await page.getByRole("textbox", { name: `聚合搜索${label}`, exact: true }).fill("仍未提交");
    assert.equal(await searchCalls(kind), after);
    console.log(`${label}: discovery/shelf isolation, no implicit search, grouped results, independent single-source layout, clear and late responses passed`);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.error(await page.locator(".online-comics").textContent());
    await page.screenshot({ path: path.join(artifacts, "failure.png") });
  }
  throw error;
} finally {
  if (app) await app.close();
}
