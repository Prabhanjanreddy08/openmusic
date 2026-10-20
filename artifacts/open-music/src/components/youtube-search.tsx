import { useEffect, useRef, useState } from "react";
import { AlertCircle, ExternalLink, Play, X } from "lucide-react";

type YoutubeVideo = {
  id: string;
  title: string;
  channel: string;
  description: string;
  thumbnailUrl: string;
  sourceUrl: string;
};

type SearchResponse = { items: YoutubeVideo[]; nextPageToken?: string };
type Props = { query: string; language: string; artist: string; album: string; genre: string };
type IFramePlayer = { destroy: () => void };
type IFrameApi = {
  Player: new (element: HTMLElement, options: {
    videoId: string;
    playerVars: Record<string, string | number>;
    events: { onReady: () => void; onError: (event: { data: number }) => void };
  }) => IFramePlayer;
};

declare global {
  interface Window {
    YT?: IFrameApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let iframeApiPromise: Promise<IFrameApi> | undefined;

function loadIFrameApi(): Promise<IFrameApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (iframeApiPromise) return iframeApiPromise;
  iframeApiPromise = new Promise<IFrameApi>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("YouTube's video player did not load. Check your connection and try again.")), 15_000);
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT?.Player) {
        window.clearTimeout(timer);
        resolve(window.YT);
      }
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("YouTube's video player could not be loaded."));
      };
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    iframeApiPromise = undefined;
    throw error;
  });
  return iframeApiPromise;
}

function languageCode(language: string) {
  const value = language.trim().toLowerCase();
  const codes: Record<string, string> = {
    english: "en", telugu: "te", hindi: "hi", tamil: "ta", kannada: "kn",
    malayalam: "ml", gujarati: "gu", bengali: "bn", japanese: "ja", korean: "ko",
  };
  return codes[value] || (/^[a-z]{2}$/.test(value) ? value : "");
}

export function YouTubeSearch({ query, language, artist, album, genre }: Props) {
  const searchText = [query, artist, album, genre].map((part) => part.trim()).filter(Boolean).join(" ");
  const langCode = languageCode(language);
  const searchKey = `${searchText}|${langCode}`;
  const [results, setResults] = useState<YoutubeVideo[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string>();
  const [pageToken, setPageToken] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<YoutubeVideo | null>(null);

  useEffect(() => {
    setPageToken(undefined);
    setNextPageToken(undefined);
    setResults([]);
    setError("");
  }, [searchKey]);

  useEffect(() => {
    if (searchText.length < 2) {
      setLoading(false);
      setResults([]);
      setError("");
      return;
    }
    const controller = new AbortController();
    const requestedToken = pageToken;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      if (!requestedToken) setError("");
      const params = new URLSearchParams({ q: searchText });
      if (requestedToken) params.set("pageToken", requestedToken);
      if (langCode) params.set("language", langCode);
      try {
        const response = await fetch(`/api/youtube/search?${params}`, { signal: controller.signal });
        const payload = await response.json() as SearchResponse | { error?: string };
        if (!response.ok) throw new Error("error" in payload ? payload.error || "YouTube search failed." : "YouTube search failed.");
        const page = payload as SearchResponse;
        setResults((previous) => {
          if (!requestedToken) return page.items;
          const known = new Set(previous.map((item) => item.id));
          return [...previous, ...page.items.filter((item) => !known.has(item.id))];
        });
        setNextPageToken(page.nextPageToken);
        setError("");
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Could not search YouTube.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchKey, searchText, langCode, pageToken, attempt]);

  if (searchText.length < 2) {
    return <div className="youtube-hint" role="status"><Play size={20} /><div><strong>Search YouTube’s public video catalog</strong><p>Try an artist, song title, or a language such as Telugu, Hindi, Malayalam, Gujarati, or English.</p></div></div>;
  }

  return <div className="youtube-results">
    {error && <div className="youtube-error" role="alert"><AlertCircle size={18} /><div><strong>YouTube search is unavailable.</strong><p>{error}</p><button className="text-action" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div></div>}
    {loading && results.length === 0 && <div className="youtube-hint" role="status"><span className="youtube-spinner" /><div><strong>Searching YouTube</strong><p>Results come from the official YouTube Data API.</p></div></div>}
    {!loading && !error && results.length === 0 && <div className="youtube-hint" role="status"><Play size={20} /><div><strong>No video results found.</strong><p>Try a different spelling or broader search phrase.</p></div></div>}
    {results.length > 0 && <div className="youtube-grid">{results.map((video) => <article className="youtube-card" key={video.id}>
      <button className="youtube-thumbnail" onClick={() => setSelected(video)} aria-label={`Play ${video.title} in YouTube's player`}>
        <img src={video.thumbnailUrl} alt="" loading="lazy" />
        <span className="youtube-play"><Play size={19} fill="currentColor" /></span>
      </button>
      <div className="youtube-card-info"><button className="youtube-title" onClick={() => setSelected(video)}>{video.title}</button><span>{video.channel}</span><p>{video.description || "YouTube video result."}</p>
        <div className="youtube-card-actions"><button className="small-action" onClick={() => setSelected(video)}><Play size={13} /> Watch here</button><a href={video.sourceUrl} target="_blank" rel="noreferrer" className="youtube-source">YouTube <ExternalLink size={11} /></a></div>
      </div>
    </article>)}</div>}
    {nextPageToken && <div className="load-more-wrap"><button className="secondary-button" onClick={() => setPageToken(nextPageToken)} disabled={loading}>{loading ? "Finding more…" : "Load more YouTube videos"}</button></div>}
    <p className="youtube-disclosure">Video playback uses YouTube’s official player. YouTube may show its own ads, restrict playback, or make a video unavailable. This app does not bypass those controls.</p>
    {selected && <YouTubePlayer video={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function YouTubePlayer({ video, onClose }: { video: YoutubeVideo; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<IFramePlayer | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    document.body.style.overflow = "hidden";
    let cancelled = false;
    void loadIFrameApi().then((api) => {
      if (cancelled || !container.current) return;
      player.current = new api.Player(container.current, {
        videoId: video.id,
        playerVars: {
          autoplay: 1, controls: 1, enablejsapi: 1, playsinline: 1, rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => setReady(true),
          onError: (event) => setError(`YouTube could not play this video (code ${event.data}). Try opening the source page.`),
        },
      });
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "YouTube's video player could not be loaded."));
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = "";
      player.current?.destroy();
      player.current = null;
    };
  }, [video.id, onClose]);

  return <div className="youtube-player-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="youtube-player-dialog" role="dialog" aria-modal="true" aria-label={`YouTube player: ${video.title}`}>
      <div className="youtube-player-head"><div><span className="eyebrow">OFFICIAL YOUTUBE PLAYER</span><h2>{video.title}</h2><p>{video.channel}</p></div><button className="icon-button" onClick={onClose} aria-label="Close YouTube player"><X size={19} /></button></div>
      <div className="youtube-frame-wrap"><div className="youtube-frame" ref={container} />{!ready && !error && <div className="youtube-frame-loading"><span className="youtube-spinner" /> Loading YouTube’s player…</div>}</div>
      {error && <div className="youtube-error" role="alert"><AlertCircle size={17} /><span>{error}</span><a href={video.sourceUrl} target="_blank" rel="noreferrer">Open on YouTube <ExternalLink size={12} /></a></div>}
      <p className="youtube-disclosure">YouTube controls video playback and may display ads or restrictions. Playback is not audio-only.</p>
    </section>
  </div>;
}
