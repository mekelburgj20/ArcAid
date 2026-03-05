# ArcAid Project Checkpoint

## Current State
**Date**: March 4, 2026
**Branch**: `feature/arcaid-init`
**Phase**: Completed Phase 3 (Feature Porting: Logic). Ready for Phase 4 (Admin UI).

### Completed Features
1. **Foundation & Architecture (Phase 1)**
   - Generic "Games" and "Tournaments" terminology engine implemented.
   - SQLite Database Schema with multi-server (guild_id) and cadence support.
   - Generic cron-based Scheduler.
   - Core `TournamentEngine` structure with game rotation logic.

2. **iScored Integration (Phase 2)**
   - Playwright-powered `IScoredClient` implemented.
   - Supports robust login, game creation, DOM-based lineup repositioning, public score scraping, and style sync.

3. **Feature Porting: Logic (Phase 3)**
   - **Eligibility Logic**: 120-day game variety lookback implemented in `TournamentEngine.ts`.
   - **Runner-Up Fallback**: Tiered timeout logic implemented in `TimeoutManager.ts`.
   - **Identity Mapping**: Auto-mapping and `/map-user` command implemented (`IdentityManager.ts`).

### Next Steps (Phase 4: Admin UI & Configuration)
- Scaffold React (Vite) local dashboard.
- Implement First-Run Wizard.
- Build Settings UI for database-backed configuration.

### Important Context for New AI Sessions
- The app uses `TerminologyMode` ('legacy' vs 'generic') to dynamically adapt its language.
- Run `npm run dev` to start the bot.
- All secrets are excluded via `.gitignore`.
