import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  OnlineComicRef,
  OnlineChapterRef,
} from "../../shared/onlineComics";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const comicKey = (ref: OnlineComicRef) =>
  digest(JSON.stringify([ref.sourceId, ref.comicId]));
export const chapterKey = (ref: OnlineChapterRef) =>
  digest(JSON.stringify([ref.sourceId, ref.comicId, ref.chapterId]));
export class OnlineComicStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 1) {
      this.db.close();
      throw new Error("在线漫画数据库版本高于当前应用，请使用较新版本");
    }
    if (version === 0)
      this.db.exec(
        "BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1; COMMIT;",
      );
  }
  get<T = any>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind=? AND id=?")
      .get(kind, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  all<T = any>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid")
        .all(kind) as { value: string }[]
    ).map((row) => JSON.parse(row.value));
  }
  set(kind: string, id: string, value: any) {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, id, JSON.stringify(value));
  }
  delete(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  close() {
    this.db.close();
  }
}
