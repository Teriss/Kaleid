import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-novel-requests-"));
const app = await electron.launch({
  args: ["out/main/index.js"],
  env: { ...process.env, MEDIA_BROWSER_TEST_DATA: root },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.media?.onlineNovels);
  await app.evaluate(({ session, BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.hide();
    }
    const fixture = globalThis.__novelRequests = { requests: {}, fail: false };
    session.fromPartition("persist:novel-bilinovel").fetch = async (raw) => {
      const url = new URL(String(raw));
      fixture.requests[url.pathname] = (fixture.requests[url.pathname] || 0) + 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (fixture.fail) return new Response("fixture unavailable", { status: 503 });
      const id = url.pathname.match(/\/novel\/(\d+)/)?.[1];
      if (url.pathname.endsWith("/catalog"))
        return new Response(`<h2>第一卷</h2><a href="/novel/${id}/100.html">第一章</a><a href="/novel/${id}/101.html">第二章</a>`);
      if (/^\/novel\/\d+\/\d+\.html$/.test(url.pathname))
        return new Response('<h1>第一章</h1><div id="TextContent"><p>用于测试首次打开阅读页时，作品详情请求是否正确合并。</p></div>');
      return new Response(`<h1>并发请求测试小说</h1><meta property="og:novel:author" content="测试作者">`);
    };
  });
  const call = (method, ...args) => page.evaluate(
    ({ method, args }) => window.media.onlineNovels[method](...args), { method, args },
  );
  const counts = () => app.evaluate(() => globalThis.__novelRequests.requests);
  const ref = { sourceId: "bilinovel", novelId: "42" };
  const chapter = { ...ref, chapterId: "100" };
  const [details, reader] = await Promise.all([
    call("details", ref, true),
    call("reader", chapter),
  ]);
  assert.equal(details.chapters.length, 2);
  assert.equal(reader.item.onlineNovelRef.chapterId, "100");
  let requests = await counts();
  assert.equal(requests["/novel/42.html"], 1, "首次目录与阅读请求共享作品详情");
  assert.equal(requests["/novel/42/catalog"], 1, "首次目录只请求一次");
  assert.equal(requests["/novel/42/100.html"], 1);

  await Promise.all([call("reader", chapter), call("reader", chapter)]);
  assert.deepEqual(await counts(), requests, "已保存的详情与章节直接复用");
  await Promise.all(Array.from({ length: 3 }, () => call("details", ref, true)));
  requests = await counts();
  assert.equal(requests["/novel/42.html"], 2, "并发手动刷新合并为一次新请求");

  await app.evaluate(() => { globalThis.__novelRequests.fail = true; });
  const failed = await Promise.all([call("details", ref, true), call("details", ref, true)]);
  assert.ok(failed.every((value) => value.offline && /503/.test(value.refreshError)));
  assert.equal((await counts())["/novel/42.html"], 3, "刷新失败共享错误并保留已保存目录");
  const missing = { sourceId: "bilinovel", novelId: "43" };
  const rejected = await Promise.allSettled([call("details", missing), call("details", missing)]);
  assert.ok(rejected.every((result) => result.status === "rejected"));
  assert.equal((await counts())["/novel/43.html"], 1);
  await app.evaluate(() => { globalThis.__novelRequests.fail = false; });
  assert.equal((await call("details", missing)).chapters.length, 2);
  assert.equal((await counts())["/novel/43.html"], 2, "失败后能够发起新请求重试");
  assert.equal((await call("details", ref, true)).chapters.length, 2);
  assert.equal((await counts())["/novel/42.html"], 4);
  console.log(JSON.stringify({ result: "passed", requests: await counts() }));
} finally {
  await app.close();
}
