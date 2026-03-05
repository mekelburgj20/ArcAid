# ArcAid Project TODO

## Phase 0: Setup & Configuration
- [x] **Beta Bot Setup**: Instructions for creating a separate Discord bot for ArcAid testing.
- [x] **Environment Template**: Create `.env.example` with iScored and Discord Beta configurations.
- [ ] **Feature Branching**: Ensure all work continues on `feature/` branches.

## Phase 1: Foundation & Architecture
- [ ] **Generic Engine Core**: Implement internal logic using generic `Games` and `Tournaments` terminology.
- [x] **Terminology Toggle**: Add configuration for "Pinball Legacy" mode (Games->Tables, Tournaments->Grinds).
- [x] **Database Schema**: Scaffold fresh SQLite schema in `data/arcaid.db` for generic tournaments and games.
- [ ] **Multi-Server Support**: Migrate guild-specific configuration from `.env` to database-backed settings.

## Phase 2: iScored Integration (Primary Focus)
- [ ] **Port iScored Automation**: Migrate the Playwright-based login, creation, and repositioning logic from TableFlipper.
- [ ] **Terminology Mapping**: Ensure the integration respects the "Pinball Legacy" vs "Generic" toggle.
- [ ] **Score Submission**: Port the photo-upload and score posting logic.
- [ ] **Leaderboard Sync**: Port the scraping and style-syncing capabilities.

## Phase 3: Feature Porting (Logic)
- [ ] **Eligibility Logic**: Port 120-day game variety lookback.
- [ ] **Runner-Up Fallback**: Port the 1-hour/30-minute tiered timeout system.
- [ ] **Identity Mapping**: Port Discord-to-Leaderboard user mapping.

## Phase 4: Admin UI & Configuration
- [ ] **Admin Dashboard**: Scaffold React (Vite) local dashboard.
- [ ] **First-Run Wizard**: Guided setup for initial configuration.
- [ ] **Settings UI**: Database-backed configuration management.
- [ ] **Log Viewer**: Integrated UI for monitoring activity.

## Phase 5: Reliability & Data
- [ ] **Cadence Backups**: Automated snapshots of tournament and database state.
- [ ] **Standalone Restore**: Decoupled script for leaderboard restoration.

## Phase 6: Internal Leaderboard (Future)
- [ ] **Lightweight Leaderboard**: Internal, high-performance scoreboard engine.
- [ ] **Real-time API**: REST/WebSockets for leaderboard data.

## Phase 7: Deployment
- [ ] **Dockerization**: Provide `Dockerfile` and `docker-compose.yml`.
- [ ] **Cross-Platform Support**: Ensure Windows, Linux, and Mac compatibility.
