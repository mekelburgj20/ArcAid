# Contract: Global Scoreboard — token foundation + card rebuild (v2.50.0)

Track A phases **A1 + A2** of the approved plan (`C:\Users\mekel\.claude\plans\transient-crafting-barto.md` —
read the Context, A0 corrections table, A1 and A2 sections before starting). Frontend-only except
one small settings deprecation. No migration.

Design source: `tmp/ArcAid UX/design_handoff_global_scoreboard/` — `README.md` (Components → Game
card; Design Tokens), `components/DirD2_Merged.jsx` (canonical target), `screenshots/02-target-logged-out.png`
(visual litmus). **The package must NOT be implemented verbatim** — the A0 corrections below are
binding and override it.

## Binding corrections from A0 (verified against our code)

- **#2 Provider-agnostic login.** Never "Log in with Discord". Google is a full IdP. Subhead copy:
  `High scores from every Arcaid room. Log in to submit your own scores.` with "Log in" triggering
  the existing login affordance (the page already imports `LoginButtons`; keep both providers).
- **#3 Casing** — "Arcaid", never "ArcAid".
- **#9 Platform chips** filter on `PLATFORM_GROUPS` **keys** (`physical`/`vpin`/`video`), not labels.
- **#11** Two medal tokens, not one.
- **#12** `grid-auto-rows: 200px` is wrong (contradicts the package's own screenshot at ~323px and
  its own Top-6 requirement). Use content-driven row height; cards in a row stretch to match.
- **#15** The page is NOT dark-only — see A1.
- Out of scope for this release: pins, the pinned rail, `sort=pinned`, `my_rank`/`neighbors`, the
  hero card, the ⌘K palette, density toggles, rank alerts, the live "updated Ns ago" indicator, and
  the player-count in the header (no API for it). Do not build them, do not stub them.

## A1 — Token foundation

