import { DatabaseSync } from "node:sqlite";

export class NovelStore {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 1) {
      this.db.close();
      throw new Error("在线小说数据版本较新，请升级应用");
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;",
    );
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind=? AND id=?")
      .get(kind, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  all<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  set(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, id, JSON.stringify(value));
  }
  delete(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  clear(kind: string) {
    this.db.prepare("DELETE FROM records WHERE kind=?").run(kind);
  }
  close() {
    this.db.close();
  }
}
