export type Track = {
  id: string;
  providerId: string;
  source: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  language: string;
  genre: string;
  artworkUrl: string;
  audioUrl: string;
  licenseName: string;
  licenseUrl: string;
  sourceUrl: string;
  attribution: string;
  duration: number;
};

export type SearchFilters = {
  language: string;
  artist: string;
  album: string;
  genre: string;
  source: string;
  sort?: string;
};

export type SearchPage = {
  tracks: Track[];
  hasMore: boolean;
};

export class SearchProviderError extends Error {
  constructor(message: string, readonly tracks: Track[], readonly hasMore = false) {
    super(message);
  }
}

const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const PAGE_SIZE = 10;
const CACHE_TTL = 5 * 60_000;
const FIELDS = ['identifier', 'title', 'creator', 'date', 'year', 'licenseurl', 'license', 'subject', 'genre', 'language'];
const OPENVERSE_ALLOWED = new Set(['by', 'by-sa', 'by-nd', 'cc0', 'pdm']);
type CacheEntry = { at: number; result: SearchPage };
const archiveCache = new Map<string, CacheEntry>();
const openverseCache = new Map<string, CacheEntry>();

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
const first = (value: unknown, fallback: string): string => list(value)[0] || fallback;
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

function cacheResult(cache: Map<string, CacheEntry>, key: string, result: SearchPage) {
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 80) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function languageName(value: string): string {
  const names: Record<string, string> = {
    ben: 'Bengali', eng: 'English', hin: 'Hindi', kan: 'Kannada', mal: 'Malayalam',
    nep: 'Nepali', pan: 'Punjabi', sin: 'Sinhala', tam: 'Tamil', tel: 'Telugu', urd: 'Urdu',
  };
  return clean(value).split(/[,;]/).map((part) => {
    const normalized = part.trim().toLowerCase();
    return names[normalized] || part.trim();
  }).filter(Boolean).join(', ');
}

function explicitLicense(metadata: Record<string, unknown>) {
  const url = first(metadata.licenseurl, '');
  if (!/^https?:\/\//i.test(url)) return null;
  const by = url.match(/creativecommons\.org\/licenses\/(by(?:-sa|-nd)?)\/(\d+(?:\.\d+)?)(?:\/|$)/i);
  const zero = url.match(/creativecommons\.org\/publicdomain\/zero\/(\d+(?:\.\d+)?)(?:\/|$)/i);
  const mark = url.match(/creativecommons\.org\/publicdomain\/mark\/(\d+(?:\.\d+)?)(?:\/|$)/i);
  if (by) return { label: `CC ${by[1].toUpperCase()} ${by[2]}`, url };
  if (zero) return { label: `CC0 ${zero[1]}`, url };
  if (mark) return { label: `Public Domain Mark ${mark[1]}`, url };
  return null;
}

function audioFile(files: Array<Record<string, unknown>>) {
  const usable = files.filter((file) => {
    const name = String(file.name || '').toLowerCase();
    const format = String(file.format || '').toLowerCase();
    return /\.(mp3|ogg|oga|wav|m4a)$/i.test(name) &&
      !/thumbnail|archive bit torrent/.test(format);
  });
  const preferred = usable.find((file) => /\.mp3$/i.test(String(file.name))) ||
    usable.find((file) => /\.ogg$|\.oga$/i.test(String(file.name))) || usable[0];
  return preferred ? String(preferred.name) : '';
}

function durationSeconds(files: Array<Record<string, unknown>>, filename: string): number {
  const file = files.find((item) => item.name === filename);
  const raw = String(file?.length || '');
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parts = raw.split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export async function searchArchive(query: string, filters: SearchFilters, signal?: AbortSignal, page = 1): Promise<SearchPage> {
  const cacheKey = JSON.stringify([query.trim().toLowerCase(), filters, page]);
  const cached = archiveCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.result;
  const terms: string[] = ['mediatype:audio', 'licenseurl:*', 'NOT licenseurl:*nc*'];
  if (!query.trim()) terms.push('collection:netlabels');
  if (query.trim()) terms.push(`(${query.trim().split(/\s+/).map((term) => `title:"${term.replace(/["\\]/g, '')}" OR creator:"${term.replace(/["\\]/g, '')}"`).join(' OR ')})`);
  if (filters.language) terms.push(`(${filters.language.split(',').map((part) => `subject:"${part.trim()}"`).join(' OR ')})`);
  if (filters.artist) terms.push(`creator:"${filters.artist.replace(/["\\]/g, '')}"`);
  if (filters.album) terms.push(`title:"${filters.album.replace(/["\\]/g, '')}"`);
  if (filters.genre) terms.push(`subject:"${filters.genre.replace(/["\\]/g, '')}"`);
  const url = new URL(IA_SEARCH);
  url.searchParams.set('q', terms.join(' AND '));
  FIELDS.forEach((field) => url.searchParams.append('fl[]', field));
  url.searchParams.set('rows', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('output', 'json');
  url.searchParams.set('sort[]', filters.sort || 'downloads desc');

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Internet Archive search returned ${response.status}.`);
  const payload = await response.json();
  const docs = payload?.response?.docs;
  if (!Array.isArray(docs)) throw new Error('The source returned an unexpected response.');

  const trackResults = await Promise.all(docs.slice(0, PAGE_SIZE).map(async (doc: Record<string, unknown>) => {
    const providerId = first(doc.identifier, '');
    if (!providerId) return null;
    try {
      const metaResponse = await fetch(`https://archive.org/metadata/${encodeURIComponent(providerId)}`, { signal });
      if (!metaResponse.ok) return null;
      const metadata = await metaResponse.json();
      const meta = metadata?.metadata || {};
      const license = explicitLicense({ ...doc, ...meta });
      if (!license) return null;
      const files = Array.isArray(metadata?.files) ? metadata.files as Array<Record<string, unknown>> : [];
      const filename = audioFile(files);
      if (!filename) return null;
      const title = clean(first(meta.title || doc.title, 'Untitled recording'));
      const creator = clean(first(meta.creator || doc.creator, 'Unknown artist'));
      const subjects = [...list(meta.genre || doc.genre), ...list(meta.subject || doc.subject)].map(clean).filter(Boolean);
      const year = clean(first(meta.year || meta.date || doc.year || doc.date, ''));
      const language = languageName(first(meta.language || doc.language, ''));
      const sourceUrl = `https://archive.org/details/${encodeURIComponent(providerId)}`;
      return {
        id: `ia:${providerId}`,
        providerId,
        source: 'Internet Archive',
        title,
        artist: creator,
        album: clean(first(meta.album, '')),
        year: year.slice(0, 4),
        language,
        genre: [...new Set(subjects)].join(', '),
        artworkUrl: `https://archive.org/services/img/${encodeURIComponent(providerId)}`,
        audioUrl: `https://archive.org/download/${encodeURIComponent(providerId)}/${encodeURIComponent(filename)}`,
        licenseName: license.label,
        licenseUrl: license.url,
        sourceUrl,
        attribution: `${title} by ${creator}. Source: ${sourceUrl}. Licensed ${license.label} (${license.url}).`,
        duration: durationSeconds(files, filename),
      } satisfies Track;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return null;
    }
  }));
  const result = {
    tracks: trackResults.filter((track): track is Track => track !== null),
    hasMore: docs.length >= PAGE_SIZE,
  };
  cacheResult(archiveCache, cacheKey, result);
  return result;
}

