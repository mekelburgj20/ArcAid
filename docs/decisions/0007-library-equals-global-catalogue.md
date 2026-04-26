---
status: accepted
date: 2026-04-26
deciders: mekelburgj
supersedes:
superseded-by:
---

# Per-room library page reads `global_games` directly; per-room curation is dropped

## Context

Three tables historically carried partially overlapping data about "what games exist":

- **`game_library`** — the original catalogue (PK = `name`), predates `global_games`. Carries `aliases` (for iScored sync matching), per-game CSS overrides (`css_title`, `css_initials`, …), `style_id`, `mode`, `platforms`, `image_url`. Tournament activation reads it for fallbacks.
- **`game_room_game_library`** — bridge table, originally for per-room curation ("this room only uses these games"). Sprint 2.4.0 added two overlay fields: `custom_platforms` (per-room platform additions) and `display_name` (per-room name override).
- **`global_games`** (added v2.4.0) — the modern catalogue with UUIDs, external IDs, dedup logic, approval status. Source of truth for "what games exist in the world".

Migration 069 (v2.4.0) backfilled `global_game_id` on both legacy tables to link everything to `global_games`, but no one finished the migration of the per-game data into `global_games` and dropped the old tables.

Pre-v2.5.1, the per-room game library page joined through `game_room_game_library` to render its list. Empty rooms (no curation done yet) showed nothing — admins had to either run the legacy "Import VPS" / "Import Wizard" buttons (which duplicated work the global catalogue already does) or manually add games one-by-one. The user reported this as friction:

> "I want all game rooms to just have all the global catalogue games in the game library. […] The admins will know what games are allowed to be added to tournaments, etc. so no need to maintain a curated list per game room."

## Decision

The per-room library page (`GET /:roomId/game_library`) reads `global_games WHERE status='approved'` directly. The legacy `game_room_game_library` curation overlay is no longer consulted for the list view. Every room sees the full approved catalogue; admins gate access at *tournament-creation* time, not at library-curation time.

This is **step 1** of a planned two-step cleanup. Tournaments still pick from `game_library`, score history paths still reference it, iScored alias matching still reads `game_library.aliases`. Step 2 — drop both legacy tables, move `aliases` and any genuinely-needed metadata onto `global_games`, simplify the v2.5.0 proposal commit endpoints — is documented in [`docs/step-2-cleanup-plan.md`](../step-2-cleanup-plan.md). Step 1 ships independently because:

- The library page is the highest-friction UX (empty room → empty list).
- Step 2 is a 1-day careful refactor with real iScored-sync risk; doing it under a deadline is asking for a regression.
- Step 1 is a UI-shaped change (~30 lines of route handler) and reverses cleanly.

The `GET /:roomId/game_library` route shims the response into the FE's existing `GameRow` shape so `GameLibrary.tsx` didn't have to change. Per-row override fields (`aliases`, `css_*`, `bg_color`, `style_id`) are stubbed empty — they were per-room render overrides we're dropping; the per-game card style now flows through the style catalogue + global card styles pipeline.

The four v2.5.0 proposal endpoints (`/use_global`, `/room_only`, `/submit_to_global`, `/proposals`) and the CSV preview/commit pair all still write to `game_library` + `game_room_game_library` for back-compat with tournament activation. They become contribution-only flows post-v2.5.1 — "use_global" mostly degenerates to a no-op since the catalogue is already the library; "submit_to_global" remains the load-bearing path for adding a new game to the catalogue. Step 2 simplifies all of them.

## Consequences

- **Easier:** rooms see the full catalogue immediately on creation. No empty-state, no manual curation step. Submissions can target any approved game without admin pre-approval. The Steam Pinball / VPS / Wizard / OPDB / IGDB importers (running at the global level) are the single source of catalogue truth.
- **Easier:** tournament editors can pick from the same set the library shows — no more "this game is in the catalogue but not in this room's library, why can't I tournament it?".
- **Harder:** rooms can't hide unwanted catalogue games from their library page. Admins control tournament eligibility via tournament-level platform rules + by simply not creating a tournament for a game. For a "this room is Williams-only" UX, the workaround is to filter visually, not to remove from the library.
- **Harder:** the per-room `custom_platforms` overlay on `game_room_game_library` is no longer applied at submit time. Pre-v2.5.1, a room could say "we also play Medieval Madness on VR even though the catalogue says VPX-only". Post-v2.5.1, that overlay is dead until step 2 either drops it formally or moves the capability somewhere else.
- **Locked out:** returning to per-room curation without rebuilding the UI. Practically not a regression risk — the user explicitly opted out of curation and isn't asking to come back.

## Alternatives Considered

- **Keep per-room curation; just default-populate new rooms with the full catalogue.** Rejected — the "hide a game from this room" use case wasn't real, but the curation overhead was. Defaulting only delays the friction.
- **Drop both `game_library` and `game_room_game_library` in this single sprint.** Rejected as too risky. iScored sync alias matching (`game_library.aliases`), tournament activation (`gameCreation.ts` reading game_library for image/style fallbacks), and scoreboard rendering all depend on the legacy tables. A clean migration needs careful per-path verification, which doesn't fit in the same change as the user-visible library shift.
- **Hide the empty library behind a "Browse Catalogue" sub-page.** Rejected as worse UX than just rendering the catalogue. Two clicks to see what's playable in this room.
