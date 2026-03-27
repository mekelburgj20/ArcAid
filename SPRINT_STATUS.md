# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the roadmap and future plans, see ROADMAP.md.

---

## Current Work

**Sprint 10: Production Hardening** — COMPLETE
**Post-Sprint Features** — COMPLETE (deployed to production)
**Community Platform Features** — COMPLETE (deployed to production)
**Player Engagement Features** — COMPLETE (deployed to production)

### Player Engagement Features (2026-03-27)
- [x] Discord player login on public pages (OAuth → player token)
- [x] Web-based game picking from Game Availability page
- [x] Queue management (reorder, delete, max 5 per tournament)
- [x] Queue cooldown revalidation at activation time
- [x] "Your Picks" summary card with numbered queue
- [x] Auto-merge near-duplicate games during import
- [x] Mobile-responsive Game Availability layout
- [x] Scoreboard background opacity slider

### Community Platform Features (2026-03-21 → 2026-03-23)
- [x] Public stats page with enhanced metrics (avg finish position, top 5% rate, champion streak, sparklines)
- [x] Per-game player stats lookup on game detail page
- [x] Community score submissions (scores outside tournaments, community leaderboards)
- [x] Game tips & comments (player-submitted tips and comments per game)
- [x] Discord post-score rating flow (star buttons + comment modal after /submit-score)
- [x] Score history tracking (score_history table, expandable per-player history on scoreboard)
- [x] Style catalogue system (iScored style import/upload, per-game assignment)
- [x] Kiosk mode (/:slug/kiosk, auto-refresh)
- [x] Scoreboard branding (logo upload, background upload, title customization)
- [x] Session persistence on login pages (auto-redirect with valid JWT)
- [x] Removed room-level Discord bot token/client ID/secret (global-only)
- [x] Styled admin section headings (NeonCard cyan accent)

### Sprint 10 Summary
- Tier 1 Critical: Rate limiting, DB indexes, CORS, JWT validation
- Tier 2 Code Quality: N+1 fixes, maintenance mutex, WebSocket fix, TournamentForm extraction
- Tier 4 Polish: Helmet, correlation IDs, health checks, audit logging, migration versioning
- Testing Foundation: 40 tests (Vitest, in-memory SQLite)

### Post-Sprint Features (2026-03-16 → 2026-03-19)
- [x] Discord OAuth on super-admin login page
- [x] Admin invite system (one-time invite links, 48h expiry, optional Discord DM delivery)
- [x] Discord admin management (add Discord users as room admins, log in via OAuth)
- [x] Discord username resolution everywhere (accept usernames instead of numeric IDs)
- [x] UI fixes: hide Activate on super-admin library, center single room on landing, remove redundant button
- [x] Last day of month schedule support (custom `L` marker, Scheduler runtime guard for days 28-31)
- [x] VPXS Wizard Tables import (fetches from LegendsUnchained GitHub, imports with VPXS platform)
- [x] Room-scoped game imports (VPS/Wizard imports now associate games with current room)

### Previous
**Multi-Game-Room Architecture** — COMPLETE (merged to main, deployed 2026-03-16)

## Previous Sprints

- Sprint 1 (Stabilize) — COMPLETE
- Sprint 2 (Harden) — COMPLETE
- Sprint 3 (Redesign) — COMPLETE
- Sprint 4 (Phase 8) — COMPLETE
- Sprint 5 (Discord UX + Player Portal) — COMPLETE
- Sprint 6 (Schedule UX & UAT) — COMPLETE
- Sprint 7 (Platform & Mode) — COMPLETE
- Sprint 8 (Public Player Portal) — COMPLETE
- Sprint 9 (UI Themes) — ABANDONED (Gemini), reimplemented as feature
- Feature: Ranking Groups — COMPLETE
- Feature: UI Theme System — COMPLETE
- Sprint 10 (Production Hardening) — COMPLETE
- Feature: Player Engagement (Discord login, web picking, queue management) — COMPLETE

## Last Session

**Date:** 2026-03-27
**What happened:** Added Discord player login on public pages, web-based game picking/queuing from Game Availability, queue management (reorder/delete/max 5), cooldown revalidation at activation, "Your Picks" summary card. Fixed auto-merge near-duplicate import bug. Mobile-responsive Game Availability layout. Background opacity slider for scoreboard branding.
**Next:** User-driven features as needed.

## Blockers

None.
