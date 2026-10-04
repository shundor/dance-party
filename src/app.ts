import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import { Server, Socket } from "socket.io";
import { Auth, JoinError, Session } from "./auth.js";
import { openDb } from "./db.js";
import { Jukebox, QueueError, QueueItem } from "./queue.js";
import { fetchVideoInfo, isVideoId, parseVideoId, searchVideos, VideoNotFoundError } from "./youtube.js";

export interface Config {
  port: number;
  adminPin: string;
  tvKey: string;
  youtubeApiKey?: string;
  guestQueueLimit: number;
  dbPath: string;
  roomCode?: string;
  publicUrl?: string;
  /** Hostname other devices use for the TV page (YouTube refuses some embeds on bare-IP origins). */
  tvHost?: string;
}

export interface Deps {
  fetch?: typeof fetch;
}

type Ack = (res: { ok: boolean; error?: string; [k: string]: unknown }) => void;

const YT_ERRORS: Record<number, string> = {
  2: "invalid video ID",
  5: "the TV browser can't play this video",
  100: "video not found or private",
  101: "the owner doesn't allow it to be played outside YouTube",
  150: "the owner doesn't allow it to be played outside YouTube",
  152: "YouTube blocked playback in this player",
  153: "YouTube blocked playback (missing referrer) — open the TV page in Chrome or Safari",
};

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Short public identifier for a session so clients can recognize "their" songs without seeing tokens. */
export function ownerId(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function lanUrl(port: number): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return `http://${a.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

/** This machine's Bonjour/mDNS name, e.g. "mymac.local", which other LAN devices can resolve. */
export function mdnsHost(): string | undefined {
  let name = "";
  if (process.platform === "darwin") {
    try {
      name = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // fall back to os.hostname()
    }
  }
  if (!name) name = os.hostname().split(".")[0];
  name = name.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return name && name !== "localhost" ? `${name}.local` : undefined;
}

/**
 * YouTube refuses many embeds (error 150) when the page's origin is a bare IP address, but plays them on
 * localhost or any hostname. Returns where to redirect a /tv request opened by IP, or undefined to serve it.
 */
export function tvRedirect(opts: {
  hostname: string;
  port: number;
  url: string;
  remoteAddress: string | undefined;
  tvHost: string | undefined;
}): string | undefined {
  const host = opts.hostname.replace(/^\[|\]$/g, "");
  if (!net.isIP(host) || isLoopbackHost(host)) return undefined;
  if (isThisMachine(opts.remoteAddress)) return `http://localhost:${opts.port}${opts.url}`;
  if (opts.tvHost) return `http://${opts.tvHost}:${opts.port}${opts.url}`;
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isThisMachine(remote: string | undefined): boolean {
  if (!remote) return false;
  const addr = remote.replace(/^::ffff:/, "");
  return Object.values(os.networkInterfaces()).some((list) => list?.some((a) => a.address === addr));
}

function publicItem(item: QueueItem | null) {
  if (!item) return null;
  const { addedByToken, ...rest } = item;
  return { ...rest, owner: ownerId(addedByToken) };
}

export function createDanceParty(config: Config, deps: Deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const db = openDb(config.dbPath);
  const auth = new Auth(db, config.adminPin, config.roomCode);
  const jukebox = new Jukebox(db, config.guestQueueLimit);
  if (!jukebox.current()) jukebox.advance();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  const state = () => ({
    current: publicItem(jukebox.current()),
    queue: jukebox.list().map(publicItem),
    recent: jukebox.recent().map(publicItem),
    paused: jukebox.paused,
    guestLimit: jukebox.guestLimit,
    roomCode: auth.roomCode,
  });
  // Read-only /queue viewers aren't signed in: no room code and no owner ids.
  const viewerState = () => {
    const strip = (item: ReturnType<typeof publicItem>) => {
      if (!item) return null;
      const { owner, ...rest } = item;
      return rest;
    };
    const s = state();
    return { current: strip(s.current), queue: s.queue.map(strip), recent: s.recent.map(strip), paused: s.paused };
  };
  const broadcast = () => {
    io.except("viewers").emit("state", state());
    io.to("viewers").emit("state", viewerState());
  };

  // --- Simple per-IP throttle for join attempts (protects the admin PIN) ---
  const attempts = new Map<string, { n: number; reset: number }>();
  const throttled = (ip: string) => {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.reset < now) {
      attempts.set(ip, { n: 1, reset: now + 60_000 });
      return false;
    }
    a.n++;
    return a.n > 20;
  };

  const sessionFrom = (req: express.Request): Session | undefined => {
    const h = req.get("authorization") ?? "";
    return auth.get(h.startsWith("Bearer ") ? h.slice(7) : undefined);
  };

  app.post("/api/join", (req, res) => {
    if (throttled(req.ip ?? "?")) return res.status(429).json({ error: "Too many attempts. Wait a minute." });
    try {
      const { code, name, pin, admin } = req.body ?? {};
      const s = admin === true ? auth.joinAdmin(name, pin) : auth.join(code, name, pin);
      res.json({ token: s.token, name: s.name, role: s.role, owner: ownerId(s.token) });
    } catch (err) {
      if (err instanceof JoinError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.get("/api/me", (req, res) => {
    const s = sessionFrom(req);
    if (!s) return res.status(401).json({ error: "Not joined" });
    res.json({ name: s.name, role: s.role, owner: ownerId(s.token), searchEnabled: !!config.youtubeApiKey });
  });

  app.get("/api/search", async (req, res) => {
    if (!sessionFrom(req)) return res.status(401).json({ error: "Not joined" });
    if (!config.youtubeApiKey) return res.status(404).json({ error: "Search is not enabled." });
    try {
      const results = await searchVideos(String(req.query.q ?? ""), config.youtubeApiKey, fetchFn);
      res.json({ results });
    } catch {
      res.status(502).json({ error: "YouTube search failed. Try pasting a link instead." });
    }
  });

  app.get("/api/tv", async (req, res) => {
    if (req.query.key !== config.tvKey) return res.status(403).json({ error: "Bad TV key" });
    const base = config.publicUrl ?? lanUrl(config.port);
    const joinUrl = `${base}/?code=${auth.roomCode}`;
    res.json({
      tvHost: config.tvHost ?? null,
      roomCode: auth.roomCode,
      baseUrl: base,
      joinUrl,
      qr: await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 }),
    });
  });

  // Public and read-only, like /queue: what's been played, never who added it by token.
  app.get("/api/history", (req, res) => {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const h = jukebox.history({ limit: Number(req.query.limit) || 50, before: str(req.query.before), query: str(req.query.q) });
    res.json({
      total: h.total,
      next: h.next,
      items: h.items.map(({ addedByToken, ...item }) => item),
    });
  });
  app.get("/history", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "history.html")));
  app.get("/queue", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "queue.html")));
  app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
  app.get("/remote", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "remote.html")));
  app.get("/tv", (req, res) => {
    const to = tvRedirect({
      hostname: req.hostname,
      port: req.socket.localPort ?? config.port,
      url: req.originalUrl,
      remoteAddress: req.socket.remoteAddress,
      tvHost: config.tvHost,
    });
    if (to) return res.redirect(to);
    res.sendFile(path.join(PUBLIC_DIR, "tv.html"));
  });
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));

  // --- Sockets ---
  io.use((socket, next) => {
    const { token, tvKey, viewer } = socket.handshake.auth ?? {};
    if (typeof tvKey === "string" && tvKey === config.tvKey) {
      socket.data.tv = true;
      return next();
    }
    if (viewer === true) {
      socket.data.viewer = true;
      return next();
    }
    const s = auth.get(token);
    if (!s) return next(new Error("unauthorized"));
    socket.data.token = s.token;
    next();
  });

  // With several TV pages open (e.g. a stale tab), skip a song only when every TV reports it can't
  // play it, so one misconfigured TV can't skip songs for everyone.
  const tvErrors = new Map<number, Set<string>>();
  const tvSocketIds = () => [...io.sockets.sockets.values()].filter((x) => x.data.tv).map((x) => x.id);
  const allTvsFailed = (itemId: number) => {
    const failed = tvErrors.get(itemId);
    return !!failed && failed.size > 0 && tvSocketIds().every((id) => failed.has(id));
  };
  const skipFailed = (reason: string) => {
    const cur = jukebox.current();
    if (!cur) return;
    tvErrors.clear();
    console.warn(`[tv] skipped "${cur.title}" (${cur.videoId}): ${reason}`);
    io.emit("notice", { message: `Skipped "${cur.title}": ${reason}` });
    jukebox.advance({ failed: true });
  };

  const handle = (socket: Socket, event: string, fn: (s: Session | undefined, payload: any) => Promise<object | void> | object | void, opts: { admin?: boolean; tv?: boolean } = {}) => {
    socket.on(event, async (payload: unknown, ack?: Ack) => {
      const reply: Ack = typeof ack === "function" ? ack : () => {};
      try {
        let s: Session | undefined;
        if (opts.tv) {
          if (!socket.data.tv) return reply({ ok: false, error: "TV only." });
        } else {
          // Re-check every time so rotated room codes take effect immediately.
          s = auth.get(socket.data.token);
          if (!s) {
            socket.emit("session:invalid");
            return reply({ ok: false, error: "Your session expired. Please rejoin." });
          }
          if (opts.admin && s.role !== "admin") return reply({ ok: false, error: "Admins only." });
        }
        const extra = await fn(s, payload ?? {});
        broadcast();
        reply({ ok: true, ...(extra ?? {}) });
      } catch (err) {
        if (err instanceof QueueError || err instanceof VideoNotFoundError) return reply({ ok: false, error: err.message });
        console.error(`[${event}]`, err);
        reply({ ok: false, error: "Something went wrong." });
      }
    });
  };

  const idOf = (p: any): number => {
    const id = Number(p?.id);
    if (!Number.isInteger(id)) throw new QueueError("Invalid song.");
    return id;
  };

  io.on("connection", (socket) => {
    if (socket.data.viewer) {
      // Read-only: gets state updates, has no event handlers.
      socket.join("viewers");
      socket.emit("state", viewerState());
      return;
    }
    socket.emit("state", state());
    if (socket.data.tv) {
      socket.on("disconnect", () => {
        const cur = jukebox.current();
        if (cur && allTvsFailed(cur.id)) {
          skipFailed("no connected TV could play it");
          broadcast();
        }
      });
    }

    handle(socket, "queue:add", async (s, p) => {
      const videoId = isVideoId(p.videoId) ? p.videoId : parseVideoId(p.input);
      if (!videoId) {
        const text = typeof p.input === "string" ? p.input : "";
        throw new QueueError(
          /youtu\.?be/i.test(text)
            ? "That link isn't a single video. Playlists and channels can't be queued; open a video and share that link."
            : "That doesn't look like a YouTube link.",
        );
      }
      const info = await fetchVideoInfo(videoId, fetchFn);
      const item = jukebox.add(info, s!);
      if (!jukebox.current()) jukebox.advance();
      return { title: item.title };
    });
    handle(socket, "queue:remove", (_s, p) => jukebox.remove(idOf(p)), { admin: true });
    handle(socket, "queue:promote", (_s, p) => jukebox.promote(idOf(p)), { admin: true });
    handle(socket, "player:skip", () => void jukebox.advance(), { admin: true });
    handle(socket, "player:toggle", () => {
      if (jukebox.current()) jukebox.paused = !jukebox.paused;
    }, { admin: true });

    // Reported by the TV page. Only advance if the event is about the song that is actually playing,
    // so duplicate/late events can't skip a song.
    const finished = (_s: unknown, p: any) => {
      const cur = jukebox.current();
      if (cur && cur.id === Number(p?.id)) jukebox.advance();
    };
    handle(socket, "player:ended", (s, p) => {
      const cur = jukebox.current();
      if (cur && cur.id === Number(p?.id)) console.log(`[tv] finished "${cur.title}"`);
      finished(s, p);
    }, { tv: true });
    handle(socket, "player:error", (_s, p) => {
      const cur = jukebox.current();
      if (!cur || cur.id !== Number(p?.id)) return;
      const code = Number(p?.code);
      const reason = YT_ERRORS[code] ?? `YouTube error ${Number.isFinite(code) ? code : "unknown"}`;
      const failed = tvErrors.get(cur.id) ?? new Set<string>();
      failed.add(socket.id);
      tvErrors.set(cur.id, failed);
      if (!allTvsFailed(cur.id)) {
        console.warn(`[tv] one TV can't play "${cur.title}" (${reason}); another TV is still trying`);
        return;
      }
      skipFailed(reason);
    }, { tv: true });
    handle(socket, "player:paused", (_s, p) => {
      if (jukebox.current()) jukebox.paused = !!p?.paused;
    }, { tv: true });
  });

  return {
    app,
    httpServer,
    io,
    auth,
    jukebox,
    broadcast,
    close: async () => {
      io.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
      db.close();
    },
  };
}
