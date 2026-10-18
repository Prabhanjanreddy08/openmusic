# Open Music

Open Music helps listeners discover and play public-domain and openly licensed recordings, with playlists and favorites saved in the browser.

## Run & Operate

- `pnpm --filter @workspace/open-music run dev` — run the music app
- `pnpm --filter @workspace/open-music run typecheck` — check the music app
- `pnpm --filter @workspace/open-music run build` — build the static music app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Open Music needs no database, account, API key, or secret. The separate shared API server uses `DATABASE_URL`; it is not required by this app.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- App: React, Vite, TypeScript, Tailwind CSS, Wouter, Lucide
- Music search: public Internet Archive and Openverse APIs; HTML5 Audio for direct streams
- Local persistence: browser `localStorage`
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/open-music/src/App.tsx` — application shell, routes, player, playlists, and local library
- `artifacts/open-music/src/lib/source.ts` — modular source adapters, license checks, and paged catalog search
- `artifacts/open-music/src/index.css` — app theme and responsive styles
- `artifacts/open-music/README.md` — source, attribution, rate-limit, and catalog limitations

## Architecture decisions

- Keep music playback and personal library data in the browser; no backend or account is needed.
- Only play direct audio URLs with an explicit eligible license. Exclude NonCommercial terms because commercial-use status is not established.
- Search both Openverse and Internet Archive; show the provider, license, creator credit, and source record for each result.
- Never imply access to protected commercial streaming catalogs or fill discovery sections with invented tracks.

## Product

Listeners can discover, search, and play eligible open recordings; manage favorites, playlists, queue, and listening history; and choose dark or light mode.

## User preferences

- Dark theme by default with a light-mode option, responsive navigation, and a persistent player.

## Gotchas

- Openverse anonymous search is rate-limited. Cache searches and surface rate-limit/provider failures; do not make its requests on every keystroke.
- Regional-language coverage depends on provider metadata and licensing; do not infer or fabricate language tags.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
