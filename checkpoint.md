# ArcAid Project Checkpoint

## Current State
**Date**: March 5, 2026
**Branch**: `feature/arcaid-init`
**Phase**: Completed Phase 7 (Deployment). Phase 6 (Internal Leaderboard) was skipped for now.

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
5. **Reliability & Data (Phase 5)**
   - Automated DB + iScored State Backups (`BackupManager.ts`).
   - Standalone CLI restore script (`npm run restore`).
7. **Deployment (Phase 7)**
   - Multi-stage `Dockerfile` capturing the React UI and Node backend.
   - `docker-compose.yml` with persistent volume mounts.

### Skipped for Later
- **Phase 6: Internal Leaderboard** (We will return to this once the core iScored functionality is thoroughly tested).

### Important Context for New AI Sessions
- To run locally via Docker: `docker-compose up -d --build`. The UI will be available at `http://localhost:3001`.
- The bot and UI communicate over the Express API (`/api/*`).
