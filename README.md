# ArcAid

**ArcAid** is a multi-tenant tournament management platform for virtual pinball and retro gaming communities. Host multiple game rooms on a single instance, each with independent tournaments, admins, settings, and iScored accounts. Discord bot + React Admin UI + Playwright-powered iScored automation.

## Features

### Multi-Room Architecture
- **Multi-tenant** — Host multiple game rooms on one server, each with its own tournaments, leaderboards, settings, and iScored credentials
- **Three-tier auth** — Super-admin (server-wide), room admins (local username/password or Discord OAuth), scoped to specific rooms
- **Public landing page** — Game room directory at `/` with links to each room's public scoreboard
- **Per-room settings** — Timezone, pick windows, platforms, iScored credentials, theme — all independently configurable per room
- **Global game library** — Master catalog with per-room curation (rooms select a subset)

### Tournament Engine
- **Multi-tournament engine** — Daily, Weekly, Monthly, or custom schedules with per-tournament timezones
- **Automated rotation** — Cron-scheduled maintenance: lock game → scrape winner → announce → activate next → assign picker
- **iScored integration** — Playwright-powered automation with retry logic, persistent sessions, screenshot-on-failure
- **Pick system** — Winner picks next game with tiered timeouts (winner → runner-up → auto-select)
- **Per-tournament mode** — Pinball (Tables & Grinds) or Video Game (Games & Tournaments) terminology
- **Platform rules** — Required/excluded platform filtering per tournament with master platform list
- **Per-tournament cleanup** — Configurable cleanup of completed games from iScored (immediate, retain count, or scheduled cron)

### Scoring & Rankings
- **Internal leaderboard** — Score storage, ranking, and caching with case-insensitive player identity
- **Real-time updates** — WebSocket events for scores, rotations, and status changes
- **Cross-tournament rankings** — Ranking groups with 4 methods (Max 10, Average Rank, Best Game PAPA/Linear)
- **Score sync** — Bidirectional score reconciliation between iScored and local DB with stale-record cleanup
- **Game ratings** — 5-star per-user rating system with community averages

### Admin & Operations
- **Super-admin panel** — Server-wide dashboard, game room CRUD, master library, backups, logs, global settings
- **Room admin panel** — Per-room dashboard, tournaments, library, leaderboard, rankings, stats, history, settings
- **Admin UI** — Retro arcade-themed with 3 theme options (Arcade/Dark/Light), mobile-responsive
- **Discord commands** — Full slash command suite for players and admins
- **VPS auto-import** — Bulk import games from Virtual Pinball Spreadsheet API
- **Player merge/rename** — Admin tool to fix typos or merge alternate usernames across all records
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

## URL Structure

```
/                              → Public landing (game room directory)
/login                         → Super-admin login
/admin/*                       → Super-admin panel
  /admin/dashboard             → All-rooms overview
  /admin/rooms                 → Game room CRUD
  /admin/library               → Master game library
  /admin/backups               → DB backup/restore
  /admin/logs                  → Server logs
  /admin/settings              → Global settings + super-admin management

/:slug/                        → Public scoreboard
/:slug/players                 → Public player list
/:slug/players/:id             → Public player detail
/:slug/games/:name             → Public game detail
/:slug/login                   → Room admin login
/:slug/admin/*                 → Room admin panel
  /:slug/admin/dashboard       → Room dashboard
  /:slug/admin/tournaments     → Tournament CRUD
  /:slug/admin/library         → Room game library
  /:slug/admin/leaderboard     → Leaderboard with expandable scores
  /:slug/admin/rankings        → Ranking groups
  /:slug/admin/stats           → Player/game analytics
  /:slug/admin/history         → Game history
  /:slug/admin/settings        → Room settings
```

## Discord Bot Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications)
2. **Bot tab** — Enable Privileged Gateway Intents: Presence, Server Members, Message Content
3. **OAuth2 → URL Generator** — Select `bot` + `applications.commands` scopes with permissions:
   - View Channels, Send Messages, Create Public Threads, Send Messages in Threads
   - Embed Links, Attach Files, Read Message History, Use External Emojis, Add Reactions, Use Slash Commands
4. Invite the bot to your server using the generated URL
5. Copy Bot Token, Client ID, and Guild ID into your `.env` file
6. **For Discord OAuth admin login:** Copy the **Client Secret** from the OAuth2 page into `DISCORD_CLIENT_SECRET`. Add redirect URIs (e.g., `http://localhost:3001/auth/discord/callback`, your production URL).

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
| `/map-user` | Link your Discord ID to your iScored username |

