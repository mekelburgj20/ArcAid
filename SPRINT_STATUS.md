# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Sprint

**Sprint 6 — Schedule UX & UAT** — COMPLETE
**Branch:** `sprint-6/schedule-ux-uat`
**Goal:** Friendly schedule builder, setup wizard fixes, tournament editing, UAT.

## Sprint Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | ScheduleBuilder component | `done` | Day/time/timezone picker replaces raw cron input |
| 2 | Setup wizard password flow | `done` | Step 1 sets password + JWT before saving settings |
| 3 | Empty settings overwrite fix | `done` | SettingsService skips blank values to preserve .env defaults |
| 4 | Tournament tag freeform input | `done` | Replaced dropdown with text input for iScored tags |
| 5 | Tournament edit modal | `done` | Edit name, tag, channel, schedule on existing tournaments |
| 6 | Per-tournament timezone | `done` | Scheduler reads timezone from cadence config |
| 7 | Channel ID clear on create | `done` | All form fields reset after successful creation |
| 8 | UAT fresh install | `done` | Full flow tested: setup → 4 tournaments → verified |

## Sprint 5 — COMPLETE
## Sprint 4 — COMPLETE
## Sprint 3 — COMPLETE
## Sprint 2 — COMPLETE
## Sprint 1 — COMPLETE

## Last Session

**Date:** 2026-03-09
**What happened:** Completed Sprint 6. Built ScheduleBuilder component (frequency/day/time/timezone picker with live preview). Fixed setup wizard auth flow (password step creates JWT before settings save). Added tournament edit modal. Fixed SettingsService to skip empty values. Made tag field freeform. Added per-tournament timezone support. Completed UAT with fresh DB — created 4 tournaments matching TableFlipper schedules.
**Next:** Merge to main. Future: Discord OAuth, trend charts, CI/CD, monitoring.

## Blockers

None.
