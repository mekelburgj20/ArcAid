---
status: accepted
date: 2026-04-30
deciders: mekelburgj
supersedes:
superseded-by:
---

# Deleted-score suppression tombstone for sync-resistant moderation

## Context

ArcAid has had per-score deletion in two places for a while:

- `DELETE /api/me/global-scores/:scoreId` — players self-delete on the Global scoreboard's GameDetail page (since v2.4.x). Soft-delete via `global_scores.deleted_at`.
- `DELETE /api/admin/global-scores/:scoreId` — super-admin equivalent (hard or soft).

Room-scoped scores never had an equivalent. v2.9.0 added two new room delete paths:

- `DELETE /api/rooms/:roomId/admin/games/:gameId/submissions/:submissionId` — admin "wipe player from game" (existed pre-v2.9 but was silently broken — see CHANGELOG v2.9.0 for the cascade-to-`score_history` fix).
- `DELETE /api/rooms/:roomId/score-history/:historyId` — per-row delete, gated by admin role OR row ownership.

Once the cascade-to-`score_history` fix was in, the next problem surfaced: for any room with `ISCORED_ENABLED=true`, the deletion vanished from ArcAid for ~30 seconds and then **came back** on the next `ScoreSyncPoller` cycle. iScored still held the score; the dedup in `ScoreHistoryService.log` keys on `(game_room_id, game_name, iscored_username, score)`, so once the local rows were gone, the existing-row check returned nothing and the poller cheerfully re-inserted everything it had just deleted.

The obvious solution — **also delete the score on iScored** — isn't available:

- `IScoredApiClient` (REST) exposes `getGameroom`, `getGameScores`, `getAllScores`, `submitScore`, plus event lifecycle calls. No delete-score endpoint. `submitScore` explicitly rejects scores lower than an existing best, so we can't zero one out.
- `IScoredClient` (Playwright UI scripting) has `deleteGame` (whole game), `setGameStatus` (lock/hide), `submitScore`. No `deletePlayerScore`.
- iScored's admin web UI may have a per-score delete affordance, but its DOM/flow is undocumented in this codebase. Reverse-engineering would need a separate exploration session.

