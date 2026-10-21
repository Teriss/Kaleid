import type { ComicPage, Progress, Settings } from "./types";

export interface ComicPreferences {
  mode: "single" | "double" | "scroll";
  rtl: boolean;
  fit: "window" | "width" | "original";
  coverAlone: boolean;
  pairingOffset: boolean;
}
export interface ComicInfo {
  series?: string;
  title?: string;
  number?: string;
  volume?: string;
  writer?: string;
  summary?: string;
  coverIndex?: number;
}
/** Shared by scroll placeholders, scroll offsets and the displayed image. */
export function comicPageSize(
  page: Pick<ComicPage, "width" | "height">,
  viewport: { width: number; height: number },
  fit: ComicPreferences["fit"],
  columns = 1,
  zoom = 1,
) {
  const width = page.width || 1000;
  const height = page.height || 1500;
  const availableWidth = Math.max(1, viewport.width - 40) / columns;
  const availableHeight = Math.max(1, viewport.height - 20);
  const scale =
    fit === "original"
      ? 1
      : fit === "width"
        ? availableWidth / width
        : Math.min(availableWidth / width, availableHeight / height);
  return { width: width * scale * zoom, height: height * scale * zoom };
}
export function comicPreferences(
  settings: Settings,
  value: Partial<ComicPreferences> = {},
): ComicPreferences {
  return {
    mode: ["single", "double", "scroll"].includes(value.mode ?? "")
      ? value.mode!
      : ["single", "double", "scroll"].includes(settings.comicMode)
        ? settings.comicMode
        : "single",
    rtl:
      typeof value.rtl === "boolean" ? value.rtl : settings.comicRtl === true,
    fit: ["window", "width", "original"].includes(value.fit ?? "")
      ? value.fit!
      : "window",
    coverAlone: value.coverAlone !== false,
    pairingOffset: value.pairingOffset === true,
  };
}
export function comicSpreads(
  pages: Pick<ComicPage, "width" | "height">[],
  prefs: ComicPreferences,
): number[][] {
  const result: number[][] = [];
  for (let index = 0; index < pages.length;) {
    const wide = (i: number) =>
      Boolean(
        pages[i]?.width &&
        pages[i]?.height &&
        pages[i].width! > pages[i].height!,
      );
    const alone =
      prefs.mode !== "double" ||
      wide(index) ||
      (index === 0 && prefs.coverAlone) ||
      (index === (prefs.coverAlone ? 1 : 0) && prefs.pairingOffset);
    if (alone || index + 1 >= pages.length || wide(index + 1))
      result.push([index++]);
    else {
      result.push([index, index + 1]);
      index += 2;
    }
  }
  return result;
}
export function restoredComicPage(
  pages: Pick<ComicPage, "id">[],
  progress?: Progress,
) {
  const byId = progress?.comicPageId
    ? pages.findIndex((p) => p.id === progress.comicPageId)
    : -1;
  const oldPage = Number.isFinite(progress?.page)
    ? Math.trunc(progress!.page!)
    : 0;
  return byId >= 0 ? byId : Math.max(0, Math.min(pages.length - 1, oldPage));
}
export function comicReadState(
  progress?: Progress,
): "unread" | "reading" | "completed" {
  return progress?.completed
    ? "completed"
    : progress &&
        (progress.page !== undefined || progress.comicPageId !== undefined)
      ? "reading"
      : "unread";
}
export function comicWindow(
  offsets: number[],
  top: number,
  height: number,
  overscan = 2,
) {
  const find = (position: number) => {
    let lo = 0,
      hi = offsets.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (offsets[mid] <= position) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, Math.max(0, offsets.length - 2));
  };
  return {
    start: Math.max(0, find(top) - overscan),
    end: Math.min(offsets.length - 1, find(top + height) + overscan + 1),
  };
}
// ComicInfo uses simple scalar fields; never resolve DTDs or external entities.
export function parseComicInfo(xml: string): ComicInfo {
  if (xml.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return {};
  const decode = (text: string) =>
    text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(
        /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
        (all, key: string) => {
          const known: Record<string, string> = {
            amp: "&",
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
          };
          if (known[key]) return known[key];
          const n = key.startsWith("#x")
            ? parseInt(key.slice(2), 16)
            : parseInt(key.slice(1), 10);
          return Number.isInteger(n) && n > 0 && n <= 0x10ffff
            ? String.fromCodePoint(n)
            : all;
        },
      )
      .trim();
  const field = (name: string) => {
    const text = xml.match(
      new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"),
    )?.[1];
    return text ? decode(text).slice(0, 10000) : undefined;
  };
  const cover = [...xml.matchAll(/<Page\b([^>]*)\/?\s*>/gi)].find((m) =>
    /\bType\s*=\s*["']FrontCover["']/i.test(m[1]),
  );
  const coverIndex = cover?.[1].match(/\bImage\s*=\s*["'](\d+)["']/i)?.[1];
  return {
    series: field("Series"),
    title: field("Title"),
    number: field("Number"),
    volume: field("Volume"),
    writer: field("Writer"),
    summary: field("Summary"),
    ...(coverIndex !== undefined ? { coverIndex: Number(coverIndex) } : {}),
  };
}
