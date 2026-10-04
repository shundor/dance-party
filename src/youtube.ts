export interface VideoInfo {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

const YT_HOSTS = new Set(["youtube.com", "youtube-nocookie.com", "youtube.googleapis.com"]);
const PATH_ID_RE = /^\/(?:embed|shorts|live|v|vi|e|watch)\/([^/?#&]+)/;

function idFromUrl(url: URL, depth = 0): string | null {
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music|gaming)\./, "");
  if (host === "youtu.be") return url.pathname.split("/")[1] || null;
  if (!YT_HOSTS.has(host)) return null;

  for (const key of ["v", "vi"]) {
    const v = url.searchParams.get(key);
    if (isVideoId(v)) return v;
  }
  const m = url.pathname.match(PATH_ID_RE);
  if (m && isVideoId(m[1])) return m[1];

  // Fragment forms: "#!v=ID", "#v=ID", "#/watch?v=ID".
  const frag = url.hash.replace(/^#!?/, "");
  if (frag.startsWith("/") && depth < 2) {
    try {
      const id = idFromUrl(new URL(frag, "https://www.youtube.com"), depth + 1);
      if (id) return id;
    } catch {
      /* ignore */
    }
  }
  const hashV = new URLSearchParams(frag).get("v");
  if (isVideoId(hashV)) return hashV;

  // Wrapped links: /attribution_link?u=/watch%3Fv%3DID and /oembed?url=https://youtu.be/ID
  if (depth < 2) {
    for (const key of ["u", "url"]) {
      const inner = url.searchParams.get(key);
      if (!inner) continue;
      try {
        const id = idFromUrl(new URL(inner, "https://www.youtube.com"), depth + 1);
        if (id) return id;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Extracts a YouTube video ID from a bare ID, any YouTube URL (watch, youtu.be, shorts, live,
 * embed, music, mobile, nocookie, attribution links…) or share text that contains such a URL.
 * Returns null if none found.
 */
export function parseVideoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().slice(0, 2000);
  if (ID_RE.test(s)) return s;

  const candidates = s.match(/(?<![\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube(?:-nocookie)?\.com|youtube\.googleapis\.com|youtu\.be)\/[^\s<>"']*/gi) ?? [];
  for (const c of candidates) {
    try {
      const id = idFromUrl(new URL(/^https?:\/\//i.test(c) ? c : `https://${c}`));
      if (isVideoId(id)) return id;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function thumbnailFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

type FetchFn = typeof fetch;

/** Looks up title/channel via oEmbed (no API key needed). Falls back to a placeholder title. */
export async function fetchVideoInfo(videoId: string, fetchFn: FetchFn = fetch): Promise<VideoInfo> {
  const fallback: VideoInfo = { videoId, title: `YouTube video ${videoId}`, channel: "", thumbnail: thumbnailFor(videoId) };
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
    if (res.status === 404 || res.status === 400) throw new VideoNotFoundError();
    if (!res.ok) return fallback;
    const data = (await res.json()) as { title?: string; author_name?: string };
    return {
      videoId,
      title: (data.title || fallback.title).slice(0, 200),
      channel: (data.author_name || "").slice(0, 100),
      thumbnail: thumbnailFor(videoId),
    };
  } catch (err) {
    if (err instanceof VideoNotFoundError) throw err;
    return fallback;
  }
}

export class VideoNotFoundError extends Error {
  constructor() {
    super("That video couldn't be found (it may be private or deleted).");
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function searchVideos(query: string, apiKey: string, fetchFn: FetchFn = fetch): Promise<VideoInfo[]> {
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoEmbeddable: "true",
    maxResults: "10",
    q,
    key: apiKey,
  });
  const res = await fetchFn(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`YouTube search failed (${res.status})`);
  const data = (await res.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }[];
  };
  return (data.items ?? [])
    .filter((i) => isVideoId(i.id?.videoId))
    .map((i) => ({
      videoId: i.id!.videoId!,
      title: decodeEntities(i.snippet?.title ?? ""),
      channel: decodeEntities(i.snippet?.channelTitle ?? ""),
      thumbnail: thumbnailFor(i.id!.videoId!),
    }));
}
