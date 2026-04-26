# ArcAid

**ArcAid** is a multi-tenant tournament management platform for virtual pinball and retro gaming communities. Host multiple game rooms on a single instance, each with independent tournaments, admins, settings, and iScored integration. Discord bot + React Admin UI + automated score tracking.

**Production:** [arcaid.app](https://arcaid.app)

## Features

- **Multi-tenant game rooms** — Each room has its own tournaments, leaderboards, admins, settings, and iScored account
- **Automated tournament rotation** — Daily, Weekly, Monthly (including last-day-of-month), or custom cron schedules
- **iScored integration** — REST API for score sync (preferred) with Playwright fallback for game management. Continuous background polling keeps leaderboards in sync across all submission methods (web, iScored, Discord)
- **Pick system** — Winner picks the next game with tiered timeouts (winner → runner-up → auto-select). Web-based game picking for Discord-authenticated players with queue management (reorder, delete, max 5 per tournament)
- **Mystery Award** — Canvas-based random game picker with animated DMD dot display and pinball backbox aesthetic. Room logo displayed in backglass area. Discord-authenticated users can add the selected game directly to their pick queue
- **Discord player login** — Public page visitors can log in via Discord to pick/queue games directly from the Game Picks page
- **Discord bot** — Full slash command suite for players (submit scores, check stats) and admins (force rotations, manage games)
- **Cross-tournament rankings** — Ranking groups with 4 scoring methods
- **Game library imports** — Bulk import from Virtual Pinball Spreadsheet (VPS) and VPXS Wizard Tables
- **Admin invite system** — One-time invite links with optional Discord DM delivery for onboarding room admins
- **Community scores** — Submit scores outside tournaments; per-game community leaderboards
- **Game tips & comments** — Player-submitted tips and comments on each game
- **Score history tracking** — Expandable per-player submission history on leaderboards
- **Style catalogue** — iScored visual styles imported or uploaded, assigned per game
- **Kiosk mode** — Auto-refreshing scoreboard display for TV/kiosk use (no nav, configurable refresh interval)
- **Game merge tool** — Consolidate duplicate games across all tables; auto-merge near-duplicates during import (comma-variant names)
- **Audit logging** — Admin action tracking with full history
- **Public stats page** — Enhanced player metrics: average finish, top 5%, champion streak
- **Session persistence** — Login pages auto-redirect if a valid JWT exists (24h expiry)
- **Discord post-score rating flow** — Star rating buttons and comment modal after `/submit-score`
- **Scoreboard branding** — Custom logos, background images, and title styles per room
- **Progressive Web App (PWA)** — Installable on Android/iOS with standalone display, offline caching, and home screen icon
- **Global card style overrides** — Room-wide color customization for game card titles, scores, borders, and backgrounds via color pickers
- **3 scoreboard card styles** — Banner (280px, iScored-compatible), Showcase (380px, art-forward with podium top-3), Minimal (typography-only). Style+Theme 2-level selection with two Showcase themes (Glass Deck, Neon Circuit)
- **Style-matched rankings cards** — Overall rankings cards automatically match the active card style (Banner/Showcase/Minimal) with theme-appropriate colors and layout
- **Inline rankings** — Rankings cards render inline with game cards (default) or as sticky side columns. Configurable position (top/bottom/left/right)
- **12 game title styles** — Default, Glow, Neon Magenta (animated flicker), Chrome, Fire (animated shifting gradient), Plasma, Backglass, Marquee, Retro, Pixel, Shadow, Outlined
- **QR code score submission** — Configurable QR codes on game cards (disabled/kiosk-only/all) with size and position options (top-right/bottom-right)
- **Card background fill** — Background image fills entire card behind layout with glass-panel overlay (adjustable opacity)
- **Layout presets** — 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament) with auto-detection of custom settings
- **Live preview** — Settings page shows multi-card scaled preview with real game art, updating instantly on changes
- **Game display names** — Optional display name override per game (falls back to game name on scoreboard cards)
- **Smart title auto-hide** — Game name text automatically hidden when an identifier image exists on the card
- **Image cropper** — Locked aspect ratio cropping for branding uploads and style catalogue images
- **Per-game art assignment** — Independent logo and background images from different style catalogue entries
- **Readable card text** — Fixed responsive font sizes for card titles and scores at any card width
- **Score toast notifications** — Real-time WebSocket-powered slide-down notifications when players submit scores
- **"Your Best" quick stat** — Logged-in users see their best score and rank on each game card footer
- **Platform in-use validation** — Prevents deleting platforms that are referenced by active tournaments
- **Locked game protection** — Score submissions blocked for completed/locked games (backend 403 + frontend lock UI)
- **11 UI themes** — Arcade, Dark, Light, Backglass, CRT Green, Plasma, Cabinet, Silverball, Wizard, Playfield, Marquee — admin theme per-user, public theme per-room
- **Public pages** — Scoreboard, player profiles, game details, and game availability — no login required
- **Mobile-responsive** — Full functionality on phones and tablets
- **Pin to Scoreboard** — Room admins can pin any catalogue game to the room scoreboard without creating a tournament; optional one-step iScored mirroring; pinned games render with a "Pinned" chip and stay active until manually unpinned
- **At-rest secret encryption** — `iScored` passwords, OPDB API key, and Twitch client secret stored encrypted (AES-GCM) using a `SECRETS_KEY` from the host environment; allowlist-driven so a typo can't silently land in plaintext
- **Per-room iScored / Discord configuration** — Each game room connects independently to its own Discord guild and iScored account, or disables either integration; settings live in `game_room_settings`
- **OPDB / IGDB catalogue imports** — Bulk import pinball machines from OPDB and arcade/console games from IGDB (via Twitch OAuth) directly from the global catalogue page; UI fields for the API keys live in Global Settings → Configuration
- **Wizard auto vs manual tagging** — VPXS Wizard imports distinguish `vpxs` (auto-install, verified) from `vpxs_manual` (Manual Install Tables — hit-or-miss on AtGames Standalone) so tournament platform rules can require reliability

