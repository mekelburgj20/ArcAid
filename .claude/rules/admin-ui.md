---
paths:
  - "admin-ui/src/**/*.tsx"
  - "admin-ui/src/**/*.ts"
  - "admin-ui/src/index.css"
  - "admin-ui/public/**"
  - "admin-ui/vite.config.ts"
  - "admin-ui/postcss.config.js"
  - "admin-ui/scripts/*"
---
# Admin UI / React front end — rules

Loads when you touch any front-end file under `admin-ui/`. Cross-cutting invariants live in the root CLAUDE.md; this file is the detail for this domain.

## Structure and routing
- **Admin UI (`admin-ui/src/`)** is React 19 + Vite (ESM). All HTTP goes through `lib/api.ts` (relative `/api/` paths — never hardcode localhost).
- **Three layouts:** `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`). Plus standalone global pages (`/scoreboard`, `/games/:id`, `/friends`).
- **There is NO public `/catalogue` route.** `GlobalCatalogue` is a super-admin tool under `/admin/catalogue`; public catalogue browsing happens on `/scoreboard`.
- **Contexts.** Room-scoped pages get `roomId/roomSlug/roomName` from `RoomContext`. Public pages get viewer auth from `ViewerAuthContext` (auto-refreshes player tokens within 5min of expiry).
- **Global game page `/games/:id` (`GlobalGameDetail`)** ranks each player ONCE, by their best. Clicking a row expands all of that player's scores via `GET /api/global/scoreboard/:globalGameId/players/:playerKey/scores`, keyed on the board row's `player_key` — the SAME partition expression the board collapses on, shared in `GlobalLeaderboardService` so the two can't disagree about who a player is. Clicking a score toggles a score-over-time chart (`components/ScoreHistoryChart.tsx`, hand-rolled SVG, theme tokens only) that shares that one fetch (v2.157.0).
- **Cross-component DOM events.** PublicLayout (nav) and Scoreboard (Outlet child) communicate via `window.dispatchEvent(new Event('open-scoreboard-prefs'))`, because React Router `<Outlet />` doesn't pass props down.
- **Public slug matching is case-insensitive.**

## Scoreboard rendering
- **Style+Theme dispatch.** `SCOREBOARD_STYLE` (banner/showcase/minimal) + `SCOREBOARD_THEME` (showcase variants live in `lib/scoreboardThemes.ts`) → `CardRouter.tsx` selects `BannerCard`/`ShowcaseCard`/`MinimalCard`. Config derivation in `lib/scoreboardConfig.ts`: `deriveScoreboardConfig` is the new path; `deriveCardProps` is the legacy fallback. Live preview on the admin Leaderboard page is rendered inline (CSS scale-transform); the old standalone `ScoreboardPreview` component was removed as dead code (2026-08-21).
- **Manual card order is a self-invalidating override (v2.118.0).** Room scoreboard order = `COALESCE(g.display_order, t.display_order, 9999), g.start_date` (`LeaderboardService.getActiveLeaderboards`; `games.display_order` has NO writer — leave it that way). An admin drag on the admin Leaderboard page stores `game_room_settings.LEADERBOARD_CARD_ORDER` (NOT a `SCOREBOARD_*` key — that prefix is auto-public via `/scoreboard-config`) with a fingerprint of each tournament's `display_order` + sorted ACTIVE game ids.
  - `CardOrderService.applyCardOrderOverride` (pure) applies it at READ time: any fingerprinted tournament's `display_order` changed → whole override ignored; a tournament's ACTIVE set changed → only its ids drop (rotation by any path — no hooks in TournamentEngine/TimeoutManager, don't add any); slot-fill merge for the rest.
  - **Save and read MUST compute the fingerprint through the same `loadCurrentState`** or the override self-destructs on the next read.
  - Arrows (`HorizontalScrollNav`, fixed z-40 portalled to body) are off on the admin page (`hscrollArrows={false}`) — they cover the rail column by construction.
- **Past-games piles (v2.236.0, B23).** The public board folds each tournament's retained COMPLETED cards into one pile behind its LAST live card: `lib/historyPiles.ts` is the grouping rule (keyed on the board's `tournamentId`, never the name; newest first by `endedAt`), `components/scoreboard/HistoryPile.tsx` draws it. Only `pages/Scoreboard.tsx` passes `historyPiles`; the admin Leaderboard and kiosk stay flat, and a search flattens. Stacked cards are real cards, `inert` + `aria-hidden`, clipped to the live card's MEASURED height (a rail/grid slot is as tall as the row's tallest card).
  - Pinned-open state is per USER: `scoreboard_prefs.pinnedPiles` via `/api/me/pinned-piles` (players), `arcaid-pinned-piles` localStorage (guests + first paint), `hooks/usePinnedPiles.ts`. **Every `scoreboard_prefs` writer round-trips `parseDevicePrefs`, so a new top-level key must be defaulted there** or a theme or device save silently drops it.
