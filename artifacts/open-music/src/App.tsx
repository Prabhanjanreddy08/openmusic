import { useCallback, useEffect, useRef, useState, createContext, useContext, type ReactNode, type FormEvent, type CSSProperties, type RefObject } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  AudioLines, Disc3, Heart, Home, Library, ListMusic, Moon, Music2,
  Pause, Play, Plus, Search, SkipBack, SkipForward, SlidersHorizontal, Sun, Volume2,
  VolumeX, X, Shuffle, Repeat, Repeat1, ChevronDown, ExternalLink, Clock3, Trash2,
  ListPlus, ArrowLeft, Check, AlertCircle, Headphones,
} from 'lucide-react';
import { emptyFilters, searchMusic, SearchProviderError, type SearchFilters, type Track } from '@/lib/source';
import '@/index.css';

type Playlist = { id: string; name: string; description: string; trackIds: string[]; createdAt: string };
type LocalState = {
  favorites: string[];
  playlists: Playlist[];
  recent: Track[];
  queue: Track[];
  theme: 'dark' | 'light';
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  tracks: Record<string, Track>;
};
type MusicContextType = LocalState & {
  current: Track | null;
  playing: boolean;
  playbackError: string;
  currentTime: number;
  duration: number;
  muted: boolean;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  playTrack: (track: Track, items?: Track[]) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (value: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  toggleFavorite: (track: Track) => void;
  addQueue: (track: Track) => void;
  removeQueue: (index: number) => void;
  reorderQueue: (tracks: Track[]) => void;
  createPlaylist: (name: string, description?: string) => Playlist;
  updatePlaylist: (playlist: Playlist) => void;
  deletePlaylist: (id: string) => void;
  addToPlaylist: (id: string, track: Track) => void;
  updateTheme: () => void;
  clearPlaybackError: () => void;
  cacheTracks: (tracks: Track[]) => void;
  audio: HTMLAudioElement | null;
  setAudio: (audio: HTMLAudioElement) => void;
  silentAudioRef: RefObject<HTMLAudioElement | null>;
};
const MusicContext = createContext<MusicContextType | null>(null);
const STORAGE_KEY = 'open-music-state-v1';
const SILENT_AUDIO_URI = '/silence.wav';
const DEFAULT_STATE: LocalState = { favorites: [], playlists: [], recent: [], queue: [], theme: 'dark', volume: 0.72, muted: false, shuffle: false, repeat: 'off', tracks: {} };
const queryClient = new QueryClient();

function readState(): LocalState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_STATE, ...saved, tracks: saved.tracks || {} };
  } catch { return DEFAULT_STATE; }
}

function MusicProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState<LocalState>(readState);
  const [current, setCurrent] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const muted = local.muted;
  const [expanded, setExpanded] = useState(false);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const userPausedRef = useRef(false);
  const ytPlayerRef = useRef<any>(null);
  const pendingVideoRef = useRef<string | null>(null);
  const latest = useRef({ local, current, playing, userPaused: false });
  latest.current = { local, current, playing, userPaused: userPausedRef.current };

  const patch = useCallback((update: Partial<LocalState> | ((old: LocalState) => Partial<LocalState>)) => {
    setLocal((old) => ({ ...old, ...(typeof update === 'function' ? update(old) : update) }));
  }, []);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    document.documentElement.classList.toggle('dark', local.theme === 'dark');
  }, [local]);

  // Initialize YouTube IFrame API
  useEffect(() => {
    let active = true;

    const loadApi = (): Promise<any> => {
      if ((window as any).YT?.Player) return Promise.resolve((window as any).YT);
      return new Promise((resolve) => {
        const prev = (window as any).onYouTubeIframeAPIReady;
        (window as any).onYouTubeIframeAPIReady = () => {
          prev?.();
          resolve((window as any).YT);
        };
        if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
          const script = document.createElement('script');
          script.src = 'https://www.youtube.com/iframe_api';
          script.async = true;
          document.head.appendChild(script);
        }
        const check = setInterval(() => {
          if ((window as any).YT?.Player) {
            clearInterval(check);
            resolve((window as any).YT);
          }
        }, 200);
      });
    };

    loadApi().then((YT) => {
      if (!active) return;
      const target = document.getElementById('youtube-player-element');
      if (!target) return;

      ytPlayerRef.current = new YT.Player('youtube-player-element', {
        height: '100',
        width: '100',
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: any) => {
            event.target.setVolume(local.volume * 100);
            if (local.muted) event.target.mute();
            if (pendingVideoRef.current) {
              const vid = pendingVideoRef.current;
              pendingVideoRef.current = null;
              event.target.loadVideoById(vid);
              event.target.playVideo();
            }
          },
          onStateChange: (event: any) => {
            if (event.data === 1) {
              userPausedRef.current = false;
              setPlaying(true);
              const dur = event.target.getDuration();
              if (dur > 0) setDuration(dur);
            } else if (event.data === 2) {
              if (userPausedRef.current) {
                setPlaying(false);
              } else {
                // Background/lock-screen auto-pause triggered by mobile browser!
                // Keep playing and resume audio immediately like Spotify!
                if (silentAudioRef.current && silentAudioRef.current.paused) {
                  silentAudioRef.current.play().catch(() => {});
                }
                setTimeout(() => {
                  if (!userPausedRef.current && ytPlayerRef.current?.playVideo) {
                    try {
                      ytPlayerRef.current.playVideo();
                    } catch {}
                  }
                }, 50);
              }
            } else if (event.data === 0) {
              const { local: snapshot, current: track } = latest.current;
              if (snapshot.repeat === 'one' && track) {
                event.target.seekTo(0);
                event.target.playVideo();
              } else if (snapshot.repeat === 'all' || snapshot.queue.length > 1) {
                nextRef.current();
              } else {
                setPlaying(false);
              }
            }
          },
          onError: () => {
            setPlaying(false);
            setPlaybackError('This track could not be played. Skipping to next track...');
            setTimeout(() => {
              if (latest.current.local.queue.length > 1) {
                nextRef.current();
              }
            }, 1500);
          },
        },
      });
    });

    return () => {
      active = false;
    };
  }, []);

  // Poll YouTube player time
  useEffect(() => {
    if (!playing) return;
    const isYT = current?.source === 'YouTube' || current?.id?.startsWith('yt:');
    if (!isYT) return;
    const timer = setInterval(() => {
      if (ytPlayerRef.current?.getCurrentTime) {
        try {
          const time = ytPlayerRef.current.getCurrentTime();
          if (typeof time === 'number' && Number.isFinite(time)) {
            setCurrentTime(time);
          }
          const dur = ytPlayerRef.current.getDuration();
          if (typeof dur === 'number' && Number.isFinite(dur) && dur > 0) {
            setDuration(dur);
          }
        } catch {}
      }
    }, 250);
    return () => clearInterval(timer);
  }, [playing, current]);

  useEffect(() => {
    if (!audio) return;
    audio.volume = local.volume;
    audio.muted = local.muted;
    const onTime = () => setCurrentTime(audio.currentTime || 0);
    const onDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      const { local: snapshot, current: track } = latest.current;
      if (snapshot.repeat === 'one' && track) { audio.currentTime = 0; void audio.play(); }
      else if (snapshot.repeat === 'all' || snapshot.queue.length > 1) nextRef.current();
      else setPlaying(false);
    };
    const onError = () => {
      setPlaying(false);
      setPlaybackError('This source could not play the track. The file may be unavailable or unsupported by this browser. Try another recording.');
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [audio, local.volume, local.muted]);

  const cacheTracks = useCallback((tracks: Track[]) => patch((old) => {
    const nextTracks = { ...old.tracks };
    tracks.forEach((track) => { nextTracks[track.id] = track; });
    return { tracks: nextTracks };
  }), [patch]);

  const playTrack = useCallback((track: Track, items?: Track[]) => {
    cacheTracks([track, ...(items || [])]);
    userPausedRef.current = false;
    setCurrent(track);
    setCurrentTime(0);
    setPlaybackError('');

    const isYT = track.source === 'YouTube' || track.id.startsWith('yt:');
    if (silentAudioRef.current) {
      silentAudioRef.current.play().catch(() => {});
    }
    if (isYT) {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      const videoId = track.providerId || track.id.replace(/^yt:/, '');
      if (ytPlayerRef.current?.loadVideoById) {
        ytPlayerRef.current.loadVideoById(videoId);
        ytPlayerRef.current.playVideo();
        setPlaying(true);
      } else {
        pendingVideoRef.current = videoId;
        setPlaying(true);
      }
    } else {
      if (ytPlayerRef.current?.pauseVideo) {
        ytPlayerRef.current.pauseVideo();
      }
      if (audio) {
        audio.src = track.audioUrl;
        audio.load();
        void audio.play().catch((error: unknown) => {
          setPlaying(false);
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            setPlaybackError('Playback could not start. The source may be restricted or unavailable; try another recording.');
          }
        });
      }
    }

    patch((old) => {
      const queue = items?.length ? items : [track];
      return { queue, recent: [track, ...old.recent.filter((item) => item.id !== track.id)].slice(0, 100) };
    });
  }, [audio, cacheTracks, patch]);

  const next = useCallback(() => {
    userPausedRef.current = false;
    const { local: state, current: now } = latest.current;
    if (!state.queue.length) return;
    const index = state.queue.findIndex((track) => track.id === now?.id);
    let nextIndex = index + 1;
    if (state.shuffle && state.queue.length > 1) {
      const candidates = state.queue.map((_, itemIndex) => itemIndex).filter((itemIndex) => itemIndex !== index);
      nextIndex = candidates[Math.floor(Math.random() * candidates.length)];
    }
    if (nextIndex >= state.queue.length) nextIndex = state.repeat === 'all' ? 0 : -1;
    if (nextIndex >= 0) playTrack(state.queue[nextIndex], state.queue);
    else {
      if (audio) { audio.pause(); audio.currentTime = 0; }
      if (ytPlayerRef.current?.pauseVideo) ytPlayerRef.current.pauseVideo();
      setPlaying(false);
    }
  }, [audio, playTrack]);
  const nextRef = useRef(next);
  nextRef.current = next;

  const previous = useCallback(() => {
    userPausedRef.current = false;
    const isYT = current?.source === 'YouTube' || current?.id?.startsWith('yt:');
    if (isYT && ytPlayerRef.current?.getCurrentTime && ytPlayerRef.current.getCurrentTime() > 3) {
      ytPlayerRef.current.seekTo(0, true);
      return;
    }
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    const { local: state, current: now } = latest.current;
    const index = state.queue.findIndex((track) => track.id === now?.id);
    if (index > 0) playTrack(state.queue[index - 1], state.queue);
    else {
      if (isYT && ytPlayerRef.current?.seekTo) ytPlayerRef.current.seekTo(0, true);
      else if (audio) audio.currentTime = 0;
    }
  }, [audio, current, playTrack]);

  const togglePlay = useCallback(() => {
    if (!current) {
      const track = local.queue[0] || local.recent[0];
      if (track) playTrack(track, local.queue.length ? local.queue : [track]);
      return;
    }
    const isYT = current.source === 'YouTube' || current.id.startsWith('yt:');
    if (playing) {
      userPausedRef.current = true;
      if (silentAudioRef.current) silentAudioRef.current.pause();
      if (isYT && ytPlayerRef.current) {
        ytPlayerRef.current.pauseVideo();
      } else if (audio) {
        audio.pause();
      }
      setPlaying(false);
    } else {
      userPausedRef.current = false;
      if (silentAudioRef.current) silentAudioRef.current.play().catch(() => {});
      if (isYT && ytPlayerRef.current) {
        ytPlayerRef.current.playVideo();
      } else if (audio) {
        void audio.play().catch(() => setPlaying(false));
      }
      setPlaying(true);
    }
  }, [audio, current, playing, local.queue, local.recent, playTrack]);

  const seek = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    setCurrentTime(value);
    const isYT = current?.source === 'YouTube' || current?.id?.startsWith('yt:');
    if (isYT && ytPlayerRef.current?.seekTo) {
      ytPlayerRef.current.seekTo(value, true);
    } else if (audio) {
      audio.currentTime = value;
    }
  }, [audio, current]);

  const setVolume = useCallback((value: number) => {
    const safe = Math.max(0, Math.min(1, value));
    if (ytPlayerRef.current?.setVolume) {
      ytPlayerRef.current.setVolume(safe * 100);
    }
    if (audio) audio.volume = safe;
    patch({ volume: safe, ...(safe > 0 ? { muted: false } : {}) });
    if (safe > 0) {
      if (ytPlayerRef.current?.unMute) ytPlayerRef.current.unMute();
      if (audio) audio.muted = false;
    }
  }, [audio, patch]);

  const toggleMute = useCallback(() => {
    const nextMuted = !latest.current.local.muted;
    if (ytPlayerRef.current) {
      if (nextMuted) ytPlayerRef.current.mute();
      else ytPlayerRef.current.unMute();
    }
    if (audio) audio.muted = nextMuted;
    patch({ muted: nextMuted });
  }, [audio, patch]);

  const toggleShuffle = useCallback(() => patch((old) => ({ shuffle: !old.shuffle })), [patch]);
  const toggleRepeat = useCallback(() => patch((old) => ({ repeat: old.repeat === 'off' ? 'all' : old.repeat === 'all' ? 'one' : 'off' })), [patch]);
  const toggleFavorite = useCallback((track: Track) => {
    cacheTracks([track]);
    patch((old) => ({ favorites: old.favorites.includes(track.id) ? old.favorites.filter((id) => id !== track.id) : [track.id, ...old.favorites] }));
  }, [cacheTracks, patch]);
  const addQueue = useCallback((track: Track) => {
    cacheTracks([track]);
    patch((old) => ({ queue: [...old.queue, track] }));
  }, [cacheTracks, patch]);
  const removeQueue = useCallback((index: number) => patch((old) => ({ queue: old.queue.filter((_, itemIndex) => itemIndex !== index) })), [patch]);
  const reorderQueue = useCallback((queue: Track[]) => patch({ queue }), [patch]);
  const createPlaylist = useCallback((name: string, description = '') => {
    const playlist: Playlist = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, description, trackIds: [], createdAt: new Date().toISOString() };
    patch((old) => ({ playlists: [playlist, ...old.playlists] }));
    return playlist;
  }, [patch]);
  const updatePlaylist = useCallback((playlist: Playlist) => patch((old) => ({ playlists: old.playlists.map((item) => item.id === playlist.id ? playlist : item) })), [patch]);
  const deletePlaylist = useCallback((id: string) => patch((old) => ({ playlists: old.playlists.filter((item) => item.id !== id) })), [patch]);
  const addToPlaylist = useCallback((id: string, track: Track) => {
    cacheTracks([track]);
    patch((old) => ({ playlists: old.playlists.map((playlist) => playlist.id === id && !playlist.trackIds.includes(track.id) ? { ...playlist, trackIds: [...playlist.trackIds, track.id] } : playlist) }));
  }, [cacheTracks, patch]);
  const updateTheme = useCallback(() => patch((old) => ({ theme: old.theme === 'dark' ? 'light' : 'dark' })), [patch]);
  const clearPlaybackError = useCallback(() => setPlaybackError(''), []);

  // Mobile Background Audio Keepalive
  useEffect(() => {
    if (!silentAudioRef.current) return;
    if (playing) {
      silentAudioRef.current.play().catch(() => {});
    } else {
      silentAudioRef.current.pause();
    }
  }, [playing]);

  // MediaSession API Integration for Phone Lock Screen & Notification Controls
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist,
        album: current.album || 'Open Music',
        artwork: [
          { src: current.artworkUrl || '/icon.png', sizes: '512x512', type: 'image/png' },
          { src: current.artworkUrl || '/icon.png', sizes: '256x256', type: 'image/png' },
          { src: current.artworkUrl || '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
          { src: current.artworkUrl || '/favicon.png', sizes: '96x96', type: 'image/png' },
        ],
      });

      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch {}
  }, [current, playing]);

  // MediaSession Action Handlers (Bluetooth, Earbuds, Lock Screen buttons)
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const actionHandlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => {
        userPausedRef.current = false;
        if (silentAudioRef.current) silentAudioRef.current.play().catch(() => {});
        if (ytPlayerRef.current?.playVideo) ytPlayerRef.current.playVideo();
        if (audio && audio.paused) void audio.play().catch(() => {});
        setPlaying(true);
      }],
      ['pause', () => {
        userPausedRef.current = true;
        if (silentAudioRef.current) silentAudioRef.current.pause();
        if (ytPlayerRef.current?.pauseVideo) ytPlayerRef.current.pauseVideo();
        if (audio && !audio.paused) audio.pause();
        setPlaying(false);
      }],
      ['previoustrack', () => { userPausedRef.current = false; previous(); }],
      ['nexttrack', () => { userPausedRef.current = false; next(); }],
      ['seekto', (details) => { if (typeof details.seekTime === 'number') seek(details.seekTime); }],
      ['seekbackward', (details) => { seek(Math.max(currentTime - (details.seekOffset || 10), 0)); }],
      ['seekforward', (details) => { seek(Math.min(currentTime + (details.seekOffset || 10), duration)); }],
      ['stop', () => {
        userPausedRef.current = true;
        if (silentAudioRef.current) silentAudioRef.current.pause();
        if (ytPlayerRef.current?.pauseVideo) ytPlayerRef.current.pauseVideo();
        if (audio) audio.pause();
        setPlaying(false);
      }],
    ];

    actionHandlers.forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    });

    return () => {
      actionHandlers.forEach(([action]) => {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {}
      });
    };
  }, [togglePlay, previous, next, seek, currentTime, duration]);

  // Update MediaSession Position State
  useEffect(() => {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    if (duration > 0 && Number.isFinite(duration) && Number.isFinite(currentTime)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(duration, 0),
          playbackRate: 1,
          position: Math.min(Math.max(currentTime, 0), duration),
        });
      } catch {}
    }
  }, [currentTime, duration]);

  // Mobile App Switch / Background Visibility Guard
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && !userPausedRef.current && latest.current.current) {
        if (silentAudioRef.current && silentAudioRef.current.paused) {
          silentAudioRef.current.play().catch(() => {});
        }
        setTimeout(() => {
          if (!userPausedRef.current && ytPlayerRef.current?.playVideo) {
            try {
              ytPlayerRef.current.playVideo();
            } catch {}
          }
        }, 80);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handleVisibility);
    };
  }, []);

  const value: MusicContextType = {
    ...local, current, playing, playbackError, currentTime, duration, muted, expanded, setExpanded, playTrack, togglePlay, next, previous,
    seek, setVolume, toggleMute, toggleShuffle, toggleRepeat, toggleFavorite, addQueue, removeQueue, reorderQueue, createPlaylist, updatePlaylist,
    deletePlaylist, addToPlaylist, updateTheme, clearPlaybackError, cacheTracks, audio, setAudio, silentAudioRef,
  };
  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}