### v2.4.0 — Catalogue Unification + Pin to Scoreboard (2026-04-21)
- **Unified catalogue identity.** Every relevant row links to a canonical `global_games.id`. Identity resolved through the FK rather than name-based JOINs (with name-based COALESCE fallbacks kept as defense in depth). Per-room overlay supports `custom_platforms` (e.g. WMS league) and `display_name` overrides without touching the shared catalogue.
- **Pin to Scoreboard.** Pinned games render with a "Pinned" chip on Banner/Showcase/Minimal cards, stay active until unpinned, don't contribute to cross-tournament rankings, and survive maintenance cycles. Schema: `games.tournament_id IS NULL` is the canonical pinned-row signal.
- **4-step dedup hierarchy.** `GlobalGameService.upsert` resolves identity via: external ID → cross-type guard → IPDB URL → normalized name. Composite UNIQUE INDEX on `(LOWER(name), type, LOWER(COALESCE(mfg,'')), COALESCE(year,0))` lets same-name pinballs from different manufacturers (Stern Batman 2008 vs Data East Batman 1991) coexist while rejecting true duplicates.

### v2.3.0 — Per-room integrations + at-rest encryption (2026-04-19)
- **Per-room iScored / Discord** — Discord guild ID, admin role ID, announcement channel ID, and iScored credentials moved from global to per-room `game_room_settings`.
- **At-rest secret encryption** — AES-GCM encryption pipeline keyed off `SECRETS_KEY`; `ENCRYPTED_SETTING_KEYS` allowlist controls what's encrypted; `maskEncryptedValues` returns a `[ENCRYPTED]` placeholder on `GET /admin/settings`.

