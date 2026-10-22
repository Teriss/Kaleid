import { DatabaseSync } from "node:sqlite";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import { parseFile } from "music-metadata";
import yauzl from "yauzl";
import iconv from "iconv-lite";
import { ComicArchives } from "./comicArchive";
import { ComicLibrary } from "./comicLibrary";
import { detect } from "chardet";
import {
  probeVideo,
  videoPoster,
  VIDEO_INFO_VERSION,
  matchingSubtitles,
} from "./videoFiles";
import { videoPreferences } from "../shared/video";
import { normalizeStoredSettings } from "../shared/readerSettings";
import {
  DEFAULT_SETTINGS,
  type Library,
  type MediaItem,
  type MediaQuery,
  type MediaType,
  type MusicPlaylist,
  type MusicSession,
  type MusicMetadataCandidate,
  type ScanStatus,
  type IndexChange,
} from "../shared/types";
import {
  EXTENSIONS,
  isWithin,
  naturalSort,
  normalized,
  safeArchiveEntry,
} from "./core";

const port = (
  process as unknown as {
    parentPort: {
      on(event: string, fn: (event: { data: any }) => void): void;
      postMessage(data: unknown): void;
    };
  }
).parentPort;
const dataDir = process.env.MEDIA_BROWSER_DATA!;
await fs.mkdir(path.join(dataDir, "cache"), { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "library.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,roots TEXT NOT NULL,createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,type TEXT NOT NULL,path TEXT NOT NULL,folder TEXT NOT NULL,title TEXT NOT NULL,ext TEXT NOT NULL,size INTEGER NOT NULL,modifiedAt INTEGER NOT NULL,addedAt INTEGER NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',cover TEXT,favorite INTEGER NOT NULL DEFAULT 0,missing INTEGER NOT NULL DEFAULT 0,lastOpened INTEGER,progress TEXT,fileIdentity TEXT,changeTimeMs INTEGER,UNIQUE(type,path));
CREATE TABLE IF NOT EXISTS memberships(libraryId TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,mediaId TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,PRIMARY KEY(libraryId,mediaId));
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type); CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder);
CREATE INDEX IF NOT EXISTS idx_media_recent ON media(lastOpened DESC); CREATE INDEX IF NOT EXISTS idx_members_media ON memberships(mediaId);
CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS music_playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS music_playlist_tracks(playlistId TEXT NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,mediaId TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlistId,mediaId));
CREATE TABLE IF NOT EXISTS music_overrides(mediaId TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,originalMetadata TEXT NOT NULL,originalCover TEXT,fields TEXT NOT NULL DEFAULT '{}',lyric TEXT,source TEXT);
CREATE TABLE IF NOT EXISTS audio_analysis(mediaId TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,fileIdentity TEXT,changeTimeMs INTEGER NOT NULL,gainDb REAL NOT NULL,analyzedAt INTEGER NOT NULL);
`);
const mediaColumns = new Set(
  (db.prepare("PRAGMA table_info(media)").all() as any[]).map(
    (column) => column.name,
  ),
);
if (!mediaColumns.has("fileIdentity"))
  db.exec("ALTER TABLE media ADD COLUMN fileIdentity TEXT");
if (!mediaColumns.has("changeTimeMs"))
  db.exec("ALTER TABLE media ADD COLUMN changeTimeMs INTEGER");
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_media_identity ON media(type,fileIdentity)",
);
const watcherHandles = new Map<string, FSWatcher>();
const comicArchives = new ComicArchives(
  path.join(dataDir, "cache", "comics"),
  path.join(process.env.MEDIA_BROWSER_COMIC_RUNTIME ?? "", "7z.exe"),
);
const comicLibrary = new ComicLibrary(db, item);
const comicSessions = new Map<string, string>();
await comicLibrary.migrate(dataDir);
const watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDirtyPaths = new Map<string, Set<string>>();
const pendingRescans = new Set<string>();
const activeScans = new Map<string, { cancelled: boolean }>();
const folderTokens = new Map<string, { libraryId: string; path: string }>();
const folderIndexes = new Map<string, ReturnType<typeof makeFolderIndex>>();
let indexVersion = 0;
function publishIndexChange(
  ids: string[],
  removedIds: string[] = [],
  structural = false,
  libraryIds: string[] = [],
  types: MediaType[] = [],
) {
  const unique = [...new Set(ids)];
  if (!unique.length && !removedIds.length) return;
  const updated = unique.slice(0, 500).flatMap((id) => {
    const row = db.prepare("SELECT * FROM media WHERE id=?").get(id);
    return row ? [rowItem(row)] : [];
  });
  folderIndexes.clear();
  if (!structural && !removedIds.length) {
    // Update cached folder representatives together with their changed descendant.
    const affected = [...folderTokens.values()].filter((folder) =>
      updated.some(
        (entry) =>
          entry.libraryIds.includes(folder.libraryId) &&
          isWithin(folder.path, entry.path),
      ),
    );
    for (const folder of affected) {
      const lib = library(folder.libraryId);
      const entry = folderIndex(lib.id, lib.type).toFolderItem(
        folder.path,
        lib.id,
      );
      if (entry && !updated.some((item) => item.id === entry.id))
        updated.push(entry);
      if (updated.length >= 500) {
        structural = true;
        break;
      }
    }
  }
  const change: IndexChange = {
    version: ++indexVersion,
    libraryIds: [
      ...new Set([
        ...libraryIds,
        ...updated.flatMap((entry) => entry.libraryIds),
      ]),
    ],
    types: [...new Set([...types, ...updated.map((entry) => entry.type)])],
    updated,
    removedIds: [...new Set(removedIds)],
    structural: structural || unique.length > 500,
  };
  port.postMessage({ event: "index-change", data: change });
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);
const videoInfoQueue = new Set<string>();
const videoInfoActive = new Set<string>();
let videoInfoTimer: ReturnType<typeof setTimeout> | undefined;
function enqueueVideoInfo(id: string) {
  videoInfoQueue.add(id);
  if (!videoInfoTimer) videoInfoTimer = setTimeout(drainVideoInfo, 100);
}
function drainVideoInfo() {
  videoInfoTimer = undefined;
  for (const id of videoInfoQueue) {
    if (videoInfoActive.size >= 2) break;
    if (videoInfoActive.has(id)) continue;
    videoInfoQueue.delete(id);
    videoInfoActive.add(id);
    void updateVideoInfo(id)
      .catch((error) => console.error("Video metadata failed", error))
      .finally(() => {
        videoInfoActive.delete(id);
        if (videoInfoQueue.size && !videoInfoTimer)
          videoInfoTimer = setTimeout(drainVideoInfo, 100);
      });
  }
}
async function updateVideoInfo(id: string) {
  const original = item(id);
  if (original.missing || original.type !== "video") return;
  const row = db
    .prepare("SELECT metadata FROM media WHERE id=?")
    .get(id) as any;
  const initial = JSON.parse(row.metadata);
  const file = await authorizedFile(original);
  let details: Record<string, unknown>;
  let poster: Buffer | undefined;
  try {
    details = {
      ...(await probeVideo(file)),
      videoProbeError: undefined,
      videoPosterVersion: initial.indexedVersion,
    };
    // A cover failure must not discard valid stream metadata.
    try {
      poster = await videoPoster(file, details.duration as number);
    } catch {}
  } catch (error) {
    details = {
      videoInfoVersion: VIDEO_INFO_VERSION,
      videoPosterVersion: initial.indexedVersion,
      videoProbeError: String(error).slice(-500),
    };
  }
  const latest = db.prepare("SELECT * FROM media WHERE id=?").get(id) as any;
  if (!latest || latest.missing || latest.path !== original.path) return;
  const metadata = JSON.parse(latest.metadata);
  const stat = await fs.stat(file);
  if (
    metadata.indexedVersion !== initial.indexedVersion ||
    stat.size !== original.size ||
    Math.trunc(stat.mtimeMs) !== original.modifiedAt ||
    Math.trunc(stat.ctimeMs) !== latest.changeTimeMs
  )
    return;
  let cover = latest.cover;
  if (poster)
    cover = await thumbnail(
      poster,
      hash(`${id}:video:${initial.indexedVersion}`),
    );
  const current = db
    .prepare("SELECT metadata FROM media WHERE id=?")
    .get(id) as any;
  if (
    !current ||
    JSON.parse(current.metadata).indexedVersion !== initial.indexedVersion
  )
    return;
  Object.assign(metadata, details, { resourceVersion: Date.now() });
  db.prepare("UPDATE media SET metadata=?,cover=? WHERE id=?").run(
    JSON.stringify(metadata),
    cover,
    id,
  );
  publishIndexChange([id]);
}
function rowItem(row: any): MediaItem {
  const override = db
    .prepare("SELECT fields FROM music_overrides WHERE mediaId=?")
    .get(row.id) as { fields: string } | undefined;
  return {
    ...JSON.parse(row.metadata),
    ...row,
    ...(override ? JSON.parse(override.fields) : {}),
    metadata: undefined,
    favorite: Boolean(row.favorite),
    missing: Boolean(row.missing),
    progress: row.progress ? JSON.parse(row.progress) : undefined,
    libraryIds: db
      .prepare("SELECT libraryId FROM memberships WHERE mediaId=?")
      .all(row.id)
      .map((m: any) => m.libraryId),
  };
}
function item(id: string): MediaItem {
  const row = db.prepare("SELECT * FROM media WHERE id=?").get(id);
  if (!row) throw new Error("找不到该媒体条目");
  return rowItem(row);
}
function library(id: string): Library {
  const row: any = db.prepare("SELECT * FROM libraries WHERE id=?").get(id);
  if (!row) throw new Error("媒体库不存在");
  return {
    ...row,
    roots: JSON.parse(row.roots),
    count: (
      db
        .prepare("SELECT COUNT(*) AS n FROM memberships WHERE libraryId=?")
        .get(id) as any
    ).n,
  };
}
function libraries() {
  return db
    .prepare("SELECT id FROM libraries ORDER BY createdAt")
    .all()
    .map((r: any) => library(r.id));
}
async function authorizedFile(value: MediaItem) {
  const resolved = await fs.realpath(value.path);
  const allowed = value.libraryIds.flatMap((id) => library(id).roots);
  if (!allowed.some((root) => isWithin(root, resolved)))
    throw new Error("文件已不在授权目录内，请重新扫描");
  return resolved;
}
const loudnessJobs = new Map<string, Promise<number | null>>();
function ffmpegBinaryPath() {
  if (!ffmpegStatic) throw new Error("随包 FFmpeg 不支持当前系统架构");
  return ffmpegStatic.replace(/app\.asar([\\/])/i, "app.asar.unpacked$1");
}
async function measureLoudness(file: string) {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      ffmpegBinaryPath(),
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-i",
        file,
        "-vn",
        "-sn",
        "-dn",
        "-af",
        "loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json",
        "-f",
        "null",
        "-",
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (part: string) => {
      stderr = (stderr + part).slice(-128 * 1024);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("响度分析超时"));
    }, 15 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("FFmpeg 无法分析该音频文件"));
        return;
      }
      const json = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
      if (!json) {
        reject(new Error("FFmpeg 没有返回响度分析结果"));
        return;
      }
      try {
        const result = JSON.parse(json) as {
          input_i?: string;
          input_tp?: string;
        };
        const integrated = Number(result.input_i);
        const peak = Number(result.input_tp);
        if (!Number.isFinite(integrated)) throw new Error("无有效响度值");
        const targetGain = -18 - integrated;
        const peakLimitedGain = Number.isFinite(peak)
          ? Math.min(targetGain, -1.5 - peak)
          : targetGain;
        resolve(Math.max(-12, Math.min(12, peakLimitedGain)));
      } catch {
        reject(new Error("无法读取 FFmpeg 响度分析结果"));
      }
    });
  });
}
async function analyzeLoudness(id: string): Promise<number | null> {
  const existingJob = loudnessJobs.get(id);
  if (existingJob) return existingJob;
  const job = (async () => {
    const media = item(id);
    if (media.type !== "music" || media.missing)
      throw new Error("不是可用的音乐文件");
    if (Number.isFinite(media.replayGainDb)) return media.replayGainDb!;
    const file = await authorizedFile(media);
    const row = db
      .prepare("SELECT fileIdentity FROM media WHERE id=?")
      .get(id) as { fileIdentity?: string };
    const before = await fs.stat(file);
    const changeTimeMs = Math.trunc(before.ctimeMs);
    const cached = db
      .prepare(
        "SELECT fileIdentity,changeTimeMs,gainDb FROM audio_analysis WHERE mediaId=?",
      )
      .get(id) as
      | { fileIdentity?: string; changeTimeMs: number; gainDb: number }
      | undefined;
    if (
      cached &&
      cached.changeTimeMs === changeTimeMs &&
      (cached.fileIdentity ?? null) === (row.fileIdentity ?? null)
    )
      return cached.gainDb;
    const gainDb = await measureLoudness(file);
    const after = await fs.stat(file);
    if (
      Math.trunc(after.ctimeMs) !== changeTimeMs ||
      (row.fileIdentity && `${after.dev}:${after.ino}` !== row.fileIdentity)
    )
      throw new Error("分析期间音频文件发生变化，请重新扫描后再试");
    db.prepare(
      `INSERT INTO audio_analysis(mediaId,fileIdentity,changeTimeMs,gainDb,analyzedAt)
       VALUES(?,?,?,?,?) ON CONFLICT(mediaId) DO UPDATE SET
       fileIdentity=excluded.fileIdentity,changeTimeMs=excluded.changeTimeMs,
       gainDb=excluded.gainDb,analyzedAt=excluded.analyzedAt`,
    ).run(id, row.fileIdentity ?? null, changeTimeMs, gainDb, Date.now());
    return gainDb;
  })();
  loudnessJobs.set(id, job);
  try {
    return await job;
  } finally {
    if (loudnessJobs.get(id) === job) loudnessJobs.delete(id);
  }
}
const krcXorKey = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce,
  0xd2, 0x6e, 0x69,
]);
function decodeKrc(data: Buffer) {
  if (data.length < 4 || data.subarray(0, 4).toString("ascii") !== "krc1")
    return data;
  const compressed = Buffer.from(data.subarray(4));
  for (let index = 0; index < compressed.length; index++)
    compressed[index] ^= krcXorKey[index % krcXorKey.length];
  try {
    return inflateSync(compressed);
  } catch {
    return inflateRawSync(compressed);
  }
}
function query(q: MediaQuery) {
  if (q.browse) return browse(q);
  const where = [
    "m.missing=0",
    "EXISTS(SELECT 1 FROM memberships x WHERE x.mediaId=m.id)",
  ];
  const params: any[] = [];
  if (q.libraryId) {
    where.push(
      "EXISTS(SELECT 1 FROM memberships x WHERE x.mediaId=m.id AND x.libraryId=?)",
    );
    params.push(q.libraryId);
  }
  if (q.type) {
    where.push("m.type=?");
    params.push(q.type);
  }
  if (q.favorite) where.push("m.favorite=1");
  if (q.recent) where.push("m.lastOpened IS NOT NULL");
  if (q.folder) {
    where.push("m.folder=?");
    params.push(normalized(q.folder));
  }
  if (q.search?.trim()) {
    where.push("(m.title LIKE ? ESCAPE '\\' OR m.metadata LIKE ? ESCAPE '\\')");
    const pattern = `%${q.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
    params.push(pattern, pattern);
  }
  const clause = where.join(" AND ");
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${clause}`)
      .get(...params) as any
  ).n;
  const order =
    q.sort === "name"
      ? "m.title COLLATE NOCASE ASC"
      : q.sort === "recent" || q.recent
        ? "m.lastOpened DESC"
        : "m.addedAt DESC";
  const rows = db
    .prepare(
      `SELECT m.* FROM media m WHERE ${clause} ORDER BY ${order},m.id LIMIT ? OFFSET ?`,
    )
    .all(
      ...params,
      Math.min(200, Math.max(1, q.limit ?? 80)),
      Math.max(0, q.offset ?? 0),
    );
  const anchorIndex = q.anchorId
    ? (
        db
          .prepare(
            `SELECT position FROM (SELECT m.id, ROW_NUMBER() OVER (ORDER BY ${order},m.id)-1 AS position FROM media m WHERE ${clause}) WHERE id=?`,
          )
          .get(...params, q.anchorId) as { position: number } | undefined
      )?.position
    : undefined;
  return { total, items: rows.map(rowItem), anchorIndex };
}
type IndexedRow = Record<string, any>;
function makeFolderIndex(libraryId: string, type: MediaType) {
  const lib = library(libraryId);
  const rows = db
    .prepare(
      `SELECT m.* FROM media m JOIN memberships x ON x.mediaId=m.id
      WHERE x.libraryId=? AND m.type=? AND m.missing=0`,
    )
    .all(libraryId, type) as IndexedRow[];
  const normalizedRoots = lib.roots.map((root) => normalized(root));
  const allowedRows = rows.filter((row) =>
    normalizedRoots.some((root) => isWithin(root, row.path)),
  );
  const nodes = new Map<
    string,
    { path: string; rows: IndexedRow[]; children: Set<string> }
  >();
  const summaries = new Map<
    string,
    { count: number; first: IndexedRow; path: string }
  >();
  const comicBooks = new Set(
    allowedRows
      .filter((row) => row.ext === "folder")
      .map((row) => normalized(row.path)),
  );
  const ensure = (directory: string) => {
    const key = normalized(directory);
    if (!nodes.has(key))
      nodes.set(key, { path: directory, rows: [], children: new Set() });
    return nodes.get(key)!;
  };
  for (const root of normalizedRoots) ensure(root);
  for (const row of allowedRows) {
    const parent = normalized(row.folder);
    const root = normalizedRoots.find((candidate) =>
      isWithin(candidate, parent),
    );
    if (!root) continue;
    ensure(parent).rows.push(row);
    const mediaKey = normalized(row.path);
    let summaryDirectory = row.ext === "folder" ? normalized(row.path) : parent;
    while (isWithin(root, summaryDirectory)) {
      const previous = summaries.get(summaryDirectory);
      if (!previous)
        summaries.set(summaryDirectory, {
          count: 1,
          first: row,
          path: mediaKey,
        });
      else {
        previous.count++;
        if (
          mediaKey.localeCompare(previous.path, "zh-CN", { numeric: true }) < 0
        ) {
          previous.first = row;
          previous.path = mediaKey;
        }
      }
      if (summaryDirectory === root) break;
      const parentPath = normalized(path.dirname(summaryDirectory));
      if (parentPath === summaryDirectory) break;
      summaryDirectory = parentPath;
    }
    let child = parent;
    while (child !== root) {
      const parentPath = normalized(path.dirname(child));
      if (!isWithin(root, parentPath) || parentPath === child) break;
      ensure(parentPath).children.add(child);
      child = parentPath;
    }
  }
  const folderItems = new Map<string, MediaItem>();
  const toFolderItem = (
    directory: string,
    libraryId: string,
  ): MediaItem | undefined => {
    const key = normalized(directory);
    const cached = folderItems.get(key);
    if (cached) return cached;
    const summary = summaries.get(key);
    if (!summary) return undefined;
    const first = summary.first;
    const id = hash(`folder:${libraryId}:${key}`);
    folderTokens.set(id, { libraryId, path: directory });
    const value: MediaItem = {
      id,
      kind: "folder",
      folderCount: summary.count,
      type,
      title: path.basename(directory) || directory,
      path: directory,
      folder: path.dirname(directory),
      ext: "directory",
      size: 0,
      modifiedAt: first.modifiedAt,
      resourceVersion: JSON.parse(first.metadata).resourceVersion,
      addedAt: 0,
      cover: first.cover ?? undefined,
      favorite: false,
      missing: false,
      libraryIds: [libraryId],
    };
    folderItems.set(key, value);
    return value;
  };
  return {
    lib,
    rows: allowedRows,
    nodes,
    roots: normalizedRoots,
    comicBooks,
    summaries,
    toFolderItem,
    lists: new Map<string, MediaItem[]>(),
  };
}
function folderIndex(libraryId: string, type: MediaType) {
  const key = `${libraryId}:${type}`;
  let index = folderIndexes.get(key);
  if (!index) {
    index = makeFolderIndex(libraryId, type);
    folderIndexes.set(key, index);
  }
  return index;
}
function browse(q: MediaQuery) {
  if (!q.libraryId) return { items: [], total: 0 };
  const lib = library(q.libraryId);
  const type = q.type ?? lib.type;
  if (type !== lib.type) return { items: [], total: 0 };
  const index = folderIndex(q.libraryId, type);
  const current = q.folder ? normalized(q.folder) : undefined;
  if (current && !index.roots.some((root) => isWithin(root, current)))
    return { items: [], total: 0 };
  const isMultiRoot = index.roots.length > 1;
  let entries: MediaItem[] = [];
  if (!current && isMultiRoot) {
    const listKey = `@roots:${q.sort ?? "added"}`;
    entries =
      index.lists.get(listKey) ??
      index.roots
        .map((root) => index.toFolderItem(root, q.libraryId!))
        .filter((value): value is MediaItem => Boolean(value));
    if (q.sort === "name")
      entries.sort((a, b) =>
        a.title.localeCompare(b.title, "zh-CN", { numeric: true }),
      );
    index.lists.set(listKey, entries);
  } else {
    const directory = current ?? index.roots[0];
    if (!directory) return { items: [], total: 0 };
    const node = index.nodes.get(directory);
    if (!node) return { items: [], total: 0 };
    const directRows = node.rows;
    const listKey = `${directory}:${q.sort ?? "added"}`;
    entries = index.lists.get(listKey) ?? [];
    if (!index.lists.has(listKey)) {
      const compare = (a: MediaItem, b: MediaItem) => {
        if (q.sort === "name")
          return (
            a.title.localeCompare(b.title, "zh-CN", { numeric: true }) ||
            a.id.localeCompare(b.id)
          );
        if (q.sort === "recent")
          return (
            (b.lastOpened ?? 0) - (a.lastOpened ?? 0) ||
            a.id.localeCompare(b.id)
          );
        return b.addedAt - a.addedAt || a.id.localeCompare(b.id);
      };
      const isCollection = (directory: string) => {
        const child = index.nodes.get(normalized(directory));
        return Boolean(
          child &&
          (child.children.size > 0 ||
            child.rows.some(
              (row) =>
                row.ext === "folder" &&
                normalized(row.path) !== normalized(directory),
            )),
        );
      };
      const files = [...directRows]
        .filter(
          (row) =>
            !(
              type === "comic" &&
              row.ext === "folder" &&
              isCollection(row.path)
            ),
        )
        .sort((a, b) => {
          if (q.sort === "name")
            return (
              a.title.localeCompare(b.title, "zh-CN", { numeric: true }) ||
              a.id.localeCompare(b.id)
            );
          if (q.sort === "recent")
            return (
              (b.lastOpened ?? 0) - (a.lastOpened ?? 0) ||
              a.id.localeCompare(b.id)
            );
          return b.addedAt - a.addedAt || a.id.localeCompare(b.id);
        })
        .map(rowItem);
      const children = [...node.children]
        .filter((child) => !index.comicBooks.has(child) || isCollection(child))
        .map((child) => index.toFolderItem(child, q.libraryId!))
        .filter((value): value is MediaItem => Boolean(value));
      if (q.sort === "name") children.sort(compare);
      entries =
        q.sort === "name"
          ? [...files, ...children].sort(compare)
          : [...files, ...children];
      if (
        type === "comic" &&
        (isCollection(directory) || index.roots.includes(directory))
      ) {
        const ownBook = index.rows.find(
          (row) => row.ext === "folder" && normalized(row.path) === directory,
        );
        if (ownBook)
          entries.unshift({ ...rowItem(ownBook), title: "本目录漫画" });
      }
      index.lists.set(listKey, entries);
    }
  }
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(200, Math.max(1, q.limit ?? 80));
  const anchorIndex = q.anchorId
    ? entries.findIndex((entry) => entry.id === q.anchorId)
    : -1;
  return {
    scene:
      entries.length && entries.every((entry) => Boolean(entry.kind))
        ? "carousel"
        : "collection",
    items: entries.slice(offset, offset + limit),
    total: entries.length,
    anchorIndex: anchorIndex >= 0 ? anchorIndex : undefined,
  };
}
function resolveIds(ids: string[]) {
  if (!Array.isArray(ids) || ids.length > 10000)
    throw new Error("选择数量超出限制");
  const unique = [...new Set(ids)];
  return unique.map((id) => {
    const folder = folderTokens.get(id);
    if (folder) {
      const lib = library(folder.libraryId);
      if (!lib.roots.some((root) => isWithin(root, folder.path)))
        throw new Error("文件夹不在授权范围内");
      return {
        id,
        path: folder.path,
        title: path.basename(folder.path),
        kind: "folder" as const,
        isDirectory: true,
        libraryIds: [folder.libraryId],
      };
    }
    const media = item(id);
    return {
      id,
      path: media.path,
      title: media.title,
      kind: "media" as const,
      isDirectory: media.ext === "folder",
      type: media.type,
      favorite: media.favorite,
      missing: media.missing,
      libraryIds: media.libraryIds,
    };
  });
}
async function walk(
  root: string,
  visit: (file: string, isDir: boolean) => Promise<void>,
  control: { cancelled: boolean },
  errors: () => void,
) {
  if (control.cancelled) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    errors();
    return;
  }
  for (const entry of entries) {
    if (control.cancelled) break;
    if (
      entry.isSymbolicLink() ||
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "$RECYCLE.BIN"
    )
      continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await visit(full, true);
      await walk(full, visit, control, errors);
    } else if (entry.isFile()) await visit(full, false);
  }
}

const ZIP_FILE_LIMIT = 64 * 1024 * 1024;
async function zipEntries(file: string): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error("无法读取压缩包"));
      const entries: yauzl.Entry[] = [];
      let total = 0;
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        if (
          !safeArchiveEntry(entry.fileName) ||
          entry.uncompressedSize > ZIP_FILE_LIMIT ||
          entries.length > 20000 ||
          total > 1024 * 1024 * 1024
        ) {
          zip.close();
          reject(new Error("压缩包含不安全路径或内容超过限制"));
          return;
        }
        entries.push(entry);
        zip.readEntry();
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}
async function zipRead(file: string, name: string): Promise<Buffer> {
  if (!safeArchiveEntry(name)) throw new Error("不安全的压缩包路径");
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error("无法打开压缩包"));
      let matched = false;
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== name) {
          zip.readEntry();
          return;
        }
        matched = true;
        if (entry.uncompressedSize > ZIP_FILE_LIMIT) {
          zip.close();
          reject(new Error("压缩条目过大"));
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            zip.close();
            reject(err || new Error("无法读取条目"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk) => {
            size += chunk.length;
            if (size > ZIP_FILE_LIMIT) {
              stream.destroy(new Error("解压内容过大"));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("error", (e) => {
            zip.close();
            reject(e);
          });
          stream.on("end", () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      zip.on("end", () => {
        if (!matched) reject(new Error("找不到压缩包条目"));
      });
      zip.readEntry();
    });
  });
}
async function thumbnail(input: string | Buffer, id: string) {
  const target = path.join(dataDir, "cache", `${id}.jpg`);
  await sharp(input, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize(640, 640, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#19191f" })
    .jpeg({ quality: 82 })
    .toFile(target);
  return `${id}.jpg`;
}
async function scan(
  libraryId: string,
  reason: "manual" | "background" = "manual",
) {
  if (activeScans.has(libraryId)) return;
  const queuedWatcherScan = watcherTimers.get(libraryId);
  if (queuedWatcherScan) {
    clearTimeout(queuedWatcherScan);
    watcherTimers.delete(libraryId);
  }
  const lib = library(libraryId);
  const control = { cancelled: false };
  activeScans.set(libraryId, control);
  const dirtyPaths = pendingDirtyPaths.get(libraryId) ?? new Set<string>();
  pendingDirtyPaths.delete(libraryId);
  if (dirtyPaths.size) await settleChangedPaths([...dirtyPaths]);
  const changedIds = new Set<string>();
  let structural = false;
  const forcedDependencies = new Set<string>();
  const partial = reason === "background" && dirtyPaths.size > 0;
  let targets = [...lib.roots];
  if (partial) {
    const dirty = [...dirtyPaths];
    const candidates: string[] = [];
    for (let value of dirty) {
      if (
        lib.type === "comic" &&
        EXTENSIONS.image.has(path.extname(value).toLowerCase())
      )
        value = path.dirname(value);
      if (
        lib.type === "music" &&
        /\.(lrc|ttml|vtt|qrc|yrc|krc|jpg|jpeg|png|webp)$/i.test(value)
      ) {
        for (const row of db
          .prepare("SELECT id,path FROM media WHERE type='music' AND folder=?")
          .all(normalized(path.dirname(value))) as any[]) {
          if (
            /^(cover|folder|front)\./i.test(path.basename(value)) ||
            path.parse(row.path).name === path.parse(value).name
          ) {
            candidates.push(row.path);
            forcedDependencies.add(row.path);
          }
        }
      } else candidates.push(value);
    }
    targets = [
      ...new Set(
        candidates.flatMap((target) =>
          lib.roots.some((root) => isWithin(root, target))
            ? [target]
            : lib.roots.filter((root) => isWithin(target, root)),
        ),
      ),
    ].filter(
      (target, index, all) =>
        lib.roots.some((root) => isWithin(root, target)) &&
        !all.some((parent) => parent !== target && isWithin(parent, target)),
    );
  }
  const status: ScanStatus = {
    reason,
    libraryId,
    status: "scanning",
    found: 0,
    processed: 0,
    errors: 0,
  };
  let lastSent = 0;
  const seen = new Set<string>();
  const completeRoots: string[] = [];
  const incompleteRoots = new Set<string>();
  const emit = (force = false) => {
    if (force || Date.now() - lastSent > 180) {
      port.postMessage({ event: "scan", data: { ...status } });
      lastSent = Date.now();
    }
  };
  emit(true);
  try {
    const indexFile = async (file: string, comicDirectory = false) => {
      if (control.cancelled) return;
      const canonical = normalized(file);
      if (seen.has(canonical)) return;
      status.found++;
      status.current = path.basename(file);
      emit();
      try {
        const stat = await fs.stat(file);
        seen.add(canonical);
        let existing = db
          .prepare("SELECT id FROM media WHERE type=? AND path=?")
          .get(lib.type, canonical) as { id: string } | undefined;
        const fileIdentity =
          Number.isSafeInteger(stat.ino) && stat.ino > 0
            ? `${stat.dev}:${stat.ino}`
            : null;
        if (!existing && fileIdentity) {
          const candidates = db
            .prepare(
              `SELECT m.id,m.path FROM media m JOIN memberships s ON s.mediaId=m.id
               WHERE s.libraryId=? AND m.type=? AND m.fileIdentity=?`,
            )
            .all(libraryId, lib.type, fileIdentity) as {
            id: string;
            path: string;
          }[];
          const missing: typeof candidates = [];
          for (const candidate of candidates) {
            try {
              await fs.lstat(candidate.path);
            } catch (error: any) {
              if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
                missing.push(candidate);
            }
          }
          if (missing.length === 1) existing = { id: missing[0].id };
        }
        const id = existing?.id ?? hash(`${lib.type}:${canonical}`);
        const old: any = db.prepare("SELECT * FROM media WHERE id=?").get(id);
        const ext = comicDirectory
          ? "folder"
          : path.extname(file).slice(1).toLowerCase();
        // Directory mtime does not reflect edits to its pages; rebuild its small cover on rescan.
        const oldMetadata = old ? JSON.parse(old.metadata) : {};
        const version = `${stat.size}:${Math.trunc(stat.mtimeMs)}:${Math.trunc(stat.ctimeMs)}`;
        let pageStamp = "";
        if (comicDirectory) {
          const pages = (await fs.readdir(file))
            .filter((name) =>
              EXTENSIONS.image.has(path.extname(name).toLowerCase()),
            )
            .sort(naturalSort);
          pageStamp = (
            await Promise.all(
              pages.map(async (name) => {
                const st = await fs.stat(path.join(file, name));
                return `${name}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
              }),
            )
          ).join("|");
        }
        const contentChanged =
          !old ||
          old.size !== stat.size ||
          old.modifiedAt !== Math.trunc(stat.mtimeMs) ||
          (old.path === canonical &&
            old.changeTimeMs !== Math.trunc(stat.ctimeMs));
        const changed =
          !old ||
          old.size !== stat.size ||
          old.modifiedAt !== Math.trunc(stat.mtimeMs) ||
          (old.path === canonical &&
            old.changeTimeMs !== Math.trunc(stat.ctimeMs)) ||
          forcedDependencies.has(canonical) ||
          (!old.cover &&
            (reason === "manual" || oldMetadata.indexedVersion !== version)) ||
          (old.cover &&
            !(await fs.access(path.join(dataDir, "cache", old.cover)).then(
              () => true,
              () => false,
            ))) ||
          (comicDirectory && pageStamp !== oldMetadata.pageStamp) ||
          (lib.type === "comic" && oldMetadata.comicIndexVersion !== 1);
        // A changed source file becomes the new canonical import. Keep its stable
        // media ID, but discard online metadata tied to the previous audio bytes.
        if (contentChanged && lib.type === "music" && old)
          db.prepare("DELETE FROM music_overrides WHERE mediaId=?").run(id);
        if (contentChanged && lib.type === "video" && old)
          db.prepare("UPDATE media SET progress=NULL WHERE id=?").run(id);
        let metadata: Record<string, unknown> = old
          ? JSON.parse(old.metadata)
          : {};
        let cover = old?.cover ?? null;
        let title =
          (old && (old.path === canonical || lib.type === "music")
            ? old.title
            : undefined) ??
          path.basename(file, comicDirectory ? undefined : path.extname(file));
        if (changed) {
          metadata = {};
          cover = null;
          try {
            if (lib.type === "image") {
              const info = await sharp(file).metadata();
              metadata = { width: info.width, height: info.height };
              cover = await thumbnail(file, id);
            }
            if (lib.type === "music") {
              const parsed = await parseFile(file, { duration: true });
              metadata = {
                artist: parsed.common.artist,
                album: parsed.common.album,
                duration: parsed.format.duration,
                replayGainDb:
                  parsed.common.replaygain_track_gain?.dB ??
                  parsed.common.replaygain_album_gain?.dB,
                embeddedLyrics: parsed.common.lyrics
                  ?.map((entry) => entry.text)
                  .filter(Boolean)
                  .join("\n")
                  .slice(0, 2 * 1024 * 1024),
              };
              title = parsed.common.title || title;
              if (parsed.common.picture?.[0])
                cover = await thumbnail(
                  Buffer.from(parsed.common.picture[0].data),
                  id,
                );
              if (!cover && lib.type === "music") {
                const names = await fs.readdir(path.dirname(file));
                const candidate = names.find((n) =>
                  /^(cover|folder|front)\.(jpe?g|png|webp)$/i.test(n),
                );
                if (candidate) {
                  const resolved = await fs.realpath(
                    path.join(path.dirname(file), candidate),
                  );
                  if (lib.roots.some((root) => isWithin(root, resolved)))
                    cover = await thumbnail(resolved, id);
                }
              }
            }
            if (lib.type === "comic") {
              comicArchives.invalidate(file);
              const pageCache = path.resolve(dataDir, "cache", id);
              if (isWithin(path.resolve(dataDir, "cache"), pageCache))
                await fs.rm(pageCache, { recursive: true, force: true });
              const manifest = await comicArchives.manifest(file);
              const pages = manifest.pages;
              metadata = {
                pageCount: pages.length,
                comicInfo: manifest.info,
                comicIndexVersion: 1,
              };
              const coverIndex =
                Number.isSafeInteger(manifest.info.coverIndex) &&
                manifest.info.coverIndex! >= 0 &&
                manifest.info.coverIndex! < pages.length
                  ? manifest.info.coverIndex!
                  : 0;
              if (pages[coverIndex])
                cover = await thumbnail(
                  await comicArchives.page(file, coverIndex),
                  id,
                );
            }
            if (lib.type === "novel" && ext === "epub") {
              const entries = await zipEntries(file);
              const art = entries.find((e) =>
                /(^|\/)cover[^/]*\.(jpe?g|png|webp)$/i.test(e.fileName),
              );
              if (art)
                cover = await thumbnail(await zipRead(file, art.fileName), id);
            }
          } catch {
            status.errors++;
          }
        }
        if (changed) {
          metadata.indexedVersion = version;
          metadata.resourceVersion = Date.now();
          if (comicDirectory) metadata.pageStamp = pageStamp;
        }
        if (
          changed ||
          old?.path !== canonical ||
          old?.fileIdentity !== fileIdentity ||
          old?.missing
        ) {
          changedIds.add(id);
          if (!old || old.path !== canonical || old.title !== title)
            structural = true;
          db.prepare(
            `INSERT INTO media(id,type,path,folder,title,ext,size,modifiedAt,addedAt,metadata,cover,fileIdentity,changeTimeMs,missing) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET path=excluded.path,folder=excluded.folder,title=excluded.title,size=excluded.size,modifiedAt=excluded.modifiedAt,metadata=excluded.metadata,cover=excluded.cover,fileIdentity=excluded.fileIdentity,changeTimeMs=excluded.changeTimeMs,missing=0`,
          ).run(
            id,
            lib.type,
            canonical,
            normalized(path.dirname(file)),
            title,
            ext,
            stat.size,
            Math.trunc(stat.mtimeMs),
            Date.now(),
            JSON.stringify(metadata),
            cover,
            fileIdentity,
            Math.trunc(stat.ctimeMs),
          );
        }
        const membership = db
          .prepare(
            "INSERT OR IGNORE INTO memberships(libraryId,mediaId) VALUES(?,?)",
          )
          .run(libraryId, id);
        if (membership.changes) {
          changedIds.add(id);
          structural = true;
        }
        if (lib.type === "comic") {
          const sourceRoot = lib.roots
            .filter((root) => isWithin(root, canonical))
            .sort((a, b) => b.length - a.length)[0];
          if (sourceRoot) comicLibrary.autoGroup(id, normalized(sourceRoot));
        }
        if (
          lib.type === "video" &&
          (metadata.videoInfoVersion !== VIDEO_INFO_VERSION ||
            (!cover &&
              (reason === "manual" ||
                metadata.videoPosterVersion !== metadata.indexedVersion)))
        )
          enqueueVideoInfo(id);
      } catch {
        status.errors++;
      }
      status.processed++;
      emit();
    };
    for (const root of targets) {
      if (control.cancelled) break;
      const rootKey = normalized(root);
      let targetStat;
      try {
        // Do not purge children of an offline or inaccessible configured source.
        const source = lib.roots.find((source) => isWithin(source, root));
        if (!source) continue;
        await fs.access(source);
        targetStat = await fs.lstat(root);
        if (targetStat.isSymbolicLink()) continue;
      } catch (error: any) {
        if (
          partial &&
          (error?.code === "ENOENT" || error?.code === "ENOTDIR")
        ) {
          const source = lib.roots.find((source) => isWithin(source, root));
          if (
            source &&
            (await fs.stat(source).then(
              (st) => st.isDirectory(),
              () => false,
            ))
          )
            completeRoots.push(root);
        } else {
          status.errors++;
          status.message = `无法同步 ${path.basename(root)}：${error?.code ?? String(error)}`;
        }
        continue;
      }
      if (targetStat.isFile()) {
        if (EXTENSIONS[lib.type].has(path.extname(root).toLowerCase()))
          await indexFile(root);
        completeRoots.push(root);
        continue;
      }
      if (lib.type === "comic") {
        const visitDirectory = async (dir: string) => {
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            if (
              entries.some(
                (e) =>
                  e.isFile() &&
                  EXTENSIONS.image.has(path.extname(e.name).toLowerCase()),
              )
            )
              await indexFile(dir, true);
          } catch {
            status.errors++;
            incompleteRoots.add(rootKey);
          }
        };
        await visitDirectory(root);
        await walk(
          root,
          async (file, isDir) => {
            if (isDir) await visitDirectory(file);
            else if (EXTENSIONS.comic.has(path.extname(file).toLowerCase()))
              await indexFile(file);
          },
          control,
          () => {
            status.errors++;
            incompleteRoots.add(rootKey);
          },
        );
      } else {
        await walk(
          root,
          async (file, isDir) => {
            if (
              !isDir &&
              EXTENSIONS[lib.type].has(path.extname(file).toLowerCase())
            )
              await indexFile(file);
          },
          control,
          () => {
            status.errors++;
            incompleteRoots.add(rootKey);
          },
        );
      }
      if (!incompleteRoots.has(rootKey)) completeRoots.push(root);
    }
    if (!control.cancelled) {
      const staleIds = new Set<string>();
      for (const row of db
        .prepare(
          "SELECT m.id,m.path FROM media m JOIN memberships s ON m.id=s.mediaId WHERE s.libraryId=?",
        )
        .all(libraryId) as any[]) {
        if (
          !seen.has(row.path) &&
          completeRoots.some((root) => isWithin(root, row.path))
        ) {
          try {
            await fs.lstat(row.path);
            db.prepare(
              "DELETE FROM memberships WHERE libraryId=? AND mediaId=?",
            ).run(libraryId, row.id);
            const membership = db
              .prepare("SELECT 1 FROM memberships WHERE mediaId=? LIMIT 1")
              .get(row.id);
            if (!membership) staleIds.add(row.id);
          } catch (error: any) {
            if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
              staleIds.add(row.id);
          }
        }
      }
      await purgeMediaIds([...staleIds]);
    }
    status.status = control.cancelled ? "cancelled" : "done";
  } catch (error) {
    status.status = "error";
    status.message = String(error);
  } finally {
    activeScans.delete(libraryId);
    publishIndexChange(
      [...changedIds],
      [],
      structural,
      [libraryId],
      [lib.type],
    );
    emit(true);
    if (pendingRescans.delete(libraryId))
      setTimeout(() => void scan(libraryId, "background"), 300).unref();
  }
}
async function purgeMediaIds(ids: string[]) {
  const removedIds: string[] = [];
  const affectedLibraries = new Set<string>();
  const types = new Set<MediaType>();
  for (const id of new Set(ids)) {
    const row = db.prepare("SELECT path FROM media WHERE id=?").get(id) as
      { path: string } | undefined;
    if (!row) continue;
    const media = item(id);
    media.libraryIds.forEach((id) => affectedLibraries.add(id));
    types.add(media.type);
    removedIds.push(id);
    db.prepare("DELETE FROM media WHERE id=?").run(id);
    await fs.rm(path.join(dataDir, "cache", `${id}.jpg`), { force: true });
    await fs.rm(path.join(dataDir, "cache", id), {
      recursive: true,
      force: true,
    });
    comicArchives.invalidate(row.path);
  }
  publishIndexChange([], removedIds, true, [...affectedLibraries], [...types]);
}
async function settleChangedPaths(paths: string[]) {
  let previous = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = (
      await Promise.all(
        paths.map(async (file) => {
          try {
            const stat = await fs.stat(file);
            return `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
          } catch {
            return `${file}\0missing`;
          }
        }),
      )
    ).join("\n");
    if (snapshot === previous) return;
    previous = snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
function scheduleLibraryScan(libraryId: string, changedPath?: string) {
  if (changedPath) {
    const paths = pendingDirtyPaths.get(libraryId) ?? new Set<string>();
    if (paths.size < 512) paths.add(normalized(changedPath));
    else {
      paths.clear();
      for (const root of library(libraryId).roots) paths.add(normalized(root));
    }
    pendingDirtyPaths.set(libraryId, paths);
  }
  const previous = watcherTimers.get(libraryId);
  if (previous) clearTimeout(previous);
  if (activeScans.has(libraryId)) {
    pendingRescans.add(libraryId);
    return;
  }
  const timer = setTimeout(() => {
    watcherTimers.delete(libraryId);
    void scan(libraryId, "background");
  }, 750);
  timer.unref();
  watcherTimers.set(libraryId, timer);
}
async function refreshWatchers() {
  const candidates = libraries()
    .flatMap((entry) => entry.roots)
    .map((root) => normalized(root))
    .filter((root, index, all) => all.indexOf(root) === index)
    .sort((a, b) => a.length - b.length);
  const roots = candidates.filter(
    (root) =>
      !candidates.some((parent) => parent !== root && isWithin(parent, root)),
  );
  for (const [root, watcher] of watcherHandles) {
    if (roots.includes(root)) continue;
    watcher.close();
    watcherHandles.delete(root);
  }
  for (const root of roots) {
    if (watcherHandles.has(root)) continue;
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) continue;
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        const changed = filename
          ? normalized(path.resolve(root, filename.toString()))
          : root;
        for (const entry of libraries())
          if (
            entry.roots.some(
              (source) =>
                isWithin(source, changed) || isWithin(changed, source),
            )
          )
            scheduleLibraryScan(entry.id, changed);
      });
      watcher.on("error", () => {
        watcher.close();
        watcherHandles.delete(root);
      });
      watcherHandles.set(root, watcher);
    } catch {
      // An offline or inaccessible source remains indexed until a later reconcile.
    }
  }
}
let lastReconcile = 0;
let reconcileJob: Promise<void> | null = null;
function reconcileAll() {
  if (reconcileJob) return reconcileJob;
  if (Date.now() - lastReconcile < 60000) return Promise.resolve();
  lastReconcile = Date.now();
  reconcileJob = (async () => {
    await refreshWatchers();
    for (const entry of libraries()) await scan(entry.id, "background");
  })().finally(() => {
    reconcileJob = null;
  });
  return reconcileJob;
}

function protectedDirectory(target: string) {
  return libraries().some((lib) =>
    lib.roots.some((root) => isWithin(target, root)),
  );
}
function assertNotScanning(target: string) {
  for (const lib of libraries())
    if (
      lib.roots.some((root) => isWithin(root, target)) &&
      activeScans.has(lib.id)
    )
      throw new Error("请等待相关媒体库扫描完成或取消后再操作");
}
async function resolveTarget(id: string) {
  const [target] = resolveIds([id]);
  const value = await fs.realpath(target.path);
  const allowed = target.libraryIds.flatMap((libId) => library(libId).roots);
  if (!allowed.some((root) => isWithin(root, value)))
    throw new Error("文件已不在授权目录内");
  const stat = await fs.stat(value);
  if (target.kind === "folder" && !stat.isDirectory())
    throw new Error("文件夹已不存在");
  if (
    target.kind === "media" &&
    !stat.isFile() &&
    !(target.type === "comic" && stat.isDirectory())
  )
    throw new Error("文件已不存在");
  return { ...target, path: value, stat };
}
async function renameTarget(id: string, name: string) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 240 ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name)
  )
    throw new Error("名称无效");
  const target = await resolveTarget(id);
  if (protectedDirectory(target.path))
    throw new Error("来源目录或其父目录不能重命名");
  assertNotScanning(target.path);
  const file = target.kind === "media" && !target.stat.isDirectory();
  const base = file
    ? path.basename(target.path, path.extname(target.path))
    : path.basename(target.path);
  const ext = file ? path.extname(target.path) : "";
  const nextName = name.trim();
  if (
    file &&
    path.extname(nextName) &&
    path.extname(nextName).toLowerCase() !== ext.toLowerCase()
  )
    throw new Error("不能更改文件扩展名");
  const desired =
    file && !path.extname(nextName) ? `${nextName}${ext}` : nextName;
  if (!base || desired === path.basename(target.path)) return;
  const destination = path.join(path.dirname(target.path), desired);
  if (normalized(destination) === normalized(target.path)) return;
  if (
    await fs.access(destination).then(
      () => true,
      () => false,
    )
  )
    throw new Error("目标名称已存在");
  await fs.rename(target.path, destination);
  let transaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    const affected = db
      .prepare("SELECT id,path,folder,title,ext FROM media")
      .all() as any[];
    for (const row of affected) {
      if (isWithin(target.path, row.path)) {
        const relative = path.relative(target.path, row.path);
        const newPath = normalized(
          relative ? path.join(destination, relative) : destination,
        );
        const oldBase = path.basename(
          row.path,
          row.ext === "folder" ? undefined : path.extname(row.path),
        );
        const newTitle =
          !relative && row.title === oldBase
            ? path.basename(
                destination,
                file ? path.extname(destination) : undefined,
              )
            : row.title;
        const stat = await fs.stat(newPath);
        db.prepare(
          "UPDATE media SET path=?,folder=?,title=?,size=?,modifiedAt=?,changeTimeMs=?,missing=0 WHERE id=?",
        ).run(
          newPath,
          normalized(path.dirname(newPath)),
          newTitle,
          stat.size,
          Math.trunc(stat.mtimeMs),
          Math.trunc(stat.ctimeMs),
          row.id,
        );
      } else if (isWithin(target.path, row.folder)) {
        const relative = path.relative(target.path, row.folder);
        db.prepare("UPDATE media SET folder=? WHERE id=?").run(
          normalized(path.join(destination, relative)),
          row.id,
        );
      }
    }
    db.exec("COMMIT");
    transaction = false;
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    try {
      await fs.rename(destination, target.path);
    } catch (rollbackError) {
      throw new Error(
        `重命名索引更新失败，且无法恢复原文件名：${String(rollbackError)}`,
      );
    }
    throw error;
  }
  publishIndexChange(
    (db.prepare("SELECT id,path FROM media").all() as any[])
      .filter((row) => isWithin(destination, row.path))
      .map((row) => row.id),
    [],
    true,
  );
}
async function forgetPaths(paths: string[]) {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const value of [...new Set(paths)]) {
    try {
      try {
        await fs.lstat(value);
        throw new Error("文件仍在原位置，未更新索引");
      } catch (error: any) {
        if (error?.message === "文件仍在原位置，未更新索引") throw error;
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
      const rows = db.prepare("SELECT id,path FROM media").all() as any[];
      const matching = rows.filter((entry) =>
        isWithin(normalized(value), normalized(entry.path)),
      );
      await purgeMediaIds(matching.map((row) => row.id));
      removed.push(...matching.map((row) => row.id));
    } catch (error) {
      errors.push(`${path.basename(value)}：${String(error)}`);
    }
  }
  folderIndexes.clear();
  folderTokens.clear();
  return { removed, errors };
}
async function trashTarget(id: string) {
  const target = await resolveTarget(id);
  if (protectedDirectory(target.path))
    throw new Error("来源目录或其父目录不能移到回收站");
  assertNotScanning(target.path);
  return target;
}
function preference(key: string) {
  const row = db
    .prepare("SELECT value FROM preferences WHERE key=?")
    .get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}
function savePreference(key: string, value: unknown) {
  db.prepare(
    "INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
}
function musicPlaylists(): MusicPlaylist[] {
  return (
    db
      .prepare(
        "SELECT * FROM music_playlists ORDER BY updatedAt DESC,name COLLATE NOCASE",
      )
      .all() as any[]
  ).map((row) => ({
    ...row,
    songIds: (
      db
        .prepare(
          "SELECT mediaId FROM music_playlist_tracks WHERE playlistId=? ORDER BY position,mediaId",
        )
        .all(row.id) as any[]
    ).map((track) => track.mediaId),
  }));
}
function cleanMusicText(value: unknown, max = 300) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
async function fetchMusicJson(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000),
    headers: { "user-agent": "Mozilla/5.0 MediaBrowser/0.3" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 5 * 1024 * 1024) throw new Error("在线结果过大");
  return response.json();
}
function resultScore(queryText: string, title: string, artist = "") {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const queryValue = normalize(queryText);
  const titleValue = normalize(title);
  if (!queryValue || !titleValue) return 0;
  if (titleValue === queryValue) return 1;
  if (titleValue.includes(queryValue) || queryValue.includes(titleValue))
    return 0.85;
  const artistValue = normalize(artist);
  return artistValue && queryValue.includes(artistValue) ? 0.45 : 0.2;
}
async function searchMusicMetadata(
  id: string,
): Promise<MusicMetadataCandidate[]> {
  const media = item(id);
  if (media.type !== "music") throw new Error("只能为音乐搜索匹配信息");
  const queryText = [media.title, media.artist].filter(Boolean).join(" ");
  const encoded = encodeURIComponent(queryText);
  const attempts = await Promise.allSettled([
    (async () => {
      const result: any = await fetchMusicJson(
        `https://music.163.com/api/search/get/web?s=${encoded}&type=1&offset=0&total=true&limit=8`,
      );
      return (result?.result?.songs ?? []).map((song: any) => ({
        source: "netease" as const,
        remoteId: String(song.id),
        title: cleanMusicText(song.name),
        artist: cleanMusicText(
          song.artists?.map((entry: any) => entry.name).join(" / "),
        ),
        album: cleanMusicText(song.album?.name),
        coverUrl: cleanMusicText(song.album?.picUrl, 1000),
      }));
    })(),
    (async () => {
      const result: any = await fetchMusicJson(
        `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=8&w=${encoded}`,
      );
      return (result?.data?.song?.list ?? []).map((song: any) => ({
        source: "qq" as const,
        remoteId: cleanMusicText(song.songmid, 80),
        title: cleanMusicText(song.songname),
        artist: cleanMusicText(
          song.singer?.map((entry: any) => entry.name).join(" / "),
        ),
        album: cleanMusicText(song.albumname),
        coverUrl: song.albummid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(song.albummid)}.jpg`
          : "",
      }));
    })(),
    (async () => {
      const title = cleanMusicText(media.title, 160);
      const artist = cleanMusicText(media.artist ?? "", 160);
      const params = new URLSearchParams({ musicName: title, pageSize: "8" });
      if (artist) params.set("artistName", artist);
      const result: any = await fetchMusicJson(
        `https://api.amll.dev/v1/lyrics/search?${params.toString()}`,
      );
      const songs: any[] = result?.data?.items ?? [];
      return songs.flatMap((song) => {
        const songTitle = cleanMusicText(song.musicNames?.[0], 300);
        const songArtist = cleanMusicText(song.artistNames?.join(" / "), 300);
        const album = cleanMusicText(song.albumNames?.[0], 300);
        const candidates: MusicMetadataCandidate[] = [];
        for (const remoteId of song.ncmMusicIds ?? [])
          if (remoteId)
            candidates.push({
              source: "amll",
              platform: "ncm",
              remoteId: String(remoteId),
              title: songTitle,
              artist: songArtist,
              album,
            });
        for (const remoteId of song.qqMusicIds ?? [])
          if (remoteId)
            candidates.push({
              source: "amll",
              platform: "qq",
              remoteId: String(remoteId),
              title: songTitle,
              artist: songArtist,
              album,
            });
        return candidates;
      });
    })(),
  ]);
  const candidates = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? attempt.value : [],
  ) as MusicMetadataCandidate[];
  return candidates
    .filter((candidate) => candidate.remoteId && candidate.title)
    .map((candidate) => ({
      ...candidate,
      score: resultScore(queryText, candidate.title, candidate.artist),
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 18);
}
async function matchedLyrics(candidate: MusicMetadataCandidate) {
  if (candidate.source === "amll") {
    if (candidate.platform !== "ncm" && candidate.platform !== "qq") return "";
    const query = new URLSearchParams({
      [candidate.platform === "ncm" ? "ncmMusicId" : "qqMusicId"]:
        candidate.remoteId,
    });
    const result: any = await fetchMusicJson(
      `https://api.amll.dev/v1/lyrics/get?${query.toString()}`,
    );
    const lyric = result?.data?.lyrics;
    return typeof lyric === "string" && /<tt(?:\s|>)/i.test(lyric)
      ? lyric.slice(0, 2 * 1024 * 1024)
      : "";
  }
  if (candidate.source === "netease") {
    const result: any = await fetchMusicJson(
      `https://music.163.com/api/song/lyric?id=${encodeURIComponent(candidate.remoteId)}&lv=1&tv=1`,
    );
    return [result?.lrc?.lyric, result?.tlyric?.lyric]
      .filter((text) => typeof text === "string" && text)
      .join("\n");
  }
  if (candidate.source === "qq") {
    const result: any = await fetchMusicJson(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(candidate.remoteId)}&format=json&nobase64=1&songtype=0`,
    );
    return cleanMusicText(result?.lyric, 2 * 1024 * 1024);
  }
  return "";
}
function musicQueueIds(q: MediaQuery) {
  const queryValue = { ...q, type: "music" as const, browse: false };
  const first = query({ ...queryValue, offset: 0, limit: 1 });
  if (first.total > 100000) throw new Error("音乐队列最多支持 100000 首");
  const ids: string[] = [];
  for (let offset = 0; offset < first.total; offset += 200)
    ids.push(
      ...query({ ...queryValue, offset, limit: 200 }).items.map(
        (entry) => entry.id,
      ),
    );
  return ids;
}
function layoutMetrics(q: MediaQuery) {
  const total = query({ ...q, offset: 0, limit: 1 }).total;
  if (total > 200000) throw new Error("条目数量过大，无法为该布局建立尺寸索引");
  const result: { id: string; aspect: number }[] = [];
  for (let offset = 0; offset < total; offset += 200) {
    for (const entry of query({ ...q, offset, limit: 200 }).items) {
      const metadata = entry as MediaItem & { width?: number; height?: number };
      const measured =
        metadata.width && metadata.height
          ? metadata.width / metadata.height
          : entry.type === "video"
            ? 16 / 9
            : entry.type === "novel" || entry.type === "comic"
              ? 0.72
              : 1;
      result.push({
        id: entry.id,
        aspect: Math.max(0.25, Math.min(4, measured)),
      });
    }
  }
  return result;
}
const handlers: Record<string, (...args: any[]) => any> = {
  backupMusicDatabase: async () => {
    const directory = path.join(dataDir, "backups");
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `pre-folia-${Date.now()}.sqlite`);
    db.prepare("VACUUM INTO ?").run(target);
    return target;
  },
  libraries,
  statistics: () => {
    const counts: Record<MediaType, number> = {
      image: 0,
      music: 0,
      video: 0,
      novel: 0,
      comic: 0,
    };
    for (const row of db
      .prepare(
        "SELECT type,COUNT(*) AS n FROM media m WHERE EXISTS(SELECT 1 FROM memberships s WHERE s.mediaId=m.id) GROUP BY type",
      )
      .all() as any[])
      counts[row.type as MediaType] = row.n;
    return counts;
  },
  createLibrary: (input: {
    name: string;
    type: MediaType;
    roots: string[];
  }) => {
    const id = randomUUID();
    db.prepare("INSERT INTO libraries VALUES(?,?,?,?,?)").run(
      id,
      input.name.trim(),
      input.type,
      JSON.stringify(input.roots),
      Date.now(),
    );
    void refreshWatchers();
    return library(id);
  },
  addRoots: (id: string, roots: string[]) => {
    if (activeScans.has(id))
      throw new Error("请等待扫描完成或取消后再修改目录");
    const lib = library(id);
    db.prepare("UPDATE libraries SET roots=? WHERE id=?").run(
      JSON.stringify([...new Set([...lib.roots, ...roots])]),
      id,
    );
    folderIndexes.clear();
    folderTokens.clear();
    void refreshWatchers();
  },
  removeRoot: (id: string, root: string) => {
    if (activeScans.has(id)) throw new Error("请先取消扫描");
    const lib = library(id);
    const roots = lib.roots.filter((r) => r !== root);
    db.prepare("UPDATE libraries SET roots=? WHERE id=?").run(
      JSON.stringify(roots),
      id,
    );
    const orphanIds: string[] = [];
    for (const row of db
      .prepare(
        "SELECT m.id,m.path FROM media m JOIN memberships s ON m.id=s.mediaId WHERE s.libraryId=?",
      )
      .all(id) as any[])
      if (!roots.some((r) => isWithin(r, row.path)))
        db.prepare(
          "DELETE FROM memberships WHERE libraryId=? AND mediaId=?",
        ).run(id, row.id);
    for (const row of db
      .prepare(
        "SELECT id FROM media WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE memberships.mediaId=media.id)",
      )
      .all() as { id: string }[])
      orphanIds.push(row.id);
    if (orphanIds.length) void purgeMediaIds(orphanIds);
    folderIndexes.clear();
    folderTokens.clear();
    void refreshWatchers();
  },
  renameLibrary: (id: string, name: string) => {
    if (!name.trim()) throw new Error("请输入媒体库名称");
    db.prepare("UPDATE libraries SET name=? WHERE id=?").run(
      name.trim().slice(0, 80),
      id,
    );
  },
  removeLibrary: (id: string) => {
    if (activeScans.has(id)) throw new Error("请先取消扫描");
    db.prepare("DELETE FROM libraries WHERE id=?").run(id);
    const orphanIds = (
      db
        .prepare(
          "SELECT id FROM media WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE memberships.mediaId=media.id)",
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
    if (orphanIds.length) void purgeMediaIds(orphanIds);
    folderIndexes.clear();
    folderTokens.clear();
    for (const timer of [watcherTimers.get(id)]) if (timer) clearTimeout(timer);
    watcherTimers.delete(id);
    void refreshWatchers();
  },
  scan: (id: string) => {
    void scan(id);
  },
  reconcile: () => {
    void reconcileAll();
  },
  cancelScan: (id: string) => {
    const active = activeScans.get(id);
    if (active) active.cancelled = true;
  },
  item,
  videoFile: async (id: string) => {
    const value = item(id);
    if (value.type !== "video" || value.kind) throw new Error("不是视频文件");
    return { item: value, path: await authorizedFile(value) };
  },
  videoSubtitles: async (id: string) => {
    const value = item(id);
    if (value.type !== "video") throw new Error("不是视频文件");
    const file = await authorizedFile(value);
    const roots = value.libraryIds.flatMap((id) => library(id).roots);
    return matchingSubtitles(file, async (candidate) => {
      try {
        const resolved = await fs.realpath(candidate);
        return (
          roots.some((root) => isWithin(root, resolved)) &&
          (await fs.stat(resolved)).isFile()
        );
      } catch {
        return false;
      }
    });
  },
  videoPreferences: () => videoPreferences(preference("video-preferences")),
  saveVideoPreferences: (input: unknown) =>
    savePreference("video-preferences", videoPreferences(input as any)),
  videoQueue: (id: string, sort: string) => {
    const value = item(id);
    if (value.type !== "video") throw new Error("不是视频文件");
    const rows = db
      .prepare(
        "SELECT * FROM media WHERE type='video' AND folder=? AND missing=0",
      )
      .all(value.folder)
      .map(rowItem);
    rows.sort((a, b) =>
      sort === "added"
        ? b.addedAt - a.addedAt || naturalSort(a.title, b.title)
        : sort === "recent"
          ? (b.lastOpened ?? 0) - (a.lastOpened ?? 0) ||
            naturalSort(a.title, b.title)
          : naturalSort(a.title, b.title),
    );
    return rows;
  },
  resolveBrowseLocation: async (id: string, folder?: string) => {
    const lib = library(id);
    if (!folder) return null;
    let directory = normalized(folder);
    const root = lib.roots.find((root) => isWithin(root, directory));
    if (!root) return null;
    while (directory !== normalized(root)) {
      try {
        if ((await fs.stat(directory)).isDirectory()) return directory;
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")
          return directory;
      }
      directory = normalized(path.dirname(directory));
    }
    return lib.roots.length > 1 ? normalized(root) : null;
  },
  query: (q: MediaQuery) => ({ ...query(q), version: indexVersion }),
  layoutMetrics,
  musicQueueIds,
  musicItems: (ids: string[]) => {
    if (!Array.isArray(ids) || ids.length > 1000)
      throw new Error("无效的音乐条目列表");
    return resolveIds(ids)
      .filter(
        (target) =>
          target.kind === "media" && target.type === "music" && !target.missing,
      )
      .map((target) => item(target.id));
  },
  analyzeLoudness,
  musicSession: () => {
    db.prepare(
      "UPDATE media SET progress=NULL WHERE type='music' AND progress IS NOT NULL",
    ).run();
    const value = preference("music-session") as MusicSession | undefined;
    if (!value || !Array.isArray(value.queueIds)) return null;
    const queueIds = [...new Set(value.queueIds)]
      .slice(0, 100000)
      .filter((id) => {
        const row = db
          .prepare("SELECT type,missing FROM media WHERE id=?")
          .get(id) as any;
        return row?.type === "music" && !row.missing;
      });
    const track = value.trackId
      ? (db
          .prepare("SELECT type,missing FROM media WHERE id=?")
          .get(value.trackId) as any)
      : undefined;
    return {
      origin:
        value.origin?.trackId === value.trackId ? value.origin : undefined,
      trackId:
        track?.type === "music" && !track.missing ? value.trackId : undefined,
      queueIds,
      position: 0,
      volume: Math.max(0, Math.min(1, Number(value.volume) || 0)),
      muted: Boolean(value.muted),
      repeat: ["off", "all", "one"].includes(value.repeat)
        ? value.repeat
        : "off",
      order: value.order === "shuffle" ? "shuffle" : "sequential",
    } satisfies MusicSession;
  },
  saveMusicSession: (input: MusicSession) => {
    if (
      !input ||
      !Array.isArray(input.queueIds) ||
      input.queueIds.length > 100000
    )
      throw new Error("无效的播放会话");
    const ids = [...new Set(input.queueIds)].filter((id) => {
      const row = db
        .prepare("SELECT type,missing FROM media WHERE id=?")
        .get(id) as any;
      return row?.type === "music" && !row.missing;
    });
    const trackId = ids.includes(input.trackId ?? "")
      ? input.trackId
      : undefined;
    savePreference("music-session", {
      origin: input.origin?.trackId === trackId ? input.origin : undefined,
      trackId,
      queueIds: ids,
      position: 0,
      volume: Math.max(0, Math.min(1, Number(input.volume) || 0)),
      muted: Boolean(input.muted),
      repeat: ["off", "all", "one"].includes(input.repeat)
        ? input.repeat
        : "off",
      order: input.order === "shuffle" ? "shuffle" : "sequential",
    } satisfies MusicSession);
  },
  musicPlaylists,
  saveMusicPlaylist: (input: MusicPlaylist) => {
    if (
      !input ||
      !Array.isArray(input.songIds) ||
      input.songIds.length > 100000
    )
      throw new Error("无效的歌单");
    const id = cleanMusicText(input.id, 80) || randomUUID();
    const name = cleanMusicText(input.name, 80);
    if (!name) throw new Error("歌单名称不能为空");
    const now = Date.now();
    const createdAt = Number(input.createdAt) || now;
    const ids = [...new Set(input.songIds)].filter((mediaId) => {
      const row = db
        .prepare("SELECT type,missing FROM media WHERE id=?")
        .get(mediaId) as any;
      return row?.type === "music" && !row.missing;
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO music_playlists(id,name,createdAt,updatedAt) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updatedAt=excluded.updatedAt",
      ).run(id, name, createdAt, now);
      db.prepare("DELETE FROM music_playlist_tracks WHERE playlistId=?").run(
        id,
      );
      const insert = db.prepare(
        "INSERT INTO music_playlist_tracks(playlistId,mediaId,position) VALUES(?,?,?)",
      );
      ids.forEach((mediaId, position) => insert.run(id, mediaId, position));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  deleteMusicPlaylist: (id: string) => {
    db.prepare("DELETE FROM music_playlists WHERE id=?").run(id);
  },
  searchMusicMetadata,
  applyMusicCandidate: async (
    id: string,
    candidate: MusicMetadataCandidate,
    selectedFields: string[],
  ) => {
    const media = item(id);
    if (media.type !== "music") throw new Error("只能更新音乐信息");
    if (
      !candidate ||
      !["netease", "qq", "kugou", "amll"].includes(candidate.source)
    )
      throw new Error("无效的匹配结果");
    const fields = new Set(selectedFields);
    if (
      [...fields].some(
        (field) =>
          !["title", "artist", "album", "cover", "lyric"].includes(field),
      )
    )
      throw new Error("无效的匹配字段");
    if (
      candidate.source === "amll" &&
      [...fields].some((field) => field !== "lyric")
    )
      throw new Error("AMLL 匹配仅提供逐字歌词");
    const current: any = db
      .prepare("SELECT title,metadata,cover FROM media WHERE id=?")
      .get(id);
    if (!current) throw new Error("找不到音乐条目");
    const lyric = fields.has("lyric")
      ? (candidate.lyric || (await matchedLyrics(candidate))).slice(
          0,
          2 * 1024 * 1024,
        )
      : undefined;
    db.prepare(
      "INSERT OR IGNORE INTO music_overrides(mediaId,originalMetadata,originalCover,fields) VALUES(?,?,?,'{}')",
    ).run(
      id,
      JSON.stringify({ title: current.title, metadata: current.metadata }),
      current.cover,
    );
    const changes: Record<string, unknown> = {};
    if (fields.has("artist") && candidate.artist)
      changes.artist = cleanMusicText(candidate.artist);
    if (fields.has("album") && candidate.album)
      changes.album = cleanMusicText(candidate.album);
    if (fields.has("cover") && candidate.coverUrl) {
      let url: URL;
      try {
        url = new URL(candidate.coverUrl);
      } catch {
        throw new Error("封面地址无效");
      }
      const allowedHosts = [
        "music.126.net",
        "music.163.com",
        "y.qq.com",
        "gtimg.cn",
        "kugou.com",
        "kugou.net",
      ];
      if (
        url.protocol !== "https:" ||
        !allowedHosts.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      )
        throw new Error("封面来源不受支持");
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const contentType = response.headers.get("content-type") ?? "";
      const length = Number(response.headers.get("content-length") ?? 0);
      if (
        !response.ok ||
        !contentType.startsWith("image/") ||
        length > 8 * 1024 * 1024
      )
        throw new Error("无法下载该封面");
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > 8 * 1024 * 1024) throw new Error("封面文件过大");
      const cover = await thumbnail(data, id);
      db.prepare("UPDATE media SET cover=? WHERE id=?").run(cover, id);
    }
    if (fields.has("title") && candidate.title)
      db.prepare("UPDATE media SET title=? WHERE id=?").run(
        cleanMusicText(candidate.title),
        id,
      );
    const oldFields = db
      .prepare("SELECT fields FROM music_overrides WHERE mediaId=?")
      .get(id) as { fields: string };
    const merged = { ...JSON.parse(oldFields.fields), ...changes };
    db.prepare(
      "UPDATE music_overrides SET fields=?,lyric=COALESCE(?,lyric),source=? WHERE mediaId=?",
    ).run(JSON.stringify(merged), lyric ?? null, candidate.source, id);
    folderIndexes.clear();
    folderTokens.clear();
  },
  restoreMusicMetadata: (id: string) => {
    const row = db
      .prepare(
        "SELECT originalMetadata,originalCover FROM music_overrides WHERE mediaId=?",
      )
      .get(id) as any;
    if (!row) return;
    const original = JSON.parse(row.originalMetadata);
    db.prepare("UPDATE media SET title=?,metadata=?,cover=? WHERE id=?").run(
      original.title,
      original.metadata,
      row.originalCover,
      id,
    );
    db.prepare("DELETE FROM music_overrides WHERE mediaId=?").run(id);
    folderIndexes.clear();
    folderTokens.clear();
  },
  resolveIds: (ids: string[]) => resolveIds(ids),
  resolvePaths: async (ids: string[]) =>
    Promise.all(
      ids.map(async (id) => {
        const target = await resolveTarget(id);
        return {
          id: target.id,
          path: target.path,
          title: target.title,
          kind: target.kind,
          isDirectory: target.stat.isDirectory(),
          type: target.type,
          favorite: target.favorite,
          libraryIds: target.libraryIds,
        };
      }),
    ),
  resolveTrash: async (ids: string[]) =>
    Promise.all(
      ids.map(async (id) => {
        const [target] = resolveIds([id]);
        const sourceRoots = target.libraryIds
          .flatMap((libId) => library(libId).roots)
          .filter((root) => isWithin(root, target.path));
        if (!sourceRoots.length) throw new Error("文件已不在授权目录内");
        let accessible = false;
        for (const root of sourceRoots) {
          try {
            accessible = (await fs.stat(root)).isDirectory();
            if (accessible) break;
          } catch {
            // Keep checking overlapping roots before treating the file as absent.
          }
        }
        if (!accessible) throw new Error("来源文件夹不可访问，未清理索引");
        if (protectedDirectory(target.path))
          throw new Error("来源目录或其父目录不能移到回收站");
        assertNotScanning(target.path);
        try {
          await fs.lstat(target.path);
        } catch (error: any) {
          if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
            return {
              id: target.id,
              path: target.path,
              title: target.title,
              kind: target.kind,
              missing: true,
            };
          throw error;
        }
        const checked = await trashTarget(id);
        return {
          id: checked.id,
          path: checked.path,
          title: checked.title,
          kind: checked.kind,
          isDirectory: checked.stat.isDirectory(),
          missing: false,
        };
      }),
    ),
  renameTarget,
  forgetPaths,
  folders: (libraryId?: string) =>
    db
      .prepare(
        `SELECT m.folder AS path,COUNT(*) AS count FROM media m WHERE ${libraryId ? "EXISTS(SELECT 1 FROM memberships s WHERE s.mediaId=m.id AND s.libraryId=?)" : "EXISTS(SELECT 1 FROM memberships s WHERE s.mediaId=m.id)"} GROUP BY m.folder ORDER BY m.folder`,
      )
      .all(...(libraryId ? [libraryId] : [])),
  favorite: (id: string, value: boolean) =>
    db
      .prepare("UPDATE media SET favorite=? WHERE id=?")
      .run(value ? 1 : 0, id) && undefined,
  clearRecent: (id?: string) => {
    if (id !== undefined && !/^[a-f0-9]{32}$/.test(id))
      throw new Error("无效的媒体标识");
    return Number(
      db
        .prepare(
          `UPDATE media SET lastOpened=NULL WHERE lastOpened IS NOT NULL${id ? " AND id=?" : ""}`,
        )
        .run(...(id ? [id] : [])).changes,
    );
  },
  opened: (id: string) =>
    db
      .prepare("UPDATE media SET lastOpened=? WHERE id=?")
      .run(Date.now(), id) && undefined,
  saveProgress: (id: string, progress: unknown) => {
    const result = db
      .prepare("UPDATE media SET progress=? WHERE id=? AND type<>'music'")
      .run(JSON.stringify(progress), id);
    // Video playback also saves from the native host. Notify cached directory
    // lists so the watch indicator is current when the player closes.
    if (result.changes && item(id).type === "video") publishIndexChange([id]);
  },
  readText: async (id: string, encoding?: string) => {
    const media = item(id);
    if (media.type !== "novel" || media.ext !== "txt")
      throw new Error("不是 TXT 小说");
    const file = await authorizedFile(media);
    if ((await fs.stat(file)).size > 50 * 1024 * 1024)
      throw new Error("TXT 超过 50 MB，请拆分后阅读");
    const data = await fs.readFile(file);
    const detected =
      encoding ||
      (["UTF-8", "ASCII"].includes(detect(data) || "") ? "utf-8" : "gb18030");
    if (!["utf-8", "gb18030", "utf16-le", "utf16-be"].includes(detected))
      throw new Error("不支持的编码");
    return { text: iconv.decode(data, detected), encoding: detected };
  },
  lyrics: async (id: string) => {
    const media = item(id);
    if (media.type !== "music") return null;
    const matched = db
      .prepare("SELECT lyric FROM music_overrides WHERE mediaId=?")
      .get(id) as { lyric?: string } | undefined;
    if (matched?.lyric) return matched.lyric;
    const file = await authorizedFile(media);
    const embedded = JSON.parse(
      (db.prepare("SELECT metadata FROM media WHERE id=?").get(id) as any)
        .metadata,
    ).embeddedLyrics;
    if (typeof embedded === "string" && embedded) return embedded;
    const base = file.slice(0, -path.extname(file).length);
    for (const extension of [
      ".lrc",
      ".ttml",
      ".xml",
      ".vtt",
      ".qrc",
      ".yrc",
      ".krc",
    ]) {
      try {
        const resolved = await fs.realpath(base + extension);
        if (!isWithin(path.dirname(file), resolved)) continue;
        const stat = await fs.stat(resolved);
        if (stat.size > 2 * 1024 * 1024) continue;
        let data: Uint8Array = await fs.readFile(resolved);
        if (extension === ".krc") {
          try {
            data = decodeKrc(Buffer.from(data));
          } catch {
            continue;
          }
        }
        const encoding = detect(data) === "UTF-8" ? "utf-8" : "gb18030";
        return iconv.decode(data, encoding).replace(/^\uFEFF/, "");
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
    return null;
  },
  comicPages: async (id: string, session?: string) => {
    const media = item(id);
    if (media.type !== "comic") throw new Error("不是漫画");
    if (session) comicSessions.set(id, session);
    const file = await authorizedFile(media);
    const manifest = await comicArchives.manifest(file);
    return manifest.pages.map((entry, index) => ({
      id: entry.name.replaceAll("\\", "/"),
      name: entry.name,
      ...manifest.metrics.get(entry.name),
      url: `media://asset/${id}/page/${index}?v=${media.resourceVersion ?? media.modifiedAt}`,
    }));
  },
  comicPageMetrics: async (id: string, indices: number[]) => {
    const media = item(id);
    if (
      media.type !== "comic" ||
      !Array.isArray(indices) ||
      indices.length > 12 ||
      indices.some((i) => !Number.isSafeInteger(i) || i < 0)
    )
      throw new Error("无效的漫画页面请求");
    const file = await authorizedFile(media);
    return Promise.all(
      indices.map(async (index) => ({
        index,
        ...(await comicArchives.dimensions(file, index)),
      })),
    );
  },
  releaseComic: (id: string, session?: string) => {
    if (session && comicSessions.get(id) !== session) return;
    comicSessions.delete(id);
    const media = item(id);
    if (media.type === "comic") comicArchives.release(media.path);
  },
  comicContext: (id: string) => comicLibrary.context(id),
  comicWorks: () => comicLibrary.works(),
  saveComicWork: (work: import("../shared/types").ComicWork) =>
    comicLibrary.save(work),
  deleteComicWork: (id: string) => comicLibrary.delete(id),
  saveComicPreferences: (
    id: string,
    prefs: import("../shared/comic").ComicPreferences,
  ) => comicLibrary.preferences(id, prefs),
  saveComicBookmark: (mark: import("../shared/types").ComicBookmark) =>
    comicLibrary.bookmark(mark),
  deleteComicBookmark: (id: string) => comicLibrary.deleteBookmark(id),
  resource: async (id: string, variant: string, index?: number) => {
    const folder = folderTokens.get(id);
    if (folder && variant === "cover") {
      const lib = library(folder.libraryId);
      if (!lib.roots.some((root) => isWithin(root, folder.path)))
        throw new Error("文件夹不在授权范围内");
      const entry = folderIndex(folder.libraryId, lib.type).toFolderItem(
        folder.path,
        folder.libraryId,
      );
      if (!entry?.cover) throw new Error("文件夹媒体没有缩略图");
      return {
        path: path.join(dataDir, "cache", entry.cover),
        mime: "image/jpeg",
      };
    }
    const media = item(id);
    const file = await authorizedFile(media);
    if (variant === "cover") {
      if (!media.cover) throw new Error("没有封面");
      return {
        path: path.join(dataDir, "cache", media.cover),
        mime: "image/jpeg",
      };
    }
    if (variant === "page") {
      if (media.type !== "comic") throw new Error("不是漫画");
      return { path: await comicArchives.page(file, index ?? -1) };
    }
    if (media.ext === "epub") {
      if ((await fs.stat(file)).size > 200 * 1024 * 1024)
        throw new Error("EPUB 超过 200 MB");
      await zipEntries(file);
    }
    if (media.ext === "folder") throw new Error("目录不能作为文件打开");
    return { path: file };
  },
  reveal: async (id: string) => (await resolveTarget(id)).path,
  setVideoCover: async (id: string, data: string) => {
    const media = item(id);
    if (
      media.type !== "video" ||
      !/^data:image\/(jpeg|png);base64,/.test(data) ||
      data.length > 3 * 1024 * 1024
    )
      throw new Error("无效封面");
    const cover = await thumbnail(
      Buffer.from(data.split(",")[1], "base64"),
      id,
    );
    const metadata = JSON.parse(
      (db.prepare("SELECT metadata FROM media WHERE id=?").get(id) as any)
        .metadata,
    );
    metadata.resourceVersion = Date.now();
    db.prepare("UPDATE media SET cover=?,metadata=? WHERE id=?").run(
      cover,
      JSON.stringify(metadata),
      id,
    );
    publishIndexChange([id]);
  },
  settings: () => {
    const stored = preference("settings") ?? {};
    const settings = normalizeStoredSettings(stored);
    if (JSON.stringify(stored) !== JSON.stringify(settings))
      savePreference("settings", settings);
    return settings;
  },
  saveSettings: (settings: unknown) => {
    savePreference("settings", settings);
  },
  clearCache: async () => {
    if (activeScans.size) throw new Error("请等待扫描结束后再清理缓存");
    await comicArchives.clear();
    await fs.rm(path.join(dataDir, "cache"), { recursive: true, force: true });
    await fs.mkdir(path.join(dataDir, "cache"), { recursive: true });
    db.prepare(
      "UPDATE media SET cover=NULL,metadata=json_remove(metadata,'$.indexedVersion')",
    ).run();
    db.prepare("UPDATE music_overrides SET originalCover=NULL").run();
  },
};
port.on(
  "message",
  async ({ data }: { data: { id: number; method: string; args: any[] } }) => {
    try {
      const fn = handlers[data.method];
      if (!fn) throw new Error("未知操作");
      const result = await fn(...data.args);
      port.postMessage({ id: data.id, result });
    } catch (error) {
      port.postMessage({
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
port.postMessage({ event: "ready" });
void reconcileAll().catch((error) =>
  console.error("Initial reconciliation failed", error),
);
