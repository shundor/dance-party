import { DB } from "./db.js";
import type { Session } from "./auth.js";
import type { VideoInfo } from "./youtube.js";

export interface QueueItem {
  id: number;
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  addedBy: string;
  addedByToken: string;
  playedAt: number | null;
}

export class QueueError extends Error {}

interface Row {
  id: number;
  video_id: string;
  title: string;
  channel: string;
  thumbnail: string;
  added_by_name: string;
  added_by_token: string;
  played_at: number | null;
}

function toItem(r: Row): QueueItem {
  return {
    id: r.id,
    videoId: r.video_id,
    title: r.title,
    channel: r.channel,
    thumbnail: r.thumbnail,
    addedBy: r.added_by_name,
    addedByToken: r.added_by_token,
    playedAt: r.played_at ?? null,
  };
}

export class Jukebox {
  paused = false;

  constructor(
    private db: DB,
    public guestLimit = 3,
  ) {}

  current(): QueueItem | null {
    const r = this.db.prepare("SELECT * FROM queue WHERE status = 'playing' LIMIT 1").get() as Row | undefined;
    return r ? toItem(r) : null;
  }

  list(): QueueItem[] {
    const rows = this.db
      .prepare("SELECT * FROM queue WHERE status = 'queued' ORDER BY position ASC, id ASC")
      .all() as Row[];
    return rows.map(toItem);
  }

  /** Songs that finished playing, most recent first. Songs the TV couldn't play aren't included. */
  recent(limit = 10): QueueItem[] {
    const rows = this.db
      .prepare("SELECT * FROM queue WHERE status = 'played' ORDER BY played_at DESC, id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(toItem);
  }

  /**
   * Every song ever played, most recent first, kept permanently in the database.
   * Paged with a cursor (`before` = the `cursor` of the last item on the previous page);
   * `query` matches the title, channel or who added it.
   */
  history({ limit = 50, before, query }: { limit?: number; before?: string; query?: string } = {}): {
    items: QueueItem[];
    total: number;
    next: string | null;
  } {
    limit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const where = ["status = 'played'"];
    const args: (string | number)[] = [];
    const q = query?.trim().slice(0, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR channel LIKE ? ESCAPE '\\' OR added_by_name LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
    const m = /^(\d+):(\d+)$/.exec(before ?? "");
    if (m) {
      // Songs played before timestamps were recorded have played_at NULL and sort last (as 0).
      where.push("(COALESCE(played_at, 0) < ? OR (COALESCE(played_at, 0) = ? AND id < ?))");
      args.push(Number(m[1]), Number(m[1]), Number(m[2]));
    }
    const rows = this.db
      .prepare(`SELECT * FROM queue WHERE ${where.join(" AND ")} ORDER BY COALESCE(played_at, 0) DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1) as Row[];
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(toItem);
    const last = items.at(-1);
    return { items, total, next: more && last ? `${last.playedAt ?? 0}:${last.id}` : null };
  }

  countFor(token: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM queue WHERE status = 'queued' AND added_by_token = ?")
      .get(token) as { n: number };
    return r.n;
  }

  add(video: VideoInfo, by: Session): QueueItem {
    const dup = this.db
      .prepare("SELECT 1 FROM queue WHERE video_id = ? AND status IN ('queued', 'playing')")
      .get(video.videoId);
    if (dup) throw new QueueError("That song is already in the queue.");
    if (by.role !== "admin" && this.countFor(by.token) >= this.guestLimit) {
      throw new QueueError(`You can only have ${this.guestLimit} songs waiting. Try again after one plays.`);
    }
    const max = this.db.prepare("SELECT MAX(position) AS p FROM queue WHERE status = 'queued'").get() as {
      p: number | null;
    };
    const position = (max.p ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO queue (video_id, title, channel, thumbnail, added_by_token, added_by_name, position, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(video.videoId, video.title, video.channel, video.thumbnail, by.token, by.name, position, Date.now());
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): QueueItem | null {
    const r = this.db.prepare("SELECT * FROM queue WHERE id = ?").get(id) as Row | undefined;
    return r ? toItem(r) : null;
  }

  remove(id: number): void {
    const res = this.db.prepare("UPDATE queue SET status = 'removed' WHERE id = ? AND status = 'queued'").run(id);
    if (res.changes === 0) throw new QueueError("That song is no longer in the queue.");
  }

  promote(id: number): void {
    const min = this.db.prepare("SELECT MIN(position) AS p FROM queue WHERE status = 'queued'").get() as {
      p: number | null;
    };
    const res = this.db
      .prepare("UPDATE queue SET position = ? WHERE id = ? AND status = 'queued'")
      .run((min.p ?? 1) - 1, id);
    if (res.changes === 0) throw new QueueError("That song is no longer in the queue.");
  }

  /**
   * Finishes the current song (if any) and starts the next one. Returns the new current song.
   * `failed` means the TV couldn't play it, so it's dropped instead of counted as played.
   */
  advance({ failed = false } = {}): QueueItem | null {
    const tx = this.db.transaction(() => {
      if (failed) this.db.prepare("UPDATE queue SET status = 'removed' WHERE status = 'playing'").run();
      else this.db.prepare("UPDATE queue SET status = 'played', played_at = ? WHERE status = 'playing'").run(Date.now());
      const next = this.db
        .prepare("SELECT id FROM queue WHERE status = 'queued' ORDER BY position ASC, id ASC LIMIT 1")
        .get() as { id: number } | undefined;
      if (next) this.db.prepare("UPDATE queue SET status = 'playing' WHERE id = ?").run(next.id);
    });
    tx();
    this.paused = false;
    return this.current();
  }
}