### v2.1.0 — Tournament scoring + Stats Combo (2026-04-18)
- **Tournament leaderboards read from `score_history`** filtered by `submitted_during_tournament_id` — best-during-the-window wins, no longer tied to all-time personal best. Lower-than-PB scores during a tournament window count correctly.
- **Multi-score inline expand** — click a username on Game Detail leaderboard to drop down a sparkline + "This tournament" / "All time" split of their submissions, with source tags and proof-photo links per row.
- **Stats page Combo** — 4-card overview row at the top of `/:slug/stats` (plays this week / active players / hottest game / latest submission) above the existing Players / Games tabs.

### v2.2.x — Identity correctness + cabinet redesign (2026-04-19 → 2026-04-21)
- **First-claim-wins identity** — whoever uses a name first in a room owns it; later arrivals auto-suffix to `Bob_2`, `Bob_3`. Works symmetrically for Discord and anon users. Anon identity keyed on a per-browser localStorage token so re-submits stay sticky; multiple names per browser allowed.
- **Pre-submit collision prompt** — when a guest types a name that's already claimed, `SubmissionSheet` surfaces an editable prompt with the server's suggested alternative before committing.
- **Global fan-out gate** — guest submissions never reach `/scoreboard`. Every row on Global has a verified Discord ID behind it.
- **Safe-by-default login** — new rooms get `REQUIRE_DISCORD_LOGIN=true` by default. Existing rooms unaffected; admins opt in per-room.
- **Auth in guest-allowed rooms** — logged-in users' submissions attribute to their Discord identity even when the room allows guest play.
- **Unified iScored sync** — all three web submission paths (tournament card, freeplay, legacy community endpoint) sync to iScored identically when the target is an active tournament game.
- **Winner resolution from local DB** — the bot announces whoever's on top of the room's scoreboard (not iScored), and handles anon winners with a "claim your account" message instead of a broken `@mention`.
- **Scoreboard click routing** — clicking a tournament card title goes to Room Game Detail; usernames everywhere are links to player stats; `+` expand icons actually expand inline (no accidental navigation).
- **Human-readable Picks URL** — `/:slug/picks?t=daily_grind` (was `?t=<uuid>`).
- **Mystery Award cabinet redesign** — `TournamentPoolTopper` component renders above the backbox as a pinball cabinet topper (orange LED glow, drop-down overlays the backbox). Fire + Queue buttons are always visible as circular pinball-cabinet buttons; Queue grayed until a game is revealed.
- **Post-login lands on the Lobby** — `/:slug/lobby` is the default return path after Discord OAuth from room pages.

## Quick Start

### Docker (Recommended)
```bash
cp .env.example .env    # Fill in Discord credentials
docker-compose up -d --build
# Admin UI: http://localhost:3001
# First visit runs the Setup Wizard
```

### Manual
```bash
cp .env.example .env
npm install
npm run build
npm start              # or: npm run dev (tsx, no build needed)
```

### Admin UI Development
```bash
cd admin-ui
npm install
npm run dev            # Vite dev server with HMR
```

## URL Structure

| URL | Page |
|-----|------|
| `/` | Public landing (game room directory) |
| `/login` | Super-admin login (password or Discord OAuth) |
| `/admin/*` | Super-admin panel (dashboard, rooms, library, backups, logs, settings) |
| `/invite/:token` | Admin invite acceptance (public) |
| `/:slug/` | Public scoreboard |
| `/:slug/kiosk` | Kiosk scoreboard (auto-refresh, no nav) |
| `/:slug/players` | Public player list |
| `/:slug/players/:id` | Player detail (stats, history) |
| `/:slug/games/:name` | Game detail — tabs: scores, community, tips/comments, player stats |
| `/:slug/picks` | Game Picks (cooldowns, pick/queue games if Discord-logged-in). URL takes a `?t=<tournament_slug>` query (e.g. `?t=daily_grind`). `/:slug/games` 301-redirects here. |
| `/:slug/mystery-award` | Mystery Award random-game picker (canvas DMD + pinball cabinet aesthetic). |
| `/:slug/lobby` | Live activity feed + announcements + community shelf. Default post-login landing page. |
| `/friends` | Friends list (global, requires Discord login). |
| `/my-rooms` | Rooms you've submitted in (global, requires Discord login). |
| `/:slug/freeplay` | Freeplay (browse catalogue, submit scores for any game) |
| `/:slug/submit/:gameId` | Standalone score submission (QR code target) |
| `/:slug/stats` | Public enhanced stats (avg finish, top 5%, champion streak) |
| `/scoreboard` | Global cross-room leaderboard |
| `/catalogue` | Global searchable game catalogue |
| `/games/:id` | Global game detail (scores, metadata, downloads, tutorials) |
| `/:slug/login` | Room admin login |
| `/:slug/admin/*` | Room admin panel (dashboard, tournaments, library, leaderboard, rankings, stats, history, settings) |

