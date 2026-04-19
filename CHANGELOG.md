# Changelog

Each release has a dedicated notes file in `releases/`. This index is a scannable summary; the per-version files have the full breakdown.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/).

---

## [2.1.0] — 2026-04-18

**Minor.** Three net-new capabilities.

- **Tournament scoring reads `score_history`** filtered by `submitted_during_tournament_id` — best-during-the-window wins, no longer tied to all-time personal best. `submissions` writes preserved for back-compat. Migration 063 backfills existing rows.
- **Multi-score view** on Game Detail: click a username → inline expand with sparkline of progression, split into "This tournament" vs "All time" when an active tournament is in play. Photo-proof links per row.
- **Stats page Combo redesign** — 4-card overview at the top (plays this week / active players / hottest game / latest submission) on top of the existing Players / Games tabs. New `GET /:roomId/stats/overview` endpoint.

Full details → [releases/v2.1.0/README.md](releases/v2.1.0/README.md)

---

## [2.0.3] — 2026-04-18

**Patch.** Three smoke-test follow-ups.

- Default catalogue image restored on Tournament + All Games cards (backend COALESCE to `global_games` + ShowcaseCard fallback; admin style still wins)
- Submit button icon unified — `Plus` on both Tournament and All Games cards
- `/freeplay-score` now upserts `submissions` when the game is an active tournament game, so scores submitted via game detail count for the tournament just like Tournament-card submits

Full details → [releases/v2.0.3/README.md](releases/v2.0.3/README.md)

---

## [2.0.2] — 2026-04-18

**Hotfix.** Tournament card title routed to room-scoped URL instead of global catalogue.
`LeaderboardService.getActiveLeaderboards()` now selects `COALESCE(g.global_game_id, gl.global_game_id)`
so the frontend's `linkForTournamentCard` resolves to `/games/:id?from=:slug` when the game is mapped.

Full details → [releases/v2.0.2/README.md](releases/v2.0.2/README.md)

---

## [2.0.1] — 2026-04-18

**Patch release.** Seven fixes from v2.0.0 manual testing.

- Avatar leak on anonymous submissions (privacy regression — `LeaderboardService` + 3 siblings narrowed the username-fallback to `iscored:*` only)
- OAuth-cancel detection when user closes the Discord tab without a redirect
- Room-scoped GameDetail Community tab migrated to `SubmissionSheet` (photo upload + anon claim + error messaging)
- `SubmissionSheet` gained a `requireLogin` prop → login-required state up-front on gated rooms
- Global GameDetail Submit respects `?from=<slug>` room context → freeplay target when present
- Internal `Catalogue` / `Community` labels no longer leak onto cards
- Mystery Award direct URL: `/:slug/mystery-award` as a shareable Discord link + login hint

Migration 062: cache flush for the avatar-fix SQL changes.

Full details → [releases/v2.0.1/README.md](releases/v2.0.1/README.md)

---

## [2.0.0] — 2026-04-18

**Major release.** Scores/Nav Reorg — 12-sprint plan + Sprint 13 polish pass.

Highlights:
- Anonymous submission runtime with Discord-collision claim prompt + OAuth draft handoff
- Merge/unmerge admin flow at `/:slug/admin/identity` with freeze-rule protection
- `ENABLE_GAME_PICK_AWARD` opt-in gate hides the pick flow where not wanted
- Global Scoreboard room badges with `?room=<slug>` filter URLs
- Unified `SubmissionSheet` replaces 4 legacy submit modals
- Scoreboard tabs: `Tournaments | All Games` + "Played at" filter
- `/:slug/games` renamed to `/:slug/picks` with 301 redirect
- New nav UserMenu dropdown with full WAI-ARIA keyboard support
- Per-room `short_tag` column for custom badge abbreviations

Breaking: route rename + 4 components deleted + existing rooms must opt into `ENABLE_GAME_PICK_AWARD` to keep the Picks tab visible.

Full details → [releases/v2.0.0/README.md](releases/v2.0.0/README.md)

Commit: `595d9b0f`

---

## [1.x] — pre-2026-04-18

No per-version release notes exist for the 1.x line. Historical context is tracked in `SPRINT_STATUS.md` (current session notes) and `ROADMAP.md` (completed work). Starting with v2.0.0, every release gets a dedicated notes file.
