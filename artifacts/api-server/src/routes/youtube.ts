import { Router, type IRouter } from "express";
import { type ErrorResponse, SearchYouTubeQueryParams, SearchYouTubeResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const CACHE_TTL = 5 * 60_000;
const CACHE_LIMIT = 120;
const responseCache = new Map<string, { createdAt: number; data: ReturnType<typeof SearchYouTubeResponse.parse> }>();

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

export default router;

