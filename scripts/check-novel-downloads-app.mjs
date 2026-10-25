// Actual IPC, QuickJS, EPUB files and UI, isolated from the user's library.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "@playwright/test";

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-novel-downloads-"),
);
const artifacts = path.resolve("artifacts/novel-download-verification");
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: temporary };
delete env.ELECTRON_RUN_AS_NODE;
const sourceScript = (id) => `
class NovelSourceEntry extends NovelSource {
  constructor() { super({ apiVersion: 1, id: ${JSON.stringify(id)}, name: "下载测试源",
    version: "1.0.0", url: "https://fixture.example.org/",
    capabilities: { search: true, latest: true, popular: true, login: [], exportEpub: false }, settings: {} }); }
  book(id) { return { sourceId: this.meta.id, novelId: id, title: "下载测试小说 " + id }; }
  async search(keyword, page) { return { novels: [this.book("1")], page, hasMore: false }; }
  async discover(kind, page) { return { novels: [], page, hasMore: false }; }
  async details(id) { return { ...this.book(id), chapters: ["a", "b", "c"].map((chapter) => ({
    id: chapter, title: "章节 " + chapter, volume: "第一卷" })) }; }
  async chapter(id, chapter) {
    const response = await host.request("https://fixture.example.org/" + id + "/" + chapter.id);
    if (response.status !== 200) throw new Error(response.body);
    return { title: chapter.title, html: "<p>" + response.body + "</p>", base: this.meta.url };
  }
}`;
const launch = () => _electron.launch({ args: ["out/main/index.js"], env });
let application;
let page;
const call = (method, ...args) =>
  page.evaluate(
    ({ method, args }) => window.media.onlineNovels[method](...args),
    { method, args },
  );
