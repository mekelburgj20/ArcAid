# ArcAid

**ArcAid** is a modern tournament management system for virtual pinball and retro gaming communities. Discord bot + React Admin UI + Playwright-powered iScored automation.

> **Development Status:** Core overhaul complete (Sprints 1–7). All major features implemented and UAT-tested. See [OVERHAUL_PLAN.md](./OVERHAUL_PLAN.md) for the full plan and [TODO.md](./TODO.md) for remaining future work.

## Features

- **Multi-tournament engine** — Daily, Weekly, Monthly, or custom schedules with per-tournament timezones
- **Automated rotation** — Cron-scheduled maintenance: lock game → scrape winner → announce → activate next → assign picker
- **iScored integration** — Playwright-powered automation with retry logic, persistent sessions, screenshot-on-failure
- **Pick system** — Winner picks next game with tiered timeouts (winner → runner-up → auto-select)
- **Internal leaderboard** — Score storage, ranking, and caching (no iScored scraping for results)
- **Real-time updates** — WebSocket events for scores, rotations, and status changes
- **Admin UI** — Retro arcade-themed dashboard with tournament management, game library, logs, settings, history, backups
- **Public pages** — Scoreboard (OBS-embeddable), player profiles, game stats
- **Discord commands** — Full slash command suite for players and admins
- **Per-tournament mode** — Pinball (Tables & Grinds) or Video Game (Games & Tournaments) terminology per tournament
- **Platform rules** — Required/excluded platform filtering per tournament with master platform list
- **Docker deployment** — Production-ready with health checks, non-root user, Playwright

## Quick Start

### Docker (Recommended)
```bash
cp .env.example .env    # Fill in Discord credentials
docker-compose up -d --build
# Admin UI: http://localhost:3001
# First visit runs the Setup Wizard (password → Discord → iScored)
```