- **Past results (v2.238.0, B24).** `lib/tournamentLinks.ts`'s `tournamentResultsPath(slug, tournamentId, runGameId?)` is the ONE builder of links to a tournament's results (`/:slug/tournaments/:id`; `?run=<gameId>` opens one run). The server's copy (Discord posts) is `tournamentRunUrl` in `src/utils/publicLinks.ts`: change both together. Users: the card chip (`tournamentChipLink` -> the surface's `chipLinkTo`; the public board and admin Leaderboard pass it, the kiosk never does), the pile spine, History rows, the Lobby `tournament_results` item (`metadata.gameId`).
  - `TournamentDetail` opens on Runs (`/history?tournament_id=`, a row opens `/leaderboard/:gameId`); `?view=tables` is the merged per-table boards. A `?run=` with no `page` asks the server for the page holding that run; an explicit `page` never jumps. History keeps `?tournament=&type=&page=` in the URL and takes its type options from the room's own tags.
  - A finished card's timer slot shows `cardTimerText` ("Ended Tue, Nov 3" from `endedAt`), behind the same Show-timer setting.
- **Table art and avatars on results lists (v2.240.0, B25).** History, the tournament page, the player page and the Stats page draw `components/GameArt.tsx` (thumbnail; initials tile when there is no art) and `PlayerAvatar`. The server ships the art: `GameArtService` is the ONE rule (approved catalogue row by name; local, wheel, remote; the art a card falls back to), as `image_url` on rows or a `gameArt` map read through `lib/gameArt.ts`'s `gameArtFor`. Avatars ship beside names, resolved at read (`resolveProfiles`), never baked into a cache.
- **Style catalogue is global** (shared across rooms). Per-game overlay via `logo_style_id` + `bg_style_id` on `games` and `game_room_game_library`. Resolution: `effectiveBgId = bgStyleId || catalogueStyleId`.
- **Score abbreviation:** scores ≥1T render as `X.XT` with full value in tooltip.
- **Score toast:** WebSocket `score:new` carries `{ gameId, gameName, playerName, score }`; Scoreboard shows slide-down toast.
- **Image upload limit** 30MB. Formats PNG/APNG/JPEG/WebP. APNG animates natively in `<img>` tags.

## Live pages
- **Live pages must also recover when the socket does NOT deliver (v2.154.0).** `hooks/useLiveRefresh.ts` refetches on RE-connect (room membership is per-connection; a re-join of `room:<id>` on `connect` reloads nothing by itself), on visibility / `pageshow` / window `focus`, and on a 60s poll skipped while `document.hidden`. One 5s throttle across all three. `pageshow` is required because iOS bfcache fires neither a visibility change nor a socket event; `focus` because a desktop alt-tab fires no visibility change.
- **Any new page that calls `socket.emit('join:room', ...)` needs this hook too** — the five are Scoreboard, KioskScoreboard, GameDetail, the admin Leaderboard and the public Lobby (for `season:poll`). The hook owns only the recovery; each page keeps its own event handlers and decides what to reload.

