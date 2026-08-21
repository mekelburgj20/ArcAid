# Quick self-delete of own scores — work-package contract (v2.108.0)

Owner ask (2026-08-14): deleting a score you just posted must be easy: (a) click
YOUR OWN score row on any score card → opens the game quick popup (same one the
title opens); (b) in that popup your score row carries a delete icon, and
expanding your score shows each nested history score with its own delete icon;
(c) the GameDetail Leaderboard tab rows get the same own-row delete. Players
delete only their own scores; room admins/super-admins any row. Branch:
`feature/score-self-delete` off main.

Recon inventory: agent report 2026-08-14 (see summary table). Key facts:
- `DELETE /:roomId/score-history/:historyId` (rooms.ts:1694-1757) exists,
  tiers correct, but `source IN ('tournament','sync')` only — the community
  cascade was never built (deliberate v2.9.0 gap, documented at
  rooms.ts:1689-1690, RoomScoresService.ts:9-11, GameDetail.tsx:613-614).
- `RankedEntry` rows ship NO `submitted_by_user_id`/`source`/history id —
  the resolved `discord_user_id` is a display identity (alias-resolvable),
  not an ownership claim.
- The per-player history endpoint ALREADY returns `submitted_by_user_id` etc.;
  `useScoreExpand.ts`'s local type just drops the fields.
- `GlobalScoreService.softDelete` exists (`/api/me/global-scores/:scoreId`)
  but is disconnected from room tables — shipping asymmetry.

## Backend

### B1 — Community-source cascade (closes the v2.9.0 gap)
Extend `ScoreHistoryService.deleteEvent` + the DELETE route to accept
`source='community'`:
- Delete the `score_history` row (as today) + photo files.
- Delete the matching `community_scores` row(s): match on
  `(game_room_id, LOWER(player_name/iscored_username), score)` plus
  `submitted_by_user_id`/player-id where the schema allows and a created_at
  proximity window if needed — INSPECT `CommunityScoreService.submitScore`'s
  dual-write to pick the tightest reliable key; document the choice in a
  comment. If no match, proceed (best-effort, log DEBUG).
- NO iScored suppression tombstone for community rows (poller is sync-only —
  keep the existing tombstone logic gated to sync/tournament exactly as-is).
- `submissions` recompute: unchanged (it already filters tournament/sync).
- Update the three "no community cascade" comments to describe the new truth.

### B2 — Global fan-out cleanup on room delete (closes the asymmetry, one way)
On EVERY successful deleteEvent (any source), best-effort soft-delete the
fanned-out `global_scores` row via `GlobalScoreService.softDelete`-equivalent:
conservative match — `player_id = submitted_by_user_id AND score = deleted
score AND origin_game_room_id = roomId` and, when resolvable, the game's
`global_game_id`; if the match is not unique, DO NOTHING (skip, log DEBUG).
Soft-delete records the actor. Invalidate GlobalLeaderboardService cache (the
existing softDelete already does). The REVERSE direction (global self-delete →
room tables) stays as-is; note it in the route comment as a known one-way.

### B3 — Ranked-row payload additions
`LeaderboardService` (+ its cache) and `RoomScoresService.getGameRankingsBatch`
ship three new identity-stable fields per ranked row: `history_id` (the
score_history id of the best row backing the collapsed entry — the poller-
compatible `submissions`-shaped reads must derive it from the same best-row
query), `source`, and the RAW `submitted_by_user_id` (nullable — distinct from
the resolved display `discord_user_id`). CACHE CAUTION (CLAUDE.md doctrine):
these are identity-stable facts, ALLOWED in `leaderboard_cache`/
`global_leaderboard_cache` blobs — but the blob shape changes, so bump the
`{v, rows}` envelope version so old blobs read as cache miss; never bake
names/avatars. Verify `resolveProfiles` passes the new fields through.

### B4 — Route auth unchanged
Keep `requireDiscordUser` + existing three tiers. Self-delete gate stays
`row.submitted_by_user_id === req.user.discordId` (raw column, never the
resolved id). Keep admin-only RoomEvent/Audit logging semantics.

## Frontend

### F1 — Shared viewer-claims helper
Extract the triplicated `decodeViewerClaims` (GameDetail.tsx:22-40,
RoomScoresView.tsx:51-64, PlayerDetail.tsx:16) into
`admin-ui/src/lib/viewerClaims.ts`; all three sites consume it. New code uses
it too.

