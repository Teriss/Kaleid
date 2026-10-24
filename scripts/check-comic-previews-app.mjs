import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "@playwright/test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-comic-previews-"));
const artifacts = path.resolve("artifacts/comic-preview-verification");
await fs.mkdir(artifacts, { recursive: true });
const png = (color, width = 60, height = 100) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const blue = await png("blue"), red = await png("red"), cover = await png("green", 80, 120);
const sprite = await sharp({ create: { width: 120, height: 100, channels: 3, background: "red" } })
  .composite([{ input: blue, left: 60, top: 0 }]).png().toBuffer();
const counts = { details: {}, thumbnails: {}, images: {}, episodes: {} };
const increment = (group, key) => counts[group][key] = (counts[group][key] || 0) + 1;
let base, failPage = false, failImage = true;
const staticIds = ["chapters", "static", "both", "neither", "empty-chapters", "empty-previews", "failed-image", "large"];
const pagedIds = ["paged", "loop", "late", "invalid"];
const previewURLs = () => [
  `${base}/image/blue`,
  `${base}/image/sprite@x=0-60&y=0-100`,
  `${base}/image/sprite@x=60-120&y=0-100`,
  `${base}/image/sprite@y=0-50`,
  `${base}/image/sprite@x=200-250`,
  `${base}/image/blue`,
];
function sourceScript(paged) {
  const ids = paged ? pagedIds : staticIds;
  return `class PreviewFixture extends ComicSource {
    name='${paged ? "分页预览测试源" : "静态预览测试源"}';key='preview_${paged ? "paged" : "static"}';version='1.0.0';
    explore=[{title:'${paged ? "分页样本" : "静态样本"}',type:'singlePageWithMultiPart',load:async()=>({'样本':${JSON.stringify(ids)}.map(id=>new Comic({id,title:'样本·'+id,cover:'${base}/image/cover'}))})}];
    comic={
      loadInfo:async(id)=>JSON.parse((await Network.get('${base}/details?id='+id,{'cache-time':'no'})).body),
      loadEp:async(id,ep)=>JSON.parse((await Network.get('${base}/ep?id='+id,{'cache-time':'no'})).body),
      ${paged ? `loadThumbnails:async(id,next)=>{const r=await Network.get('${base}/thumbs?id='+id+'&next='+encodeURIComponent(next===null?'FIRST':next),{'cache-time':'no'});if(r.status!==200)throw Error('Invalid status code: '+r.status);return JSON.parse(r.body)},` : ""}
      onThumbnailLoad:(key)=>({url:key==='opaque-key'?'${base}/image/red':key,headers:{Referer:'${base}/','X-Preview-Fixture':'yes'},onResponse:buffer=>new Uint8Array(buffer).reverse().buffer}),
      onImageLoad:()=>({headers:{Referer:'${base}/','X-Preview-Fixture':'yes'},onResponse:buffer=>new Uint8Array(buffer).reverse().buffer})
    };
  }`;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname.startsWith("/source")) return res.end(sourceScript(url.pathname.includes("paged")));
  if (url.pathname === "/details") {
    const id = url.searchParams.get("id"); increment("details", id);
    const info = { title: `样本·${id}`, cover: `${base}/image/cover`, description: "章节与预览根据源能力独立显示。", tags: { 作者: ["测试作者"], 页数: ["6"] } };
    if (["chapters", "both"].includes(id)) info.chapters = { 正文: { a: "第一章", b: "第二章" } };
    if (id === "empty-chapters") info.chapters = {};
    if (["static", "both"].includes(id)) info.thumbnails = previewURLs();
    if (id === "large") info.thumbnails = Array.from({ length: 60 }, (_, i) => `${base}/image/${i % 2 ? "red" : "blue"}`);
    if (id === "empty-previews") info.thumbnails = [];
    if (id === "failed-image") info.thumbnails = [`${base}/image/retry`];
    if (id === "opaque") info.thumbnails = ["opaque-key", 42];
    res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(info));
  }
  if (url.pathname === "/ep") {
    const id = url.searchParams.get("id"); increment("episodes", id);
    return res.end(JSON.stringify({ images: Array.from({ length: 6 }, (_, i) => `${base}/page/${id}/${i}`) }));
  }
  if (url.pathname === "/thumbs") {
    const id = url.searchParams.get("id"), next = url.searchParams.get("next");
    increment("thumbnails", `${id}:${next}`);
    if (id === "late") await new Promise((resolve) => setTimeout(resolve, 600));
    else await new Promise((resolve) => setTimeout(resolve, 80));
    if (id === "invalid") return res.end(JSON.stringify({ thumbnails: [], next: 42 }));
    if (id === "loop") return res.end(JSON.stringify({ thumbnails: [`${base}/image/red`], next: "loop" }));
    if (failPage && next === "opaque-next") { failPage = false; res.writeHead(210); return res.end("wait"); }
    return res.end(JSON.stringify({ thumbnails: [1, 2, 3].map(() => `${base}/image/${id === "late" ? "red" : "blue"}`), next: next === "FIRST" && id === "paged" ? "opaque-next" : null }));
  }
  if (url.pathname.startsWith("/image/") || url.pathname.startsWith("/page/")) {
    increment("images", url.pathname);
    if (req.headers.referer !== base + "/" || req.headers["x-preview-fixture"] !== "yes") { res.writeHead(403); return res.end(); }
    if (url.pathname === "/image/retry" && failImage) { failImage = false; res.writeHead(503); return res.end(); }
    const data = url.pathname.endsWith("sprite") ? sprite : url.pathname.endsWith("cover") ? cover : url.pathname.endsWith("red") ? red : blue;
    res.setHeader("content-type", "application/octet-stream"); return res.end(Buffer.from(data).reverse());
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;
let app, page;
const errors = [];
async function start() {
  app = await electron.launch({ args: ["out/main/index.js"], env: { ...process.env, MEDIA_BROWSER_TEST_DATA: root } });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.waitForFunction(() => window.media?.onlineComics);
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) { win.webContents.setBackgroundThrottling(false); win.hide(); } });
}
const call = (method, ...args) => page.evaluate(({ method, args }) => window.media.onlineComics[method](...args), { method, args });
const fetchImage = (url) => page.evaluate(async (url) => {
  const r = await fetch(url); if (!r.ok) throw Error(`image ${r.status}`);
  const data = await r.arrayBuffer(), image = await createImageBitmap(new Blob([data]));
  const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  const pixel = [...context.getImageData(0, 0, 1, 1).data]; image.close();
  return { width: canvas.width, height: canvas.height, pixel };
}, url);
async function waitDownload(ref) {
  for (let i = 0; i < 150; i++) {
    const task = (await call("downloads")).find((task) => task.comicId === ref.comicId);
    if (task?.state === "completed") return;
    if (task?.state === "failed") throw Error(task.error);
    await page.waitForTimeout(50);
  }
  throw Error("download timeout");
}
async function settledDetail() {
  await page.locator(".comic-detail-loaded").waitFor();
  await page.locator(".comic-detail-loading").waitFor({ state: "detached" });
  await page.locator(".comic-detail-cover-flight").waitFor({ state: "detached" });
}
async function backToList() {
  await page.locator(".comic-detail-back").click();
  await page.locator(".comic-detail-loaded").waitFor({ state: "detached" });
}
async function openSample(id) {
  await page.getByText(`样本·${id}`, { exact: true }).first().click();
  await settledDetail();
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await page.waitForTimeout(25);
  }
  throw Error("Fixture condition timed out");
}
try {
  await start();
  const staticSource = await call("install", base + "/source-static.js");
  const pagedSource = await call("install", base + "/source-paged.js");
  const ref = (id, paged = false) => ({ sourceId: paged ? pagedSource.id : staticSource.id, comicId: id });
  for (const [id, hasChapters, hasPreview, count] of [
    ["chapters", true, false, 2], ["static", false, true, 1], ["both", true, true, 2],
    ["neither", false, false, 1], ["empty-chapters", true, false, 0], ["empty-previews", false, true, 1],
  ]) {
    const details = await call("details", ref(id));
    assert.equal(details.hasChapters, hasChapters, id);
    assert.equal(Array.isArray(details.thumbnails), hasPreview, id);
    assert.equal(details.hasThumbnailLoader, false);
    assert.equal(details.chapters.length, count);
    if (!hasChapters) assert.equal(details.chapters[0].id, null);
  }
  assert.deepEqual(counts.episodes, {}, "详情与预览元数据不加载正文");
  const opaque = await call("details", ref("opaque"));
  assert.equal(opaque.thumbnails.length, 2, "坏预览不阻止详情、不改变页码");
  assert.equal((await fetchImage(opaque.thumbnails[0])).pixel[0], 255, "源可用缩略图钩子解析非 URL 图片键");
  const details = await call("details", ref("static"));
  const images = await Promise.all(details.thumbnails.map(fetchImage));
  assert.equal(images[0].pixel[2], 255, "onThumbnailLoad 的请求头与响应转换生效");
  assert.deepEqual(images.slice(1, 3).map((image) => [image.width, image.height]), [[60, 100], [60, 100]]);
  assert.equal(images[1].pixel[0], 255); assert.equal(images[2].pixel[2], 255);
  assert.equal(images[3].height, 50); assert.equal(images[4].width, 120);
  assert.equal(counts.images["/image/sprite"], 1, "拼图原图只下载一次");
  const blueRequests = counts.images["/image/blue"];
  await fetchImage(details.thumbnails[0] + "?retry=1");
  assert.equal(counts.images["/image/blue"], blueRequests + 1, "单图重试重新获取原图而非复用坏缓存");
  await call("enqueue", ref("static"), [null]); await waitDownload(ref("static"));
  assert.equal((await fetchImage(details.thumbnails[0])).pixel[2], 255, "已下载封面不会覆盖预览");

  const pagedRef = ref("paged", true);
  const pd = await call("details", pagedRef);
  assert.equal(pd.hasThumbnailLoader, true);
  const [first, shared] = await Promise.all([call("thumbnails", pagedRef), call("thumbnails", pagedRef)]);
  assert.deepEqual(first, shared); assert.equal(counts.thumbnails["paged:FIRST"], 1);
  assert.equal(first.next, "opaque-next");
  failPage = true;
  await assert.rejects(call("thumbnails", pagedRef, first.next), /210/);
  assert.equal((await call("thumbnails", pagedRef, first.next)).next, null);
  await call("thumbnails", ref("loop", true));
  await assert.rejects(call("thumbnails", ref("loop", true), "loop"), /重复/);
  await assert.rejects(call("thumbnails", ref("invalid", true)), /游标/);

  // Simulate a pre-upgrade snapshot without touching chapter/progress identities.
  await app.close(); app = undefined;
  const db = new DatabaseSync(path.join(root, "comic-online.sqlite"));
  const old = db.prepare("SELECT id,value FROM records WHERE kind='comic'").all().find((row) => JSON.parse(row.value).ref.comicId === "static");
  const record = JSON.parse(old.value); delete record.details.hasChapters; delete record.details.hasThumbnailLoader; delete record.details.thumbnails;
  db.prepare("UPDATE records SET value=? WHERE kind='comic' AND id=?").run(JSON.stringify(record), old.id); db.close();
  await start();
  const before = counts.details.static;
  await call("enable", staticSource.id, false);
  const legacyOffline = await call("details", ref("static"));
  assert.equal(legacyOffline.hasChapters, false);
  assert.equal(counts.details.static, before, "停用的旧快照仍可离线使用");
  await call("enable", staticSource.id, true);
  assert.equal((await call("details", ref("static"))).thumbnails.length, 6);
  assert.equal(counts.details.static, before + 1, "旧快照补取预览能力");
  assert.equal((await call("pages", { ...ref("static"), chapterId: null })).length, 6, "原下载章节身份保持兼容");
  console.log("API checks passed: capabilities, sprites, headers, paging, downloads and legacy snapshots");

  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.showInactive(); });
  await page.getByRole("button", { name: "浏览漫画", exact: true }).evaluate((button) => button.click());
  await page.locator(".comic-home").waitFor();
  await page.locator(".comic-source-pills").getByRole("button", { name: "静态预览测试源", exact: true }).click();
  await page.getByText("样本·static", { exact: true }).first().click();
  await page.locator(".comic-detail-preview-section").waitFor();
  await settledDetail();
  assert.equal(await page.locator(".comic-detail-chapter-section").count(), 0);
  assert.equal(await page.locator(".comic-preview-tile").count(), 6);
  await page.waitForFunction(() => [...document.querySelectorAll(".comic-preview-image img")].every((image) => image.complete && image.naturalWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".comic-detail-preview-section").screenshot({ path: path.join(artifacts, "static-dark.png") });
  await call("saveProgress", { ...ref("static"), chapterId: null }, { page: 5, comicPageId: "body:5", comicOffset: .5 });
  await page.getByRole("button", { name: "从第 3 页开始阅读", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('input[aria-label="漫画页码"]')?.value === "3");
  await page.locator(".comic-image.ready").first().waitFor();
  await page.screenshot({ path: path.join(artifacts, "reader-jump.png") });
  await page.getByRole("button", { name: "返回漫画详情", exact: true }).click();
  await page.locator(".comic-detail-preview-section").waitFor();
  await page.getByRole("button", { name: "继续阅读", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="漫画页码"]')?.value === "3");
  await page.getByRole("button", { name: "返回漫画详情", exact: true }).click();
  await backToList();
  await openSample("both");
  assert.equal(await page.locator(".comic-detail-chapter-section").count(), 1);
  await page.screenshot({ path: path.join(artifacts, "both-dark.png") });
  await page.evaluate(async () => { const settings = await window.media.settings(); await window.media.saveSettings({ ...settings, theme: "light" }); });
  await page.setViewportSize({ width: 430, height: 850 });
  await page.locator(".comic-detail-preview-section").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, "both-light-narrow.png") });
  assert.equal(await page.evaluate(() => document.querySelector(".online-detail").scrollWidth > document.querySelector(".online-detail").clientWidth + 1), false);
  for (const [id, chapterSection, previewSection] of [["chapters", 1, 0], ["neither", 0, 0], ["empty-chapters", 1, 0], ["empty-previews", 0, 1]]) {
    await backToList(); await openSample(id);
    assert.equal(await page.locator(".comic-detail-chapter-section").count(), chapterSection, id);
    assert.equal(await page.locator(".comic-detail-preview-section").count(), previewSection, id);
    if (id === "empty-chapters") assert.equal(await page.getByText("暂无章节。", { exact: true }).count(), 1);
    if (id === "empty-previews") assert.equal(await page.getByText("漫画源暂无预览图片。", { exact: true }).count(), 1);
  }
  await backToList(); await openSample("failed-image");
  await page.locator(".comic-detail-preview-section").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "重试第 1 页预览图" }).waitFor();
  await page.getByRole("button", { name: "重试第 1 页预览图" }).click();
  await page.waitForFunction(() => document.querySelector(".comic-preview-image img")?.naturalWidth > 0);
  assert.equal(counts.images["/image/retry"], 2);

  await backToList(); await openSample("large");
  for (const mode of ["single", "double", "scroll"]) {
    await call("preferences", ref("large"), { mode });
    await page.getByRole("button", { name: "从第 60 页开始阅读", exact: true }).scrollIntoViewIfNeeded();
    const oldScroll = await page.locator(".online-comics").evaluate((element) => element.scrollTop);
    await page.getByRole("button", { name: "从第 60 页开始阅读", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="漫画页码"]')?.value === "6");
    await page.getByRole("button", { name: "漫画阅读设置", exact: true }).click();
    await page.waitForFunction((mode) => document.querySelector('select[aria-label="漫画阅读模式"]')?.value === mode, mode);
    await page.getByRole("button", { name: "漫画阅读设置", exact: true }).click();
    await page.getByRole("button", { name: "返回漫画详情", exact: true }).click();
    await settledDetail();
    const returnedScroll = await page.locator(".online-comics").evaluate((element) => element.scrollTop);
    assert.ok(Math.abs(returnedScroll - oldScroll) < 4, "返回详情恢复预览滚动位置");
  }

  await backToList();
  await page.getByRole("tab", { name: "分页样本", exact: true }).click();
  failPage = true;
  const pageRequestsBefore = counts.thumbnails["paged:FIRST"];
  await openSample("paged");
  await page.locator(".comic-detail-preview-section").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "重试预览", exact: true }).waitFor();
  assert.equal(await page.locator(".comic-preview-tile").count(), 3, "分页失败保留首批预览");
  await page.getByRole("button", { name: "重试预览", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".comic-preview-tile").length === 6);
  assert.equal(counts.thumbnails["paged:FIRST"], pageRequestsBefore + 1);
  const accepted = JSON.stringify(counts.thumbnails);
  await page.getByRole("button", { name: "从第 2 页开始阅读", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="漫画页码"]')?.value === "2");
  await page.getByRole("button", { name: "返回漫画详情", exact: true }).click();
  await settledDetail();
  assert.equal(await page.locator(".comic-preview-tile").count(), 6);
  assert.equal(JSON.stringify(counts.thumbnails), accepted, "返回详情复用已接受的分页");
  await page.getByRole("button", { name: "刷新漫画详情", exact: true }).click();
  await until(() => counts.thumbnails["paged:FIRST"] === pageRequestsBefore + 2);
  await page.waitForFunction(() => document.querySelectorAll(".comic-preview-tile").length === 3);
  await page.locator(".comic-preview-footer").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll(".comic-preview-tile").length === 6);
  await page.waitForFunction(() => !document.querySelector(".comic-preview-footer [role=status]"));
  assert.equal(counts.thumbnails["paged:FIRST"], pageRequestsBefore + 2, "刷新详情重置预览游标");
  await page.locator(".comic-detail-preview-section").screenshot({ path: path.join(artifacts, "paged-light-narrow.png") });

  await backToList(); await openSample("loop");
  await page.locator(".comic-detail-preview-section").scrollIntoViewIfNeeded();
  await page.getByText(/重复的预览分页游标/).waitFor();
  assert.equal(await page.locator(".comic-preview-tile").count(), 1);
  await backToList();
  await page.getByText("样本·late", { exact: true }).first().click();
  await page.locator(".comic-preview-footer [role=status]").waitFor();
  await backToList(); await openSample("paged");
  await page.waitForTimeout(650);
  assert.equal(await page.locator(".comic-detail-loaded h1").innerText(), "样本·paged");
  assert.equal(await page.locator(".comic-preview-tile").count(), 6, "迟到预览不能污染新作品");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", counts, screenshots: artifacts }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  server.close();
}