function useMusic() {
  const value = useContext(MusicContext);
  if (!value) throw new Error('MusicProvider is missing');
  return value;
}

const navItems = [
  { href: '/', label: 'Discover', icon: Home },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/library', label: 'Your library', icon: Library },
  { href: '/favorites', label: 'Favorites', icon: Heart },
  { href: '/playlists', label: 'Playlists', icon: ListMusic },
];

function AppShell() {
  const music = useMusic();
  const [location] = useLocation();
  const [queueOpen, setQueueOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(event.target.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); music.togglePlay(); }
      if (event.code === 'ArrowRight' && event.altKey) music.next();
      if (event.code === 'ArrowLeft' && event.altKey) music.previous();
      if (event.code === 'ArrowRight' && !event.altKey) music.seek(Math.min(music.duration, music.currentTime + 5));
      if (event.code === 'ArrowLeft' && !event.altKey) music.seek(Math.max(0, music.currentTime - 5));
      if (event.key.toLowerCase() === 'm') music.toggleMute();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [music.togglePlay, music.next, music.previous, music.toggleMute, music.seek, music.duration, music.currentTime]);
  return <div className="shell grain">
    <div style={{ position: 'fixed', top: 0, left: 0, width: 200, height: 200, opacity: 0.001, pointerEvents: 'none', zIndex: -9999, transform: 'translate3d(0, 0, 0)' }}>
      <div id="youtube-player-element" />
    </div>
    <audio ref={(node) => { if (node && music.audio !== node) music.setAudio(node); }} preload="metadata" data-testid="audio-element" />
    <audio ref={music.silentAudioRef} src={SILENT_AUDIO_URI} loop preload="auto" playsInline />
    <aside className="sidebar">
      <Link href="/" className="brand" data-testid="link-brand"><span className="brand-mark"><AudioLines size={20} /></span><span>open<span className="brand-light">music</span></span></Link>
      <div className="side-caption">YOUR SPACE</div>
      <nav className="side-nav">
        {navItems.map(({ href, label, icon: Icon }) => <Link href={href} key={href} className={`nav-link ${location === href || (href === '/playlists' && location.startsWith('/playlists')) ? 'active' : ''}`} data-testid={`nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{href === '/favorites' && music.favorites.length > 0 && <span className="nav-count">{music.favorites.length}</span>}</Link>)}
      </nav>
      <div className="sidebar-note"><div className="note-rule" /><p>Music that belongs to everyone.</p><span>Free to hear. Clear to share.</span></div>
      <button className="theme-button" onClick={music.updateTheme} data-testid="button-theme"><span>{music.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</span><span>Switch to {music.theme === 'dark' ? 'light' : 'dark'} mode</span></button>
    </aside>
    <div className="mobile-top"><Link href="/" className="brand"><span className="brand-mark"><AudioLines size={19} /></span><span>open<span className="brand-light">music</span></span></Link><button className="icon-button" onClick={music.updateTheme} aria-label="Toggle theme" data-testid="button-theme-mobile">{music.theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button></div>
    <main className="main-area" key={location}>
      <Switch>
        <Route path="/" component={DiscoverPage} />
        <Route path="/search" component={SearchPage} />
        <Route path="/library" component={LibraryPage} />
        <Route path="/favorites" component={FavoritesPage} />
        <Route path="/playlists" component={PlaylistsPage} />
        <Route path="/playlists/:id" component={PlaylistPage} />
        <Route component={NotFoundPage} />
      </Switch>
    </main>
    <PlayerBar onQueue={() => setQueueOpen((value) => !value)} />
    {music.playbackError && <div className="playback-error" role="alert" data-testid="status-playback-error"><AlertCircle size={16} /><span>{music.playbackError}</span><button onClick={music.clearPlaybackError} aria-label="Dismiss playback error" data-testid="button-dismiss-playback-error"><X size={15} /></button></div>}
    {queueOpen && <QueueDrawer onClose={() => setQueueOpen(false)} />}
    <nav className="mobile-nav" aria-label="Main navigation">{navItems.slice(0, 5).map(({ href, label, icon: Icon }) => <Link href={href} key={href} className={`mobile-nav-link ${location === href ? 'active' : ''}`} data-testid={`mobile-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={19} /><span>{label === 'Your library' ? 'Library' : label}</span></Link>)}</nav>
    {music.expanded && <ExpandedPlayer onClose={() => music.setExpanded(false)} />}
  </div>;
}

