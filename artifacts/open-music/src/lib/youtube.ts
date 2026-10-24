export type YouTubeVideo = {
  id: string;
  title: string;
  channel: string;
  description: string;
  thumbnailUrl: string;
  sourceUrl: string;
  duration: number;
  durationText: string;
};

export type YouTubeSearchResponse = {
  items: YouTubeVideo[];
  nextPageToken?: string;
};

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function parseDurationText(text: string): number {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/**
 * Searches YouTube for music videos.
 * Tries the official YouTube Data API v3 if YOUTUBE_API_KEY is configured,
 * otherwise transparently falls back to parsing YouTube's public web search.
 */
export async function searchYouTube(
  query: string,
  options?: { language?: string; pageToken?: string; apiKey?: string }
): Promise<YouTubeSearchResponse> {
  const q = query.trim();
  if (!q) {
    return { items: [] };
  }

  const apiKey = options?.apiKey || process.env.YOUTUBE_API_KEY;

  if (apiKey) {
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('type', 'video');
      url.searchParams.set('videoEmbeddable', 'true');
      url.searchParams.set('maxResults', '25');
      url.searchParams.set('q', q);
      if (options?.pageToken) url.searchParams.set('pageToken', options.pageToken);
      if (options?.language) url.searchParams.set('relevanceLanguage', options.language);
      url.searchParams.set('key', apiKey);

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const payload = (await res.json()) as {
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

        const items: YouTubeVideo[] = (payload.items || []).flatMap((item) => {
          const id = item.id?.videoId;
          const snippet = item.snippet;
          if (!id || !snippet?.title) return [];
          const thumbnailUrl =
            snippet.thumbnails?.high?.url ||
            snippet.thumbnails?.medium?.url ||
            snippet.thumbnails?.default?.url ||
            `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
          return [
            {
              id,
              title: decodeHtmlEntities(snippet.title),
              channel: decodeHtmlEntities(snippet.channelTitle || 'YouTube Artist'),
              description: decodeHtmlEntities(snippet.description || ''),
              thumbnailUrl,
              sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
              duration: 0,
              durationText: '',
            },
          ];
        });

        if (items.length > 0) {
          return { items, nextPageToken: payload.nextPageToken };
        }
      }
    } catch {
      // API error or quota reached, fall through to web search
    }
  }

  // Web search scraper fallback
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': options?.language ? `${options.language},en;q=0.9` : 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`YouTube returned status ${res.status}`);
  }

  const html = await res.text();
  const match = html.match(/ytInitialData\s*=\s*({.+?});/s);
  if (!match) {
    return { items: [] };
  }

  try {
    const data = JSON.parse(match[1]);
    const sections =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const items: YouTubeVideo[] = [];

    for (const section of sections) {
      const contents = section.itemSectionRenderer?.contents || [];
      for (const content of contents) {
        const v = content.videoRenderer;
        if (v && v.videoId) {
          const title = v.title?.runs?.map((r: { text: string }) => r.text).join('') || '';
          const channel =
            v.ownerText?.runs?.map((r: { text: string }) => r.text).join('') ||
            v.shortBylineText?.runs?.map((r: { text: string }) => r.text).join('') ||
            'YouTube Music';
          const lengthStr = v.lengthText?.simpleText || '';
          const duration = parseDurationText(lengthStr);
          const thumb =
            v.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
            `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
          const desc =
            v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r: { text: string }) => r.text).join('') ||
            '';

          items.push({
            id: v.videoId,
            title: decodeHtmlEntities(title),
            channel: decodeHtmlEntities(channel),
            description: decodeHtmlEntities(desc),
            thumbnailUrl: thumb,
            sourceUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
            duration,
            durationText: lengthStr,
          });
        }
      }
    }

    return { items };
  } catch {
    return { items: [] };
  }
}
