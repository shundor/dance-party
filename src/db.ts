import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
      room_code TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT '',
      thumbnail TEXT NOT NULL DEFAULT '',
      added_by_token TEXT NOT NULL,
      added_by_name TEXT NOT NULL,
      position REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'playing', 'played', 'removed')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS queue_status_pos ON queue(status, position);
  `);
  // Added after the first release: when a song finished (for "Recently played").
  const cols = db.prepare("PRAGMA table_info(queue)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "played_at")) db.exec("ALTER TABLE queue ADD COLUMN played_at INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS queue_history ON queue(status, played_at, id)");
  return db;
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