export async function searchOpenverse(query: string, signal?: AbortSignal, page = 1): Promise<SearchPage> {
  if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
  const cacheKey = `${query.trim().toLowerCase()}|${page}`;
  const cached = openverseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.result;
  const url = new URL('https://api.openverse.org/v1/audio/');
  url.searchParams.set('q', query.trim() || 'music');
  url.searchParams.set('page_size', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('license_type', 'commercial');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(response.status === 429 ? 'Openverse is rate-limiting requests. Please wait a moment and try again.' : `Openverse returned ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload?.results)) throw new Error('Openverse returned an unexpected response.');
  const tracks = payload.results.flatMap((item: Record<string, unknown>) => {
    const licenseCode = String(item.license || '').toLowerCase();
    if (!OPENVERSE_ALLOWED.has(licenseCode)) return [];
    const audioUrl = String(item.url || '');
    const sourceUrl = String(item.foreign_landing_url || item.source_url || '');
    const licenseUrl = String(item.license_url || '');
    if (!/^https?:\/\//i.test(audioUrl) || !/^https?:\/\//i.test(sourceUrl) || !/^https?:\/\//i.test(licenseUrl)) return [];
    const title = clean(String(item.title || 'Untitled recording'));
    const creator = clean(String(item.creator || 'Creator not identified'));
    const exactLicense = `${String(item.license || '').toUpperCase()}${item.license_version ? ` ${item.license_version}` : ''}`;
    const provider = clean(String(item.provider || item.source || 'Openverse'));
    const duration = Number(item.duration || 0);
    const genres = Array.isArray(item.genres) ? item.genres.map(String) : [];
    const tags = Array.isArray(item.tags) ? item.tags.map((tag: unknown) =>
      typeof tag === 'string' ? tag : String((tag as Record<string, unknown>)?.name || ''),
    ).filter(Boolean) : [];
    const id = `openverse:${String(item.id || audioUrl)}`;
    return [{
      id,
      providerId: String(item.id || audioUrl),
      source: `Openverse · ${provider}`,
      title,
      artist: creator,
      album: clean(String((item.audio_set as Record<string, unknown> | undefined)?.title || '')),
      year: '',
      language: languageName(String(item.language || '')),
      genre: clean([...genres, ...tags].join(', ')),
      artworkUrl: String(item.thumbnail || ''),
      audioUrl,
      licenseName: exactLicense,
      licenseUrl,
      sourceUrl,
      attribution: clean(String(item.attribution || `${title} — ${creator}; ${exactLicense}; ${sourceUrl}`)),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    } satisfies Track];
  });
  const result = { tracks, hasMore: Number(payload.result_count || 0) > page * PAGE_SIZE };
  cacheResult(openverseCache, cacheKey, result);
  return result;
}

const youtubeCache = new Map<string, CacheEntry>();

export function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.location.hostname.includes('vercel.app')) {
    return 'https://openmusic-jnp8.onrender.com';
  }
  return '';
}

export async function searchYouTubeTracks(
  query: string,
  filters: SearchFilters,
  signal?: AbortSignal,
  page = 1
): Promise<SearchPage> {
  const parts = [query, filters.artist, filters.album, filters.genre, filters.language].map((s) => s?.trim()).filter(Boolean);
  let searchText = parts.join(' ');
  if (!searchText) {
    if (filters.sort?.includes('downloads')) {
      searchText = 'top music hits global';
    } else if (filters.sort?.includes('date')) {
      searchText = 'new music hits this week';
    } else if (filters.language) {
      searchText = `${filters.language} top songs`;
    } else if (filters.genre) {
      searchText = `${filters.genre} music hits`;
    } else {
      searchText = 'trending music hits';
    }
  }

  const cacheKey = `${searchText.toLowerCase()}|${page}`;
  const cached = youtubeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.result;

  const params = new URLSearchParams({ q: searchText });
  const apiBase = getApiBaseUrl();
  const response = await fetch(`${apiBase}/api/youtube/search?${params}`, { signal });
  if (!response.ok) {
    throw new Error(`YouTube search returned ${response.status}.`);
  }

  const payload = (await response.json()) as {
    items?: Array<{
      id: string;
      title: string;
      channel: string;
      description: string;
      thumbnailUrl: string;
      sourceUrl: string;
      duration?: number;
      durationText?: string;
    }>;
    nextPageToken?: string;
  };

  const tracks: Track[] = (payload.items || []).map((video) => {
    const title = clean(video.title || 'Untitled song');
    const artist = clean(video.channel || 'YouTube Artist');
    const sourceUrl = video.sourceUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
    return {
      id: `yt:${video.id}`,
      providerId: video.id,
      source: 'YouTube',
      title,
      artist,
      album: 'YouTube',
      year: '',
      language: filters.language || '',
      genre: filters.genre || 'Music',
      artworkUrl: video.thumbnailUrl,
      audioUrl: `${apiBase}/api/youtube/stream?id=${encodeURIComponent(video.id)}`,
      licenseName: '',
      licenseUrl: '',
      sourceUrl,
      attribution: `${title} by ${artist}`,
      duration: video.duration || 0,
    };
  });

  const result: SearchPage = {
    tracks,
    hasMore: Boolean(payload.nextPageToken) || tracks.length >= 10,
  };
  cacheResult(youtubeCache, cacheKey, result);
  return result;
}

export async function searchMusic(query: string, filters: SearchFilters, signal?: AbortSignal, page = 1): Promise<SearchPage> {
  if (filters.source === 'Internet Archive') {
    return searchArchive(query, filters, signal, page);
  }
  if (filters.source === 'Openverse') {
    const openverseQuery = [query, filters.artist, filters.album, filters.genre, filters.language].filter(Boolean).join(' ');
    return searchOpenverse(openverseQuery, signal, page);
  }

  // Default: Search YouTube first
  try {
    const ytResult = await searchYouTubeTracks(query, filters, signal, page);
    if (ytResult.tracks.length > 0) {
      return ytResult;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // If YouTube search fails, fall back to Archive/Openverse
  }

  const providers = ['archive', 'openverse'];
  const openverseQuery = [
    query, filters.artist, filters.album, filters.genre, filters.language.split(',')[0],
  ].filter(Boolean).join(' ');
  const outcomes = await Promise.allSettled(providers.map((provider) =>
    provider === 'archive' ? searchArchive(query, filters, signal, page) : searchOpenverse(openverseQuery, signal, page)));
  if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
  const successes = outcomes.filter((result): result is PromiseFulfilledResult<SearchPage> => result.status === 'fulfilled');
  if (!successes.length) {
    const firstFailure = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw firstFailure?.reason || new Error('The music sources are unavailable.');
  }
  const tracks = successes.flatMap((result) => result.value.tracks);
  const hasMore = successes.some((result) => result.value.hasMore);
  const filtered = tracks.filter((track) => {
    const languageMatch = !filters.language || filters.language.split(',').some((value) => `${track.language} ${track.genre} ${track.title}`.toLowerCase().includes(value.trim().toLowerCase()));
    const artistMatch = !filters.artist || track.artist.toLowerCase().includes(filters.artist.toLowerCase());
    const albumMatch = !filters.album || `${track.album} ${track.title}`.toLowerCase().includes(filters.album.toLowerCase());
    const genreMatch = !filters.genre || track.genre.toLowerCase().includes(filters.genre.toLowerCase());
    return languageMatch && artistMatch && albumMatch && genreMatch;
  });
  const ordered = filtered.slice(0, PAGE_SIZE * providers.length);
  return { tracks: ordered, hasMore };
}

export const emptyFilters: SearchFilters = { language: '', artist: '', album: '', genre: '', source: '' };