### 1. Medal tokens (theme-aware, NOT flat hex)
`admin-ui/src/index.css`: add to the `@theme` block (dark defaults) **and** override in the
light-polarity theme classes (`.theme-light`, `.theme-coffee`, and `.theme-minimal` if it reads light):
```
--color-medal-silver / --color-medal-bronze
```
Dark: `#c0c0c0` / `#cd7f32` per the package. Light: darken both enough to pass 4.5:1 on
`--color-surface` (silver on white is the failure case — pick something like a slate/steel and a
deeper bronze; verify, don't guess). Gold reuses `--color-neon-amber`, which is already theme-aware.

### 2. Scoreboard surface tokens
Add a small set of `--sb-*` tokens for the design's repeated literals, each with a dark default in
`@theme` and a light override alongside the medal tokens. At minimum:
`--sb-art-scrim` (180° card art gradient), `--sb-hero-scrim` (90°), `--sb-card-hover-border`,
`--sb-title-shadow`, and per-rank row tint/border pairs for gold/silver/bronze/you.
Name them `--sb-` (scoreboard surface) so they're distinguishable from the `--color-` palette.
**Every new surface in A2 must consume these tokens — no literal `rgba(0,0,0,…)` in the TSX.**

### 3. Per-visitor light/dark on global pages (retires `GLOBAL_PAGE_THEME`)
Currently `ThemeProvider.tsx:52-56` (`GLOBAL_PAGE_PREFIXES`/`isGlobalPath`) fetches
`/api/global/config` and applies the admin's `GLOBAL_PAGE_THEME` for `/scoreboard`, `/catalogue`,
`/games/*` and the landing page (`global.ts:984-994`). Replace that resolution for global paths with,
in precedence order:
1. `localStorage['arcaid-global-theme']` (`'light' | 'dark'`) — the visitor's explicit choice
2. `window.matchMedia('(prefers-color-scheme: light)')` → `light`, else `dark`
3. `dark`

Listen for OS changes while mounted (only when there's no explicit localStorage choice). Apply via
the existing `applyThemeClass`. Keep the read of `/api/global/config` if other fields are used —
just stop letting `theme` drive global pages.

**Toggle UI:** a small sun/moon icon button (lucide `Sun`/`Moon`) in the `/scoreboard` header, left
of the login/user area, writing the localStorage key. Add it to the landing-page header too (same
component — put it in a shared `GlobalThemeToggle.tsx`), since both are global pages.

**Deprecate, don't delete:** in `GlobalSettings.tsx`, leave the `GLOBAL_PAGE_THEME` control in place
but mark it deprecated in its help text (e.g. "No longer applied — global pages now follow each
visitor's light/dark preference. This setting will be removed in a future release."). Do not delete
the DB row or the endpoint field in this release.

## A2 — Card rebuild (`admin-ui/src/pages/GlobalScoreboard.tsx`)

Keep ALL existing logic: fetch, pagination/Load More, debounced search, `?room=` scope sync,
`score:new:global` WebSocket toast + optimistic bump, `SubmissionSheet` launch, ratings fetch (the
rating *data* stays; only the on-card star row goes). Replace the presentational layer.

**Card structure** (top → bottom), per README → Components → Game card:
1. **Art block ~110px** — `<img>` `object-cover` from the existing `imageFor(game)`; `--sb-art-scrim`
   overlay; **one** platform pill top-right (`platforms[0]` via `getPlatformShortLabel`); title
   overlaid bottom-left (`font-display`, ~13px/700, `line-height:1.15`, `text-wrap: pretty`,
   `--sb-title-shadow`) with `{manufacturer} · {year}` beneath. Whole art block links to
   `/games/{global_game_id}`. Fallback: centered "No image" on `bg-deep`.
2. **Leaderboard block** — rows **1–6** (server currently returns 10; render 6, leave the API alone
   this release). Row: rank cell (ranks 1–3 = lucide `Medal` in amber/silver/bronze tokens; 4+ =
   `#{n}` mono 10px muted) · `PlayerAvatar` 18 · name (11px, truncate, `playerName()` helper) ·
   `RoomTag` when `origin_room_slug` present (KEEP — it's the provenance signal) · score
   (`formatScore`, mono 11px/700, amber for rank 1). Row tint/border per rank from the A1 tokens.
   **No podium. No empty placeholder rows** — a game with 1 score renders exactly 1 row.
3. **Empty state** — dashed `Claim 1st →` CTA (11px, cyan, dashed cyan border) opening
   `SubmissionSheet`, replacing the current `—` placeholder podium.
4. **Footer** — `{n} score{s}` left (10px muted, correct singular/plural); **solid** Submit button
   right (`bg-neon-cyan text-deep`, 10px/700, lucide `Upload`), hover brightness. Solid, not ghost.

**Removed from the card:** the `StarRating` row (component stays, still used on `GlobalGameDetail`),
the 2nd/3rd `—` placeholders, the multi-pill platform stack in the footer, and the centered
title-above-image stack.

**Other page changes:**
- Replace the sort `<select>` with **sort pills** (same `SortMode` values minus the unbuilt `pinned`).
  Keep the room-scope `<select>` as-is.
- Card hover → `--sb-card-hover-border`, 150ms.
- Grid: `repeat(4,1fr)` at lg / 3 md / 2 sm / 1 base, gap 14px, content-driven row height, cards
  stretch to equal height within a row.
- **No score text below 11px anywhere.**
- No emoji (strip the `🏆` from `RANK_STYLES` labels if any remains).

**Shared helper:** `imageFor`/`toCatalogueUrl` is already duplicated in `GlobalScoreboard.tsx`,
`GlobalScoresView.tsx:52-54` (flagged in-code as a dup) and `GlobalGameDetail.tsx:94`. Extract ONE
exported helper (suggest `admin-ui/src/lib/catalogueImage.ts`) and repoint all three. Do not add a
fourth copy.

## Tests

- FE: card renders 1 row for a 1-score game with no placeholders; 0-score game renders the Claim CTA;
  6 rows max for a 10-score payload; medal tokens applied to ranks 1–3; Submit fires the sheet;
  `RoomTag` renders when `origin_room_slug` present.
- `GlobalThemeToggle`: localStorage precedence over `matchMedia`; OS-change listener only active with
  no explicit choice.
- Existing suites stay green (BE 798, FE 146).

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF numstat check ·
**no commit/branch/push**.

## Visual verification (required before reporting done)

Write `tmp/global-scoreboard-harness.js` following the existing pattern in
`tmp/tour-screenshot-harness.js` (build → `npx vite preview --port 4174` → Playwright,
`serviceWorkers:'block'`, generic `/api/**` catch-all registered FIRST then specific mocks LAST).
Mock `/api/global/scoreboard` with a fixture covering: a game with 10 scores, one with exactly 1, one
with 0, one with a 60-char title, one with no image. Capture to `tmp/global-scoreboard-shots/`:
`grid-desktop-dark.png`, `grid-desktop-light.png` (1440×900), `grid-mobile-dark.png` (390×844).
Report the paths; do not judge the visuals yourself — they go to the user.

## Blockers policy

If something contradicts this contract (ThemeProvider structure differs, a helper isn't where stated),
STOP and report rather than guessing. Do not expand scope into A3–A5.