## Auth System

| Method | Scope | Description |
|--------|-------|-------------|
| Super-admin password | Server-wide | Set on first login. Full access to all rooms and global settings. |
| Room local admin | Per-room | Username/password created via invite link or super-admin. Scoped to specific rooms. |
| Discord OAuth | Either | Available on all login pages + public pages. Checks `super_admins` → `game_room_admins` → issues `player` token for public features. |

## Discord Commands

### Player Commands
| Command | Description |
|---------|-------------|
| `/list-active` | Show currently active games across all tournaments |
| `/list-scores` | Leaderboard for active games (optional `@user` filter, pagination) |
| `/submit-score` | Submit score + photo to iScored (auto-maps username on first use); prompts star rating + comment |
| `/ping` | Check bot responsiveness |
| `/view-stats` | Historical stats for any game (autocomplete) |
| `/my-stats` | Personal stats card (wins, win%, average, best, recent games) |
| `/list-winners` | Hall of fame — recent tournament winners |
| `/view-selection` | Show queued games and what's next in the lineup |
| `/pick-game` | Nominated picker selects the next game (shows eligible games only) |
| `/map-user` | Link your Discord account to your iScored username |
| `/create-backup` | Trigger a database backup |
| `/sync-state` | Reconcile local DB with live iScored data |

### Admin Commands
| Command | Description |
|---------|-------------|
| `/force-maintenance` | Manually trigger a tournament rotation cycle |
| `/activate-game` | Immediately activate a specific game for a tournament |
| `/deactivate-game` | Deactivate an active game (optionally locks on iScored) |
| `/run-cleanup` | Delete completed/orphan games from iScored per cleanup rules |
| `/pause-pick` | Inject a specific game into the tournament queue |
| `/nominate-picker` | Manually assign picker rights to a user |
| `/reorder-lineup` | Reorder queued games in a tournament's iScored lineup |
| `/setup` | Configure Discord channels, roles, and pick windows |

## Configuration

### Secrets and encryption

Secret values (currently: per-room `ISCORED_PASSWORD`) are stored encrypted at
rest using AES-256-GCM. A master key is required — set it once per environment:

```bash
npm run generate-secrets-key
# outputs: SECRETS_KEY=<base64>
# Append that line to your .env file.
```

Back up the key. Losing it renders every encrypted secret in the database
unreadable. Rotation is not yet automated — to rotate, generate a new key,
re-enter each secret via the Settings UI, and restart. In production, prefer
Docker secrets or a secret manager over committing the value to `.env`.

Other secret-bearing env vars (`JWT_SECRET`, `DISCORD_BOT_TOKEN`, etc.) remain
in `.env` for now. They're never written to the database, and the audit log
middleware redacts them from request bodies.

### Global Settings (Super-Admin)
| Setting | Description |
|---------|-------------|
| Discord Bot Token | Bot authentication token from Discord Developer Portal |
| Discord Client ID | OAuth2 application client ID |
| Discord Client Secret | OAuth2 client secret (for admin Discord login) |
| JWT Secret | Secret for signing auth tokens |
| Secrets Key | Master key for at-rest encryption of secret settings (generate via `npm run generate-secrets-key`) |
| Port | HTTP server port (default: 3001) |
| Max Log Lines | Maximum log lines returned by the API |
| Backup Retention Days | How many days to keep automatic backups |
| iScored API Enabled | Use iScored REST API for score sync instead of Playwright (default: true) |
| iScored API Poll Interval | How often to poll iScored for new scores in seconds (default: 30, hot-reloads on save) |

