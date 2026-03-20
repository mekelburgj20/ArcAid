# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the task checklist, see TODO.md.

---

## Current Work

**Sprint 10: Production Hardening** — COMPLETE
**Post-Sprint Features** — COMPLETE (deployed to production)

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

## Last Session

**Date:** 2026-03-19
**What happened:** Added VPXS Wizard Tables import feature (fetches table list from LegendsUnchained GitHub README, imports with VPXS platform). Fixed room-scoped imports (VPS and Wizard) to associate imported games with the current room via junction table. Fixed "Last day of month" schedule display showing NaNth. Updated all docs.
**Next:** Discord Bot Multi-Room (Phase 5) — deferred. User-driven features as needed.

## Blockers

None.
