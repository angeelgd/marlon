import { cached } from "../integrations/cache";

/**
 * Búsqueda de vídeos con YouTube Data API v3.
 * Cuota: search.list cuesta 100 unidades y videos.list 1; con caché semanal sobra.
 */

export interface VideoInfo {
  id: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  publishedAt: string;
  minutes: number;
  views: number;
}

/** "PT1H2M30S" → minutos. */
export function isoDurationMinutes(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  if (!m) return 0;
  const [, dd = "0", h = "0", mi = "0", s = "0"] = m;
  return Math.round(+dd * 1440 + +h * 60 + +mi + +s / 60);
}

export const DEFAULT_QUERIES = ["batch cooking vegano proteína", "vegan meal prep high protein"];

interface SearchResponse {
  items?: { id?: { videoId?: string } }[];
}
interface VideosResponse {
  items?: {
    id: string;
    snippet?: { title?: string; channelTitle?: string; description?: string; publishedAt?: string };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string };
  }[];
}

export async function searchCookingVideos(opts: {
  db: D1Database;
  apiKey: string;
  query?: string;
  now: number;
  fetchImpl?: typeof fetch;
}): Promise<VideoInfo[]> {
  const f = opts.fetchImpl ?? fetch;
  const queries = opts.query ? [opts.query] : DEFAULT_QUERIES;
  const week = Math.floor(opts.now / (7 * 86_400_000));
  return cached(opts.db, `youtube:search:${queries.join("|")}:${week}`, 7 * 86_400_000, async () => {
    const ids = new Set<string>();
    const publishedAfter = new Date(opts.now - 2 * 365 * 86_400_000).toISOString();
    for (const q of queries) {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.search = new URLSearchParams({
        part: "snippet",
        type: "video",
        q,
        maxResults: "10",
        videoDuration: "medium", // 4 a 20 minutos
        videoEmbeddable: "true",
        safeSearch: "strict",
        publishedAfter,
        relevanceLanguage: /[áéíóúñ]|vegano|proteína/i.test(q) ? "es" : "en",
        key: opts.apiKey,
      }).toString();
      const res = await f(url.toString());
      if (!res.ok) throw new Error(`YouTube respondió ${res.status}.`);
      for (const it of ((await res.json()) as SearchResponse).items ?? []) if (it.id?.videoId) ids.add(it.id.videoId);
    }
    if (ids.size === 0) return [];
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.search = new URLSearchParams({ part: "snippet,contentDetails,statistics", id: [...ids].join(","), key: opts.apiKey }).toString();
    const res = await f(url.toString());
    if (!res.ok) throw new Error(`YouTube respondió ${res.status}.`);
    return (((await res.json()) as VideosResponse).items ?? [])
      .map((v) => ({
        id: v.id,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        title: v.snippet?.title ?? "",
        channel: v.snippet?.channelTitle ?? "",
        description: (v.snippet?.description ?? "").slice(0, 4000),
        publishedAt: v.snippet?.publishedAt ?? "",
        minutes: isoDurationMinutes(v.contentDetails?.duration ?? ""),
        views: Number(v.statistics?.viewCount ?? 0),
      }))
      .filter((v) => v.minutes >= 5 && v.minutes <= 40)
      .sort((a, b) => b.views - a.views);
  });
}

/** Elige vídeos que no se hayan propuesto en los últimos meses. */
export async function pickFresh(db: D1Database, videos: VideoInfo[], count: number): Promise<VideoInfo[]> {
  const out: VideoInfo[] = [];
  for (const v of videos) {
    if (out.length >= count) break;
    const seen = await db
      .prepare(`SELECT 1 FROM api_cache WHERE key = ? AND expires_at > ?`)
      .bind(`youtube:suggested:${v.id}`, new Date().toISOString())
      .first();
    const analyzed = await db.prepare(`SELECT 1 FROM recipes WHERE video_id = ?`).bind(v.id).first();
    if (!seen && !analyzed) out.push(v);
  }
  return out;
}

export async function markSuggested(db: D1Database, ids: string[]): Promise<void> {
  const expires = new Date(Date.now() + 180 * 86_400_000).toISOString();
  for (const id of ids) {
    await db
      .prepare(`INSERT INTO api_cache (key, value_json, expires_at) VALUES (?1, '1', ?2) ON CONFLICT(key) DO UPDATE SET expires_at = ?2`)
      .bind(`youtube:suggested:${id}`, expires)
      .run();
  }
}

export function videoIdFrom(urlOrId: string): string | null {
  if (/^[\w-]{11}$/.test(urlOrId)) return urlOrId;
  try {
    const u = new URL(urlOrId);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (u.hostname.endsWith("youtube.com")) {
      return u.searchParams.get("v") ?? /\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? null;
    }
  } catch {
    /* no es una URL */
  }
  return null;
}
