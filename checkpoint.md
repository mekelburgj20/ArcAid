# ArcAid Project Checkpoint

## Current State
**Date**: March 4, 2026
**Branch**: `feature/arcaid-init`
**Phase**: Completed Phase 4 (Admin UI). Ready for Phase 5 (Reliability & Data).

### Completed Features
1. **Foundation & Architecture (Phase 1)**
   - Generic terminology engine and SQLite DB schema.
2. **iScored Integration (Phase 2)**
   - Playwright-powered API for login, creation, scraping, and repositioning.
3. **Feature Porting: Logic (Phase 3)**
   - Eligibility lookbacks, tiered timeouts, and identity mapping.
4. **Admin UI & Configuration (Phase 4)**
   - **Backend**: Express API server running alongside the bot (`src/api/server.ts`).
   - **Frontend**: React/Vite dashboard (`admin-ui/`).
   - Features a Setup Wizard for first-time users, a Settings editor, and a live Log Viewer.

### Next Steps (Phase 5: Reliability & Data)
- Implement Automated database/state backups.
- Create standalone script for leaderboard restoration.

### Important Context for New AI Sessions
- To run the app: Start the bot (`npm run dev` in root) AND start the UI (`npm run dev` in `admin-ui/`).
- The bot and UI communicate over `http://localhost:3001/api/`.
