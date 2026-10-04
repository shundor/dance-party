import { describe, expect, it } from "vitest";
import { tvRedirect } from "../src/app.js";
import { Auth, JoinError, generateRoomCode, sanitizeName } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { Jukebox, QueueError } from "../src/queue.js";
import { parseVideoId, searchVideos } from "../src/youtube.js";

const vid = (id: string) => ({ videoId: id, title: `Song ${id}`, channel: "c", thumbnail: "t" });

describe("parseVideoId", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "dQw4w9WgXcQ"],
    ["youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/jpqV3dzYOgk?si=2K2AEg0wKQeu_Bq6", "jpqV3dzYOgk"],
    ["http://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://www.youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?app=desktop&feature=share&v=dQw4w9WgXcQ&list=PL123&index=2", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30s", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ?si=xyz", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/v/dQw4w9WgXcQ?version=3", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/e/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?vi=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", "dQw4w9WgXcQ"],
    ["https://youtube.googleapis.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://gaming.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/#/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/user/Foo#p/u/1/dQw4w9WgXcQ", null],
    ["https://www.youtube.com/attribution_link?a=x&u=%2Fwatch%3Fv%3DdQw4w9WgXcQ%26feature%3Dshare", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/oembed?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["Check this out! https://youtu.be/dQw4w9WgXcQ?si=abc 🎉", "dQw4w9WgXcQ"],
    ["  https://youtu.be/dQw4w9WgXcQ\n", "dQw4w9WgXcQ"],
  ])("parses %s", (input, expected) => expect(parseVideoId(input)).toBe(expected));

  it.each(["", "hello world", "https://vimeo.com/123", "https://youtube.com/watch?v=short", "<script>",
    "https://www.youtube.com/playlist?list=PL123", "https://www.youtube.com/@channel", "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/"])(
    "rejects %s",
    (input) => expect(parseVideoId(input)).toBeNull(),
  );
});

describe("searchVideos", () => {
  it("maps API results and decodes entities", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: "Rick &amp; Roll", channelTitle: "Rick" } },
            { id: { videoId: "bad" }, snippet: { title: "x" } },
          ],
        }),
      )) as unknown as typeof fetch;
    const res = await searchVideos("rick", "KEY", fakeFetch);
    expect(res).toEqual([
      { videoId: "dQw4w9WgXcQ", title: "Rick & Roll", channel: "Rick", thumbnail: expect.stringContaining("dQw4w9WgXcQ") },
    ]);
  });
});

describe("Auth", () => {
  it("generates 4-letter codes without I or O", () => {
    for (let i = 0; i < 200; i++) expect(generateRoomCode()).toMatch(/^[A-HJ-NP-Z]{4}$/);
  });

  it("sanitizes names", () => {
    expect(sanitizeName("  <b>Alex</b>  the great dancer ")).toBe("bAlex/b the");
    expect(sanitizeName(42)).toBe("");
  });

  it("joins as guest or admin and validates code/pin", () => {
    const auth = new Auth(openDb(":memory:"), "9999", "ABCD");
    expect(() => auth.join("WXYZ", "Al")).toThrow(JoinError);
    expect(() => auth.join("abcd", "  ")).toThrow(JoinError);
    expect(() => auth.join("ABCD", "Al", "0000")).toThrow(/PIN/);
    const guest = auth.join("abcd", "Al");
    expect(guest.role).toBe("guest");
    expect(auth.join("ABCD", "Boss", "9999").role).toBe("admin");
    expect(auth.get(guest.token)?.name).toBe("Al");
  });

  it("invalidates sessions when the code rotates", () => {
    const auth = new Auth(openDb(":memory:"), "1", "ABCD");
    const s = auth.join("ABCD", "Al");
    const code = auth.rotateCode();
    expect(code).not.toBe("ABCD");
    expect(auth.get(s.token)).toBeUndefined();
  });
});

