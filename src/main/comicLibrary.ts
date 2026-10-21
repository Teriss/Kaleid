import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ComicWork, ComicBookmark, MediaItem } from "../shared/types";
import { comicPreferences, type ComicPreferences } from "../shared/comic";
import { DEFAULT_SETTINGS } from "../shared/types";
import { naturalSort } from "./core";

export class ComicLibrary {
  constructor(
    private db: DatabaseSync,
    private getItem: (id: string) => MediaItem,
  ) {}
  async migrate(dataDir: string) {
    const exists = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='comic_works'",
      )
      .get();
    if (
      !exists &&
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM media").get() as {
          n: number;
        }
      ).n
    ) {
      await fs.mkdir(path.join(dataDir, "backups"), { recursive: true });
      this.db
        .prepare("VACUUM INTO ?")
        .run(path.join(dataDir, "backups", `pre-comic-${Date.now()}.sqlite`));
    }
    this.db.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS comic_works(id TEXT PRIMARY KEY,title TEXT NOT NULL,preferences TEXT NOT NULL DEFAULT '{}',automatic INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS comic_chapters(mediaId TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,workId TEXT NOT NULL REFERENCES comic_works(id) ON DELETE CASCADE,position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_comic_chapters ON comic_chapters(workId,position);
      CREATE TABLE IF NOT EXISTS comic_bookmarks(id TEXT PRIMARY KEY,mediaId TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,pageId TEXT NOT NULL,page INTEGER NOT NULL,offset REAL NOT NULL,createdAt INTEGER NOT NULL);
      PRAGMA user_version=4;
      COMMIT;`);
  }
  private comic(id: string) {
    const item = this.getItem(id);
    if (item.type !== "comic") throw new Error("不是漫画");
    return item;
  }
  private work(id: string): ComicWork | undefined {
    const row = this.db
      .prepare("SELECT * FROM comic_works WHERE id=?")
      .get(id) as any;
    return row
      ? {
          id: row.id,
          title: row.title,
          preferences: JSON.parse(row.preferences),
          automatic: Boolean(row.automatic),
          chapterIds: this.db
            .prepare(
              "SELECT mediaId FROM comic_chapters WHERE workId=? ORDER BY position,mediaId",
            )
            .all(id)
            .map((r: any) => r.mediaId),
        }
      : undefined;
  }
  works() {
    return this.db
      .prepare("SELECT id FROM comic_works ORDER BY title COLLATE NOCASE")
      .all()
      .map((r: any) => this.work(r.id)!);
  }
  context(id: string) {
    this.comic(id);
    const link = this.db
      .prepare("SELECT workId FROM comic_chapters WHERE mediaId=?")
      .get(id) as any;
    const work = link ? this.work(link.workId) : undefined;
    const stored = this.db
      .prepare("SELECT value FROM preferences WHERE key=?")
      .get(`comic:prefs:${id}`) as any;
    return {
      work,
      chapters: (work?.chapterIds ?? [id])
        .map(this.getItem)
        .filter((c) => !c.missing && c.libraryIds.length),
      preferences:
        work?.preferences ?? (stored ? JSON.parse(stored.value) : {}),
      bookmarks: this.db
        .prepare(
          "SELECT * FROM comic_bookmarks WHERE mediaId=? ORDER BY createdAt",
        )
        .all(id) as unknown as ComicBookmark[],
    };
  }
  save(work: ComicWork) {
    if (
      !work ||
      typeof work.id !== "string" ||
      work.id.length > 100 ||
      !work.title?.trim() ||
      work.title.length > 200 ||
      !Array.isArray(work.chapterIds) ||
      work.chapterIds.length > 20000 ||
      new Set(work.chapterIds).size !== work.chapterIds.length
    )
      throw new Error("无效的漫画作品");
    for (const id of work.chapterIds) this.comic(id);
    this.db.exec("BEGIN");
    try {
      const old = this.work(work.id);
      for (const id of old?.chapterIds ?? [])
        if (!work.chapterIds.includes(id)) this.keepUngrouped(id);
      this.db
        .prepare(
          "INSERT INTO comic_works(id,title,preferences,automatic) VALUES(?,?,?,0) ON CONFLICT(id) DO UPDATE SET title=excluded.title,automatic=0",
        )
        .run(
          work.id,
          work.title.trim(),
          JSON.stringify(old?.preferences ?? {}),
        );
      this.db.prepare("DELETE FROM comic_chapters WHERE workId=?").run(work.id);
      const insert = this.db.prepare(
        "INSERT INTO comic_chapters(mediaId,workId,position) VALUES(?,?,?) ON CONFLICT(mediaId) DO UPDATE SET workId=excluded.workId,position=excluded.position",
      );
      work.chapterIds.forEach((id, index) => insert.run(id, work.id, index));
      this.db
        .prepare(
          "DELETE FROM comic_works WHERE automatic=1 AND NOT EXISTS(SELECT 1 FROM comic_chapters WHERE workId=comic_works.id)",
        )
        .run();
      this.db.exec("COMMIT");
      return this.work(work.id)!;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private keepUngrouped(id: string) {
    this.db
      .prepare(
        "INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`comic:manual:${id}`, "true");
  }
  delete(id: string) {
    this.db.exec("BEGIN");
    try {
      for (const mediaId of this.work(id)?.chapterIds ?? [])
        this.keepUngrouped(mediaId);
      this.db.prepare("DELETE FROM comic_works WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  preferences(id: string, prefs: Partial<ComicPreferences>) {
    this.comic(id);
    const checked = comicPreferences(DEFAULT_SETTINGS, prefs);
    const context = this.context(id);
    if (context.work)
      this.db
        .prepare("UPDATE comic_works SET preferences=? WHERE id=?")
        .run(JSON.stringify(checked), context.work.id);
    else
      this.db
        .prepare(
          "INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(`comic:prefs:${id}`, JSON.stringify(checked));
  }
  bookmark(mark: ComicBookmark) {
    this.comic(mark?.mediaId);
    if (
      typeof mark.id !== "string" ||
      mark.id.length > 100 ||
      typeof mark.pageId !== "string" ||
      mark.pageId.length > 4096 ||
      !Number.isSafeInteger(mark.page) ||
      mark.page < 0 ||
      !Number.isFinite(mark.offset) ||
      mark.offset < 0 ||
      mark.offset > 1
    )
      throw new Error("无效漫画书签");
    this.db
      .prepare(
        "INSERT INTO comic_bookmarks(id,mediaId,pageId,page,offset,createdAt) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        mark.id,
        mark.mediaId,
        mark.pageId,
        mark.page,
        mark.offset,
        Date.now(),
      );
  }
  deleteBookmark(id: string) {
    this.db.prepare("DELETE FROM comic_bookmarks WHERE id=?").run(id);
  }
  autoGroup(id: string, root: string) {
    const media = this.comic(id),
      series = media.comicInfo?.series?.trim();
    if (!series) return;
    if (
      this.db
        .prepare("SELECT 1 FROM preferences WHERE key=?")
        .get(`comic:manual:${id}`)
    )
      return;
    const link = this.db
      .prepare("SELECT workId FROM comic_chapters WHERE mediaId=?")
      .get(id) as any;
    // Explicit user organisation always wins over inferred metadata.
    if (link) return;
    const key = createHash("sha256")
      .update(`${root}:${series.normalize("NFKC").toLowerCase()}`)
      .digest("hex")
      .slice(0, 32);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO comic_works(id,title,automatic) VALUES(?,?,1)",
      )
      .run(key, series);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO comic_chapters(mediaId,workId,position) VALUES(?,?,0)",
      )
      .run(id, key);
    const chapters = this.work(key)!
      .chapterIds.map(this.getItem)
      .sort((a, b) =>
        naturalSort(
          `${a.comicInfo?.volume ?? ""}:${a.comicInfo?.number ?? a.title}`,
          `${b.comicInfo?.volume ?? ""}:${b.comicInfo?.number ?? b.title}`,
        ),
      );
    const update = this.db.prepare(
      "UPDATE comic_chapters SET position=? WHERE mediaId=?",
    );
    chapters.forEach((m, i) => update.run(i, m.id));
  }
}
