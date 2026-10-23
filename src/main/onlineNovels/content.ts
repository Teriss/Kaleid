import * as cheerio from "cheerio";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";

export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export interface ChapterContent {
  title: string;
  html: string;
  base: string;
  font?: string;
  nextPage?: string;
}
export interface ChapterBundle {
  data: Uint8Array;
  version: number;
  requiredFont: boolean;
}
export function checkResponse(status: number, text: string) {
  if (
    /cf-chl-|challenge-platform|Attention Required!|Just a moment\.\.\./i.test(
      text,
    )
  )
    throw new Error(
      "[verification] 站点需要浏览器验证，请打开源的网页登录窗口后重试",
    );
  if (status === 401) throw new Error("[auth-required] 登录已失效，请重新登录");
  if (status === 402) throw new Error("[permission] 站点权限或金币不足");
  if (status === 403)
    throw new Error(
      "[permission] 站点拒绝访问，请检查账号权限或完成网页登录验证",
    );
  if (status === 429) throw new Error("[rate-limit] 请求过于频繁，请稍后重试");
  if (status < 200 || status >= 300)
    throw new Error(`[network] 请求失败 HTTP ${status}`);
}
export function safeRemote(value: string, base: string) {
  const url = new URL(value, base);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    /^(localhost|127\.|0\.|\[?::1\]?$|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
      url.hostname,
    )
  )
    throw new Error("[parse] 非法资源地址");
  return url.href;
}
/** No executable site content enters the EPUB. Resources are embedded and same-document anchors survive. */
export async function chapterEpub(
  content: ChapterContent,
  load: (url: string) => Promise<{ data: Uint8Array; type: string }>,
): Promise<ChapterBundle> {
  const $ = cheerio.load(content.html, { xml: false });
  $(
    "script,iframe,object,embed,form,input,button,video,audio,source,link,style,base,meta",
  ).remove();
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
  };
  const manifest: string[] = [];
  const assets = new Map<string, Promise<string>>();
  const asset = (raw: string) => {
    const url = safeRemote(raw, content.base);
    let job = assets.get(url);
    if (!job) {
      job = (async () => {
        const { data, type } = await load(url);
        if (
          !/^(image\/(png|jpeg|gif|webp|avif)|font\/(woff2?|ttf|otf)|application\/(font-woff|x-font-ttf|vnd.ms-opentype))$/i.test(
            type,
          )
        )
          throw new Error("[parse] 插图或字体返回了不支持的内容类型");
        const name = `assets/${hash(url).slice(0, 24)}.${type.startsWith("font/") ? type.split("/")[1] : "bin"}`;
        files[`OEBPS/${name}`] = data;
        manifest.push(
          `<item id="a${manifest.length}" href="${name}" media-type="${xml(type)}"/>`,
        );
        return name;
      })();
      assets.set(url, job);
    }
    return job;
  };
  const images = $("img").toArray();
  // Sequential resource loads keep source request pressure bounded.
  for (const image of images) {
    const el = $(image),
      raw = el.attr("data-src") || el.attr("data-original") || el.attr("src");
    if (!raw) {
      el.remove();
      continue;
    }
    el.attr("src", await asset(raw));
  }
  $("*").each((_index, node) => {
    const el = $(node);
    for (const key of Object.keys(el.attr() || {}))
      if (
        !new Set([
          "id",
          "class",
          "title",
          "alt",
          "src",
          "href",
          "colspan",
          "rowspan",
          "epub:type",
        ]).has(key)
      )
        el.removeAttr(key);
    if (el.attr("href") && !el.attr("href")!.startsWith("#"))
      el.removeAttr("href");
    if (node.type === "tag" && node.name !== "img") el.removeAttr("src");
  });
  const font = content.font ? await asset(content.font) : undefined;
  const css = `html,body{background:transparent}img{max-width:100%;height:auto}body{overflow-wrap:anywhere}ruby{ruby-align:center}${font ? `@font-face{font-family:novel-source;src:url("${font}")}body,body *{font-family:novel-source!important}` : ""}`;
  // Cheerio's XML serializer closes void elements and escapes bare ampersands.
  const body = $("body")
    .contents()
    .toArray()
    .map((node) => $.xml(node))
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${xml(content.title)}</title><style>${css}</style></head><body>${body}</body></html>`;
  files["META-INF/container.xml"] = strToU8(
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  files["OEBPS/chapter.xhtml"] = strToU8(document);
  files["OEBPS/nav.xhtml"] = strToU8(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">${xml(content.title)}</a></li></ol></nav></body></html>`,
  );
  files["OEBPS/package.opf"] = strToU8(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${hash(content.base)}</dc:identifier><dc:title>${xml(content.title)}</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join("")}</manifest><spine><itemref idref="chapter"/></spine></package>`,
  );
  return {
    data: zipSync(files, { level: 0 }),
    version: parseInt(hash(document).slice(0, 12), 16),
    requiredFont: Boolean(font),
  };
}
