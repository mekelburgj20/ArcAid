# ArcAid Project Checkpoint

## Current State
**Date**: March 5, 2026
**Branch**: `main`
**Phase**: Ready for Phase 6 (Feature Parity Completion).

### What Has Been Built (The Foundation is Complete)
1. **Core Architecture (Phase 1)**
   - Generic terminology engine (`TerminologyMode`: 'legacy' vs 'generic').
   - SQLite Database Schema with multi-server support and dynamic Tournament/Game Library tables.
   - Generic cron-based Scheduler.
2. **iScored Integration (Phase 2)**
   - Playwright-powered `IScoredClient` handles headless login, game creation, tagging, and score submission.
3. **Logic Engines (Phase 3)**
   - 120-day eligibility lookbacks (`TournamentEngine.ts`).
   - Tiered timeouts (`TimeoutManager.ts` - *Note: Discord DMs are currently stubbed*).
   - Identity auto-mapping.
4. **Admin UI & Deployment (Phase 4, 5, 7)**
   - **Frontend**: React/Vite dashboard (`admin-ui/`) for Settings, Logs, Tournaments, and Game Library imports.
   - **Backend**: Express API serving the UI and handling bot configuration.
   - **Deployment**: Fully dockerized via `docker-compose up -d --build`.
   - **Backups**: Automated state snapshots and a standalone `npm run restore` CLI tool.
5. **Initial Commands**
   - `/ping`, `/setup`, `/map-user`, `/pick-game`, `/submit-score`.

### What Needs to be Built Next (Phase 6: Parity)
The underlying engine is incredibly robust, but we lack the front-facing commands and the final execution loop to match the old TableFlipper app.

**Immediate Priorities for the Next Session:**
1. **Maintenance Execution:** Implement the actual logic inside `TournamentEngine.runMaintenance()`. It currently just logs a message. It needs to lock the active game on iScored, scrape the winner, declare the winner in Discord, and promote the queued game.
2. **Discord Communication:** Wire up `TimeoutManager.ts` to actually send DMs and channel warnings using the `DiscordClient`.
3. **User Commands:** Implement `/list-active`, `/list-scores`, `/view-stats`, `/list-winners`, `/view-selection`.
4. **Admin Commands:** Implement `/force-maintenance`, `/sync-state`, `/run-cleanup`, `/create-backup`, `/pause-pick`, `/nominate-picker`.

### Important Context for New AI Sessions
- The project is fully Dockerized. Use `docker-compose up -d --build` to run everything.
- The Admin UI is accessible at `http://localhost:3001`.
- **CRITICAL:** Do NOT attempt to run Playwright without the Docker container, as the dependencies are strictly bound to the `mcr.microsoft.com/playwright:v1.58.2-jammy` image.
- Review `TODO.md` for the exact checklist of missing parity features.