describe("Jukebox", () => {
  const setup = () => {
    const db = openDb(":memory:");
    const auth = new Auth(db, "1", "ABCD");
    return { jb: new Jukebox(db, 2), guest: auth.join("ABCD", "G"), admin: auth.join("ABCD", "A", "1") };
  };

  it("adds in order, advances, and rejects duplicates", () => {
    const { jb, guest } = setup();
    jb.add(vid("aaaaaaaaaaa"), guest);
    jb.add(vid("bbbbbbbbbbb"), guest);
    expect(() => jb.add(vid("aaaaaaaaaaa"), guest)).toThrow(/already/);
    expect(jb.advance()?.videoId).toBe("aaaaaaaaaaa");
    expect(() => jb.add(vid("aaaaaaaaaaa"), guest)).toThrow(/already/); // still playing
    expect(jb.list().map((q) => q.videoId)).toEqual(["bbbbbbbbbbb"]);
    expect(jb.advance()?.videoId).toBe("bbbbbbbbbbb");
    expect(jb.advance()).toBeNull();
    jb.add(vid("aaaaaaaaaaa"), guest); // allowed again once played
  });

  it("keeps a searchable, paged history of every song played", () => {
    const { jb, admin } = setup();
    const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee"];
    for (const id of ids) jb.add(vid(id), admin);
    jb.advance(); // a playing
    jb.advance(); // a played, b playing
    jb.advance({ failed: true }); // b couldn't play: not history
    jb.advance(); // c played, d playing
    jb.advance(); // d played, e playing
    expect(jb.history().total).toBe(3);

    const p1 = jb.history({ limit: 2 });
    expect(p1.items.map((i) => i.videoId)).toEqual(["ddddddddddd", "ccccccccccc"]);
    expect(p1.next).toMatch(/^\d+:\d+$/);
    const p2 = jb.history({ limit: 2, before: p1.next! });
    expect(p2.items.map((i) => i.videoId)).toEqual(["aaaaaaaaaaa"]);
    expect(p2.next).toBeNull();

    expect(jb.history({ query: "ccccc" }).items.map((i) => i.videoId)).toEqual(["ccccccccccc"]);
    expect(jb.history({ query: "%" }).total).toBe(0); // LIKE wildcards are literal

    // Replaying a song adds another history entry.
    jb.add(vid("aaaaaaaaaaa"), admin);
    jb.advance();
    jb.advance();
    expect(jb.history().items.filter((i) => i.videoId === "aaaaaaaaaaa")).toHaveLength(2);
  });

  it("enforces the guest limit but not for admins", () => {
    const { jb, guest, admin } = setup();
    jb.add(vid("aaaaaaaaaaa"), guest);
    jb.add(vid("bbbbbbbbbbb"), guest);
    expect(() => jb.add(vid("ccccccccccc"), guest)).toThrow(QueueError);
    for (const c of "defgh") jb.add(vid(c.repeat(11)), admin);
    jb.advance(); // guest's first song starts playing -> no longer "waiting"
    jb.add(vid("ccccccccccc"), guest);
  });

  it("promotes and removes", () => {
    const { jb, admin } = setup();
    const a = jb.add(vid("aaaaaaaaaaa"), admin);
    jb.add(vid("bbbbbbbbbbb"), admin);
    const c = jb.add(vid("ccccccccccc"), admin);
    jb.promote(c.id);
    expect(jb.list().map((q) => q.videoId[0])).toEqual(["c", "a", "b"]);
    jb.remove(a.id);
    expect(jb.list().map((q) => q.videoId[0])).toEqual(["c", "b"]);
    expect(() => jb.remove(a.id)).toThrow(QueueError);
    expect(() => jb.promote(9999)).toThrow(QueueError);
    expect(jb.advance()?.videoId[0]).toBe("c");
  });
});

describe("tvRedirect", () => {
  const base = { port: 3000, url: "/tv?key=k", tvHost: "mymac.local" };
  it("moves IP-address TV pages to a hostname YouTube accepts", () => {
    expect(tvRedirect({ ...base, hostname: "192.168.1.50", remoteAddress: "192.168.1.77" })).toBe(
      "http://mymac.local:3000/tv?key=k",
    );
    expect(tvRedirect({ ...base, hostname: "192.168.1.50", remoteAddress: "127.0.0.1" })).toBe(
      "http://localhost:3000/tv?key=k",
    );
  });
  it("leaves hostnames and loopback alone, and needs a TV host for other devices", () => {
    expect(tvRedirect({ ...base, hostname: "mymac.local", remoteAddress: "192.168.1.77" })).toBeUndefined();
    expect(tvRedirect({ ...base, hostname: "localhost", remoteAddress: "127.0.0.1" })).toBeUndefined();
    expect(tvRedirect({ ...base, hostname: "127.0.0.1", remoteAddress: "127.0.0.1" })).toBeUndefined();
    expect(tvRedirect({ ...base, tvHost: undefined, hostname: "192.168.1.50", remoteAddress: "192.168.1.77" })).toBeUndefined();
  });
});