### Admin Commands
| Command | Description |
|---------|-------------|
| `/force-maintenance` | Manually trigger a tournament rotation |
| `/activate-game` | Immediately activate a game for a tournament |
| `/deactivate-game` | Deactivate an active game (optionally lock on iScored) |
| `/sync-state` | Reconcile local DB with live iScored board |
| `/run-cleanup` | Delete completed and orphan games from iScored |
| `/create-backup` | Trigger a database backup |
| `/pause-pick` | Inject a specific game into the queue |
| `/nominate-picker` | Manually assign picker rights to a user |
| `/reorder-lineup` | Reorder queued games in a tournament's lineup |
| `/setup` | Configure channels, roles, pick windows via Discord |

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
| API routes | `src/api/routes/` — auth, rooms (room-scoped), admin (super-admin), global |
| Services | `SettingsService`, `TournamentService`, `GameLibraryService`, `LeaderboardService`, `StatsService`, `GameRoomService`, `GameRoomSettingsService`, `AdminService`, `RankingService`, `DashboardService`, `BackupService`, `VpsImportService`, `RatingService`, `PreferencesService`, `LogService` |
| API | Express REST + WebSocket (Socket.io) + JWT auth + Zod validation |

**Admin UI (`admin-ui/`)** — React 19 + Vite + Tailwind CSS v4

- Multi-layout: `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`)
- `RoomContext` provides `roomId`, `roomSlug`, `roomName` to all room-scoped pages
- Retro arcade "neon command center" theme with 3 options (Arcade/Dark/Light)
- All API calls via `admin-ui/src/lib/api.ts` (relative paths, never hardcoded)
- Shared components: `NeonCard`, `NeonButton`, `DataTable`, `StarRating`, `ScheduleBuilder`, `TournamentBadge`, `StatusBadge`, `ConfirmModal`, toast system
- Mobile-responsive: hamburger sidebar on small screens, responsive grids and cards

## Auth System

Three authentication methods:

| Method | Scope | How |
|--------|-------|-----|
| Super-admin password | Server-wide | First login sets password; JWT with `role: 'super_admin'` |
| Room local admin | Per-room | Username/password accounts created by super-admin; JWT with `role: 'room_admin'` and scoped `gameRoomIds` |
| Discord OAuth | Either | Checks `super_admins` table first, then `game_room_admins`; role determined by table membership |

JWT payload: `{ role, gameRoomIds, discordId?, localAdminId?, username?, avatar? }`

## Score System

The `submissions` table is the single source of truth for all scores. Scores enter the system through two paths:

1. **Discord `/submit-score`** — Player submits score + photo, which goes to iScored and is recorded locally with a sync-compatible ID (`gameId-username`)
2. **`/sync-state` command** — Scrapes iScored public leaderboard and upserts into submissions with the same ID format

This ensures Discord submissions and iScored syncs converge on the same record (no duplicates). Leaderboards group by `LOWER(iscored_username)` and prefer real Discord user IDs over placeholders.

## Database

SQLite at `data/arcaid.db` (auto-created on first run, git-ignored). Idempotent migrations run on startup.

**Multi-room tables:** `game_rooms`, `game_room_settings`, `local_admins`, `game_room_admins`, `super_admins`, `game_room_game_library`

**Core tables:** `tournaments` (with `game_room_id`), `game_library`, `games`, `submissions`, `leaderboard_cache`, `user_mappings`, `settings`, `game_ratings`, `ranking_groups` (with `game_room_id`), `ranking_group_tournaments`, `ranking_groups_cache`, `user_preferences`

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

### Global Settings (super-admin)
| Setting | Default | Description |
|---------|---------|-------------|
| `DISCORD_BOT_TOKEN` | — | Discord bot token (required) |
| `DISCORD_CLIENT_ID` | — | Discord application client ID (required) |
| `DISCORD_CLIENT_SECRET` | — | Discord OAuth2 client secret |
| `PORT` | `3001` | HTTP server port |
| `BACKUP_RETENTION_DAYS` | `30` | Days to keep backups |

### Per-Room Settings (room admin)
| Setting | Default | Description |
|---------|---------|-------------|
| `ISCORED_USERNAME` | — | iScored.info login username |
| `ISCORED_PASSWORD` | — | iScored.info login password |
| `ISCORED_PUBLIC_URL` | — | iScored public leaderboard URL |
| `DISCORD_GUILD_ID` | — | Discord server ID for this room |
| `DISCORD_ANNOUNCEMENT_CHANNEL_ID` | — | Channel for rotation announcements |
| `DISCORD_ADMIN_ROLE_ID` | — | Discord role granting room admin access |
| `BOT_TIMEZONE` | `America/Chicago` | Room timezone |
| `PLATFORMS` | `["AtGames","VPXS","VR","IRL"]` | Platform list for this room |
| `GAME_ELIGIBILITY_DAYS` | `120` | Days before a game can be replayed |
| `WINNER_PICK_WINDOW_MIN` | `60` | Minutes for winner to pick next game |
| `RUNNERUP_PICK_WINDOW_MIN` | `30` | Minutes for runner-up fallback |
| `UI_THEME` | `arcade` | Theme for this room's public pages |
