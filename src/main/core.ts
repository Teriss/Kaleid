import path from "node:path";
import type { MediaType } from "../shared/types";

export const EXTENSIONS: Record<MediaType, Set<string>> = {
  image: new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]),
  music: new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus"]),
  video: new Set([
    ".mp4",
    ".webm",
    ".mkv",
    ".mov",
    ".m4v",
    ".avi",
    ".wmv",
    ".asf",
    ".flv",
    ".f4v",
    ".mpg",
    ".mpeg",
    ".ts",
    ".m2ts",
    ".mts",
    ".vob",
    ".rm",
    ".rmvb",
    ".3gp",
    ".3g2",
    ".ogv",
  ]),
  novel: new Set([".txt", ".epub"]),
  comic: new Set([".cbz", ".zip", ".cbr", ".rar", ".7z", ".cb7"]),
};
export function normalized(file: string) {
  const value = path.resolve(file);
  return process.platform === "win32" ? value.toLowerCase() : value;
}
export function isWithin(root: string, file: string) {
  const relative = path.relative(normalized(root), normalized(file));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export function naturalSort(a: string, b: string) {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
}
export function safeArchiveEntry(name: string) {
  return (
    !name.includes("\\") &&
    !name.startsWith("/") &&
    !/^[a-z]:/i.test(name) &&
    !name.split("/").includes("..")
  );
}
export function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | false {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = match[1]
    ? match[2]
      ? Math.min(Number(match[2]), size - 1)
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= size ||
    start < 0
  )
    return false;
  return { start, end };
}
