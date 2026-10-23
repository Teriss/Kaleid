import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { SourceRuntime } from "../src/main/onlineComics/runtime.ts";
import { sourceImage } from "../src/main/onlineComics/image.ts";
import sharp from "sharp";
import { comicSections } from "../src/main/onlineComics/normalize.ts";
const directory = path.resolve("artifacts/comic-source-audit");
await fs.mkdir(directory, { recursive: true });
const init = await fs.readFile("vendor/venera/init.js", "utf8");
const base = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/";
const live = process.argv.includes("--live");
async function read(url) {
  let error;
  for (let n = 0; n < 3; n++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      error = e;
    }
  }
  throw error;
}
let index = JSON.parse(await read(base + "index.json"));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
if (only) index = index.filter((e) => e.fileName === only);
const report = {
  repository: base + "index.json",
  checkedAt: new Date().toISOString(),
  live,
  transport:
    "Node fetch without login accounts; image transforms use the application pipeline",
  sources: [],
};
let cursor = 0;
async function worker() {
  while (cursor < index.length) {
    const entry = index[cursor++];
    let instance;
    const result = {
      name: entry.name,
      file: entry.fileName,
      indexVersion: entry.version,
    };
    try {
      const file = path.join(directory, entry.fileName);
      let script;
      try {
        script = await fs.readFile(file, "utf8");
      } catch {
        script = await read(base + entry.fileName);
        await fs.writeFile(file, script);
      }
      result.sha256 = crypto.createHash("sha256").update(script).digest("hex");
      instance = new SourceRuntime(
        init,
        { data: {}, settings: {}, cookies: [], logged: false },
        async (m) => {
          if (m.method === "UI" || m.method === "persist") return null;
          if (m.method === "cookie") return [];
          if (m.method !== "http")
            throw Error("Unsupported host method: " + m.method);
          if (!live) throw Error("NETWORK_REQUIRED");
          const headers = { ...m.headers };
          for (const key of Object.keys(headers))
            if (
              /^(host|content-length|accept-encoding|connection|http_client|prevent-parallel|cache-time)$/i.test(
                key,
              )
            )
              delete headers[key];
          const response = await fetch(m.url, {
            method: m.http_method || "GET",
            headers,
            body: ["GET", "HEAD"].includes(m.http_method)
              ? undefined
              : typeof m.data === "object" && !(m.data instanceof ArrayBuffer)
                ? JSON.stringify(m.data)
                : m.data,
            signal: AbortSignal.timeout(18000),
          });
          const data = await response.arrayBuffer();
          if (process.argv.includes("--capture")) {
            await fs.writeFile(
              path.join(
                directory,
                entry.fileName +
                  "." +
                  crypto
                    .createHash("sha256")
                    .update(m.url)
                    .digest("hex")
                    .slice(0, 12) +
                  ".response.json",
              ),
              JSON.stringify({
                url: m.url,
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: new TextDecoder().decode(data),
              }),
            );
          }
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: m.bytes ? data : new TextDecoder().decode(data),
            cookies: [],
          };
        },
      );
      const metadata = await instance.open(script);
      result.version = metadata.version;
      result.capabilities = metadata.capabilities;
      result.parse = "passed";
      result.categoryShape = metadata.categories;
      result.searchOptions = metadata.searchOptions;
      result.settings = metadata.settings;
      try {
        await instance.initialize();
        result.initialization = "passed";
      } catch (e) {
        result.initialization = String(e).includes("NETWORK_REQUIRED")
          ? "requires-network"
          : "failed";
        result.initializationError = String(e);
      }
      if (live) {
        let data;
        try {
          if (metadata.explore.length) {
            const numbered = await instance.evaluate(
              "typeof __source.explore[0].load==='function'",
            );
            data = await instance.evaluate(
              `__source.explore[0].${numbered ? "load" : "loadNext"}(${numbered ? (["multiPartPage", "singlePageWithMultiPart"].includes(metadata.explore[0].type) ? "null" : metadata.explore[0].type === "mixed" ? "0" : "1") : "null"})`,
            );
          } else if (metadata.capabilities.search) {
            data = await instance.call(
              (await instance.has("search.load"))
                ? "search.load"
                : "search.loadNext",
              [
                "",
                metadata.searchOptions.map(
                  (x) => x.default ?? (x.options?.[0]?.split?.("-")?.[0] || ""),
                ),
                (await instance.has("search.load")) ? 1 : null,
              ],
            );
          } else throw Error("No public browse entry");
          const comics = comicSections(data).flatMap(
            (section) => section.comics,
          );
          result.browse = "passed";
          result.comicCount = comics.length;
          if (comics[0]) {
            const details = await instance.call("comic.loadInfo", [
              String(comics[0].id),
            ]);
            result.details = "passed";
            const entries = (v) => v?.$map || Object.entries(v || {});
            let chapters = entries(details.chapters);
            let first = chapters[0];
            if (first && typeof first[1] === "object")
              first = entries(first[1])[0];
            const pages = await instance.call("comic.loadEp", [
              String(comics[0].id),
              first?.[0] ?? null,
            ]);
            if (!Array.isArray(pages?.images) || !pages.images.length)
              throw Error("No chapter images");
            result.chapter = "passed";
            result.imageCount = pages.images.length;
            try {
              const bytes = await sourceImage(instance, {
                url: pages.images[0],
                comicId: String(comics[0].id),
                chapterId: first?.[0] ?? null,
                thumbnail: false,
                priority: 0,
              });
              const metadata = await sharp(bytes, {
                animated: true,
              }).metadata();
              result.image = "passed";
              result.imageFormat = metadata.format;
              result.imageBytes = bytes.length;
            } catch (error) {
              result.image = "failed";
              result.imageError = String(error);
            }
          }
        } catch (e) {
          result.liveError = String(e);
          result.liveStatus =
            /\b401\b|登录|log(?:ged)? ?in|auth|token|账号/i.test(String(e))
              ? "account-required"
              : /\b403\b|cloudflare|challenge|captcha|unexpected token: '<'/i.test(
                    String(e),
                  )
                ? "site-denied-or-challenge"
                : /fetch|Timeout|NETWORK|ECONN|network/i.test(String(e))
                  ? "network-failed"
                  : "source-or-contract-failed";
        }
      }
    } catch (e) {
      result.parse = "failed";
      result.error = String(e);
    } finally {
      if (instance) {
        console.log(
          JSON.stringify({
            disposing: result.name,
            stage:
              result.liveError ||
              result.imageError ||
              result.chapter ||
              result.browse,
          }),
        );
        instance.dispose();
        if (instance.disposalWarning)
          result.engineTeardownWarning = instance.disposalWarning;
      }
    }
    report.sources.push(result);
    console.log(
      JSON.stringify({
        name: result.name,
        parse: result.parse,
        initialization: result.initialization,
        live: result.chapter || result.liveStatus || result.browse,
        error: result.error || result.initializationError || result.liveError,
      }),
    );
  }
}
await Promise.all(Array.from({ length: live ? 3 : 4 }, worker));
report.sources.sort((a, b) => a.file.localeCompare(b.file));
await fs.writeFile(
  path.join(
    directory,
    only
      ? `${only}.${live ? "live" : "parse"}-report.json`
      : live
        ? "live-report.json"
        : "report.json",
  ),
  JSON.stringify(report, null, 2) + "\n",
);
if (!live && !only) {
  const manifest = {
    repository: report.repository,
    sources: report.sources.map(
      ({ name, file, indexVersion, version, sha256 }) => ({
        name,
        file,
        indexVersion,
        version,
        sha256,
      }),
    ),
  };
  await fs.writeFile(
    "scripts/comic-sources-baseline.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    total: report.sources.length,
    parsed: report.sources.filter((s) => s.parse === "passed").length,
    report: path.join(directory, live ? "live-report.json" : "report.json"),
  }),
);
if (report.sources.some((s) => s.parse !== "passed")) process.exitCode = 1;