The user (this site's operator) explicitly chose to ship a workaround now and track the iScored-side cleanup as a follow-up. Manual iScored cleanup remains an admin chore until that lands.

## Decision

Add a tombstone table that the sync poller consults before logging incoming iScored rows. ArcAid stays clean; iScored's public page is allowed to diverge.

### Schema (migration 096)

```sql
CREATE TABLE deleted_score_suppressions (
    game_id                  TEXT NOT NULL,
    iscored_username_lower   TEXT NOT NULL,
    suppressed_score         INTEGER NOT NULL,
    deleted_at               TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_by_user_id       TEXT,
    PRIMARY KEY (game_id, iscored_username_lower)
);
CREATE INDEX idx_deleted_score_suppressions_game ON deleted_score_suppressions(game_id);
```

Keyed on `(game_id, iscored_username_lower)` — one row per (game, player) pair. The score column is the *threshold*: any incoming iScored score `<= suppressed_score` is dropped.

### Write path (both delete endpoints)

```sql
INSERT INTO deleted_score_suppressions (game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)
VALUES (?, LOWER(?), ?, datetime('now'), ?)
ON CONFLICT(game_id, iscored_username_lower) DO UPDATE SET
    suppressed_score = MAX(suppressed_score, excluded.suppressed_score),
    deleted_at = datetime('now'),
    deleted_by_user_id = excluded.deleted_by_user_id
```

`MAX(existing, excluded)` on conflict matters: a player who deletes their 5,000-point row, then their 4,000-point row, must still suppress 5,000 (iScored's view of that player's best). A naive `excluded.suppressed_score` would lower the threshold to 4,000 and let the next sync re-import the 5,000.

### Read path (`ScoreSyncPoller.pollOneAccount`)

Bulk-load suppressions for the game once per poll cycle:

```ts
const suppressionRows = await db.all(
    'SELECT iscored_username_lower, suppressed_score FROM deleted_score_suppressions WHERE game_id = ?',
    localGame.id,
);
const suppressionMap = new Map<string, number>();
for (const r of suppressionRows) suppressionMap.set(r.iscored_username_lower, r.suppressed_score);
```

Then for each iScored row, check before the existing `score > existing.score` re-insert gate:

```ts
const suppressed = suppressionMap.get(resolvedName.toLowerCase())
    ?? suppressionMap.get(score.name.toLowerCase());
if (suppressed !== undefined && scoreValue <= suppressed) continue;
```

Match against both `resolvedName` (post-`/map-user` alias) and the original iScored name so a suppression set before a later alias remap still fires.

### Recompute, not orphan

When the per-row endpoint deletes a `score_history` row, the corresponding `submissions` row (best-per-player-per-game cache) gets recomputed from the *remaining* `score_history`:

```sql
SELECT score, created_at FROM score_history
WHERE game_id = ? AND LOWER(iscored_username) = LOWER(?)
  AND orphaned_at IS NULL AND source IN ('tournament','sync')
ORDER BY score DESC, created_at ASC LIMIT 1
```

If the result is empty → `DELETE FROM submissions`. Otherwise `UPDATE submissions SET score = ?, timestamp = ?` to the new top row's values. Picking score-then-timestamp (not just `MAX(created_at)`) preserves the timestamp of the *displayed* score so the UI doesn't show a stale "submitted at" for the new top.

### Auth model

The two write paths gate differently to keep moderator and player flows aligned:

| Path | Middleware | Authorization |
|---|---|---|
| `DELETE /admin/games/:gameId/submissions/:submissionId` | `requireAuth + requireRoomAccess('roomId')` | super_admin OR room_admin for this room |
| `DELETE /score-history/:historyId` | `requireDiscordUser` | super_admin OR room_admin for this room OR `submitted_by_user_id === viewer.discordId` |

Both paths write the same suppression row format. Players can self-delete only their own scores, but the tombstone effect is identical.

## Consequences

- **Easier:** Admins (and players) can moderate scores in ArcAid and the deletion *sticks* across iScored sync cycles. Without the tombstone the user-visible behavior was "score disappears, score reappears 30 seconds later" — actively misleading.
- **Easier:** The recompute-from-`score_history` path means deleting one row of a player's history (e.g. a fat-finger 99,999,999) keeps their other legitimate scores intact and re-derives the displayed top from what's left.
- **Easier:** The threshold model (suppress `<= N`, allow `> N`) means a player who deletes a bogus high score, then submits a real new top higher than the bogus one, still gets the new top through. Only the deleted score and anything below it stays suppressed.
- **Harder:** ArcAid and iScored's public page now diverge after every moderation action. Until the iScored cascade lands (ROADMAP), the moderator's mental model has to track "deleted on ArcAid, still on iScored" until the manual cleanup. The user (operator) accepted this tradeoff explicitly.
- **Harder:** No FE surface exposes `deleted_score_suppressions` to admins. Restoring a deletion (e.g. an admin deletes by mistake) requires a manual `DELETE FROM deleted_score_suppressions WHERE game_id = ? AND iscored_username_lower = LOWER(?)` via `node -e` inside the container. ROADMAP entry covers building a "manage suppressions" UI when the iScored cascade work happens.
- **Harder:** The threshold model conflates "delete this exact score" with "block anything ≤ this score." A pathological case: a player has 10,000 (deleted) and submits a *legitimate* 5,000 later — iScored holds both, sync's max-by-player surfaces 10,000 (suppressed) and the legit 5,000 never reaches submissions because the suppression check fires first. iScored's API only exposes per-player best, not the full history, so we can't disambiguate. Acceptable today (the scenario requires the player to deliberately submit something *worse* on iScored, which is rare); flagged here for future iScored-cascade work to revisit.
- **Locked out:** If iScored ever gains a per-score delete API and we ship the cascade, this tombstone table becomes redundant — but not safe to drop until *every* deletion path goes through the cascade, because a partial migration would leave the tombstone as the only safety net for already-deleted scores. The migration path is "ship cascade, run a one-time backfill that hard-deletes from iScored everything in this table, then DROP TABLE." Documented here so the future re-implementer doesn't have to re-derive it.

## Alternatives Considered

- **Soft-delete on `submissions` / `score_history` (`deleted_at` column).** Rejected — doesn't address the sync re-import problem. The poller writes new rows on each cycle, not updates, so a `WHERE deleted_at IS NULL` filter would mark today's deletion as soft-deleted while tomorrow's identical iScored row gets a fresh INSERT and shows up undeleted. We'd need a tombstone *anyway*.
- **Use existing `orphaned_at` column on `score_history`.** Rejected for the same reason — `orphaned_at` filters reads but doesn't suppress writes. Plus `orphaned_at` is semantically "the parent game was removed", not "this score was moderated"; reusing it would conflate two cleanup paths.
- **Skip the tombstone; require admins to delete on iScored first, then ArcAid.** Rejected — bad UX for the moderation flow (admins now have to context-switch to iScored, find the right game and player, click through the iScored admin UI, then come back). Most importantly: ArcAid players who self-delete *can't* moderate iScored at all — they have no admin access there. The tombstone is the only way to give players self-delete that doesn't immediately undo itself.
- **Pursue iScored per-score delete via Playwright now.** Rejected for this release — would have required a separate exploration session against iScored's admin UI to map the DOM, and the user explicitly opted to ship the workaround first. ROADMAP entry covers the future investigation.
- **Time-based suppression (auto-expire after N days).** Rejected — once a score is intentionally deleted, the deletion is permanent. iScored's non-decreasing best-score behavior means a stale suppression won't accidentally allow re-import of a *new* legitimate higher score (those exceed the threshold and pass the check naturally). No reason to auto-expire.
- **Suppress at score==exact equality, not ≤.** Considered. Rejected — race condition: poller reads iScored, gets `score=5000`, network delay, by the time it inserts iScored has updated the player's best to `score=5500` (player submitted again on iScored). With strict equality, our 5,000 suppression doesn't match 5,500 and we re-insert despite the player's intent. With ≤, the 5,500 (legit new top) exceeds 5,000 and goes through. The threshold gives correct behavior for sync-vs-deletion races.

## Notes

- The suppression key uses `iscored_username_lower` (separate column, not `LOWER(iscored_username)` in queries) so SQLite can hit the PK index without a function-on-column scan. iScored is case-insensitive at the player-identity level (see ADR 0010 Notes), so storing the lowercased form is correct: two rows that differ only in case represent the same iScored player.
- `suppressed_score` is the *deleted row's* score, not the *iScored side's current* best. These usually match (since iScored shows max-per-player and we delete the displayed top), but if a player has a higher iScored-only score that ArcAid never synced, the threshold won't catch it. The poller will re-import that higher score — which is arguably correct behavior (the admin only saw and deleted what they saw).
- `deleted_score_suppressions` is the only post-v2.9 cross-cutting concern between the moderation flow and the sync flow. Future work that adds new score-write paths must consult it (or document why the path is exempt).
