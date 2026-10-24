import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { _electron as electron } from "@playwright/test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-comic-info-"));
const infoRequests = new Map();
let bootstrapRequests = 0;
let discoveryRequests = 0;
let obsoleteRequests = 0;
let forbidDuplicates = true;
let failNext = false;
let base;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname === "/source.js") {
    res.end(`class InfoFixture extends ComicSource {
      name='详情复用验收';key='comic_info_fixture';version='1.0.0';
      settings={base_url:{type:'input',default:'${base}/obsolete'}};
      init(){this.refreshApi();}
      async refreshApi(){
        const response=await fetch('${base}/bootstrap',{headers:{'cache-time':'no'}});
        const discovery=await fetch((await response.json()).next,{headers:{'cache-time':'no'}});
        this.settings.base_url=(await discovery.json()).url;
      }
      comic={
        loadInfo:async(id)=>{
          const response=await Network.get(this.loadSetting('base_url')+'/info?id='+id,{'cache-time':'no'});
          if(response.status!==200)throw Error('Invalid status code: '+response.status);
          this.currentComic=id;
          return new ComicDetails({title:id,chapters:new Map([['a','第一章'],['b','第二章']])});
        },
        loadEp:async(id,ep)=>{
          if(this.currentComic!==id)throw Error('详情未初始化或初始化了错误的作品');
          return {images:['${base}/'+id+'/'+ep+'.png']};
        }
      };
    }`);
    return;
  }
  if (url.pathname === "/bootstrap") {
    bootstrapRequests++;
    await new Promise((resolve) => setTimeout(resolve, 150));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ next: base + "/api-address" }));
    return;
  }
  if (url.pathname === "/api-address") {
    discoveryRequests++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: base + "/current" }));
    return;
  }
  if (url.pathname === "/obsolete/info") {
    obsoleteRequests++;
    res.writeHead(210).end('{"message":"Please update your client"}');
    return;
  }
  if (url.pathname === "/current/info") {
    const id = url.searchParams.get("id");
    const count = (infoRequests.get(id) || 0) + 1;
    infoRequests.set(id, count);
    // Hold the request open so the directory and reader overlap reliably.
    await new Promise((resolve) => setTimeout(resolve, id === "slow" ? 250 : 100));
    const reject = failNext || (forbidDuplicates && count > 1);
    failNext = false;
    res.writeHead(reject ? 210 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: reject ? "Expected available in 40 seconds" : "ok" }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;
let app;
let page;
async function start() {
  app = await electron.launch({
    args: ["out/main/index.js"],
    env: { ...process.env, MEDIA_BROWSER_TEST_DATA: root },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.media?.onlineComics);
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.hide();
    }
  });
}
function call(method, ...args) {
  return page.evaluate(
    ({ method, args }) => window.media.onlineComics[method](...args),
    { method, args },
  );
}
try {
  await start();
  const source = await call("install", base + "/source.js");
  const ref = { sourceId: source.id, comicId: "limited" };
  const chapter = { ...ref, chapterId: "a" };
  const [details, pages] = await Promise.all([
    call("details", ref),
    call("pages", chapter),
  ]);
  assert.equal(details.chapters.length, 2);
  assert.equal(pages.length, 1);
  assert.equal(infoRequests.get("limited"), 1, "目录与阅读器共享正在加载的详情");
  await call("pages", { ...chapter, chapterId: "b" });
  await call("pages", chapter);
  assert.equal(infoRequests.get("limited"), 1, "切章与重新加载不重复请求详情");

  forbidDuplicates = false;
  await call("details", ref, true);
  assert.equal(infoRequests.get("limited"), 2, "显式刷新仍请求最新详情");
  await call("enable", source.id, false);
  await call("enable", source.id, true);
  await call("pages", chapter);
  assert.equal(infoRequests.get("limited"), 3, "新源实例重新初始化作品上下文");
  await call("pages", { ...chapter, comicId: "other" });
  assert.equal(infoRequests.get("other"), 1);
  await call("pages", chapter);
  assert.equal(infoRequests.get("limited"), 4, "切回作品恢复源实例所需的上下文");

  failNext = true;
  const retry = { ...chapter, comicId: "retry" };
  await assert.rejects(call("pages", retry), /210/);
  assert.equal((await call("pages", retry)).length, 1);
  assert.equal(infoRequests.get("retry"), 2, "失败请求不会永久缓存，允许重试");
  await Promise.all([
    call("details", { ...ref, comicId: "slow" }),
    call("details", { ...ref, comicId: "fast" }),
  ]);
  assert.equal((await call("pages", { ...chapter, comicId: "fast" })).length, 1);
  assert.equal(infoRequests.get("fast"), 2, "并发详情完成顺序变化后恢复正确作品上下文");
  await app.close();
  app = undefined;
  await start();
  const [restoredPages, context] = await Promise.all([
    call("pages", chapter),
    call("context", chapter),
  ]);
  assert.equal(restoredPages.length, 1);
  assert.equal(context.chapters.length, 2);
  assert.equal(infoRequests.get("limited"), 5, "重启后从持久详情打开仍初始化源上下文");
  assert.equal(obsoleteRequests, 0, "首次进入阅读器必须等待源异步更新 API 地址");
  assert.equal(bootstrapRequests, 3, "源首次使用、启用和重启均完成异步初始化");
  assert.equal(discoveryRequests, 3, "初始化等待后续 API 发现请求完成");
  console.log(JSON.stringify({ result: "passed", bootstrapRequests, discoveryRequests, obsoleteRequests, infoRequests: Object.fromEntries(infoRequests) }));
} finally {
  if (app) await app.close();
  server.close();
}
