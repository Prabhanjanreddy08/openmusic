# Open Music

A local-first discovery and playback interface for openly licensed recordings. It has no account system, paid API, or backend; favorites, playlists, queue, listening history, playback preferences, and theme live in this browser's local storage.

## Run

From this directory, use `pnpm dev` to start the Vite app. `pnpm build` and `pnpm typecheck` validate the frontend.

## Sources and licensing

- **Internet Archive** — searches the public Advanced Search API and checks each item's metadata for an explicit Creative Commons or public-domain license plus a direct, browser-playable audio file. Source records link to the Internet Archive item.
- **Openverse** — uses its anonymous audio search endpoint (`https://api.openverse.org/v1/audio/`) with `license_type=commercial`. Search pages are cached in memory for five minutes. Anonymous Openverse traffic is rate-limited to **20 requests per minute and 200 per day**; a rate-limit response is reported in the interface and users can retry after a pause.
- Openverse results must carry an eligible explicit license: CC BY, CC BY-SA, CC BY-ND, CC0, or public-domain mark. Every NonCommercial (NC) license is rejected, even if it appears in a source response. The exact returned license/version and license URL, creator attribution, and source-page URL are retained and shown on recordings. Tracks are linked and played as provided; Open Music does not edit or transform audio.
- Provider code is isolated in `src/lib/source.ts`. A failed provider degrades visibly through the search status state; a failed rate-limited Openverse request is shown instead of silently implying catalog completeness.
- Discovery rails are live source results: the recent rail requests the Archive's date sort and the popularity rail requests its download-count sort. They are not hand-authored or fabricated track lists.

## Limitations

This is a small, source-backed collection, not a commercial streaming catalog. Coverage—especially for some South Asian languages—is uneven and depends on public metadata quality, direct audio availability, licensing, and source uptime. Some source audio may be unavailable, slow, or unsupported by a given browser. No protected-platform catalogs are accessed.

## Publish

The app is configured as a static web artifact. Use Replit's Publish flow for this artifact; it has no server-side secrets or database requirements. The external music providers remain subject to their own availability and anonymous-use limits.
