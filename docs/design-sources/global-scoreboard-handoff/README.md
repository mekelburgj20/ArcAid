# Handoff: ArcAid Global Scoreboard Redesign

## Overview

Redesign of the ArcAid Global Scoreboard (`/scoreboard`) — the hub page that aggregates high scores from every ArcAid room. The redesign serves two jobs: **discovery** (see popular titles and other people's scores) and **submission** (post your own score fast, across 2,400+ games).

Codename in the design doc: **Direction D v2 — Broadcast Hero + Discovery + Personalization**.

Target file in the repo: `admin-ui/src/pages/GlobalScoreboard.tsx`

---

## About the Design Files

The HTML/JSX files in this bundle are **design references**, not production code. They are standalone React-in-the-browser prototypes (Babel-transpiled, inline styles, mock data) built to communicate layout, spacing, color, typography, and interaction intent.

**Your task is to recreate these designs inside the existing ArcAid `admin-ui` environment** — React 19 + TypeScript + Tailwind CSS v4 + `react-router-dom` v7 + `lucide-react` — using the codebase's established patterns, tokens, and components. Do **not** copy the inline-style objects from the prototypes; translate them into Tailwind utility classes driven by the existing `@theme` tokens in `admin-ui/src/index.css`.

The prototypes use inline styles purely because they run without a build step. Every color in them is already an exact match for a token that exists in `index.css`.

---

## Fidelity

**High-fidelity (hifi).** Colors, typography, spacing, and radii in this document are final and were authored against the real ArcAid token set. Recreate the UI faithfully using Tailwind utilities mapped to existing tokens.

The one exception: game art in the prototypes is a striped gradient placeholder (`BackglassPlaceholder`). In production this is the real image resolved by the existing `imageFor(game)` helper — keep that helper as-is.

---

## Existing code you should reuse (do not rebuild)

| Concern | File | Notes |
|---|---|---|
| Page shell + data fetching | `admin-ui/src/pages/GlobalScoreboard.tsx` | Keep the fetch/pagination/WebSocket logic. Replace the presentational layer. |
| Design tokens | `admin-ui/src/index.css` | Tailwind v4 `@theme` block. One token to add (see Design Tokens). |
| Icons | `lucide-react` ^0.577.0 | Already a dependency. All icons in the design are Lucide. |
| Player avatars | `admin-ui/src/components/ScoreboardComponents.tsx` → `PlayerAvatar` | Handles Discord avatar hash + fallback. |
| Score submission | `admin-ui/src/components/SubmissionSheet.tsx` | Already wired via `target={{ kind: 'global', globalGameId, gameName }}`. No change needed. |
| Room origin badge | `admin-ui/src/components/RoomTag.tsx` | Keep on leaderboard rows. |
| Star rating | `admin-ui/src/components/StarRating.tsx` | **Removed from cards.** Keep the component — it stays on `GlobalGameDetail`. |
| Auth | `admin-ui/src/contexts/ViewerAuthContext.tsx` → `useViewerAuth` | `discordUser`, `playerToken`, `loginWithDiscord`, `logoutPlayer`. |
| Login button / user menu | `DiscordLoginButton.tsx`, `UserMenu.tsx` | Header stays as-is. |
| Loading | `admin-ui/src/components/LoadingState.tsx` | Keep. |
| Sockets | `admin-ui/src/lib/websocket.ts` → `getSocket()` | `score:new:global` handler stays. New `rank_change` event rides the existing `lobby:event` channel. |
| Lobby feed | `admin-ui/src/pages/Lobby.tsx`, `admin-ui/src/components/lobby/FeedItem.tsx` | In-app alert surface for pinned-game rank changes. Already supports typed events. |

---

## Design Tokens

All values below already exist in `admin-ui/src/index.css` under `@theme` unless marked **NEW**.

### Colors

| Token | Tailwind class | Value |
|---|---|---|
| `--color-deep` | `bg-deep` | `oklch(21.15% 0.012 254.09)` |
| `--color-surface` | `bg-surface` | `oklch(23.26% 0.014 253.1)` |
| `--color-raised` | `bg-raised` | `oklch(25.33% 0.016 252.42)` |
| `--color-border` | `border-border` | `oklch(35% 0.02 255)` |
| `--color-neon-cyan` | `text-neon-cyan` / `bg-neon-cyan` | `oklch(74% 0.16 232.661)` |
| `--color-neon-magenta` | `bg-neon-magenta` | `oklch(65% 0.241 354.308)` |
| `--color-neon-green` | `text-neon-green` | `oklch(76% 0.177 163.223)` |
| `--color-neon-amber` | `text-neon-amber` | `oklch(82% 0.189 84.429)` |
| `--color-neon-coral` | `text-neon-coral` | `oklch(71% 0.194 13.428)` |
| `--color-primary` | `text-primary` | `oklch(97.807% 0.029 256.847)` |
| `--color-muted` | `text-muted` | `oklch(70% 0.02 255)` |
| `--color-faint` | `text-faint` | `oklch(45% 0.015 255)` |
| **NEW** `--color-medal-bronze` | `text-medal-bronze` | `#cd7f32` |
| **NEW** `--color-medal-silver` | `text-medal-silver` | `#c0c0c0` |

**Add to the `@theme` block in `index.css`:**

```css
/* Podium medal metals — distinct from the semantic neon accents.
   Gold reuses --color-neon-amber; these two have no existing equivalent. */
--color-medal-silver: #c0c0c0;
--color-medal-bronze: #cd7f32;
```

> **Important:** the current code styles 3rd place with `text-amber-500` / `border-amber-600` which reads pink-orange against the dark surface. Use `--color-medal-bronze` instead. Do **not** use `--color-neon-coral` for bronze — its hue (13°) is red-pink, not metal.

### Rank → color mapping

| Rank | Text color | Row background | Row border |
|---|---|---|---|
| 1 | `text-neon-amber` | `rgba(250,190,80,0.12)` | `rgba(250,190,80,0.35)` |
| 2 | `text-medal-silver` | `rgba(220,220,220,0.08)` | `rgba(220,220,220,0.25)` |
| 3 | `text-medal-bronze` | `rgba(205,127,50,0.12)` | `rgba(205,127,50,0.35)` |
| 4+ | `text-primary` | none | none |
| **You** | `text-neon-cyan` | `rgba(100,200,240,0.12)` | `1px solid` cyan @ 33% |
| **Next to beat** | `text-neon-amber` | `rgba(250,190,80,0.08)` | `1px solid` amber @ 27% |

### Typography

| Role | Token | Family |
|---|---|---|
| Display / headings / game titles | `font-display` | Orbitron |
| Body / UI labels | `font-body` | Inter |
| Scores, ranks, counters, timestamps | `font-mono` | JetBrains Mono |
| Brand wordmark only | `font-pixel` | Press Start 2P |

**Type scale used in the design** (all px, `font-body` unless noted):

| Element | Size | Weight | Notes |
|---|---|---|---|
| Page `h1` | 32 | 700 | `font-display`, `letter-spacing: 0.5px` |
| Page subhead | 12.5 | 400 | `text-muted` |
| Hero game title | 34 | 800 | `font-display`, `line-height: 1`, `text-shadow: 0 2px 8px rgba(0,0,0,0.8)` |
| Hero champion score | 22 | 700 | `font-mono`, `text-neon-amber`, `text-shadow: 0 0 10px` amber@33% |
| Hero champion name | 15 | 700 | `font-display` |
| Card game title | 13 | 700 | `font-display`, `line-height: 1.15`, `text-wrap: pretty`, `text-shadow: 0 1px 4px rgba(0,0,0,0.8)` |
| Card meta (mfr · year) | 9.5 | 400 | `rgba(255,255,255,0.55)` |
| Card #1 score | 14 | 700 | `font-mono`, `text-neon-amber` |
| Card player name | 11 | 600 | |
| Leaderboard row name | 11 | 500 (700 if you) | |
| Leaderboard row score | 11 | 700 | `font-mono` |
| Rank label ("1ST", "CHAMPION") | 9 | 700 | `letter-spacing: 0.3–1px`, uppercase |
| Search placeholder | 14 | 400 | `rgba(255,255,255,0.5)` |
| Sort pill | 11 | 500 (600 active) | |
| Platform chip | 10 | 400 | |
| Platform pill (on art) | 9 | 600 | `letter-spacing: 0.4px`, uppercase |
| Footer score count | 10 | 400 | `text-muted` |
| Submit button (card) | 10 | 700 | |
| Submit button (hero) | 12 | 700 | |
| Section eyebrow | 10 | 400 | `text-faint`, `letter-spacing: 0.5px`, uppercase |

> **Minimum readable size is 9px and only for uppercase micro-labels.** Never put a score below 11px. The current implementation uses 10–11px monospace for scores — that's one of the defects being fixed.

### Spacing / radii / effects

| Property | Value |
|---|---|
| Page padding | `28px 32px` (`px-8 py-7`) |
| Grid gap | `14px` (`gap-3.5`) |
| Grid columns | `repeat(4, 1fr)` at `lg`, `3` at `md`, `2` at `sm`, `1` at base |
| Grid auto-row height | `200px` |
| Card radius | `10px` (`rounded-[10px]`) |
| Hero radius | `14px` (`rounded-[14px]`) |
| Pinned chip radius | `10px` |
| Search bar radius | `8px` |
| Button radius | `4px` (card) / `6px` (hero) |
| Pill / chip radius | `3px` (sort) / `999px` (platform) |
| Card art height | `110px` |
| Pinned chip art height | `64px` |
| Card body padding | `10px 12px` |
| Card footer padding | `7px 12px` |
| Hero padding | `22px` |
| Leaderboard row padding | `5px 8px` |
| Hero glow | `box-shadow: 0 0 40px` cyan@13% |
| Search focus glow | `box-shadow: 0 0 20px` cyan@13%, `inset 0 0 20px rgba(0,0,0,0.3)` |
| Card art scrim | `linear-gradient(180deg, rgba(0,0,0,0.05) 40%, rgba(16,18,26,0.95) 100%)` |
| Hero art scrim | `linear-gradient(90deg, rgba(16,18,26,0.95) 10%, rgba(16,18,26,0.5) 55%, transparent 100%)` |
| Pinned chip scrim | `linear-gradient(90deg, rgba(16,18,26,0.9), rgba(16,18,26,0.3))` |
| Card hover | `border-color` → `neon-cyan` @ 60%, `transition: 150ms` |

---

## Icons (all Lucide)

| Usage | Component | Size |
|---|---|---|
| Search field | `Search` | 16 (hero bar) / 13 (compact) |
| Live/hot dot | `Circle` (filled — `fill="currentColor"`, `strokeWidth={0}`) | 8–12 |
| Trending hero badge | `Flame` | 10 |
| Hero champion label | `Crown` | 11 |
| Card 1st-place label | `Medal` | 10 |
| Leaderboard rank 1/2/3 | `Medal` | 12 |
| Pin action / My Pins header | `Pin` | 10–14 |
| Alerts label | `Bell` | 11 |
| Rank moved up | `TrendingUp` | 10 |
| Rank moved down | `TrendingDown` | 10 |
| Submit (hero) | `ArrowUp` | 12 |
| Submit (card) | `Upload` | 12 — matches current implementation |
| Toggle: Top 6 | `Trophy` | 12 |
| Toggle: My Score | `MapPin` | 12 |
| Add pin tile | `Plus` | 22 |
| Platform filter label | `Filter` | 14 — already used |

**No emoji anywhere.** The current implementation has a `🏆` in `RANK_STYLES[1].label` — remove it (already partially cleaned in the latest commit; verify).

---

## Screens / Views

There are **three states of one page**, not three pages.

---

### View 1 — Logged out (cold traffic → discovery)

**Purpose:** A visitor lands from a shared link. They should immediately understand what this is, see what's popular, be able to search 2,400+ games, and see a clear path to participating.

**Layout, top to bottom:**

1. **Header** — unchanged. Existing sticky header with logo, Rooms link, Admin link (conditional), `DiscordLoginButton`.

2. **Title block** — flex row, `justify-between`, `align-items: flex-start`, `margin-bottom: 20px`
   - **Left:** `h1` = filled `Circle` icon (8–12px, `text-neon-magenta`, `margin-right: 8px`, `vertical-align: -3px`) + "Global Scoreboard" in `font-display` 32/700.
     Subhead below, `text-muted` 12.5px, `max-width: 540px`:
     > High scores from every ArcAid room. **Log in with Discord** to submit, pin favorites, and get rank alerts.

     ("Log in with Discord" is `text-neon-cyan`, clickable, calls `loginWithDiscord('__global__', '/scoreboard')`.)
   - **Right:** two lines, `font-mono` 10px `text-muted`, right-aligned:
     - Line 1: filled `Circle` 8px `text-neon-magenta` + `LIVE · updated {n}s ago`
     - Line 2: `{total} games · {playerCount} players`

3. **Search bar** — full width, `height: 48px`, `radius: 8px`, `border: 1px` cyan@33%, `background: rgba(0,0,0,0.35)`, `padding: 0 18px`, `gap: 10px`, glow shadow.
   - `Search` icon 16px `text-neon-cyan`
   - Placeholder 14px `rgba(255,255,255,0.5)`: `Search 2,427 games — "haunted", "stern 1995", "pinball fx"…` (interpolate the real total)
   - Right-aligned `⌘K` hint: 10px `font-mono` `text-muted`, `border: 1px border-border`, `radius: 3px`, `padding: 2px 6px`
   - `margin-bottom: 14px`

4. **Filter + sort row** — flex, `justify-between`, `align-items: center`, `gap: 12px`, `margin-bottom: 18px`
   - **Left — platform chips:** `Filter` icon + label `FILTER` (10px `text-faint`), then chips: `All platforms`, `Physical`, `Virtual Pinball`, `Arcade & Video`. Each 10px, `padding: 4px 12px`, `radius: 999px`. Active: `bg-neon-cyan/20`, `text-neon-cyan`, `border-neon-cyan/33`. Inactive: transparent, `text-muted`, `border-border`.
     Maps to the existing `PLATFORM_GROUPS` constant — no logic change.
   - **Right — sort pills:** container `bg-surface`, `border: 1px border-border`, `radius: 6px`, `padding: 3px`. Each pill 11px, `padding: 5px 11px`, `radius: 3px`. Active: `bg-neon-cyan/20`, `text-neon-cyan`, weight 600.
     Order (logged out): `Popular` · `Recent activity` · `Top rated` · `Most scores` · `A–Z`
     Maps to the existing `SortMode` union — see State Management for the one new value.

5. **Card grid** — `display: grid`, `grid-template-columns: repeat(4, 1fr)`, `grid-auto-rows: 200px`, `gap: 14px`
   - First cell: **Hero card** spanning `2 × 2`
   - Remaining cells: standard **Game cards**

6. **Load more** — unchanged existing button.

---

### View 2 — Logged in (personalized)

Same as View 1 with four changes:

1. **Subhead becomes action-oriented:**
   > Welcome back, **{username}**. You have **{n} new rank changes** on pinned games.

   Username in `text-neon-cyan` 600. Count in `text-neon-amber`. If `n === 0`, fall back to: `Welcome back, {username}. Your pinned games are holding steady.`

2. **"My Pins" rail** inserted between the title block and the search bar (`margin-bottom: 20px`):
   - Container: `padding: 14px`, `radius: 10px`, `border: 1px` amber@19%, `background: linear-gradient(180deg, {amber}08, transparent)`
   - **Header row** (`justify-between`, `margin-bottom: 10px`):
     - Left: `Pin` icon 14px `text-neon-amber` + `MY PINS` (`font-display` 14/700, `letter-spacing: 0.5px`) + `— {n} games watched` (10px `text-muted`)
     - Right: `Bell` icon 11px `text-neon-amber` + `Alerts:` + `Discord DM + Lobby bell` (`text-neon-cyan`), then a `Manage` link (10px `text-muted`) → opens alert prefs
   - **Chip row:** `display: flex`, `gap: 10px`, `overflow-x: auto`. Pins are **unlimited**, so this scrolls horizontally. Add momentum scrolling and hide the scrollbar on desktop; keep it visible on touch.
     - **Pinned chip** — `width: 220px`, `radius: 10px`, `border: 1px border-border`, `bg-surface`
       - Art strip `height: 64px` with 90° scrim
       - Top-right: rank-delta badge (if changed) + `Pin` badge. Delta badge: `bg: rgba(0,0,0,0.6)`, `padding: 2px 6px`, `radius: 3px`, 9px `font-mono` 700, `TrendingUp` (green) if improved / `TrendingDown` (coral) if dropped, followed by absolute delta.
       - Bottom-left: game title `font-display` 12/700, truncated single line
       - Body `padding: 7px 10px`: `PlayerAvatar` 20px + `#1` label (9px `text-muted` 600) + score (`font-mono` 12/700 `text-neon-amber`) + a `+` submit button (`bg-neon-cyan`, `text-deep`, 10px 700, `padding: 3px 8px`, `radius: 4px`)
     - **Trailing add-tile:** `width: 80px`, `border: 1px dashed border-border`, `radius: 10px`, centered `Plus` icon 22px `text-faint`. Opens the search palette.

3. **Sort pills gain `Pinned first` as the leading option and it is the default.**
   Order (logged in): `Pinned first` · `Popular` · `Recent activity` · `Top rated` · `Most scores` · `A–Z`

4. **Density toggle** appears in the filter row, left of the sort pills:
   - Label `VIEW` (10px `text-faint`)
   - Segmented control: `Grid` | `Compact`. Container `bg-surface`, `border: 1px border-border`, `radius: 4px`, `padding: 2px`. Each 10px, `padding: 3px 8px`, `radius: 2px`.
   - Persist per user (see State Management).

5. **Grid eyebrow** above the grid: `Pin` icon 10px `text-neon-amber` + `PINNED FIRST · THEN POPULAR` (10px `text-faint`, `letter-spacing: 0.5px`). Text reflects the active sort.

6. **Cards gain the pin hotspot and the "YOU" row** — see Components below.

---

### View 3 — Search active (command palette)

**Purpose:** The fastest possible path from "I just played X" to "my score is posted."

**Trigger:** `⌘K` / `Ctrl+K` anywhere on the page, or clicking the search bar. `Esc` closes.

**Layout:**

- The search bar gains a focused treatment: `border: 1px solid` full-strength `neon-cyan`, `background: rgba(0,0,0,0.55)`, `box-shadow: 0 0 30px` cyan@27%.
- Query text renders `font-mono` 14px `text-primary` with a blinking 2px cyan caret (`@keyframes blink { 50% { opacity: 0 } }`, `1s infinite`).
- Right side of the field: `esc to close` (11px `text-muted`).
- **Results dropdown** — absolutely positioned `top: 54px`, full width of the field, `bg-surface`, `border: 1px border-border`, `radius: 8px`, `box-shadow: 0 20px 60px rgba(0,0,0,0.5)`, `z-index: 5`.
  - **Header strip:** `padding: 10px 18px`, `border-bottom: 1px border-border`, 10px `text-faint` `letter-spacing: 1px`. Left: `GAMES — {n} MATCHES`. Right: `Press ↵ for full results` (`text-neon-cyan`).
  - **Result rows:** `padding: 10px 18px`, `gap: 14px`, `border-bottom: 1px` border@31% except last. First row (selected) has `background: rgba(100,200,240,0.08)`.
    - Art thumb 42×42, `radius: 5px`
    - Title `font-display` 14/700; meta below 10px `text-muted`: `{manufacturer} · {year} · {n} scores`
    - Right block: `Medal` icon 9px + champion name (9px `text-muted`), score below (`font-mono` 12/700 `text-neon-amber`)
    - Submit button: selected row = `bg-neon-cyan` / `text-deep` with `↵ Submit`; others = ghost (`border: 1px` cyan@40%, `text-neon-cyan`) with `Submit`. 11px 700, `padding: 6px 14px`, `radius: 4px`.
  - **Footer strip:** `padding: 8px 18px`, `background: rgba(0,0,0,0.25)`, 10px `text-muted`, `gap: 18px`. Keyboard hints rendered as `<kbd>` (`padding: 1px 5px`, `radius: 3px`, `background: rgba(255,255,255,0.08)`, `border: 1px rgba(255,255,255,0.15)`, `font-mono` 9px): `↑↓ navigate` · `↵ submit score` · `⌘↵ open details`. Right-aligned: `{n} more games matched "{query}"`.
- **Background** — the card grid behind dims to `opacity: 0.25` and becomes `pointer-events: none`.

**Search behavior:** fuzzy, and aware of manufacturer + year. `"haunt"` → Haunted House. `"stern 95"` → everything Stern made in 1995. The existing endpoint takes `search`; extend server-side matching to cover `manufacturer` and `year` tokens rather than name only.

---

## Components

### Game card (replaces the current `GameCard`)

Structure top to bottom:

1. **Art block** — `position: relative`, `height: 110px`
   - `<img>` absolutely positioned, `object-fit: cover`. Source from the existing `imageFor(game)`. Fallback: centered `No image` (11px `text-muted`) on `bg-deep`.
   - Scrim overlay (180° gradient, above).
   - **Pin button** (logged in only) — `top: 6px; left: 6px`, `22×22`, `radius: 4px`, `background: rgba(0,0,0,0.55)`, `border: 1px rgba(255,255,255,0.15)`, `Pin` icon 11px. Filled/amber when pinned, outline/primary when not. `aria-pressed`. **This is a 22px control — enlarge the hit area to 44px with an invisible padded wrapper on touch viewports.**
   - **Platform pill** — `top: 6px; right: 6px`. **One pill only** (`platforms[0]`), not all of them. 9px 600 uppercase, `letter-spacing: 0.4px`, `text-neon-cyan`, `background: rgba(255,255,255,0.03)`, `border: 1px` cyan@20%, `radius: 3px`. Full list moves to hover tooltip / detail page.
   - **Title overlay** — `left: 10px; right: 10px; bottom: 6px`. Title `font-display` 13/700, `line-height: 1.15`, `text-wrap: pretty`, `text-shadow: 0 1px 4px rgba(0,0,0,0.8)`. Meta below: `{manufacturer} · {year}`, 9.5px `rgba(255,255,255,0.55)`.
   - Entire art block links to `/games/{global_game_id}`.

2. **Leaderboard block** — `padding: 10px 12px`, `flex: 1`
   - **If scores exist:** renders rows per the active density mode (see "Leaderboard density" below).
   - **If no scores:** a single dashed CTA — `padding: 8px 4px`, `border: 1px dashed` cyan@33%, `radius: 6px`, centered `Claim 1st →` 11px `text-neon-cyan`. Clicking opens `SubmissionSheet`.

3. **Footer** — `padding: 7px 12px`, `border-top: 1px` border@31%, `justify-between`
   - Left: `{n} scores` (10px `text-muted`, singular/plural correct)
   - Right: **Submit** button — `bg-neon-cyan`, `text-deep`, 10px 700, `padding: 4px 10px`, `radius: 4px`, `Upload` icon. **Solid, not ghost.** Hover: brightness 110%.

**Removed from the card vs. today:**
- The 5-star `StarRating` row (0-rating games rendered five gray ghosts on every card)
- The 2nd/3rd empty podium slots that rendered as `—` placeholders
- The multi-pill platform stack in the footer
- The centered text-stack title above the image

### Leaderboard density (the Top 6 / My Score toggle)

A **single page-level toggle** controls every card at once. There is **no per-card toggle**.

Toggle UI: segmented control, container `bg-surface`, `border: 1px border-border`, `radius: 5px`, `padding: 2px`. Buttons 11px 700, `padding: 6px 14px`, `radius: 3px`, `gap: 6px` between icon and label. Active: `bg-neon-cyan/20`, `text-neon-cyan`. Inactive: `text-muted`.

- **`Trophy` Top 6** — ranks 1–6, straight from the top. Default. The only mode available when logged out (hide the toggle entirely for anonymous visitors).
- **`MapPin` My Score** — ranks 1–3, a dashed break line, then ranks *(yours − 1)*, *yours*, *(yours + 1)*.

Edge cases for My Score mode:
- **You are ranked 1–3:** no break line, just show ranks 1–5.
- **You are ranked 4:** no break line needed (contiguous) — show 1–5 with you highlighted.
- **You have no score on this game:** replace the "your zone" block with a dashed prompt — `NO SCORE YET` (10px `text-neon-cyan` 700) and `#{lastQualifyingRank} needs {score} to qualify` (10px `text-muted`).
- **Fewer than 6 total scores:** show all of them, no break line, in either mode.

**Leaderboard row spec** — `display: flex`, `align-items: center`, `gap: 8px`, `padding: 5px 8px`, `radius: 5px`
- Rank cell: `width: 20px`, centered. Ranks 1–3 render a `Medal` icon 12px (amber / silver / bronze). Ranks 4+ render `#{n}` in `font-mono` 10/700 `text-muted`.
- `PlayerAvatar` 18px
- Name: `flex: 1`, 11px, truncated. Weight 500 normally, 700 if it's you.
  - If it's you, append a badge: `YOU` — 8px, `padding: 1px 4px`, `background:` cyan@20%, `radius: 2px`, `letter-spacing: 0.5px`
  - If it's the person one rank above you, append: `NEXT` — 8px, `padding: 1px 4px`, `background:` amber@13%, `text-neon-amber`, `radius: 2px`
  - Include `RoomTag` here when `origin_room_slug` is present, as today.
- Score: `font-mono` 11/700. `text-neon-amber` for rank 1, `text-primary` otherwise.
- Row background/border per the rank → color table above.

**Break line** — `border-top: 1px dashed border-border`, `margin: 3px 8px`, `padding-top: 3px`, centered `· · ·` 8px `text-faint`.

### Hero card

Spans `2 × 2` in the grid. One per page, at grid position 1. Selects the highest-momentum game — most scores submitted in the trailing 7 days.

- `radius: 14px`, `border: 1px` cyan@40%, `box-shadow: 0 0 40px` cyan@13%
- Full-bleed art with the 90° scrim (text sits on the dark left side)
- **Top-left badges** (`gap: 6px`): `Flame` icon 10px + `HOT` — `bg-neon-magenta`, `#fff`, 9px 800, uppercase, `letter-spacing: 1px`, `padding: 3px 10px`, `radius: 3px`. Beside it: `+{n} scores this week` — `background: rgba(0,0,0,0.5)`, `text-primary`, 9px 600.
- **Top-right:** up to 2 platform pills.
- **Content block** — `padding: 22px`, bottom-aligned:
  - Eyebrow: `{MANUFACTURER} · {year} · {n} PLAYERS`, `font-mono` 10px `text-neon-cyan`, `letter-spacing: 1px`
  - `h2` game title: `font-display` 34/800, `line-height: 1`
  - Champion block (`gap: 12px`, `margin-top: 16px`): `PlayerAvatar` 46px + column of
    - `Crown` icon 11px + `CHAMPION` (9px 700 `text-neon-amber`, `letter-spacing: 1px`)
    - Name `font-display` 15/700
    - Score `font-mono` 22/700 `text-neon-amber` with amber glow
    - `+{delta} over #2` (10px `text-muted`) when a 2nd place exists
  - Button row (`gap: 8px`, `margin-top: 14px`):
    - Primary: `ArrowUp` + `Submit your score` — `bg-neon-cyan`, `text-deep`, 12px 700, `padding: 9px 18px`, `radius: 6px`
    - Secondary: `Pin` + `Pin` — `background: rgba(255,255,255,0.08)`, `border: 1px rgba(255,255,255,0.2)`, `#fff`
    - Tertiary: `Full leaderboard →` — `background: rgba(255,255,255,0.04)`, `border: 1px rgba(255,255,255,0.15)`

Optional (nice-to-have): render the hero's leaderboard as a glassy panel on the right — `background: rgba(0,0,0,0.45)`, `backdrop-filter: blur(8px)`, `border: 1px border-border`, `radius: 8px`, showing ranks 1–6 plus a break and your row. See `Variant_HeroTop6PlusYou` in `CardDensity.jsx`.

### Compact / density view

When `Compact` is selected, the grid becomes a table. Columns: `44px | 1fr | 1.4fr | 120px | 100px` → art thumb, game (title + meta + platform pills), champion (rank + avatar + name + score), 2nd/3rd, actions (score count + Submit).

- Column header row: `padding: 8px 14px`, `background: rgba(0,0,0,0.3)`, `border-bottom: 1px border-border`, 9px 700 uppercase `text-faint` `letter-spacing: 1px`. Labels: *(blank)* · `Game` · `Champion` · `2nd / 3rd` · `Scores`.
- Rows: `padding: 10px 14px`, `border-bottom: 1px` border@44%, `gap: 14px`. Hover: `bg-raised`.
- Art thumb 44×44, `radius: 6px`.
- Reference: `DirC_LeaderboardList.jsx`.

---

## Interactions & Behavior

| Trigger | Behavior |
|---|---|
| Click card art or title | Navigate to `/games/{global_game_id}` |
| Click **Submit** (card or hero) | If `!playerToken` → `loginWithDiscord('__global__', '/scoreboard')`. Else open `SubmissionSheet` with `target={{ kind: 'global', globalGameId, gameName }}`. Unchanged from today. |
| Click **Pin** | Optimistically toggle. `POST`/`DELETE` `/api/global/games/:id/pin`. On failure, revert and toast. |
| Click a **pinned chip** | Navigate to that game's detail page. |
| Click **+** on a pinned chip | Open `SubmissionSheet` for that game. |
| Click the **add tile** in the rail | Open the search palette. |
| `⌘K` / `Ctrl+K` | Open search palette, focus input, select all existing query text. |
| `Esc` in palette | Close palette, restore grid opacity, blur input. |
| `↑` / `↓` in palette | Move selection. Wraps. Selected row scrolls into view via `block: 'nearest'` on the container's `scrollTop` — **do not use `scrollIntoView`**. |
| `↵` in palette | Open `SubmissionSheet` for the selected game. |
| `⌘↵` in palette | Navigate to the selected game's detail page. |
| Type in palette | Debounce 300ms (matches today), then fetch. Show a subtle spinner in the field while in flight. |
| Click a **sort pill** | Set sort, refetch page 1. Push to URL as `?sort=`. |
| Click a **platform chip** | Set platform group, refetch page 1. |
| Toggle **Top 6 / My Score** | Client-side only if the payload already carries neighbor rows; otherwise refetch. Persist choice. |
| Toggle **Grid / Compact** | Client-side. Persist choice. |
| `score:new:global` socket event | Existing toast + optimistic card bump. Additionally: if the event's game is pinned by the current user and their rank changed, increment the "new rank changes" counter in the subhead. |
| Card hover | `border-color` → cyan@60%, 150ms. |
| Reduced motion | Respect `prefers-reduced-motion`: disable the caret blink and the live-dot pulse. |

### Live indicator

The magenta `Circle` next to the `h1` and the `LIVE · updated {n}s ago` line should feel alive without being noisy. Drive `{n}` off the timestamp of the last received `score:new:global` event (or the initial fetch time). Use the existing `.pulse` class from `index.css` (`pulse-glow`, 2s ease-in-out) on the dot.

---

## State Management

Existing state in `GlobalScoreboard.tsx` stays. Additions:

```ts
// New sort value — extend the existing union
type SortMode =
  | 'pinned'        // NEW — pinned games first, then popular
  | 'popular'
  | 'most_scores'
  | 'highest_rated'
  | 'most_recent'
  | 'name_asc';

// New state
const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
const [rankChangeCount, setRankChangeCount] = useState(0);
const [density, setDensity] = useState<'top6' | 'mine'>('top6');
const [layout, setLayout] = useState<'grid' | 'compact'>('grid');
const [paletteOpen, setPaletteOpen] = useState(false);
const [paletteIndex, setPaletteIndex] = useState(0);
```

**Default sort:** `playerToken ? 'pinned' : 'popular'`.

**Persistence.** Follow the pattern already used by `ThemeProvider` — `localStorage` for instant paint, server preferences as the source of truth.

- `localStorage` keys: `arcaid-scoreboard-density`, `arcaid-scoreboard-layout`
- Hydrate from `/api/me/preferences` (or the viewer equivalent) on mount and reconcile
- Write both on change

> **Do not clear or overwrite unrelated `localStorage` keys.** The app already stores `arcaid_token`, `arcaid-theme-*`, and `lobby_last_seen_*`.

**Per-game rank data.** The card needs your rank and your neighbors. Extend the `/api/global/scoreboard` response per game (see `API_CHANGES.md`):

```ts
interface TopGame {
  // ...existing fields...
  is_pinned?: boolean;         // when authed
  my_rank?: number | null;     // when authed
  my_score?: number | null;
  neighbors?: TopScoreEntry[]; // ranks my_rank-1 .. my_rank+1, when authed
}
```

Returning `neighbors` alongside `top_scores` lets the density toggle flip **client-side with no refetch**, which is the difference between the toggle feeling instant and feeling broken.

---

## Assets

No new image assets. Game art comes from the existing catalogue pipeline via `imageFor(game)` → `/api/catalogue-images/…`. Avatars come from `PlayerAvatar` (Discord CDN + initial fallback).

Fonts are already loaded (Orbitron, Inter, JetBrains Mono, Press Start 2P).

All icons come from the `lucide-react` package already in `package.json`. The prototypes hand-inline the same Lucide SVG paths only because they run without a bundler — **import from `lucide-react` in the real implementation.**

The striped gradient blocks in the prototypes are placeholders standing in for real game art. Do not port them.

---

## Files in this bundle

| File | What it is |
|---|---|
| `ArcAid Global Scoreboard Review.html` | **Start here.** Self-contained, offline. The full design doc on a pannable canvas: current-state critique, five explored directions, density comparison, live toggle prototype, and the shipping recommendations. |
| `Global Scoreboard Review.html` | Source version of the same doc (loads the `components/` files). |
| `components/DirD2_Merged.jsx` | **The canonical target.** `D2LoggedOut`, `D2LoggedIn`, `D2SearchActive`, plus `D2Hero`, `D2Tile`, `PinnedChip`, `SearchBar`, `SortPills`, `PlatformChips`. |
| `components/ToggleCard.jsx` | The Top 6 / My Score toggle behavior and row rendering. Interactive. |
| `components/CardDensity.jsx` | `LBRow` spec, the five density variants explored, and `Variant_HeroTop6PlusYou`. |
| `components/DirC_LeaderboardList.jsx` | Reference for the Compact/table density view. |
| `components/DirA_TrimmedCurrent.jsx` | The minimal-intervention card, if you want to ship quick wins before the full redesign. |
| `components/CurrentAnnotated.jsx` | Recreation of the page as it exists today. Useful for before/after diffing. |
| `components/shared.jsx` | Token values, mock data shape, `formatScore`, `rankColor`, `PlatformPill`. |
| `components/icons.jsx` | The Lucide icon set used, with exact path data — for verifying you've picked the same glyphs. |
| `IMPLEMENTATION_PLAN.md` | Phased tickets with acceptance criteria. |
| `API_CHANGES.md` | Backend contract: new endpoints, response additions, the `rank_change` lobby event. |
| `screenshots/` | **2× reference renders of every state**, plus `screenshots/README.md` explaining what each one proves. Use them as a visual litmus while building. |

To view the design doc: open `ArcAid Global Scoreboard Review.html` in a browser. Drag to pan, scroll or pinch to zoom. Section 6 is the canonical layout; section 8 is the interactive toggle; section 11 is the shipping list.

---

## Out of scope for this handoff

- `GlobalGameDetail` page (the full leaderboard destination) — unchanged, though `StarRating` now lives only here
- Room-scoped `Scoreboard.tsx` and `KioskScoreboard.tsx`
- The Marquee/arcade-cabinet aesthetic explored in section 10 — deliberately **not** shipping as default. If you want it, wire it as a new entry in the existing `ThemeProvider` theme list, not as a layout change.