### Manual
```bash
cp .env.example .env    # Fill in Discord credentials
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

## Discord Bot Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications)
2. **Bot tab** — Enable Privileged Gateway Intents: Presence, Server Members, Message Content
3. **OAuth2 → URL Generator** — Select `bot` + `applications.commands` scopes with permissions:
   - View Channels, Send Messages, Create Public Threads, Send Messages in Threads
   - Embed Links, Attach Files, Read Message History, Use External Emojis, Add Reactions, Use Slash Commands
4. Invite the bot to your server using the generated URL
5. Copy Bot Token, Client ID, and Guild ID into your `.env` file

## Discord Commands

### Player Commands
| Command | Description |
|---------|-------------|
| `/list-active` | Show currently active tournament and manual games |
| `/list-scores` | Leaderboard for active games (supports `@user` filter and pagination) |
| `/submit-score` | Post your score and photo to iScored |
| `/view-stats` | Historical stats for any game (autocomplete, record holder mention) |
| `/my-stats` | Your personal stats card (wins, win%, average, best, recent) |
| `/list-winners` | Hall of fame for recent tournament winners |
| `/view-selection` | Check which game is queued for the next rotation |
| `/pick-game` | Nominated pickers select the next game (shows eligibility) |
| `/map-user` | Link your Discord ID to your iScored username |

### Admin Commands
| Command | Description |
|---------|-------------|
| `/force-maintenance` | Manually trigger a tournament rotation |
| `/sync-state` | Reconcile local DB with live iScored board |
| `/run-cleanup` | Hide old finished tournament games from iScored |
| `/create-backup` | Trigger a database backup |
| `/pause-pick` | Inject a specific game into the queue |
| `/nominate-picker` | Manually assign picker rights to a user |
| `/setup` | Configure channels, roles, pick windows via Discord |

## Admin UI Pages

- **Dashboard** — Live stats: active games, next rotations, recent winners, quick actions
- **Tournaments** — Create, edit, delete tournaments with friendly schedule builder
- **Game Library** — Search, filter by mode, add/edit games, CSV import, platform chips
- **Leaderboard** — Internal rankings with WebSocket live updates
- **Stats** — Player and game analytics
- **History** — Past tournament results, filterable
- **Backups** — List, create, and restore database backups
- **Logs** — Real-time streaming, level filters, search, color coding
- **Settings** — Categorized configuration with sensitive field masking, platform master list editor

### Public Pages (no auth)
- `/scoreboard` — Arcade high score display, auto-rotating, OBS-embeddable
- `/players` — Searchable player list
- `/players/:id` — Player profile with stat cards and recent scores
- `/games/:name` — Game stats, record holder, recent results

## Architecture

Two sub-applications in one process:

**Backend (`src/`)** — TypeScript (CommonJS), Express v5, SQLite, Discord.js v14, Playwright

| Component | Role |
|-----------|------|
| `TournamentEngine` | Core singleton: tournament/game CRUD + full maintenance loop |
| `IScoredClient` | Playwright browser automation with retry, persistent sessions |
| `Scheduler` | Cron-based maintenance with per-tournament timezones |
| `TimeoutManager` | Winner/runner-up pick window tracking with tiered fallbacks |
| `BackupManager` | DB backup/snapshot/restore logic |
| `IdentityManager` | Discord↔iScored user mapping via name matching |
| Service layer | `SettingsService`, `TournamentService`, `GameLibraryService`, `StatsService`, `LogService` |
| API | Express REST + WebSocket (Socket.io) + JWT auth |

**Admin UI (`admin-ui/`)** — React 19 + Vite + Tailwind CSS v4

- Retro arcade "neon command center" theme
- All API calls via `admin-ui/src/lib/api.ts` (relative paths, never hardcoded)
- Shared components: `NeonCard`, `NeonButton`, `DataTable`, `ScheduleBuilder`, `TournamentBadge`, `StatusBadge`, `ConfirmModal`, toast system

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20, TypeScript |
| Discord | Discord.js v14 |
| Web Scraping | Playwright (Chromium) |
| Database | SQLite (sqlite/sqlite3) |
| API | Express v5, Zod validation, JWT auth |
| Real-time | Socket.io WebSocket |
| Frontend | React 19, Vite, Tailwind CSS v4 |
| Scheduling | node-cron |
| Logging | rotating-file-stream (10MB, 5 files) |
| Auth | bcryptjs + jsonwebtoken |
| Container | Docker (Playwright Ubuntu base), docker-compose |

## Configuration

Settings can be configured via `.env` file, the Setup Wizard (first run), or the Admin UI Settings page. DB settings override `.env` values on startup.

| Setting | Default | Description |
|---------|---------|-------------|
| `DISCORD_BOT_TOKEN` | — | Discord bot token (required) |
| `DISCORD_CLIENT_ID` | — | Discord application client ID (required) |
| `DISCORD_GUILD_ID` | — | Discord server ID (required) |
| `ISCORED_USERNAME` | — | iScored.info login username |
| `ISCORED_PASSWORD` | — | iScored.info login password |
| `BOT_TIMEZONE` | `America/Chicago` | Default timezone (per-tournament override available) |
| `PLATFORMS` | `["AtGames","VPXS","VR","IRL"]` | Master platform list (JSON array, editable in Settings) |
| `GAME_ELIGIBILITY_DAYS` | `120` | Days before a game can be replayed |
| `WINNER_PICK_WINDOW_MIN` | `60` | Minutes for winner to pick next game |
| `RUNNERUP_PICK_WINDOW_MIN` | `30` | Minutes for runner-up fallback |
| `PORT` | `3001` | HTTP server port |

## Database

SQLite at `data/arcaid.db` (auto-created on first run, git-ignored).

Key tables: `tournaments`, `game_library`, `games` (QUEUED/ACTIVE/COMPLETED/HIDDEN), `submissions`, `scores`, `leaderboard_cache`, `user_mappings`, `settings`
