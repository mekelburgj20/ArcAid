---
status: accepted
date: 2026-04-26
deciders: mekelburgj
supersedes:
superseded-by:
---

# Every score record carries a required `platform`; leaderboards stratify by it

## Context

Pre-v2.5.0 leaderboards lumped together scores from every source. A Medieval Madness score set on a real Williams Bally machine, a Pinball FX VR session on a Quest, and a VPX recreation on a desktop all landed on the same per-game leaderboard with no distinction. Two problems followed:

1. **Difficulty mismatch.** VR pinball is materially easier than a real machine; VPX recreations differ from the original; AtGames Legends is its own scoring surface. Comparing across platforms isn't apples-to-apples.
2. **No way to scope a tournament to one platform.** A "Pinball FX VR only" tournament couldn't be expressed; rules could require/exclude platform tags on the *game*, but couldn't bind on the *score*.

The v2.5.0 platform taxonomy expansion (7 new IDs covering FX Classic / FX VR / Zaccaria / SW Pinball VR) made the gap unavoidable: the catalogue now distinguishes platforms that the score model couldn't.

## Decision

Every new score row across every score table — `submissions`, `score_history`, `community_scores`, `global_scores` — carries a `platform` column. The column is nullable in SQL (legacy rows survive) but required at the API boundary via Zod on `ScoreSubmissionSchema` / `CommunityScoreSchema` / `FreeplayScoreSchema` / `POST /global/scores`. Server-side `ensurePlatformAllowed` (rooms.ts) and the equivalent in-bot logic in Discord `/submit-score` re-validate the submitted platform against the resolved submittable set at every handler — no client trust.

The submittable set is computed by `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` in `platformRules.ts`: game's effective platforms ∩ active tournament's `platform_rules.required` minus `platform_rules.excluded`. The picker UX:

- 1 platform → read-only chip (auto-filled, locked).
- 2+ platforms → required `<select>` dropdown; submit blocked until chosen.
- 0 platforms → submit blocked with an admin-must-configure message.

Discord `/submit-score` mirrors this: auto-fills when 1, rejects with valid-choices ephemeral reply when 2+ and missing.

`ScoreSyncPoller` stamps `tournament.iscored_default_platform` (a new nullable column) on rows it imports — iScored has no platform concept, so admins set a fallback per tournament. NULL leaves the score's platform NULL ("Platform unknown").

Game detail leaderboards stratify: `GET /:roomId/leaderboard/:gameId` accepts `?platform=<id>`; the response includes `distinctPlatforms[]` for the FE tab strip. `RankedEntry` and `GlobalRankedEntry` carry per-row platform; "All" view shows badges and demotes NULL-platform rows to a "Platform unknown" tail section.

Backfill for legacy rows (migration 085) is best-effort: if the source game has exactly 1 platform configured, write it; otherwise leave NULL.

## Consequences

- **Easier:** tournaments can scope to a specific platform (`required: ['pinball_fx_vr']` actually binds on submit). Per-platform comparisons become meaningful. The picker tells players which platforms count for the active scope.
- **Easier:** synced rows from iScored get an admin-chosen default via `tournament.iscored_default_platform` — no manual tagging required for the common case.
- **Harder:** every submit path threads `platform` through. There are five — three web (tournament / freeplay / legacy community) plus Discord plus the OAuth-handoff draft commit — and all five must agree on the resolved set. The `ensurePlatformAllowed` helper exists to avoid drift.
- **Harder:** legacy multi-platform games have NULL-platform rows that can't be disambiguated retroactively. The "Platform unknown" tail section is the user-visible cost.
- **Locked out:** silently making `platform` optional later. Doing so would either require backfill (which we can't do correctly for multi-platform games) or accept inconsistency between old and new rows.

## Alternatives Considered

- **Optional `platform` field.** Rejected — leaves dirty data forever, and the picker UX has no signal to prompt. Tournaments couldn't reliably scope by platform without a normalization sweep that keeps drifting back to dirty.
- **Normalize platform on read only (no submit-time field).** Rejected — leaves no per-score record of what was actually played. The picker is the *user* affirming "I played this on X"; a heuristic-from-game-platforms fallback can't replicate that.
- **Separate `score_platforms` table joined at read time.** Rejected — adds a join to every leaderboard read and every score-detail page for a 1:1 relationship that fits as a column. The composite indexes (`idx_*_game_platform`) cover the query shape we actually use.
- **Per-game-instance default platform (no per-score override).** Rejected — many catalogue games have 2+ platforms (Medieval Madness exists in real, VPX, FX Classic, FX VR). The whole point is that a single game has multiple scoring surfaces; the score record has to capture which one.
