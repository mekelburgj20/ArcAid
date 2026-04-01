# ArcAid

**ArcAid** is a multi-tenant tournament management platform for virtual pinball and retro gaming communities. Host multiple game rooms on a single instance, each with independent tournaments, admins, settings, and iScored integration. Discord bot + React Admin UI + automated score tracking.

**Production:** [arcaid.app](https://arcaid.app)

## Features

- **Multi-tenant game rooms** — Each room has its own tournaments, leaderboards, admins, settings, and iScored account
- **Automated tournament rotation** — Daily, Weekly, Monthly (including last-day-of-month), or custom cron schedules
- **iScored integration** — REST API for score sync (preferred) with Playwright fallback for game management. Continuous background polling keeps leaderboards in sync across all submission methods (web, iScored, Discord)
- **Pick system** — Winner picks the next game with tiered timeouts (winner → runner-up → auto-select). Web-based game picking for Discord-authenticated players with queue management (reorder, delete, max 5 per tournament)
- **Discord player login** — Public page visitors can log in via Discord to pick/queue games directly from the Game Availability page
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
- **Compact card header** — Alternative card layout with small thumbnail + title bar instead of full-width banner
- **Wheel icon card header** — Pinball wheel PNGs displayed above the card border with configurable scale (100-200%)
- **Score toast notifications** — Real-time WebSocket-powered slide-down notifications when players submit scores
- **"Your Best" quick stat** — Logged-in users see their best score and rank on each game card footer
- **Platform in-use validation** — Prevents deleting platforms that are referenced by active tournaments
- **Locked game protection** — Score submissions blocked for completed/locked games (backend 403 + frontend lock UI)
- **11 UI themes** — Arcade, Dark, Light, Backglass, CRT Green, Plasma, Cabinet, Silverball, Wizard, Playfield, Marquee — admin theme per-user, public theme per-room
- **Public pages** — Scoreboard, player profiles, game details, and game availability — no login required
- **Mobile-responsive** — Full functionality on phones and tablets

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
| `/:slug/games` | Game availability (cooldowns, random picker, pick/queue games if Discord-logged-in) |
| `/:slug/submit/:gameId` | Standalone score submission (QR code target) |
| `/:slug/stats` | Public enhanced stats (avg finish, top 5%, champion streak) |
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

### Global Settings (Super-Admin)
| Setting | Description |
|---------|-------------|
| Discord Bot Token | Bot authentication token from Discord Developer Portal |
| Discord Client ID | OAuth2 application client ID |
| Discord Client Secret | OAuth2 client secret (for admin Discord login) |
| JWT Secret | Secret for signing auth tokens |
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
| Scoreboard Branding | Custom background image, logo, and title style/size for public scoreboard |
| Kiosk Refresh Interval | Auto-refresh interval (seconds) for kiosk display |
| Hide Empty Games | Toggle to suppress games with no scores from public views |
| Discord @Mentions | Toggle Discord role/user @mentions in tournament announcements |
| Card Header Style | Banner (full-width artwork), Compact (thumbnail + title bar), or Wheel (pinball wheel icon above card) |
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
