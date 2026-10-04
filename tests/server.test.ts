import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect, Socket } from "socket.io-client";
import { createDanceParty } from "../src/app.js";

const fakeFetch = (async (url: string) => {
  const id = new URL(url).searchParams.get("url")?.split("v=")[1] ?? "";
  if (id === "deadvideo00") return new Response("Not Found", { status: 404 });
  return new Response(JSON.stringify({ title: `Title ${id}`, author_name: "Artist" }));
}) as unknown as typeof fetch;

let party: ReturnType<typeof createDanceParty>;
let base: string;
const sockets: Socket[] = [];

beforeEach(async () => {
  party = createDanceParty(
    { port: 0, adminPin: "4321", tvKey: "tvsecret", guestQueueLimit: 3, dbPath: ":memory:", roomCode: "PLAY" },
    { fetch: fakeFetch },
  );
  await new Promise<void>((r) => party.httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(party.httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  await party.close();
});

async function join(name: string, pin?: string) {
  const res = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "play", name, pin }),
  });
  return { status: res.status, body: await res.json() };
}

function socketFor(auth: object): Promise<Socket> {
  const s = connect(base, { auth, transports: ["websocket"], forceNew: true });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once("connect", () => resolve(s));
    s.once("connect_error", reject);
  });
}

const call = (s: Socket, event: string, payload: object = {}) =>
  new Promise<any>((r) => s.emit(event, payload, r));

