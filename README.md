# ArcAid

**ArcAid** is a modern tournament management system for virtual pinball and retro gaming communities. Discord bot + React Admin UI + Playwright-powered iScored automation.

> **Development Status:** Core overhaul complete (Sprints 1–8). All major features implemented and UAT-tested. See [OVERHAUL_PLAN.md](./OVERHAUL_PLAN.md) for the full plan and [TODO.md](./TODO.md) for remaining future work.

## Features

- **Multi-tournament engine** — Daily, Weekly, Monthly, or custom schedules with per-tournament timezones
- **Automated rotation** — Cron-scheduled maintenance: lock game → scrape winner → announce → activate next → assign picker
- **iScored integration** — Playwright-powered automation with retry logic, persistent sessions, screenshot-on-failure
- **Pick system** — Winner picks next game with tiered timeouts (winner → runner-up → auto-select)
- **Internal leaderboard** — Score storage, ranking, and caching with case-insensitive player identity
- **Real-time updates** — WebSocket events for scores, rotations, and status changes
- **Admin UI** — Retro arcade-themed dashboard with tournament management, game library, logs, settings, history, backups (mobile-responsive)
- **Public player portal** — Slug-based routing (`/:slug/*`), card-grid scoreboard, shared nav bar with game room branding, mobile-friendly
- **Game ratings** — 5-star per-user rating system with community averages
- **VPS auto-import** — Bulk import games from Virtual Pinball Spreadsheet API
- **Admin game control** — Activate/deactivate games on-demand via admin UI or Discord
- **Discord commands** — Full slash command suite for players and admins
- **Per-tournament mode** — Pinball (Tables & Grinds) or Video Game (Games & Tournaments) terminology per tournament
- **Platform rules** — Required/excluded platform filtering per tournament with master platform list
- **Per-tournament cleanup** — Configurable cleanup of completed games from iScored (immediate, retain count, or scheduled cron)
- **Score sync** — Bidirectional score reconciliation between iScored and local DB with stale-record cleanup
- **Player merge/rename** — Admin tool to fix typos or merge alternate usernames across all records
- **Scheduler hot-reload** — Schedule changes take effect without restart
- **Callouts easter egg** — Configurable trigger-word responses (toggleable in Settings)
- **Auto user mapping** — First-time submitters auto-mapped by Discord display name
- **Discord OAuth login** — Mods with the configured admin role can log into the Admin UI via Discord (alongside password auth)
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
6. **For Discord OAuth admin login:** Copy the **Client Secret** from the OAuth2 page into `DISCORD_CLIENT_SECRET`. Add redirect URIs (e.g., `http://localhost:3001/auth/discord/callback`, your production URL). Set the admin role via `/setup admin-role` in Discord.

## Discord Commands

### Player Commands
| Command | Description |
|---------|-------------|
| `/list-active` | Show currently active tournament and manual games |
| `/list-scores` | Leaderboard for active games (supports `@user` filter and pagination) |
| `/submit-score` | Post your score and photo to iScored (auto-maps username on first use) |
| `/view-stats` | Historical stats for any game (autocomplete, record holder mention) |
| `/my-stats` | Your personal stats card (wins, win%, average, best, recent) |
| `/list-winners` | Hall of fame for recent tournament winners |
| `/view-selection` | Check which game is queued for the next rotation |
| `/pick-game` | Nominated pickers select the next game (shows eligibility) |
| `/map-user` | Link your Discord ID to your iScored username (overwrites previous mapping) |

### Admin Commands
| Command | Description |
|---------|-------------|
| `/force-maintenance` | Manually trigger a tournament rotation |
| `/activate-game` | Immediately activate a game for a tournament |
| `/deactivate-game` | Deactivate an active game (optionally lock on iScored) |
| `/sync-state` | Reconcile local DB with live iScored board (syncs scores, removes stale records) |
| `/run-cleanup` | Delete completed and orphan games from iScored |
| `/create-backup` | Trigger a database backup |
| `/pause-pick` | Inject a specific game into the queue |
| `/nominate-picker` | Manually assign picker rights to a user |
| `/reorder-lineup` | Reorder queued games in a tournament's lineup |
| `/setup` | Configure channels, roles, pick windows via Discord |

## Admin UI Pages

- **Dashboard** — Live stats: active games, next rotations, recent winners, quick actions
- **Tournaments** — Create, edit, delete tournaments with friendly schedule builder and cleanup rule config
- **Game Library** — Search, filter by mode/platform, add/edit games, CSV import, VPS import, star ratings, per-game background image
- **Leaderboard** — Internal rankings with WebSocket live updates
- **Stats** — Player and game analytics
- **History** — Past tournament results, filterable
- **Backups** — List, create, and restore database backups
- **Logs** — Real-time streaming, level filters, search, color coding
- **Settings** — Categorized configuration with sensitive field masking, platform master list editor, feature toggles (callouts), scheduler reload, player merge/rename tool

### Public Pages (no auth, under `/:slug/`)
- `/:slug` — Card-grid scoreboard showing all active games with top 5 scores, background images, and "Full Leaderboard" links
- `/:slug/players` — Searchable player list with games played, best/avg scores
- `/:slug/players/:username` — Player profile with stat cards and recent scores
- `/:slug/games/:name` — Full leaderboard, game stats, star ratings, record holder, past results

