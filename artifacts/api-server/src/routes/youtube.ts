import { Router, type IRouter } from "express";
import { type ErrorResponse, SearchYouTubeQueryParams, SearchYouTubeResponse } from "@workspace/api-zod";
import { Ytdl } from "@distube/ytdl-core";
import { Readable } from "node:stream";

const router: IRouter = Router();
const CACHE_TTL = 5 * 60_000;
const CACHE_LIMIT = 120;
const responseCache = new Map<string, { createdAt: number; data: ReturnType<typeof SearchYouTubeResponse.parse> }>();

const ytdl = new Ytdl();
interface CachedAudioStream {
  url: string;
  mimeType: string;
  contentLength?: number;
  expiresAt: number;
}
const streamUrlCache = new Map<string, CachedAudioStream>();

function errorBody(error: string): ErrorResponse {
  return { error };
}

router.get("/youtube/search", async (req, res): Promise<void> => {
  const parsed = SearchYouTubeQueryParams.safeParse({
    q: typeof req.query.q === "string" ? req.query.q : "",
    ...(typeof req.query.pageToken === "string" ? { pageToken: req.query.pageToken } : {}),
    ...(typeof req.query.language === "string" ? { language: req.query.language } : {}),
  });
  if (!parsed.success || parsed.data.q.trim().length < 2) {
    res.status(400).json(errorBody("Enter at least two characters to search."));
    return;
  }

  const { q, pageToken, language } = parsed.data;
  const cacheKey = JSON.stringify([q.trim(), pageToken || "", language || ""]);
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    res.json(cached.data);
    return;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;

  if (apiKey) {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoEmbeddable", "true");
    url.searchParams.set("maxResults", "20");
    url.searchParams.set("q", q.trim());
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    if (language) url.searchParams.set("relevanceLanguage", language);
    url.searchParams.set("key", apiKey);

    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const payload = await upstream.json() as {
        error?: { errors?: Array<{ reason?: string }> };
        items?: Array<{
          id?: { videoId?: string };
          snippet?: {
            title?: string;
            channelTitle?: string;
            description?: string;
            thumbnails?: Record<string, { url?: string }>;
          };
        }>;
        nextPageToken?: string;
      };

      if (upstream.ok && payload.items && payload.items.length > 0) {
        const items = payload.items.flatMap((item) => {
          const id = item.id?.videoId;
          const snippet = item.snippet;
          if (!id || !snippet?.title) return [];
          const thumbnailUrl = snippet.thumbnails?.medium?.url
            || snippet.thumbnails?.high?.url
            || snippet.thumbnails?.default?.url
            || `https://i.ytimg.com/vi/${encodeURIComponent(id)}/default.jpg`;
          return [{
            id,
            title: snippet.title,
            channel: snippet.channelTitle || "YouTube channel",
            description: snippet.description || "",
            thumbnailUrl,
            sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
          }];
        });
        const data = SearchYouTubeResponse.parse({
          items,
          ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {}),
        });
        responseCache.set(cacheKey, { createdAt: Date.now(), data });
        res.json(data);
        return;
      }
    } catch {
      // Fall through to web search scraper
    }
  }

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q.trim())}`;
    const upstream = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": language ? `${language},en;q=0.9` : "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!upstream.ok) {
      res.status(502).json(errorBody("YouTube search is temporarily unavailable. Check your connection."));
      return;
    }

    const html = await upstream.text();
    const match = html.match(/ytInitialData\s*=\s*({.+?});/s);
    if (!match) {
      res.json(SearchYouTubeResponse.parse({ items: [] }));
      return;
    }

    const json = JSON.parse(match[1]);
    const sections = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const items: Array<{ id: string; title: string; channel: string; description: string; thumbnailUrl: string; sourceUrl: string }> = [];

    for (const section of sections) {
      const contents = section.itemSectionRenderer?.contents || [];
      for (const content of contents) {
        const v = content.videoRenderer;
        if (v && v.videoId) {
          const title = v.title?.runs?.map((r: { text: string }) => r.text).join("") || "";
          const channel = v.ownerText?.runs?.map((r: { text: string }) => r.text).join("") || v.shortBylineText?.runs?.map((r: { text: string }) => r.text).join("") || "YouTube Artist";
          const desc = v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r: { text: string }) => r.text).join("") || "";
          const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;

          items.push({
            id: v.videoId,
            title,
            channel,
            description: desc,
            thumbnailUrl: thumb,
            sourceUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
          });
        }
      }
    }

    const data = SearchYouTubeResponse.parse({ items });
    responseCache.set(cacheKey, { createdAt: Date.now(), data });
    if (responseCache.size > CACHE_LIMIT) {
      const oldestKey = responseCache.keys().next().value;
      if (oldestKey !== undefined) responseCache.delete(oldestKey);
    }
    res.json(data);
    return;
  } catch (err) {
    req.log.warn({ err }, "YouTube web search scraper failed");
    res.status(502).json(errorBody("Could not reach YouTube. Check your connection and try again."));
    return;
  }
});

router.get("/youtube/stream", async (req, res): Promise<void> => {
  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id || !/^[\w-]{6,16}$/.test(id)) {
    res.status(400).json(errorBody("A valid YouTube video ID is required."));
    return;
  }

  try {
    let cached = streamUrlCache.get(id);
    if (!cached || Date.now() > cached.expiresAt) {
      const info = await ytdl.getInfo(id);
      const audioFormats = info.formats.filter((f) => f.hasAudio && !f.hasVideo && f.url);
      if (!audioFormats.length) {
        res.status(404).json(errorBody("No direct audio format found for this video."));
        return;
      }

      // Prioritize AAC / mp4 (itag 140 or similar) for full iOS Safari and Android Chrome compatibility
      const mp4Audio = audioFormats
        .filter((f) => f.container === "mp4" || f.mimeType?.includes("audio/mp4"))
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

      const best = mp4Audio || audioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
      if (!best || !best.url) {
        res.status(404).json(errorBody("No direct audio format found for this video."));
        return;
      }

      const streamItem: CachedAudioStream = {
        url: best.url,
        mimeType: best.mimeType || "audio/mp4",
        contentLength: best.contentLength ? Number(best.contentLength) : undefined,
        expiresAt: Date.now() + 2 * 3600_000,
      };
      cached = streamItem;
      streamUrlCache.set(id, streamItem);
      if (streamUrlCache.size > 200) {
        const oldest = streamUrlCache.keys().next().value;
        if (oldest) streamUrlCache.delete(oldest);
      }
    }

    if (!cached) {
      res.status(404).json(errorBody("Audio stream not available."));
      return;
    }

    // Forward range requests
    const range = req.headers.range;
    const upstreamHeaders: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };
    if (range) {
      upstreamHeaders["Range"] = range;
    }

    let upstream = await fetch(cached.url, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(30_000),
    });

    // If cached URL expired (403 / 410), refresh cache once
    if (upstream.status === 403 || upstream.status === 410) {
      streamUrlCache.delete(id);
      const freshInfo = await ytdl.getInfo(id);
      const freshAudioFormats = freshInfo.formats.filter((f) => f.hasAudio && !f.hasVideo && f.url);
      const freshMp4 = freshAudioFormats
        .filter((f) => f.container === "mp4" || f.mimeType?.includes("audio/mp4"))
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
      const freshBest = freshMp4 || freshAudioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

      if (!freshBest || !freshBest.url) {
        res.status(404).json(errorBody("No direct audio format found for this video."));
        return;
      }

      const freshStreamItem: CachedAudioStream = {
        url: freshBest.url,
        mimeType: freshBest.mimeType || "audio/mp4",
        contentLength: freshBest.contentLength ? Number(freshBest.contentLength) : undefined,
        expiresAt: Date.now() + 2 * 3600_000,
      };
      cached = freshStreamItem;
      streamUrlCache.set(id, freshStreamItem);

      upstream = await fetch(cached.url, {
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    }

    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || cached.mimeType || "audio/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    res.setHeader("Cache-Control", "public, max-age=3600");

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstream.body as any);
    nodeStream.pipe(res);

    req.on("close", () => {
      nodeStream.destroy();
    });
  } catch (err: any) {
    req.log?.warn?.({ err, videoId: id }, "Failed to stream YouTube audio");
    res.status(502).json(errorBody(err?.message || "Could not stream audio from YouTube."));
  }
});

export default router;