### F2 — Shared ownership/delete-gate helper
`admin-ui/src/lib/scoreDelete.ts`: `canDeleteRow(entry, claims, roomId)`
implementing the tiers (super_admin → true; room_admin in room → true; else
`entry.submitted_by_user_id === claims.discordId`). Source check: tournament/
sync/community all deletable now. Plus a `deleteScoreHistory(roomId, historyId,
playerToken)` fetch helper both pages/components call.

### F3 — Card row click → quick popup (own rows only)
In ALL card families (ArcadeCard rows + ArcadePodium, BannerCard, MinimalCard,
ShowcaseCard + ShowcasePodium, ScoreList, legacy GameCard): when the row is the
VIEWER'S OWN (`entry.submitted_by_user_id === claims.discordId` — needs B3
field; fall back to nothing if absent) AND an `onOpenQuickView(lb)` callback is
provided, clicking the row opens the quick popup instead of the inline expand
toggle. All other rows keep today's expand behavior byte-identical. Thread the
callback from the pages that already own a GameQuickView instance
(Scoreboard/tournamentCardTitle path, RoomScoresView, GlobalScoresView — for
Global tab rows DO NOT wire delete (global rows use the existing
/me/global-scores path); simplest: only thread onOpenQuickView on the two room
tabs). Add a subtle affordance on own rows (e.g. cursor-pointer + a small
chevron or underline on hover) so the gesture is discoverable — keep it quiet.

### F4 — GameQuickView delete + nested history
- Accept new optional props: `roomId`, viewer claims (or read ViewerAuthContext
  directly — match the app's idiom), and a `onScoreDeleted` refresh callback.
- Each ranked row where `canDeleteRow` passes gets an ALWAYS-VISIBLE (not
  hover-only) Trash2 icon → ConfirmModal (reuse the existing confirm component
  pattern) → `deleteScoreHistory(row.history_id)` → optimistic row removal +
  onScoreDeleted so the underlying page refetches.
- Add per-player expand inside the popup via `useScoreExpand` (roomId + game):
  clicking a row's expand chevron (only when hasMultiple) shows nested history
  rows, each with its own delete icon when permitted. Widen
  `useScoreExpand.ts`'s `ScoreHistoryEntry` type to include
  `submitted_by_user_id` (+ display fields it already receives).
- Popup opened WITHOUT roomId (Global tab, Picks highlightStat mode) renders
  exactly as today — zero delete affordances.

### F5 — GameDetail Leaderboard tab
The CURRENT LEADERBOARD table rows: own-row delete icon, ALWAYS visible (the
existing nested-history trash stays but ALSO becomes always-visible on
touch devices — use the `[@media(hover:none)]:opacity-100` idiom already used
elsewhere, keep hover-reveal on desktop pointers). Deleting the top row deletes
its backing `history_id` (B3 field on the leaderboard payload GameDetail
consumes — verify which endpoint feeds that table and thread the fields).
Community rows are now deletable (update the FE gate that excluded them).

## Tests
- BE: community cascade (deletes score_history + community_scores, leaves
  tombstone absent, recompute unaffected), global soft-delete match hit + skip-
  on-ambiguous, payload new fields present (live + cached path with envelope
  version bump → old blob = miss), auth tiers incl. community self-delete.
- FE: canDeleteRow gate tiers; GameQuickView shows delete only for own rows
  with claims + roomId; nested-history delete rendering; card own-row click
  opens popup while other rows still expand; GameDetail always-visible icon.
- Baselines: backend 1704, admin-ui 742 — end at or above, ALL suites run
  SYNCHRONOUSLY in the foreground (never background — prior agents stalled).

## Screenshot loop (required)
vite preview + repo playwright per tmp/p1-arcade-harness.js pattern (kill the
preview when done — orphaned previews lock node_modules): (1) Arcade card with
viewer's own row affordance visible, (2) GameQuickView with delete icon on own
row + one expanded nested history with per-row delete, (3) 390px phone shot of
the popup. Mock viewer claims so ownership renders. Save to
tmp/self-delete-shots/.

## Hard rules
Build both sides, lint zero-new on touched files, CRLF check (`git diff
--numstat` vs `-w`), commit on the branch with `feature:` message. NO push, NO
version bump, NO CHANGELOG/SPRINT_STATUS/ROADMAP edits, NO PR. If the code
contradicts this contract (especially around the community_scores match key or
the cache envelope), STOP and return a structured blocker instead of guessing.

RETURN: per-item status, the community_scores + global_scores match keys you
landed on, cache envelope details, test/build/lint/CRLF results, screenshot
list, commit SHA.
