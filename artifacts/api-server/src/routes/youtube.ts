import { Router, type IRouter } from "express";
import { ErrorResponse, SearchYouTubeQueryParams, SearchYouTubeResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const CACHE_TTL = 5 * 60_000;
const CACHE_LIMIT = 120;
const responseCache = new Map<string, { createdAt: number; data: ReturnType<typeof SearchYouTubeResponse.parse> }>();

function errorBody(error: string) {
  return ErrorResponse.parse({ error });
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

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    res.status(503).json(errorBody("YouTube search is not configured. Add YOUTUBE_API_KEY in Replit Secrets."));
    return;
  }

  const { q, pageToken, language } = parsed.data;
  const cacheKey = JSON.stringify([q.trim(), pageToken || "", language || ""]);
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    res.json(cached.data);
    return;
  }

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

    if (!upstream.ok) {
      const reason = payload.error?.errors?.[0]?.reason;
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
        res.status(429).json(errorBody("YouTube search quota is temporarily exhausted. Try again after the quota resets."));
        return;
      }
      req.log.warn({ status: upstream.status, reason }, "YouTube search request was rejected");
      res.status(502).json(errorBody("YouTube search is temporarily unavailable. Check the API key and YouTube Data API v3 setup."));
      return;
    }

    const items = (payload.items || []).flatMap((item) => {
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
    if (responseCache.size > CACHE_LIMIT) {
      const oldestKey = responseCache.keys().next().value;
      if (oldestKey !== undefined) responseCache.delete(oldestKey);
    }
    res.json(data);
  } catch (error) {
    req.log.warn({ error }, "YouTube search request failed");
    res.status(502).json(errorBody("Could not reach YouTube. Check your connection and try again."));
  }
});

export default router;
