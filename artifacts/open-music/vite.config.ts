import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';
import { searchYouTube } from './src/lib/youtube';

const rawPort = process.env.PORT || '5173';
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || '/';

function youtubeApiPlugin(): Plugin {
  return {
    name: 'youtube-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/youtube/search')) {
          return next();
        }
        try {
          const url = new URL(req.url, 'http://localhost');
          const q = url.searchParams.get('q') || '';
          const language = url.searchParams.get('language') || undefined;
          const pageToken = url.searchParams.get('pageToken') || undefined;

          if (!q.trim()) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Search query is required' }));
            return;
          }

          const result = await searchYouTube(q, { language, pageToken });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (error: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error.message || 'YouTube search failed' }));
        }
      });

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/youtube/stream')) {
          return next();
        }
        try {
          const url = new URL(req.url, 'http://localhost');
          const id = url.searchParams.get('id') || '';
          if (!id || !/^[\w-]{6,16}$/.test(id)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Valid YouTube ID required' }));
            return;
          }
          const { Ytdl } = await import('@distube/ytdl-core');
          const ytdl = new Ytdl();
          const info = await ytdl.getInfo(id);
          const audioFormats = info.formats.filter((f) => f.hasAudio && !f.hasVideo && f.url);
          const mp4Audio = audioFormats
            .filter((f) => f.container === 'mp4' || f.mimeType?.includes('audio/mp4'))
            .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
          const best = mp4Audio || audioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
          if (!best?.url) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Audio stream not found' }));
            return;
          }

          const range = req.headers.range;
          const upstreamHeaders: Record<string, string> = {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          };
          if (range) upstreamHeaders['Range'] = range;

          const upstream = await fetch(best.url, { headers: upstreamHeaders });
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', upstream.headers.get('content-type') || best.mimeType || 'audio/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Access-Control-Allow-Origin', '*');
          const cr = upstream.headers.get('content-range');
          if (cr) res.setHeader('Content-Range', cr);
          const cl = upstream.headers.get('content-length');
          if (cl) res.setHeader('Content-Length', cl);

          if (req.method === 'HEAD' || !upstream.body) {
            res.end();
            return;
          }

          const { Readable } = await import('node:stream');
          const stream = Readable.fromWeb(upstream.body as any);
          stream.pipe(res);
          req.on('close', () => { stream.destroy(); });
        } catch (err: any) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message || 'Stream error' }));
        }
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    youtubeApiPlugin(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
