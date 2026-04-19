# ArcAid v2.0.3 — Card backgrounds, submit parity, room-context submissions

**Released:** 2026-04-18
**Baseline:** v2.0.2 (commit `2da010e3`)

Three targeted fixes from continued smoke-testing.

## Fixes

### 1. Default catalogue image returns to Tournament + All Games cards

Sprint 8 consolidated catalogue and tournament rendering through `CardRouter`, which derived backgrounds from `style_catalogue` only. Cards with no style_id dropped their catalogue art entirely.

Two changes restore the fallback:

- **Backend (`LeaderboardService.getActiveLeaderboards`):** both the active and retained-completed game SELECTs now `COALESCE(gl.image_url, gg.local_image_path, gg.wheel_image_path, gg.image_url)` against a new `LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'`. Each tournament row includes the catalogue image when the room's library didn't supply one. Paths stored as `data/catalogue-images/…` are normalized to their public URL (`/api/catalogue-images/…`) by a new helper `normalizeImageUrl`.
- **Frontend (`ShowcaseCard`):** now falls back to `lb.imageUrl` in `resolveImages` — matches the existing behavior in `BannerCard` and `MinimalCard`. Rooms on the Showcase style with `cardBgFill` enabled now see the catalogue art when no style mapping exists.

Admin override precedence is unchanged: set a `bg_style_id` (or `catalogue_style_id`) in the room's style editor and it wins over the default catalogue image.

### 2. Submit button icon consistency

Tournament cards were using the themed `SubmitScoreIcon` (a score-slip glyph); All Games cards used `lucide <Plus>`. Swapped Tournament over to `Plus` for parity. `SubmitScoreIcon` is still exported but no longer used by any card template — leaving it for a possible future reintroduction.

Touched: `admin-ui/src/pages/Scoreboard.tsx` (3 inline buttons — grid / vertical / scroll layouts), `admin-ui/src/components/cards/GameCard.tsx`.

### 3. Freeplay-style submissions now count toward tournaments

After v2.0.2, Tournament card titles route to `/games/:id?from=<slug>` for any game with a global catalogue entry. The submit from that page uses a `freeplay` target (v2.0.1 Fix 5) posting to `/api/rooms/:roomId/freeplay-score` — which previously **only wrote `community_scores`**, never `submissions`. Tournament card leaderboards read from `submissions`, so scores submitted via the game detail page looked like they went into a void from the Tournament card's perspective.

Fix: `/freeplay-score` now mirrors `/submit-score`'s behavior — when the room has an `ACTIVE` or `COMPLETED` tournament game matching the name, it upserts `submissions` with full Sprint 1 context (`submitted_from_room_id`, `submitted_during_tournament_id`, `submitted_by_user_id`, `submitted_by_anonymous_name`) and invalidates the leaderboard cache. Path of submission is no longer user-visible — same room + same game + same tournament state → same leaderboard outcome.

## Deferred to future releases

### "Reset to default image" in the style editor

Admin can already clear a style assignment (which makes the default fallback kick in), but there's no explicit "Use catalogue default" button labelled as such. Worth an explicit UI affordance in a v2.1 polish pass on `StylePicker` / `GamePickerModal`.

### Multi-score view per player

Current leaderboards show best score only. You flagged wanting to see a player's full submission history from a game detail page. Ideal design:

- On the game detail leaderboard, make the username clickable → expand in-place to show that player's full `score_history` for this game (newest → oldest), with submission timestamps, photo link, and a small chart of score progression over time.
- For tournament context, show two rows in the expanded view: "This tournament" (filtered to `submitted_during_tournament_id`) and "All time". Makes it clear why a user might submit a score below their personal best — the current tournament window requires it.
- Data is already there: the `score_history` table logs every submission with source (tournament/community/sync). `ScoreHistoryService` has helpers. The UI surface doesn't exist yet — a small expandable row component on `GameDetail.tsx` + a backend endpoint returning per-user history for a game.

**Scope estimate:** ~1 afternoon. Candidate for v2.1 alongside the Stats page rework you flagged earlier.

## Files touched

- `src/services/LeaderboardService.ts` — `LEFT JOIN global_games`, image fallback, `normalizeImageUrl` helper
- `src/api/routes/rooms.ts` — `/freeplay-score` upserts `submissions`
- `admin-ui/src/components/scoreboard/ShowcaseCard.tsx` — `lb.imageUrl` fallback
- `admin-ui/src/components/cards/GameCard.tsx` — `Plus` icon
- `admin-ui/src/pages/Scoreboard.tsx` — `Plus` icon on all 3 inline submit buttons

No migrations. No cache bust required (tournament image comes from the fresh JOIN; freeplay upsert invalidates per-game cache on write).

## Upgrade

Drop-in. Redeploy image.

## Rollback

Previous tag: `2da010e3`. No schema or cache artifacts to undo.
