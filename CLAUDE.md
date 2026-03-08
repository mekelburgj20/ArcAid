# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this ArcAid repository.

## Session Start Checklist

1. Read `SPRINT_STATUS.md` for current sprint, task statuses, and last session notes
2. Read `TODO.md` for remaining tasks with checkboxes
3. Verify git branch matches the current sprint (`git branch --show-current`)
4. Run `npm run build` to confirm the codebase compiles cleanly

## Project Summary

ArcAid is a tournament management system for virtual pinball and retro gaming communities. Discord bot + React Admin UI + Playwright-powered iScored automation.

**Stack:** TypeScript (CommonJS, NodeNext), Node.js 20, Discord.js v14, Playwright, SQLite, Express v5, React 19 + Vite

## Key Commands

```bash
npm run build          # Compile TypeScript → dist/
npm run dev            # Run via tsx (no pre-build needed)
npm start              # Run compiled dist/index.js
npm run restore        # CLI restore tool

# Docker (production)
docker-compose up -d --build   # Admin UI on http://localhost:3001

# Admin UI (inside admin-ui/)
cd admin-ui && npm run dev     # Vite dev server
cd admin-ui && npm run build   # Build production assets
cd admin-ui && npm run lint    # ESLint
```

## Architecture at a Glance

Two sub-applications in one process:

**Backend (`src/`):**
- `src/index.ts` — Bootstrap (DB → settings → API → Discord)
- `src/engine/TournamentEngine.ts` — Core singleton: tournament CRUD + `runMaintenance()` (lock → scrape winner → complete → activate next → assign picker → announce)
- `src/engine/IScoredClient.ts` — Playwright browser automation for iScored.info
- `src/engine/Scheduler.ts` — Cron-based maintenance scheduling (reads `BOT_TIMEZONE` from settings)
- `src/engine/TimeoutManager.ts` — Winner/runner-up pick window tracking
- `src/api/server.ts` — Express REST API (JWT auth via `src/api/auth.ts` + `src/api/middleware.ts`, Zod validation via `src/api/schemas.ts`)
- `src/utils/discord.ts` — Shared `sendChannelMessage()` for engine classes
- `src/utils/terminology.ts` — `getTerminology()` — "legacy" (Table/Grind) vs "generic" (Game/Tournament)

**Admin UI (`admin-ui/src/`):**
- All API calls through `admin-ui/src/lib/api.ts` (relative `/api/` paths — NEVER hardcode localhost)
- Pages: Dashboard, Tournaments, GameLibrary, Logs, Settings, SetupWizard

## Key Patterns

- Engine classes are **singletons** (`getInstance()`)
- `getTerminology()` used in all user-facing text
- DB `settings` table = runtime config (overrides `.env` on startup)
- iScored games identified by tags: `DG`, `WG-VPXS`, `WG-VR`, `MG`
- Configurable values from settings: `GAME_ELIGIBILITY_DAYS` (120), `WINNER_PICK_WINDOW_MIN` (60), `RUNNERUP_PICK_WINDOW_MIN` (30), `BOT_TIMEZONE` (America/Chicago)
- API write endpoints require JWT Bearer token (first login sets admin password)

## Development Process

**Branch convention:** `sprint-N/description` (e.g., `sprint-1/stabilize`)

**State files to update:**
- `SPRINT_STATUS.md` — every session start/end
- `TODO.md` — as tasks complete
- `README.md` — end of each sprint
- `OVERHAUL_PLAN.md` — end of each sprint (progress section)

**Full overhaul plan:** See `OVERHAUL_PLAN.md` (4 sprints: Stabilize → Harden → Redesign → Phase 8)

## Database

SQLite at `data/arcaid.db` (git-ignored). Schema auto-created on first run.

Key tables: `tournaments`, `game_library`, `games` (status: QUEUED/ACTIVE/COMPLETED/HIDDEN), `submissions`, `user_mappings`, `settings`

Indexed on: `games.tournament_id`, `games.status`, `submissions.game_id`, `submissions.discord_user_id`, `submissions.timestamp`