## Architecture

Two sub-applications in one process:

**Backend (`src/`)** — TypeScript (CommonJS), Express v5, SQLite, Discord.js v14, Playwright

| Component | Role |
|-----------|------|
| `TournamentEngine` | Core singleton: tournament/game CRUD + full maintenance loop + cleanup |
| `IScoredClient` | Playwright browser automation with retry, persistent sessions, game deletion |
| `Scheduler` | Cron-based maintenance with per-tournament timezones, hot-reload support |
| `TimeoutManager` | Winner/runner-up pick window tracking with tiered fallbacks |
| `BackupManager` | DB backup/snapshot/restore logic |
| `IdentityManager` | Discord↔iScored user mapping via name matching |
| Service layer | `SettingsService`, `TournamentService`, `GameLibraryService`, `LeaderboardService`, `StatsService`, `VpsImportService`, `RatingService`, `LogService`, `DashboardService`, `BackupService` |
| API | Express REST + WebSocket (Socket.io) + JWT auth + Zod validation |

**Admin UI (`admin-ui/`)** — React 19 + Vite + Tailwind CSS v4

- Retro arcade "neon command center" theme
- All API calls via `admin-ui/src/lib/api.ts` (relative paths, never hardcoded)
- Shared components: `NeonCard`, `NeonButton`, `DataTable`, `StarRating`, `PublicLayout`, `ScheduleBuilder`, `TournamentBadge`, `StatusBadge`, `ConfirmModal`, toast system
- Mobile-responsive: hamburger sidebar on small screens, responsive grids and cards

## Score System

The `submissions` table is the single source of truth for all scores. Scores enter the system through two paths:

1. **Discord `/submit-score`** — Player submits score + photo, which goes to iScored and is recorded locally with a sync-compatible ID (`gameId-username`)
2. **`/sync-state` command** — Scrapes iScored public leaderboard and upserts into submissions with the same ID format

This ensures Discord submissions and iScored syncs converge on the same record (no duplicates). The sync also:
- Uses **case-insensitive IDs** (normalized to lowercase) to prevent case-variant duplicates
- **Removes stale records** — local synced submissions not found on iScored are deleted (handles score removals and username changes)
- **Resolves Discord user IDs** via `user_mappings` when available

**Leaderboards** group by `LOWER(iscored_username)` and prefer real Discord user IDs over placeholders.

**Player merge/rename** (`POST /api/admin/merge-player`) updates `iscored_username` across submissions, scores, and user_mappings, and also renames sync-format submission IDs so they aren't treated as stale on next sync.

## Cleanup System

Each tournament has a configurable `cleanup_rule` that determines when completed games are deleted from iScored:

| Mode | Behavior |
|------|----------|
| `immediate` | Delete from iScored as soon as the game completes |
| `retain` (count) | Keep the N most recent completed games; delete older ones |
| `scheduled` (cron) | Run cleanup on a cron schedule (e.g., Wednesday 10pm) |

The `/run-cleanup` admin command also handles orphan games (ACTIVE with no tournament association).

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

Settings can be configured via `.env` file, the Setup Wizard (first run), or the Admin UI Settings page. DB settings override `.env` values on startup and are synced to `process.env` immediately when saved.

| Setting | Default | Description |
|---------|---------|-------------|
| `DISCORD_BOT_TOKEN` | — | Discord bot token (required) |
| `DISCORD_CLIENT_ID` | — | Discord application client ID (required) |
| `DISCORD_CLIENT_SECRET` | — | Discord OAuth2 client secret (for mod login via Discord) |
| `DISCORD_GUILD_ID` | — | Discord server ID (required) |
| `DISCORD_ADMIN_ROLE_ID` | — | Discord role ID granting admin UI access (set via `/setup admin-role`) |
| `ISCORED_USERNAME` | — | iScored.info login username |
| `ISCORED_PASSWORD` | — | iScored.info login password |
| `ISCORED_PUBLIC_URL` | — | iScored public leaderboard URL (for score sync) |
| `GAME_ROOM_NAME` | — | Display name for the public game room portal |
| `GAME_ROOM_SLUG` | — | URL slug for public pages (case-insensitive matching) |
| `BOT_TIMEZONE` | `America/Chicago` | Default timezone (per-tournament override available) |
| `PLATFORMS` | `["AtGames","VPXS","VR","IRL"]` | Master platform list (JSON array, editable in Settings) |
| `GAME_ELIGIBILITY_DAYS` | `120` | Days before a game can be replayed |
| `WINNER_PICK_WINDOW_MIN` | `60` | Minutes for winner to pick next game |
| `RUNNERUP_PICK_WINDOW_MIN` | `30` | Minutes for runner-up fallback |
| `ENABLE_CALLOUTS` | `false` | Enable trigger-word easter egg responses (reads `data/callouts.json`) |
| `PORT` | `3001` | HTTP server port |
| `LOG_LEVEL` | `info` | Logging level |

## Database

SQLite at `data/arcaid.db` (auto-created on first run, git-ignored).

Key tables: `tournaments`, `game_library`, `games` (QUEUED/ACTIVE/COMPLETED/HIDDEN), `submissions`, `leaderboard_cache`, `user_mappings`, `settings`, `game_ratings`

The `scores` table exists for legacy data but is no longer written to. The `submissions` table is the single source of truth for all score data.