function Header({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <header className="page-header fade-up"><div><div className="eyebrow">{eyebrow}</div><h1 className="serif">{title}</h1>{subtitle && <p className="page-subtitle">{subtitle}</p>}</div>{action}</header>;
}

function Status({ kind, title, detail, retry }: { kind: 'loading' | 'empty' | 'error'; title: string; detail: string; retry?: () => void }) {
  return <div className={`status-panel status-${kind}`} data-testid={`status-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    {kind === 'loading' ? <div className="skeleton-icon" /> : kind === 'error' ? <AlertCircle size={21} /> : <Headphones size={21} />}
    <div><strong>{title}</strong><p>{detail}</p>{kind === 'error' && retry && <button className="text-action" onClick={retry} data-testid="button-retry">Try again</button>}</div>
  </div>;
}

function useSourceTracks(query: string, filters: SearchFilters, enabled = true) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const music = useMusic();
  const stableFilters = JSON.stringify(filters);
  useEffect(() => {
    setPage(1);
    setTracks([]);
    setHasMore(false);
    setLoadingMore(false);
    setError('');
  }, [query, stableFilters]);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    const requestedPage = page;
    const controller = new AbortController();
    setLoading(requestedPage === 1);
    setLoadingMore(requestedPage > 1);
    if (requestedPage === 1) setError('');
    const timer = window.setTimeout(() => {
      searchMusic(query, JSON.parse(stableFilters), controller.signal, requestedPage)
        .then((result) => {
          setTracks((previous) => {
            if (requestedPage === 1) return result.tracks;
            const known = new Set(previous.map((track) => track.id));
            return [...previous, ...result.tracks.filter((track) => !known.has(track.id))];
          });
          setHasMore(result.hasMore);
          music.cacheTracks(result.tracks);
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === 'AbortError') return;
          if (reason instanceof SearchProviderError) {
            setTracks((previous) => {
              if (requestedPage === 1) return reason.tracks;
              const known = new Set(previous.map((track) => track.id));
              return [...previous, ...reason.tracks.filter((track) => !known.has(track.id))];
            });
            setHasMore(reason.hasMore);
            music.cacheTracks(reason.tracks);
          }
          setError(reason instanceof Error ? reason.message : 'Could not reach the music source.');
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
            setLoadingMore(false);
          }
        });
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, stableFilters, enabled, attempt, page, music.cacheTracks]);
  return {
    tracks, loading, loadingMore, hasMore, error,
    retry: () => setAttempt((value) => value + 1),
    loadMore: () => { if (hasMore && !loadingMore) setPage((value) => value + 1); },
  };
}

function DiscoverPage() {
  const music = useMusic();
  const latest = useSourceTracks('', { ...emptyFilters, source: 'YouTube', sort: 'date desc' });
  const popular = useSourceTracks('', { ...emptyFilters, source: 'YouTube', sort: 'downloads desc' });
  const recent = music.recent;
  const favoriteTrack = music.favorites.map((id) => music.tracks[id]).find(Boolean);
  const recommendationSeed = recent[0] || favoriteTrack;
  const recommendationQuery = recommendationSeed?.genre.split(',')[0]?.trim() || recommendationSeed?.artist || '';
  const recommendation = useSourceTracks(recommendationQuery ? `${recommendationQuery} songs` : '', emptyFilters, Boolean(recommendationQuery));
  const recommendationTracks = recommendation.tracks.filter((track) =>
    !recent.some((item) => item.id === track.id) && !music.favorites.includes(track.id),
  );
  const [filter, setFilter] = useState('All sounds');
  const filterMap: Record<string, SearchFilters> = {
    'All sounds': emptyFilters,
    'South Asian': { ...emptyFilters, language: 'Hindi Bollywood Punjabi' },
    'Instrumental': { ...emptyFilters, genre: 'lofi instrumental chill' },
    'Global Pop': { ...emptyFilters, genre: 'pop billboard hits' },
    'Rock Classics': { ...emptyFilters, genre: 'rock classics' },
    'Hip-Hop & R&B': { ...emptyFilters, genre: 'hip hop r&b' },
  };
  const discovery = useSourceTracks('', filterMap[filter]);
  return <div className="page-wrap">
    <div className="topline"><span className="topline-copy"><span className="live-dot" /> Any song on YouTube, freely playable</span><Link href="/search" className="top-search" data-testid="link-top-search"><Search size={17} /> Find a sound <span className="mono">/</span></Link></div>
    <section className="welcome-block fade-up"><div className="welcome-copy"><p className="eyebrow">A listening room without borders</p><h1 className="serif">Hear what<br /><em>belongs to all.</em></h1><p className="welcome-description">Search and stream any song, artist, album, or music video across YouTube's vast global catalog.</p><div className="welcome-meta"><span className="open-circle"><Check size={13} /></span><span>Every song is powered by YouTube's high quality audio stream.</span></div></div><div className="welcome-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-center"><Disc3 size={85} strokeWidth={0.8} /></div><span className="art-label">OPEN<br />SOUNDS</span><span className="art-number">01 — 26</span></div></section>
    <div className="catalog-note"><span className="note-glyph">i</span><p>Listen to any song on YouTube with background audio, custom playlists, queue, and local favorites saved on your device.</p></div>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">Trending on YouTube</div><h2 className="serif">A first listen</h2></div><Link href="/search" className="section-link" data-testid="link-browse-search">Browse the catalog <span>↗</span></Link></div>
      <div className="filter-pills" role="tablist" aria-label="Discovery filters">{Object.keys(filterMap).map((item) => <button role="tab" aria-selected={filter === item} key={item} className={`pill ${filter === item ? 'selected' : ''}`} onClick={() => setFilter(item)} data-testid={`filter-${item.toLowerCase().replaceAll(' ', '-')}`}>{item}</button>)}</div>
      <TrackSection result={discovery} title="Source results" />
    </section>
    <section className="section-block popular-block"><div className="section-heading"><div><div className="eyebrow">Recently added</div><h2 className="serif">New to this room</h2></div><span className="section-caption">YouTube · fresh releases</span></div><TrackSection result={latest} compact /></section>
    <section className="section-block popular-block"><div className="section-heading"><div><div className="eyebrow">Source activity</div><h2 className="serif">Most downloaded</h2></div><span className="section-caption">YouTube · top global charts</span></div><TrackSection result={popular} compact /></section>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">A thread from your listening</div><h2 className="serif">For your listening</h2></div>{recommendationQuery && <span className="section-caption">Inspired by {recommendationSeed?.artist}</span>}</div>
      {recommendationQuery
        ? <TrackSection result={{ ...recommendation, tracks: recommendationTracks }} compact />
        : <Status kind="empty" title="Your first listen will shape this space." detail="Play or favorite a recording, and we'll look for similar music using its artist or genre." />}
    </section>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">Your listening trail</div><h2 className="serif">Recently played</h2></div><Link href="/library" className="section-link" data-testid="link-history">Your library <span>↗</span></Link></div>
      {recent.length ? <TrackGrid tracks={recent.slice(0, 6)} /> : <div className="recent-empty"><Clock3 size={19} /><span>Tracks you play will find their way here.</span></div>}
    </section>
    <footer className="site-footer"><span>OPEN MUSIC <span>·</span> YOUTUBE STREAMING</span><span>Stream freely with local playlists and queue.</span></footer>
  </div>;
}

function TrackSection({ result, title, compact = false }: { result: ReturnType<typeof useSourceTracks>; title?: string; compact?: boolean }) {
  if ((result.loading || result.loadingMore) && result.tracks.length === 0) return <div className="track-grid">{[1, 2, 3, 4].map((key) => <div className="track-skeleton" key={key}><div /><span /><i /></div>)}</div>;
  if (result.error && result.tracks.length === 0) return <Status kind="error" title="A music source is unavailable." detail={result.error} retry={result.retry} />;
  if (!result.tracks.length) return <>
    <Status kind="empty" title="No openly licensed recordings found yet." detail="Try a broader phrase or explore another filter. Search results only appear when the source confirms a playable file and an eligible license." />
    {result.hasMore && <div className="load-more-wrap"><button className="secondary-button" onClick={result.loadMore} disabled={result.loadingMore} data-testid="button-load-more">{result.loadingMore ? 'Finding more…' : 'Load more recordings'}</button></div>}
  </>;
  return <>
    {result.error && <Status kind="error" title="A music source is unavailable." detail={result.error} retry={result.retry} />}
    <TrackGrid tracks={result.tracks} compact={compact} title={title} />
    {result.hasMore && <div className="load-more-wrap"><button className="secondary-button" onClick={result.loadMore} disabled={result.loadingMore} data-testid="button-load-more">{result.loadingMore ? 'Finding more…' : 'Load more recordings'}</button></div>}
  </>;
}

function TrackGrid({ tracks, compact = false, title }: { tracks: Track[]; compact?: boolean; title?: string }) {
  return <div className={`track-grid ${compact ? 'compact-grid' : ''}`} data-testid="track-grid">{tracks.map((track) => <TrackCard key={track.id} track={track} compact={compact} />)}</div>;
}

function TrackCard({ track, compact = false }: { track: Track; compact?: boolean }) {
  const music = useMusic();
  const liked = music.favorites.includes(track.id);
  const [menu, setMenu] = useState(false);
  return <article className={`track-card ${compact ? 'track-row' : ''}`} data-testid={`track-card-${track.id}`}>
    <div className="artwork-wrap">
      <img src={track.artworkUrl} alt="" className="track-art" loading="lazy" onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }} data-testid={`artwork-${track.id}`} />
      <div className="art-fallback"><Music2 size={27} strokeWidth={1.2} /></div>
      <button className="art-play" onClick={() => music.playTrack(track, [track, ...music.queue.filter((item) => item.id !== track.id)])} aria-label={`Play ${track.title}`} data-testid={`play-track-${track.id}`}><Play size={18} fill="currentColor" /></button>
    </div>
    <div className="track-info"><div className="track-title-line"><button onClick={() => music.playTrack(track, [track, ...music.queue.filter((item) => item.id !== track.id)])} className="track-title" title={track.title} data-testid={`title-track-${track.id}`}>{track.title}</button><button className={`inline-like ${liked ? 'liked' : ''}`} onClick={() => music.toggleFavorite(track)} aria-label={liked ? 'Remove favorite' : 'Add favorite'} data-testid={`favorite-track-${track.id}`}><Heart size={15} fill={liked ? 'currentColor' : 'none'} /></button></div>
      <div className="track-artist">{track.artist}{track.year ? ` · ${track.year}` : ''}</div>
      <div className="track-actions">
        <button className="small-action" onClick={() => music.addQueue(track)} data-testid={`queue-track-${track.id}`}><ListPlus size={14} /> Queue</button>
        <button className="small-action" onClick={() => setMenu((value) => !value)} data-testid={`playlist-add-track-${track.id}`}><Plus size={14} /> Playlist</button>
      </div>
      {menu && <div className="playlist-popover" data-testid={`playlist-menu-${track.id}`}><div className="popover-head">Save to a playlist<button onClick={() => setMenu(false)} aria-label="Close" data-testid={`close-playlist-menu-${track.id}`}><X size={14} /></button></div>
        {music.playlists.length ? music.playlists.map((playlist) => <button key={playlist.id} onClick={() => { music.addToPlaylist(playlist.id, track); setMenu(false); }} data-testid={`add-to-playlist-${playlist.id}`}>{playlist.name}<Plus size={13} /></button>) : <p>No playlists yet. <Link href="/playlists" data-testid={`create-playlist-from-track-${track.id}`}>Make one here.</Link></p>}</div>}
    </div>
  </article>;
}

function SearchPage() {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(emptyFilters);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(draft), 350); return () => window.clearTimeout(timer); }, [draft]);
  const result = useSourceTracks(query, filters);
  const [showFilters, setShowFilters] = useState(false);
  return <div className="page-wrap">
    <Header eyebrow="Find your song" title="Search all music on YouTube" subtitle="Search and play any song, artist, album, or track." />
    <div className="search-tools"><label className="search-field"><Search size={19} /><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Try an artist, song title, lyrics, or album…" aria-label="Search music" data-testid="input-search" /><kbd>ENTER</kbd>{draft && <button onClick={() => setDraft('')} aria-label="Clear search" data-testid="button-clear-search"><X size={16} /></button>}</label><button className={`filter-toggle ${showFilters ? 'selected' : ''}`} onClick={() => setShowFilters((value) => !value)} data-testid="button-filters"><SlidersHorizontal size={16} /> Filters</button></div>
    {showFilters && <div className="filter-panel" data-testid="search-filters">
      <FilterInput label="Language" value={filters.language} onChange={(value) => setFilters({ ...filters, language: value })} placeholder="e.g. Hindi, English, Spanish" />
      <FilterInput label="Artist / creator" value={filters.artist} onChange={(value) => setFilters({ ...filters, artist: value })} placeholder="Creator or singer name" />
      <FilterInput label="Album / title" value={filters.album} onChange={(value) => setFilters({ ...filters, album: value })} placeholder="Album or single" />
      <FilterInput label="Genre / mood" value={filters.genre} onChange={(value) => setFilters({ ...filters, genre: value })} placeholder="e.g. pop, rock, chill, edm" />
      <label className="filter-field"><span>Source</span><select value={filters.source} onChange={(event) => setFilters({ ...filters, source: event.target.value })} data-testid="select-source"><option value="">All YouTube songs</option><option value="YouTube">YouTube</option><option value="Internet Archive">Internet Archive</option><option value="Openverse">Openverse</option></select></label>
      <button className="reset-filters" onClick={() => setFilters(emptyFilters)} data-testid="button-reset-filters">Clear all</button>
    </div>}
    <div className="results-intro"><span>{query ? `Matching “${query}”` : 'Browse music on YouTube'}</span><span className="mono">YOUTUBE MUSIC STREAMING</span></div>
    <TrackSection result={result} />
    <p className="source-footnote">Search and stream any song, artist, album, or music video across YouTube and open archives.</p>
  </div>;
}

function FilterInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="filter-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} data-testid={`filter-input-${label.toLowerCase().replaceAll(' ', '-')}`} /></label>;
}

function LibraryPage() {
  const music = useMusic();
  const saved = music.favorites.map((id) => music.tracks[id]).filter(Boolean);
  return <div className="page-wrap">
    <Header eyebrow="Kept close" title="Your library" subtitle="Your saved sounds and recent listening, kept on this device." />
    <section className="section-block library-section"><div className="section-heading"><div><div className="eyebrow">Collected</div><h2 className="serif">Saved music <span className="count">{saved.length.toString().padStart(2, '0')}</span></h2></div><Link href="/favorites" className="section-link" data-testid="link-see-favorites">All favorites <span>↗</span></Link></div>
      {saved.length ? <TrackGrid tracks={saved} /> : <Status kind="empty" title="Nothing saved here just yet." detail="Tap the heart on a track to keep it in your personal collection. Your library stays on this device." />}
    </section>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">The last few listens</div><h2 className="serif">Recently played <span className="count">{music.recent.length.toString().padStart(2, '0')}</span></h2></div></div>
      {music.recent.length ? <div className="recent-list">{music.recent.slice(0, 30).map((track, index) => <TrackListRow key={track.id} track={track} index={index} onPlay={() => music.playTrack(track, music.recent.slice(0, 30))} />)}</div> : <Status kind="empty" title="Your listening history starts with a play." detail="Played tracks are kept locally, and never sent to an account or server." />}
    </section>
    <p className="privacy-note"><Check size={14} /> Your favorites, playlists and history are saved locally in this browser.</p>
  </div>;
}

function FavoritesPage() {
  const music = useMusic();
  const tracks = music.favorites.map((id) => music.tracks[id]).filter(Boolean);
  return <div className="page-wrap"><Header eyebrow="Saved by you" title="Favorites" subtitle={`${tracks.length} ${tracks.length === 1 ? 'recording' : 'recordings'} you wanted to keep close.`} />
    {tracks.length ? <TrackGrid tracks={tracks} /> : <Status kind="empty" title="Your favorites will live here." detail="Save any track with the heart button. Only authorized source recordings can be saved and played." />}
  </div>;
}

function PlaylistsPage() {
  const music = useMusic();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!name.trim()) return; music.createPlaylist(name.trim(), description.trim()); setName(''); setDescription(''); setFormOpen(false); };
  return <div className="page-wrap">
    <Header eyebrow="Made for your moments" title="Playlists" subtitle="Gather freely shared recordings into your own listening threads." action={<button className="primary-button" onClick={() => setFormOpen((value) => !value)} data-testid="button-create-playlist"><Plus size={17} /> New playlist</button>} />
    {formOpen && <form className="playlist-form" onSubmit={submit} data-testid="form-create-playlist"><div className="form-top"><strong>Start a collection</strong><button type="button" className="icon-button" onClick={() => setFormOpen(false)} aria-label="Close form" data-testid="button-close-playlist-form"><X size={17} /></button></div><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Playlist name" required maxLength={60} data-testid="input-playlist-name" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A note about this mix (optional)" maxLength={160} data-testid="input-playlist-description" /><button className="primary-button" type="submit" data-testid="button-save-playlist">Create playlist</button></form>}
    {music.playlists.length ? <div className="playlist-grid">{music.playlists.map((playlist, index) => <PlaylistCard key={playlist.id} playlist={playlist} index={index} />)}</div> : <Status kind="empty" title="A blank page for your next mix." detail="Create a playlist, then save any eligible recording into it from its track card." />}
  </div>;
}

function PlaylistCard({ playlist, index }: { playlist: Playlist; index: number }) {
  const music = useMusic();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(playlist.name);
  return <article className={`playlist-card palette-${index % 4}`} data-testid={`playlist-card-${playlist.id}`}>
    <div className="playlist-cover"><Disc3 size={52} strokeWidth={.8} /><span>{playlist.trackIds.length.toString().padStart(2, '0')} TRACKS</span></div>
    <div className="playlist-card-body">{editing ? <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) music.updatePlaylist({ ...playlist, name: name.trim() }); setEditing(false); }}><input value={name} onChange={(event) => setName(event.target.value)} aria-label="Playlist name" data-testid={`input-rename-${playlist.id}`} /><button className="text-action" type="submit" data-testid={`save-rename-${playlist.id}`}>Save name</button></form> : <Link href={`/playlists/${playlist.id}`} className="playlist-name" data-testid={`link-playlist-${playlist.id}`}>{playlist.name}</Link>}
      <p>{playlist.description || 'A collection of open recordings.'}</p><div className="playlist-card-actions"><Link href={`/playlists/${playlist.id}`} className="text-action" data-testid={`open-playlist-${playlist.id}`}>Open playlist <span>↗</span></Link><button onClick={() => { setName(playlist.name); setEditing((value) => !value); }} aria-label="Rename playlist" data-testid={`rename-playlist-${playlist.id}`}>Rename</button><button onClick={() => { if (window.confirm(`Delete “${playlist.name}”?`)) music.deletePlaylist(playlist.id); }} aria-label="Delete playlist" data-testid={`delete-playlist-${playlist.id}`}><Trash2 size={14} /></button></div>
    </div>
  </article>;
}

function PlaylistPage() {
  const params = useParamsSafe();
  const music = useMusic();
  const playlist = music.playlists.find((item) => item.id === params.id);
  const tracks = playlist?.trackIds.map((id) => music.tracks[id]).filter(Boolean) || [];
  if (!playlist) return <div className="page-wrap"><Header eyebrow="Playlist" title="Not found" subtitle="This playlist may have been removed from this device." /><Link href="/playlists" className="section-link"><ArrowLeft size={15} /> Back to playlists</Link></div>;
  return <div className="page-wrap">
    <Link href="/playlists" className="back-link" data-testid="link-back-playlists"><ArrowLeft size={15} /> All playlists</Link>
    <div className="playlist-hero"><div className="playlist-hero-art"><Disc3 size={80} strokeWidth={.7} /></div><div><div className="eyebrow">YOUR COLLECTION · {tracks.length} TRACKS</div><h1 className="serif">{playlist.name}</h1><p>{playlist.description || 'A collection of open recordings.'}</p><button className="primary-button" disabled={!tracks.length} onClick={() => music.playTrack(tracks[0], tracks)} data-testid="button-play-playlist"><Play size={15} fill="currentColor" /> Play collection</button></div></div>
    {tracks.length ? <div className="recent-list">{tracks.map((track, index) => <TrackListRow key={track.id} track={track} index={index} onPlay={() => music.playTrack(track, tracks)} onRemove={() => music.updatePlaylist({ ...playlist, trackIds: playlist.trackIds.filter((id) => id !== track.id) })} />)}</div> : <Status kind="empty" title="This collection is waiting for its first track." detail="Add tracks from their card using the Playlist action." />}
  </div>;
}

function useParamsSafe() {
  const [location] = useLocation();
  const match = location.match(/^\/playlists\/([^/]+)/);
  return { id: match ? decodeURIComponent(match[1]) : '' };
}

function TrackListRow({ track, index, onPlay, onRemove }: { track: Track; index: number; onPlay: () => void; onRemove?: () => void }) {
  const music = useMusic();
  return <div className={`list-row ${music.current?.id === track.id ? 'is-current' : ''}`} data-testid={`list-track-${track.id}`}>
    <button className="row-index" onClick={onPlay} aria-label={`Play ${track.title}`} data-testid={`row-play-${track.id}`}>{music.current?.id === track.id && music.playing ? <AudioLines size={15} /> : String(index + 1).padStart(2, '0')}</button>
    <div className="row-cover"><img src={track.artworkUrl} alt="" onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }} /><Music2 size={16} /></div>
    <div className="row-meta"><button onClick={onPlay} className="row-title" data-testid={`row-title-${track.id}`}>{track.title}</button><span>{track.artist}</span></div>
    <span className="row-source">{track.duration ? formatTime(track.duration) : ''}</span>
    <span className="row-license">{track.album || ''}</span>
    {onRemove && <button className="row-remove" onClick={onRemove} aria-label="Remove from playlist" data-testid={`remove-track-${track.id}`}><X size={16} /></button>}
  </div>;
}

function PlayerBar({ onQueue }: { onQueue: () => void }) {
  const music = useMusic();
  const progress = music.duration ? (music.currentTime / music.duration) * 100 : 0;
  return <div className="player-bar" data-testid="player-bar">
    <div className="player-track" onClick={() => music.current && music.setExpanded(true)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') music.setExpanded(true); }} data-testid="player-current-track">
      <div className="mini-art">{music.current?.artworkUrl ? <img src={music.current.artworkUrl} alt="" onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }} /> : <Disc3 size={21} />}</div><div className="player-title">{music.current ? <><strong>{music.current.title}</strong><span>{music.current.artist}</span></> : <><strong>Nothing playing</strong><span>A free sound is only a few notes away.</span></>}</div>
    </div>
    <div className="player-controls"><div className="control-buttons"><button className={`player-control ${music.shuffle ? 'control-on' : ''}`} onClick={music.toggleShuffle} aria-label="Shuffle" data-testid="button-shuffle"><Shuffle size={15} /></button><button className="player-control" onClick={music.previous} aria-label="Previous track" data-testid="button-previous"><SkipBack size={17} fill="currentColor" /></button><button className="play-button" onClick={music.togglePlay} aria-label={music.playing ? 'Pause' : 'Play'} data-testid="button-play-pause">{music.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><button className="player-control" onClick={music.next} aria-label="Next track" data-testid="button-next"><SkipForward size={17} fill="currentColor" /></button><button className={`player-control ${music.repeat !== 'off' ? 'control-on' : ''}`} onClick={music.toggleRepeat} aria-label="Change repeat mode" data-testid="button-repeat">{music.repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}</button></div>
      <div className="seek-line"><span>{formatTime(music.currentTime)}</span><input type="range" min="0" max={music.duration || 100} value={music.duration ? music.currentTime : 0} onChange={(event) => music.seek(Number(event.target.value))} aria-label="Seek" data-testid="input-seek" style={{ '--progress': `${progress}%` } as CSSProperties} /><span>{formatTime(music.duration)}</span></div>
    </div>
    <div className="player-extra"><button className="player-control queue-control" onClick={onQueue} aria-label="Open queue" data-testid="button-queue"><ListMusic size={17} /><span>{music.queue.length}</span></button><button className="mobile-play-control" onClick={music.togglePlay} aria-label={music.playing ? 'Pause' : 'Play'} data-testid="mobile-button-play-pause">{music.playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><button className="player-control" onClick={music.toggleMute} aria-label={music.muted ? 'Unmute' : 'Mute'} data-testid="button-mute">{music.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><input className="volume-range" type="range" min="0" max="1" step=".01" value={music.muted ? 0 : music.volume} onChange={(event) => music.setVolume(Number(event.target.value))} aria-label="Volume" data-testid="input-volume" /><button className="player-control expand-player" onClick={() => music.setExpanded(true)} aria-label="Expand player" data-testid="button-expand-player"><ChevronDown size={17} /></button></div>
    <div className="player-progress" style={{ transform: `scaleX(${progress / 100})` }} />
  </div>;
}

function QueueDrawer({ onClose }: { onClose: () => void }) {
  const music = useMusic();
  const current = music.current;
  const upcoming = music.queue.filter((track) => track.id !== current?.id);
  return <div className="queue-scrim" onMouseDown={onClose}><aside className="queue-drawer" onMouseDown={(event) => event.stopPropagation()} data-testid="queue-drawer"><div className="drawer-head"><div><div className="eyebrow">UP NEXT</div><h2 className="serif">Queue <span>{music.queue.length}</span></h2></div><button className="icon-button" onClick={onClose} aria-label="Close queue"><X size={19} /></button></div>{current && <div className="queue-now"><span>NOW PLAYING</span><TrackListRow track={current} index={0} onPlay={() => music.playTrack(current)} /> </div>}
    {upcoming.length ? upcoming.map((track, index) => <div className="queue-row" key={`${track.id}-${index}`}><button onClick={() => music.playTrack(track, music.queue)} className="queue-track-button"><Music2 size={16} /><span><strong>{track.title}</strong><small>{track.artist}</small></span></button><button className="row-remove" onClick={() => music.removeQueue(music.queue.findIndex((item) => item.id === track.id))} aria-label={`Remove ${track.title}`}><X size={15} /></button></div>) : <div className="queue-empty">Your queue is clear. Add a recording from its card.</div>}
    <div className="drawer-bottom"><button className="text-action" onClick={() => { music.reorderQueue([]); onClose(); }} data-testid="button-clear-queue">Clear queue</button><button className="text-action" onClick={() => music.setExpanded(true)}>Open player</button></div></aside></div>;
}

function ExpandedPlayer({ onClose }: { onClose: () => void }) {
  const music = useMusic();
  const track = music.current;
  const progress = music.duration ? (music.currentTime / music.duration) * 100 : 0;
  return <div className="expanded-overlay" data-testid="expanded-player"><button className="expanded-close" onClick={onClose} aria-label="Close expanded player"><ChevronDown size={20} /></button><div className="expanded-content">
    <div className="expanded-record">{track && <img src={track.artworkUrl} alt="" onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }} />}<Disc3 className="expanded-disc" size={125} strokeWidth={.65} /></div>
    {track && <div className="expanded-credit"><a href={track.sourceUrl} target="_blank" rel="noreferrer">Open on YouTube <ExternalLink size={12} /></a></div>}
    <div className="expanded-seek"><input type="range" min="0" max={music.duration || 100} value={music.duration ? music.currentTime : 0} onChange={(event) => music.seek(Number(event.target.value))} aria-label="Seek playback" style={{ '--progress': `${progress}%` } as CSSProperties} /><div><span>{formatTime(music.currentTime)}</span><span>{formatTime(music.duration)}</span></div></div>
    <div className="expanded-controls"><button className={`player-control ${music.shuffle ? 'control-on' : ''}`} onClick={music.toggleShuffle} aria-label="Toggle shuffle"><Shuffle size={19} /></button><button className="player-control" onClick={music.previous} aria-label="Previous"><SkipBack size={22} fill="currentColor" /></button><button className="expanded-play" onClick={music.togglePlay} aria-label={music.playing ? 'Pause' : 'Play'}>{music.playing ? <Pause size={25} fill="currentColor" /> : <Play size={25} fill="currentColor" />}</button><button className="player-control" onClick={music.next} aria-label="Next"><SkipForward size={22} fill="currentColor" /></button><button className={`player-control ${music.repeat !== 'off' ? 'control-on' : ''}`} onClick={music.toggleRepeat} aria-label="Repeat"><Repeat size={19} /></button></div>
    <div className="expanded-volume"><button className="player-control" onClick={music.toggleMute} aria-label={music.muted ? 'Unmute' : 'Mute'} data-testid="expanded-button-mute">{music.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><input type="range" min="0" max="1" step=".01" value={music.muted ? 0 : music.volume} onChange={(event) => music.setVolume(Number(event.target.value))} aria-label="Volume" data-testid="expanded-input-volume" /></div>
  </div></div>;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

function NotFoundPage() {
  return <div className="page-wrap"><Header eyebrow="A quiet detour" title="This page isn't in the collection." subtitle="The address may be wrong, or this page may have moved." /><Link href="/" className="primary-button"><ArrowLeft size={15} /> Back to discovery</Link></div>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><ErrorBoundary><MusicProvider><AppShell /></MusicProvider></ErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