## Score entry and provenance memory
- **Provenance is remembered, per-game before global (v2.149.0).** `arcaid_last_provenance:<gameKey>` (JSON `{engine, device}`, checked FIRST) → `arcaid_last_engine` / `arcaid_last_device` (the global "my rig" keys; the device one dates to v2.53.0) → auto-lock when only one option fits → empty. Room targets key on `(roomId, lowercased game name)`, NOT a game id — a tournament game row is recreated on every rotation, so an id-keyed memory would forget exactly when the table comes round again.
- **Every remembered value must be tested against the same exclusion-filtered option list the dropdown renders** (`allowedEngines` / `allowedDevicesForEngine`). A membership test against the unfiltered list submitted `pc` while the `<select>` displayed "AtGames Cabinet" (v2.95.1).
- **Score ENTRY is comma-grouped (v2.149.0).** `admin-ui/src/lib/scoreInput.ts` — the sheet's `score` state holds the FORMATTED string so `lib/caretEdit`'s splice helpers and the browser's `selectionStart` index the same thing the player sees; every numeric read goes through `digitsOnly` first.
  - Grouping is done by string, not `toLocaleString`, so it stays exact past `MAX_SAFE_INTEGER` and cannot pick up a locale whose separator disagrees with `formatScore`.
  - Caret positions are carried across a re-group as a DIGIT COUNT (`reformatScoreEdit`), because inserting a digit into `999,999` also shifts every separator.
  - The field is `type="text"` on desktop too — `type="number"` refuses a value containing separators and is the one input type whose `selectionStart` throws.
  - `formatMagnitude` prints the plain-language echo ("6.66 billion", truncated never rounded) that is the actual defence against an extra digit.

