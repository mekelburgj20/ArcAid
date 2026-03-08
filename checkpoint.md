# ArcAid Project Checkpoint

## Current State
**Date**: March 7, 2026
**Branch**: `main`
**Phase**: Phase 6 Complete. Ready for Phase 8 / New Features.

### What Has Been Built (The Foundation & Parity are Complete)
1. **Core Architecture**
   - Generic terminology engine (`TerminologyMode`: 'legacy' vs 'generic').
   - SQLite Database Schema with multi-tournament support and manual game tracking.
   - Generic cron-based Scheduler.
2. **iScored Integration**
   - Playwright-powered `IScoredClient` handles headless login, game creation, tagging, and score submission.
   - **Direct URL Navigation**: Scrapers optimized for speed and reliability, bypassing flaky UI menus.
3. **Logic Engines**
   - **Maintenance Loop**: Fully implemented `TournamentEngine.runMaintenance()`. Automatically locks games, declares winners, and rotates to the next queued game.
   - **Timeout Manager**: Tiered notifications (60m/30m) with actual Discord DMs and channel pings.
   - **Managed vs. Manual Protection**: Safety layer ensures bot only hides games it "owns," protecting personal games while still tracking their scores.
4. **Admin UI & Deployment**
   - **Frontend**: React/Vite dashboard (`admin-ui/`) for Settings, Logs, Tournaments, and Game Library imports.
   - **Deployment**: Fully dockerized via `docker-compose up -d --build`.
   - **Backups**: Automated state snapshots via `/create-backup`.
5. **Full Slash Command Suite**
   - **User**: `/list-active`, `/list-scores`, `/submit-score`, `/view-stats`, `/list-winners`, `/view-selection`, `/pick-game`, `/map-user`.
   - **Admin**: `/force-maintenance`, `/sync-state`, `/run-cleanup`, `/create-backup`, `/pause-pick`, `/nominate-picker`, `/setup`.

### What Needs to be Built Next (Phase 8: Future)
With 100% feature parity achieved from the old TableFlipper app, we are ready to move into ArcAid-exclusive features.

**Upcoming Priorities:**
1. **Internal Leaderboard (Phase 8):** Build a high-performance internal scoring engine to move away from iScored reliance.
2. **Real-time API:** Implement REST/WebSockets for live leaderboard data.
3. **Enhanced Admin UI:** Add more granular controls for historical data correction and user management.

### Important Context for New AI Sessions
- The project is fully Dockerized. Use `docker-compose up -d --build` to run everything.
- The Admin UI is accessible at `http://localhost:3001`.
- **iScored Automation:** The scrapers are fine-tuned for the current iScored layout. Use direct URL navigation (`settings.php`) where possible to avoid UI timing issues.
- **Manual Games:** ArcAid auto-discovers untracked games on iScored via `/sync-state` and adds them to the database without tournament constraints.
