# ArcAid Project TODO

## Phase 0: Setup & Configuration
- [x] **Beta Bot Setup**: Instructions for creating a separate Discord bot for ArcAid testing.
- [x] **Environment Template**: Create `.env.example` with iScored and Discord Beta configurations.
- [x] **Feature Branching**: Ensure all work continues on `feature/` branches.

## Phase 1: Foundation & Architecture
- [x] **Generic Engine Core**: Implement internal logic using generic `Games` and `Tournaments` terminology.
- [x] **Terminology Toggle**: Add configuration for "Pinball Legacy" mode (Games->Tables, Tournaments->Grinds).
- [x] **Database Schema**: Scaffold fresh SQLite schema in `data/arcaid.db` for generic tournaments and games.
- [x] **Multi-Server Support**: Migrate guild-specific configuration from `.env` to database-backed settings.

## Phase 2: iScored Integration (Primary Focus)
- [x] **Port iScored Automation**: Migrate the Playwright-based login, creation, and repositioning logic from TableFlipper.
- [x] **Terminology Mapping**: Ensure the integration respects the "Pinball Legacy" vs "Generic" toggle.
- [x] **Score Submission**: Port the photo-upload and score posting logic.
- [x] **Leaderboard Sync**: Port the scraping and style-syncing capabilities.

## Phase 3: Feature Porting (Logic)
- [x] **Eligibility Logic**: Port 120-day game variety lookback.
- [x] **Runner-Up Fallback**: Port the 1-hour/30-minute tiered timeout system (Logic stubbed, missing Discord DMs).
- [x] **Identity Mapping**: Port Discord-to-Leaderboard user mapping.

## Phase 4: Admin UI & Configuration
- [x] **Admin Dashboard**: Scaffold React (Vite) local dashboard.
- [x] **First-Run Wizard**: Guided setup for initial configuration.
- [x] **Settings UI**: Database-backed configuration management.
- [x] **Log Viewer**: Integrated UI for monitoring activity.
- [x] **Tournament Management**: UI for creating/editing custom tournament types and cadences.
- [x] **Game Library**: UI for bulk importing/adding the master list of available games.

## Phase 5: Reliability & Data
- [x] **Cadence Backups**: Automated snapshots of tournament and database state.
- [x] **Standalone Restore**: Decoupled script for leaderboard restoration.

## Phase 6: Feature Parity Completion (TableFlipper -> ArcAid)
*The core infrastructure is built, but the following TableFlipper features must be ported to reach 100% parity.*
- [x] **Maintenance Execution**: Fill out the stub in `TournamentEngine.ts` to actually lock games, scrape winners, ping Discord, and activate next games.
- [x] **Timeout Communications**: Update `TimeoutManager.ts` to send actual Discord DMs and channel warnings instead of just logging.
- [x] **Callouts/Personality**: Port the `callouts.json` message listener for easter eggs.
- [x] **User Commands**:
  - [x] `/list-active`: Show currently active games.
  - [x] `/list-scores`: Display the leaderboard for a game.
  - [x] `/view-stats`: Show historical stats (play count, win rate, etc.).
  - [x] `/list-winners`: Display recent tournament winners.
  - [x] `/view-selection`: Show the current queued game.
- [x] **Admin Commands**:
  - [x] `/force-maintenance`: Manually trigger a rotation.
  - [x] `/sync-state`: Manually trigger iScored reconciliation.
  - [x] `/run-cleanup`: Sweep iScored lineup to hide old games.
  - [x] `/create-backup`: Trigger `BackupManager` via Discord.
  - [x] `/pause-pick` (Manual Override): Inject a specific game into the lineup.
  - [x] `/nominate-picker`: Manually assign picker rights.
- [x] **Manual Game Support**:
  - [x] **Ownership-Aware Cleanup**: Ensure `/run-cleanup` only hides games ArcAid explicitly manages.
  - [x] **Discovery Mode**: Auto-discover and track non-tournament games on iScored.
  - [x] **Score Sync**: Automatically pull scores for manual games into the local database history.

## Phase 7: Deployment
- [x] **Dockerization**: Provide `Dockerfile` and `docker-compose.yml`.
- [x] **Cross-Platform Support**: Ensure Windows, Linux, and Mac compatibility.

## Phase 8: Internal Leaderboard (Future)
- [ ] **Lightweight Leaderboard**: Internal, high-performance scoreboard engine.
- [ ] **Real-time API**: REST/WebSockets for leaderboard data.