describe("Dance Party server", () => {
  it("serves pages", async () => {
    for (const p of ["/", "/admin", "/queue", "/queue.js", "/history", "/history.js", "/remote", "/tv", "/style.css", "/help.js", "/socket.io/socket.io.js"]) {
      expect((await fetch(base + p)).status, p).toBe(200);
    }
  });

  it("moves the TV page to localhost when opened on the server machine via its LAN address", async () => {
    const port = (party.httpServer.address() as AddressInfo).port;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) =>
      http.get({ host: "127.0.0.1", port, path: "/tv?key=tvsecret", headers: { host: `192.168.1.50:${port}` } }, resolve).on("error", reject),
    );
    res.resume();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`http://localhost:${port}/tv?key=tvsecret`);
  });

  it("skips a song only when every connected TV fails to play it", async () => {
    const { body } = await join("Admin", "4321");
    const admin = await socketFor({ token: body.token });
    const tv1 = await socketFor({ tvKey: "tvsecret" });
    const tv2 = await socketFor({ tvKey: "tvsecret" });
    await call(admin, "queue:add", { input: "dQw4w9WgXcQ" });
    const id = party.jukebox.current()!.id;
    await call(tv1, "player:error", { id, code: 150 });
    expect(party.jukebox.current()?.id).toBe(id);
    await call(tv2, "player:error", { id, code: 150 });
    expect(party.jukebox.current()).toBeNull();
  });

  it("lets admins join from /admin with just a name and PIN", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(200);
    const post = (body: object) =>
      fetch(`${base}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post({ admin: true, name: "Host", pin: "4321" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).role).toBe("admin");
    expect((await post({ admin: true, name: "Host", pin: "0000" })).status).toBe(400);
    expect((await post({ admin: true, name: "Host" })).status).toBe(400);
  });

  it("joins with code and name; admin needs the PIN", async () => {
    expect((await join("Guest")).body.role).toBe("guest");
    expect((await join("Boss", "4321")).body.role).toBe("admin");
    expect((await join("Hacker", "0000")).status).toBe(400);
  });

  it("gives /queue viewers a read-only live view with recently played songs", async () => {
    const guest = (await join("Guest")).body;
    const admin = (await join("Boss", "4321")).body;
    const a = await socketFor({ token: admin.token });
    const tv = await socketFor({ tvKey: "tvsecret" });
    const viewer = await socketFor({ viewer: true });

    await call(a, "queue:add", { videoId: "aaaaaaaaaaa" });
    await call(a, "queue:add", { videoId: "bbbbbbbbbbb" });
    await call(a, "queue:add", { videoId: "ccccccccccc" });
    await call(a, "queue:add", { videoId: "ddddddddddd" });
    await call(tv, "player:ended", { id: party.jukebox.current()!.id }); // a played
    await call(tv, "player:error", { id: party.jukebox.current()!.id, code: 150 }); // b failed

    const next = new Promise<any>((r) => {
      const onState = (st: any) => st.current?.videoId === "ddddddddddd" && (viewer.off("state", onState), r(st));
      viewer.on("state", onState);
    });
    await call(tv, "player:ended", { id: party.jukebox.current()!.id }); // c played
    const st = await next;
    expect(st.current.videoId).toBe("ddddddddddd");
    expect(st.queue).toEqual([]);
    expect(st.recent.map((r: any) => r.videoId)).toEqual(["ccccccccccc", "aaaaaaaaaaa"]);
    expect(typeof st.recent[0].playedAt).toBe("number");
    expect(st.roomCode).toBeUndefined();
    expect(st.current.owner).toBeUndefined();
    expect(JSON.stringify(st)).not.toContain(admin.token);
    expect(JSON.stringify(st)).not.toContain(guest.token);

    // Viewers have no event handlers, so actions never reach the jukebox.
    viewer.emit("queue:add", { input: "eeeeeeeeeee" });
    viewer.emit("player:skip", {});
    viewer.emit("player:ended", { id: party.jukebox.current()!.id });
    await new Promise((r) => setTimeout(r, 100));
    expect(party.jukebox.current()?.videoId).toBe("ddddddddddd");
    expect(party.jukebox.list()).toEqual([]);
  });

  it("serves the play history publicly without tokens", async () => {
    const guest = (await join("Guest")).body;
    const g = await socketFor({ token: guest.token });
    const tv = await socketFor({ tvKey: "tvsecret" });
    await call(g, "queue:add", { videoId: "aaaaaaaaaaa" });
    await call(g, "queue:add", { videoId: "bbbbbbbbbbb" });
    await call(tv, "player:ended", { id: party.jukebox.current()!.id });

    const res = await fetch(`${base}/api/history?limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.next).toBeNull();
    expect(body.items[0]).toMatchObject({ videoId: "aaaaaaaaaaa", title: "Title aaaaaaaaaaa", addedBy: "Guest" });
    expect(typeof body.items[0].playedAt).toBe("number");
    expect(JSON.stringify(body)).not.toContain(guest.token);
    expect((await (await fetch(`${base}/api/history?q=zzz`)).json()).total).toBe(0);
  });

  it("lets a guest re-queue a song from history", async () => {
    const guest = (await join("Guest")).body;
    const g = await socketFor({ token: guest.token });
    const tv = await socketFor({ tvKey: "tvsecret" });
    await call(g, "queue:add", { videoId: "aaaaaaaaaaa" });
    await call(g, "queue:add", { videoId: "bbbbbbbbbbb" });
    await call(tv, "player:ended", { id: party.jukebox.current()!.id });

    const [played] = (await (await fetch(`${base}/api/history`)).json()).items;
    expect(await call(g, "queue:add", { videoId: played.videoId })).toMatchObject({ ok: true, title: "Title aaaaaaaaaaa" });
    expect(party.jukebox.list().map((q) => q.videoId)).toEqual(["aaaaaaaaaaa"]);
    expect((await call(g, "queue:add", { videoId: played.videoId })).ok).toBe(false);
  });

  it("rejects sockets without a valid token", async () => {
    await expect(socketFor({ token: "nope" })).rejects.toThrow("unauthorized");
  });

  it("runs the full guest/admin/TV flow", async () => {
    const guest = (await join("Guest")).body;
    const admin = (await join("Boss", "4321")).body;
    const g = await socketFor({ token: guest.token });
    const a = await socketFor({ token: admin.token });
    const tv = await socketFor({ tvKey: "tvsecret" });

    // Guest adds songs; the first starts playing immediately.
    expect(await call(g, "queue:add", { input: "https://youtu.be/aaaaaaaaaaa" })).toMatchObject({ ok: true, title: "Title aaaaaaaaaaa" });
    expect(await call(g, "queue:add", { videoId: "bbbbbbbbbbb" })).toMatchObject({ ok: true });
    expect(await call(g, "queue:add", { input: "not a link" })).toMatchObject({ ok: false });
    expect(await call(g, "queue:add", { input: "deadvideo00" })).toMatchObject({ ok: false });
    expect(await call(a, "queue:add", { videoId: "ccccccccccc" })).toMatchObject({ ok: true });

    // Guests can't use admin actions.
    const list = party.jukebox.list();
    expect(await call(g, "queue:promote", { id: list[1].id })).toEqual({ ok: false, error: "Admins only." });
    expect(await call(g, "player:skip")).toMatchObject({ ok: false });
    // ...and can't impersonate the TV.
    expect(await call(g, "player:ended", { id: party.jukebox.current()!.id })).toMatchObject({ ok: false });

    // Admin promotes c above b, then removes b.
    expect(await call(a, "queue:promote", { id: list[1].id })).toMatchObject({ ok: true });
    expect(party.jukebox.list().map((q) => q.videoId)).toEqual(["ccccccccccc", "bbbbbbbbbbb"]);
    expect(await call(a, "queue:remove", { id: list[0].id })).toMatchObject({ ok: true });

    // State broadcast reaches clients and hides tokens.
    const next = new Promise<any>((r) => g.once("state", r));
    expect(await call(a, "player:toggle")).toMatchObject({ ok: true });
    const st = await next;
    expect(st.paused).toBe(true);
    expect(st.current.videoId).toBe("aaaaaaaaaaa");
    expect(JSON.stringify(st)).not.toContain(guest.token);
    expect(st.current.owner).toBe(guest.owner);

    // TV reports end of song -> advances; stale reports are ignored.
    const playingId = party.jukebox.current()!.id;
    const notice = new Promise<any>((r) => g.once("notice", r));
    expect(await call(tv, "player:error", { id: playingId, code: 150 })).toMatchObject({ ok: true });
    expect((await notice).message).toMatch(/Skipped "Title aaaaaaaaaaa": the owner doesn't allow/);
    expect(party.jukebox.current()?.videoId).toBe("ccccccccccc");
    await call(tv, "player:ended", { id: playingId });
    expect(party.jukebox.current()?.videoId).toBe("ccccccccccc");

    // Admin skip empties the player.
    await call(a, "player:skip");
    expect(party.jukebox.current()).toBeNull();
  });

  it("protects the TV info endpoint", async () => {
    expect((await fetch(`${base}/api/tv?key=wrong`)).status).toBe(403);
    const info = await (await fetch(`${base}/api/tv?key=tvsecret`)).json();
    expect(info.roomCode).toBe("PLAY");
    expect(info.joinUrl).toMatch(/\?code=PLAY$/);
    expect(info.qr).toMatch(/^data:image\/png;base64,/);
  });

  it("requires a session and API key for search", async () => {
    expect((await fetch(`${base}/api/search?q=x`)).status).toBe(401);
    const { token } = (await join("G")).body;
    const res = await fetch(`${base}/api/search?q=x`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });
});
