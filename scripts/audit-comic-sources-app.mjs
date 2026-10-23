import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { _electron as electron } from "@playwright/test";
const baseline = JSON.parse(
  await fs.readFile("scripts/comic-sources-baseline.json", "utf8"),
);
const selectedFile = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const selectedSources = selectedFile
  ? baseline.sources.filter((source) => source.file === selectedFile)
  : baseline.sources;
if (selectedFile && selectedSources.length === 0)
  throw Error(`Unknown baseline source: ${selectedFile}`);
const settingArgument = process.argv.find((arg) => arg.startsWith("--setting="))?.slice(10);
const settingSplit = settingArgument?.indexOf("=") ?? -1;
const setting = settingSplit > 0
  ? { key: settingArgument.slice(0, settingSplit), value: settingArgument.slice(settingSplit + 1) }
  : undefined;
if (settingArgument && !setting)
  throw Error("Use --setting=key=value");
const reportPath = path.join(
  "artifacts/comic-source-audit",
  selectedFile
    ? `${selectedFile}.${setting ? `${setting.key}-${setting.value}.` : ""}electron-live-report.json`
    : "electron-live-report.json",
);
const scripts = new Map();
for (const source of selectedSources) {
  const script = await fs.readFile(
    path.join("artifacts/comic-source-audit", source.file),
    "utf8",
  );
  if (createHash("sha256").update(script).digest("hex") !== source.sha256)
    throw Error("Snapshot hash mismatch: " + source.file);
  scripts.set("/" + source.file, script);
}
const server = http.createServer((req, res) => {
  const script = scripts.get(req.url);
  res.writeHead(script ? 200 : 404, { "Content-Type": "text/javascript" });
  res.end(script || "");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const userData = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-comic-live-"));
let app;
const report = {
  checkedAt: new Date().toISOString(),
  transport:
    "Actual Electron Session and utility process, fixed local source snapshots; no private accounts; each stage limited to 20 seconds",
  repository: baseline.repository,
  sources: [],
};
try {
  app = await electron.launch({
    args: ["out/main/index.js"],
    env: { ...process.env, MEDIA_BROWSER_TEST_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.media?.onlineComics);
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.hide();
    }
  });
  async function call(method, ...args) {
    let timer;
    try {
      return await Promise.race([
        page.evaluate(
          ({ method, args }) => window.media.onlineComics[method](...args),
          { method, args },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("AUDIT_STAGE_TIMEOUT")), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let cursor = 0;
  async function worker() {
  while (cursor < selectedSources.length) {
      const entry = selectedSources[cursor++];
      const result = {
        name: entry.name,
        file: entry.file,
        sha256: entry.sha256,
      };
      let source;
      let stage = "install";
      try {
        source = await call(
          "install",
          `http://127.0.0.1:${server.address().port}/${entry.file}`,
        );
        result.install = "passed";
        result.version = source.version;
        if (setting) {
          await call("settings", source.id, { [setting.key]: setting.value });
          result.testedSetting = setting;
        }
        stage = "browse";
        const listing = source.explore.length
          ? await call("explore", source.id, 0, 1)
          : await call(
              "search",
              source.id,
              "",
              source.searchOptions.map(
                (o) =>
                  o.default ??
                  (typeof o.options?.[0] === "string"
                    ? o.options[0].split("-")[0]
                    : o.options?.[0]?.value) ??
                  "",
              ),
              1,
            );
        result.browse = "passed";
        result.comicCount = listing.comics.length;
        if (!listing.comics.length) {
          result.status = "empty-browse";
          continue;
        }
        const ref = { sourceId: source.id, comicId: listing.comics[0].comicId };
        stage = "details";
        const details = await call("details", ref, true);
        result.details = "passed";
        stage = "chapter";
        const pages = await call("pages", {
          ...ref,
          chapterId: details.chapters[0]?.id ?? null,
        });
        result.chapter = "passed";
        result.pageCount = pages.length;
        if (!pages.length) throw Error("No pages");
        stage = "image";
        let timer;
        let image;
        try {
          image = await Promise.race([
            page.evaluate(async (url) => {
              const r = await fetch(url);
              return {
                status: r.status,
                mime: r.headers.get("content-type"),
                bytes: (await r.arrayBuffer()).byteLength,
              };
            }, pages[0].url),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("AUDIT_STAGE_TIMEOUT")),
                20000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        Object.assign(result, {
          imageStatus: image.status,
          imageBytes: image.bytes,
          imageMime: image.mime,
        });
        if (image.status !== 200 || !image.bytes)
          throw Error("Image HTTP " + image.status);
        result.image = "passed";
        result.status = "public-first-chapter-passed";
      } catch (error) {
        result.failedStage = stage;
        result.error = String(error);
        result.status =
          /\b401\b|登录|log(?:ged)? ?in|auth|cookie|需要登录/i.test(
            String(error),
          )
            ? "account-required"
            : /\b403\b|Cloudflare|challenge|captcha|访问验证/i.test(
                  String(error),
                )
              ? "site-denied-or-challenge"
              : /unexpected token:\s*['"]</i.test(String(error))
                ? "site-html-or-challenge"
                : /\b5\d\d\b/.test(String(error))
                  ? "upstream-error"
                  : /\b400\b|cannot read property|no pages/i.test(String(error))
                    ? "source-or-contract-failure"
              : /fetch|TIMEOUT|network|ERR_|timeout/i.test(String(error))
                ? "network-or-timeout"
                : "unclassified-failure";
      } finally {
        if (source) {
          try {
            await call("enable", source.id, false);
            const record = (await call("sources")).find(
              (s) => s.id === source.id,
            );
            if (record?.error?.includes("释放异常"))
              result.engineTeardownWarning = record.error;
            await call("uninstall", source.id);
          } catch (error) {
            result.cleanupError = String(error);
          }
        }
        report.sources.push(result);
        console.log(JSON.stringify(result));
        await fs.writeFile(
          reportPath,
          JSON.stringify(report, null, 2) + "\n",
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, selectedSources.length) }, worker));
  report.sources.sort((a, b) => a.file.localeCompare(b.file));
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      total: report.sources.length,
      installed: report.sources.filter((s) => s.install === "passed").length,
      images: report.sources.filter((s) => s.image === "passed").length,
      userData,
    }),
  );
} finally {
  if (app) await app.close();
  server.close();
}