### Per-Room Settings (Room Admin)
| Setting | Description |
|---------|-------------|
| Game Room Name | Display name for the room |
| Game Room Slug | URL identifier (e.g., `my_room` → `/my_room/`) |
| Discord Guild ID | Discord server ID this room is linked to |
| Default Announcement Channel | Default channel for tournament announcements (fallback when tournament has no channel set) |
| Discord Admin Role | Discord role that grants admin command access |
| iScored Username | Login for the room's iScored.info account |
| iScored Password | Password for the iScored account |
| iScored Public URL | Public leaderboard URL for score scraping |
| Bot Timezone | Timezone for schedules (e.g., `America/Chicago`) |
| Platforms | List of gaming platforms available (e.g., AtGames, VPXS, VR, IRL) |
| Game Eligibility Cooldown | Days before a previously played game can be picked again |
| Winner Pick Window | Minutes the winner has to pick the next game |
| Runner-up Pick Window | Minutes for runner-up fallback if winner doesn't pick |
| UI Theme | Admin theme (per-user) and public/scoreboard theme (per-room) — 11 themes available |
| Scoreboard Branding | Custom background image, logo, and title style/size for public scoreboard. Logo visibility toggle (show/hide on scoreboard independently of Mystery Award backglass) |
| Kiosk Refresh Interval | Auto-refresh interval (seconds) for kiosk display |
| Hide Empty Games | Toggle to suppress games with no scores from public views |
| Discord @Mentions | Toggle Discord role/user @mentions in tournament announcements |
| Scoreboard Style | Card style: Banner (280px), Showcase (380px, art-forward with podium), or Minimal (typography-only). Theme selection for Showcase (Glass Deck, Neon Circuit). Legacy card layouts also available (Compact, Wheel, Sidebar). |
| Card Background Fill | Off or Fill — fill mode shows background image behind entire card with glass overlay |
| Card Background Size | Cover, Contain, or Tile — controls how background images are sized |
| Game Columns | Auto (fill based on card size) or 2 (force two cards per row on desktop) |
| Wheel Icon Scale | Size of wheel icons when using Wheel header style (100-200%, default 150%) |
| Global Card Styles | Toggle + color overrides for game card titles, scores, borders, backgrounds |
| Callouts | Easter egg — bot responds to trigger words from `data/callouts.json` |

### Tournament Settings
| Setting | Description |
|---------|-------------|
| Name | Tournament display name |
| Type/Tag | Short code used as iScored tag prefix (e.g., DG, WG-VPXS) |
| Mode | `pinball` or `videogame` — controls terminology throughout |
| Schedule | Daily / Weekly / Monthly (1st–31st or Last day) with time and timezone |
| Platform Rules | Required/excluded platforms for game eligibility |
| Cleanup Rule | What happens to completed games: immediate hide, retain last N, or scheduled cron |
| Max Active Games | How many games can be active simultaneously (1–10) |
| Discord Channel | Override announcement channel per tournament |
| Discord Role | Optional role mention in announcements |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20, TypeScript (CommonJS) |
| Discord | Discord.js v14 |
| Automation | Playwright (Chromium) |
| Database | SQLite |
| API | Express v5, Zod, JWT |
| Real-time | Socket.io |
| Frontend | React 19, Vite, Tailwind CSS v4 |
| Scheduling | node-cron |
| Container | Docker (Playwright Ubuntu base) |

## Deployment

Production runs via Docker with GitHub Actions CI/CD. Push to `main` triggers build → push to GHCR → deploy.

```bash
# Production
docker-compose up -d --build

# Development with live reload
npm run dev         # Backend (tsx)
cd admin-ui && npm run dev  # Frontend (Vite)
```

## License

Proprietary. All rights reserved.