async function waitFor(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tasks = await call("downloads");
    if (predicate(tasks)) return tasks;
    await page.waitForTimeout(40);
  }
  throw new Error(
    `Download condition timed out: ${JSON.stringify(await call("downloads"))}`,
  );
}
async function fixtures() {
  await application.evaluate(({ session, BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.setBackgroundThrottling(false);
    const state = (globalThis.__downloads = {
      modes: {},
      counts: {},
      starts: {},
    });
    for (const sourceId of ["download-fixture", "lightnovelshelf"]) {
      session.fromPartition(`persist:novel-${sourceId}`).fetch = async (
        raw,
      ) => {
        const key = sourceId + new URL(String(raw)).pathname;
        const count = (state.counts[key] = (state.counts[key] || 0) + 1);
        (state.starts[sourceId] ||= []).push(Date.now());
        const mode = state.modes[key];
        if (mode === "rate" || (mode === "rate-once" && count === 1))
          return new Response("[source] 请在 0.01 秒后重试。", { status: 429 });
        if (mode === "wait")
          return new Response("[source] 请在 5 秒后重试。", { status: 429 });
        if (mode === "404")
          return new Response("[network] 请求失败 HTTP 404", { status: 404 });
        if (mode === "permission")
          return new Response("[source] 阅读等级不足，需要达到 Lv.6", {
            status: 403,
          });
        return new Response("已完整下载的正文 " + key);
      };
    }
  });
}
const modes = (values) =>
  application.evaluate((_electron, values) => {
    Object.assign(globalThis.__downloads.modes, values);
  }, values);
const snapshot = () => application.evaluate(() => globalThis.__downloads);
async function importSource(id) {
  const file = path.join(temporary, `${id}.js`);
  await fs.writeFile(file, sourceScript(id));
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
  assert.equal((await call("importFile")).sources[0].id, id);
}
async function files() {
  const root = await call("downloadDirectory");
  return (await fs.readdir(root, { recursive: true })).filter((file) =>
    file.endsWith(".epub"),
  );
}
async function home() {
  // Auto-hidden navigation is inert until an edge gesture or Tab reveals it.
  await page.keyboard.press("Tab");
  await page
    .getByRole("button", { name: "浏览小说", exact: true })
    .first()
    .click({ force: true });
  await page.locator(".novel-source-pills").waitFor();
}
try {
  application = await launch();
  page = await application.firstWindow();
  await page.waitForFunction(() => window.media?.onlineNovels);
  await page
    .locator(".type-library-page, .minimal-empty")
    .first()
    .waitFor({ timeout: 60000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixtures();
  await importSource("download-fixture");
  assert.equal(await call("getDownloadConcurrency"), 1, "默认单章节并行");
  assert.equal(await call("setDownloadConcurrency", 2), 2);
  const ref = { sourceId: "download-fixture", novelId: "1" };
  await modes({
    "download-fixture/1/b": "rate-once",
    "download-fixture/1/c": "404",
  });
  await call("hubSet", "shelf", ref, true);
  await call(
    "saveProgress",
    { ...ref, chapterId: "a" },
    { scroll: 0.4, completed: false },
  );
  await call("enqueue", ref, ["a", "b", "c"]);
  await call("enqueue", ref, ["a", "b", "c"]);
  await waitFor((tasks) => tasks.some((task) => task.retryAt && task.error));
  assert.equal(
    (await call("details", ref)).chapters.find((chapter) => chapter.id === "b")
      .downloaded,
    false,
  );
  let tasks = await waitFor(
    (tasks) =>
      tasks.length === 3 &&
      tasks.every((task) => ["completed", "failed"].includes(task.state)),
  );
  assert.equal(tasks.filter((task) => task.state === "completed").length, 2);
  assert.equal((await files()).length, 2);
  assert.deepEqual(
    (await call("details", ref)).chapters.map((chapter) => chapter.downloaded),
    [true, true, false],
  );
  assert.equal((await snapshot()).counts["download-fixture/1/b"], 2);
  assert.equal((await snapshot()).counts["download-fixture/1/c"], 1);

  // UI must keep the failure visible and permit a global retry.
  await home();
  await page
    .locator('[data-hub-id="download-fixture:1"] .comic-hub-cover')
    .first()
    .click();
  await page
    .locator('[data-hub-id="chapter:c"]')
    .getByText("下载失败", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "补全下载", exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "重试下载 章节 c", exact: true })
      .isEnabled(),
    true,
  );
  await page.screenshot({ path: path.join(artifacts, "partial-details.png") });
  await home();
  await page
    .getByRole("button", { name: /下载队列/ })
    .first()
    .click();
  await page.getByLabel("小说同时下载章节数").selectOption("3");
  assert.equal(await call("getDownloadConcurrency"), 3);
  await page.getByText("1 章失败", { exact: false }).waitFor();
  await page.getByText("查看失败原因", { exact: true }).click();
  await page.getByText(/章节 c：.*404/).waitFor();
  await page.screenshot({ path: path.join(artifacts, "failed-queue.png") });
  await modes({ "download-fixture/1/c": "ok" });
  await page.getByRole("button", { name: /重试全部失败/ }).click();
  await waitFor(
    (tasks) =>
      tasks.length === 3 && tasks.every((task) => task.state === "completed"),
  );
  assert.equal((await files()).length, 3);
  assert.equal(
    (await snapshot()).counts["download-fixture/1/a"],
    1,
    "成功章节不重下",
  );
  assert.equal((await snapshot()).counts["download-fixture/1/c"], 2);
  assert.equal((await call("details", ref)).chapters[0].progress.scroll, 0.4);
  assert.equal(
    (await call("library", "shelf")).some((novel) => novel.novelId === "1"),
    true,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await home();
  await page.getByRole("button", { name: "管理下载", exact: true }).click();
  const novelSort = page.getByLabel("已下载小说排序方式");
  await novelSort.waitFor();
  await novelSort.selectOption("title-desc");
  assert.equal(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("novel:downloads-sort") || "null"),
    ),
    "title-desc",
    "novel library sort selection is persisted",
  );

  // Retry exhaustion is bounded. Permanent errors never auto-retry.
  const second = { ...ref, novelId: "2" };
  await modes({
    "download-fixture/2/a": "rate",
    "download-fixture/2/b": "permission",
  });
  await call("enqueue", second, ["a", "b"]);
  await waitFor(
    (tasks) =>
      tasks.filter((task) => task.novelId === "2").length === 2 &&
      tasks
        .filter((task) => task.novelId === "2")
        .every((task) => task.state === "failed"),
  );
  assert.equal((await snapshot()).counts["download-fixture/2/a"], 4);
  assert.equal((await snapshot()).counts["download-fixture/2/b"], 1);
  await modes({ "download-fixture/2/a": "ok", "download-fixture/2/b": "ok" });
  await call("enqueue", second, ["a", "b"]);
  await waitFor((tasks) =>
    tasks
      .filter((task) => task.novelId === "2")
      .every((task) => task.state === "completed"),
  );

  // A retry timer must not resurrect paused or cancelled work.
  const third = { ...ref, novelId: "3" };
  await modes({ "download-fixture/3/a": "wait" });
  await call("enqueue", third, ["a"]);
  tasks = await waitFor((tasks) =>
    tasks.some((task) => task.novelId === "3" && task.retryAt),
  );
  const paused = tasks.find((task) => task.novelId === "3");
  await call("downloadAction", paused.id, "pause");
  await call("enqueue", third, ["a"]);
  assert.equal(
    (await call("downloads")).find((task) => task.id === paused.id).state,
    "paused",
  );
  await modes({ "download-fixture/3/a": "ok" });
  await call("downloadAction", paused.id, "resume");
  await call("downloadAction", paused.id, "cancel");
  await page.waitForTimeout(5600);
  assert.equal(
    (await call("downloads")).some((task) => task.id === paused.id),
    false,
  );
  assert.equal((await snapshot()).counts["download-fixture/3/a"], 1);

  // Proactive pacing across books and reader requests for existing lightnovelshelf sources.
  await importSource("lightnovelshelf");
  await call("enqueue", { sourceId: "lightnovelshelf", novelId: "4" }, ["a"]);
  await call("enqueue", { sourceId: "lightnovelshelf", novelId: "5" }, ["a"]);
  await call("reader", {
    sourceId: "lightnovelshelf",
    novelId: "6",
    chapterId: "a",
  });
  await waitFor(
    (tasks) =>
      tasks.filter((task) => task.sourceId === "lightnovelshelf").length ===
        2 &&
      tasks
        .filter((task) => task.sourceId === "lightnovelshelf")
        .every((task) => task.state === "completed"),
  );
  const starts = (await snapshot()).starts.lightnovelshelf;
  assert.equal(starts.length, 3);
  for (let index = 1; index < starts.length; index++)
    assert.ok(
      starts[index] - starts[index - 1] >= 5500,
      `章节间隔 ${starts[index] - starts[index - 1]}ms`,
    );

  // Closing during cooldown leaves work paused on restart; no startup redownloads.
  await modes({
    "download-fixture/7/a": "wait",
    "download-fixture/7/b": "404",
  });
  await call("enqueue", { ...ref, novelId: "7" }, ["a", "b"]);
  await waitFor((tasks) =>
    tasks.some((task) => task.novelId === "7" && task.retryAt),
  );
  const beforeRestart = (await files()).length;
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await page.waitForFunction(() => window.media?.onlineNovels);
  assert.equal(await call("getDownloadConcurrency"), 3, "重启保留并行设置");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("novel:downloads-sort")),
    JSON.stringify("title-desc"),
    "novel library sort survives restart",
  );
  await fixtures();
  tasks = await call("downloads");
  assert.ok(
    tasks
      .filter((task) => task.novelId === "7")
      .every((task) => task.state === "paused"),
  );
  assert.equal((await files()).length, beforeRestart);
  assert.equal((await call("details", ref)).chapters[0].progress.scroll, 0.4);
  assert.deepEqual((await snapshot()).counts, {});
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "passed",
      scenarios: [
        "batch files and deduplication",
        "accurate UI and global retry",
        "retry limits and permanent errors",
        "pause and cancellation",
        "adjustable, persisted novel download concurrency",
        "5.5s source pacing shared with reader",
        "offline restart preserves files and progress",
      ],
      artifacts,
    }),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await application?.close();
}