## Themes
- **Themes:** 16 themes in CSS variables (15 `.theme-*` classes + the no-class dark default) — the ONE list is `THEME_IDS` in `admin-ui/src/lib/themeIds.ts`, which `THEMES` (picker), `ALL_THEME_CLASSES` (class stripper) and the API's Zod enum are all derived from.
- **Dropped ids map through `LEGACY_THEME_MAP`** in that same module (FE `lib/themeIds.ts` ≡ BE `utils/themeIds.ts`, parity-locked by `themeIds-parity.test.ts`), applied by `normalizeThemeId` at every READ of a stored id (localStorage mirrors are not migratable) and by migration 162 on the three stored sites.
- **Every theme label/description must describe the rendered palette** (background tone, ink, accents — not a metaphor), ≤ 60 chars, checked against its `.theme-<id>` block.
- **One resolution order (v2.132.0)**, documented in a block at the top of `ThemeProvider.tsx`: room public pages take this-room override (`scoreboard_prefs.roomThemes[roomId]`) → personal theme (`user_preferences.ui_theme`, NULL = use each room's default) → room default (`game_room_settings.UI_THEME`) → `dark`; admin pages take personal theme → `dark`; global pages are polarity-only. The personal theme is ONE picker (Display settings / Account settings / Global Settings, all via `components/ThemePicker.tsx`); the room-settings "Admin Theme" field is gone.
- **The this-room override is keyed by ROOM, not by device.** It rides in the `scoreboard_prefs` JSON as a third top-level key beside `desktop`/`mobile` (`PreferencesService.getRoomThemes`/`setRoomTheme`, `GET`/`PUT /api/me/room-themes`). `getRoomThemes(userId, roomId)` performs the one-shot idempotent lift of the legacy `scoreboard_prefs[device].UI_THEME` key onto the room being viewed.
- **`ThemeProvider` reads localStorage first to avoid flash** (`arcaid-theme-personal`, `arcaid-theme-room-<slug>`, `arcaid-theme-public-<slug>`). The last two are deliberately separate keys: `setPublicTheme` writes the room DEFAULT into the `public` one from the admin Settings page.
- **Appearance is the LAST step of resolution on every route class.** The viewer's preference (`dark`/`light`/`auto`, v2.130.0 — `localStorage['arcaid-appearance']` + `user_preferences.appearance`): `resolveAppearance(base, appearance)` keeps a theme whose `THEME_POLARITY` (the map beside `ALL_THEME_CLASSES`, derived from `color-scheme` in `index.css`; only `light`, `arctic`, `paper` + `speegle` are light) already matches and otherwise swaps in the canonical `light`/`dark` theme — so classify any new theme there or it silently never matches.
- **A card whose artwork FILLS it is a dark-token island** (v2.131.1): its root carries `sb-theme-scope sb-on-art` so the text over the fixed black scrim is theme-independent (`sb-on-art` re-anchors the inherited `color` and shadows every `sb-art-text` element). Any NEW card style that paints artwork under a scrim must do the same, or its text goes near-black-on-black under a light theme.
- **Contrast bar (v2.131.2).** In EVERY theme `--color-muted` must clear 4.5:1 against `--color-deep`/`--color-surface`/`--color-raised`, and `--color-faint` must clear 4.5:1 against `--color-deep`/`--color-surface` (faint carries real content — "Never", timestamps, captions — not decoration). Re-run `node admin-ui/scripts/contrastAudit.cjs` after adding a theme or retuning a token.

## PWA, service worker and assets
- **PWA:** `manifest.json` + `sw.js` in `admin-ui/public/`; service worker is cache-first for static assets, network-first for navigation.
- **Service-worker cache-bust is automatic (v2.28.0+), no manual bump ever.** `admin-ui/public/sw.js`'s static cache name (`arcaid-static-${BUILD_ID}`) is derived at build time by the `arcaid-sw-build-id` Vite plugin (`admin-ui/vite.config.ts` + `admin-ui/scripts/swBuildId.ts`) — a sha-256 over the emitted asset filenames + `index.html`, truncated to 12 hex chars, injected in place of the `__ARCAID_BUILD_ID__` placeholder during `closeBundle`. Same source → same BUILD_ID (deterministic); the build throws loudly if the placeholder or `dist/sw.js`/`dist/index.html` are missing.
  - Activate deletes every cache except the current `STATIC_CACHE` and the stable `IMAGE_CACHE` name, so old `arcaid-static-*` generations (and legacy `arcaid-v###` caches from pre-v2.28 installs) are swept on the next install.
  - Image mounts (`/api/catalogue-images`, `/api/styles/images`, `/api/room-assets`, `/api/score-photos`) are routed separately into `IMAGE_CACHE` — stale-while-revalidate, LRU-capped at 200 entries.
  - `sw.js` and `index.html` are served with `Cache-Control: no-cache` (`src/api/server.ts`'s `frontendStaticOptions` + the SPA catch-all) so an installed PWA always revalidates and picks up the new BUILD_ID; `/assets/*` (Vite's content-hashed bundle output) is `public, max-age=31536000, immutable`.
  - `vite dev` serves `public/sw.js` raw with the placeholder intact — harmless, dev never goes through the build plugin.
- **Never swap an `admin-ui/public/` asset in place — new filename every time.** Same-name overwrites go stale for days: `manifest.json` is no-cache and other public statics are `max-age=86400`, and the PWA/OS icon cache compounds it (a user saw the old app icon even after delete+reinstall). Renaming (`-v2` style, plus a `manifest.json?v=N` link when icons change) is the actual fix. Hashed `/assets/*` bundle output is immune (immutable by content hash). (v2.45.1)

## Toasts
- **An error toast stays until tapped (v2.233.0)**; success/info clear after 4 s; at most three on screen; errors carry `role="alert"` and a Dismiss button. A long refusal on a phone vanished before it could be read (owner 2026-11-08). Do not reintroduce an auto-timeout for errors.

## Styling gotchas
- **Touch-screen inputs are 16px (v2.203.2).** iOS Safari zooms the page in on focus of any text field under 16px and stays zoomed; an unlayered `@media (pointer: coarse) { input, select, textarea { font-size: 16px } }` in `admin-ui/src/index.css` outranks every `text-sm`/`text-xs` utility. Never fix it with `maximum-scale=1` (Android then blocks pinch-zoom), and never give a touch input an `!important` size under 16px.
- **`GlobalScoreboardA5.test` reads the FIRST `@media (prefers-reduced-motion: reduce)` block in `index.css`** and expects the hero sweep rule in it. Gate a new animation with `prefers-reduced-motion: no-preference` instead of adding a `reduce` block above it (v2.236.0).
- **Tailwind on Windows:** must use `@tailwindcss/postcss` (NOT `@tailwindcss/vite` — oxide scanner fails silently).
