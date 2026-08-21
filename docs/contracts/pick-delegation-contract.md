# Pick delegation & per-player queues — build contract

Owner-specified 2026-08-17. Supersedes the shared-FIFO queue model.
Diagnosis source: prod investigation of Daily Grind / Blackbelt 2018 (2026-08-16→17).

---

## 1. What was actually broken

Three independent defects, all confirmed against prod data + `arcaid.log`:

**A — the queue is tournament-global FIFO, but the pick award is per-winner.**
`TournamentEngine.processSlotMaintenance` takes the head of
`SELECT * FROM games WHERE tournament_id=? AND status='QUEUED' ORDER BY queue_order ASC, rowid ASC`
(`TournamentEngine.ts:785`) and never reads `picker_discord_id`. On the 2026-08-17 03:00
rotation the log shows winner resolution was **correct** —

```
-> Top scorer (local DB): ChalataLove (3,588,843,950)
-> Winner ID resolved from submission attribution: 1344833957509861438
```

— and then soggybacon's `Magic Castle` (queue_order 1) activated while the winner's own
`Xena Warrior Princess Pinball` (queue_order 2) was skipped. The announcement congratulated
ChalataLove *and* activated someone else's pick.

**B — the disposition feature is unreachable whenever anything is queued.**
`resolveNextPicker` — the only reader of `picker_dispositions` — is called at
`TournamentEngine.ts:1428`, inside the `else` branch taken only when the queue is EMPTY.
Two unconsumed rows are live in prod.

**C — `PUT /:roomId/queue/reorder` corrupts ordering across players.**
It correctly verifies you only reorder your own games (`rooms.ts:1108-1118`), then renumbers
them `1..N` (`rooms.ts:1124`) in the **tournament-global** `queue_order` space allocated by
`queueGame` (`TournamentEngine.ts:191-195`). Prod currently holds three pairs of duplicate
positions in Daily Grind; ties break on invisible insertion `rowid`.

Defect C disappears as a side effect of the per-player model below.

---

## 2. The queue model (owner, verbatim intent)

A queue is **per player**, scoped to a tournament. It exists so a player's pick is decided in
advance: if they win, no one waits on them. It is **not** a room-level "what we play next"
list. Another player's queued game NEVER activates because someone else won — it sits until
that player wins, or they modify it.

Consequences:
- `queue_order` is allocated and reordered **per `(tournament_id, picker_discord_id)`**, not
  per tournament.
- A queued game is consumed only by its own owner winning a slot.
- Mod-managed queues feeding the auto-picker: **TABLED** (owner, explicit future item).

---

## 3. Resolution algorithm

### Definitions

- **`places[]`** — distinct players on the completed slot's leaderboard, score DESC,
  `orphaned_at IS NULL`, **deduplicated by resolved player identity** (see §4.3).
  `places[0]` = winner, `places[1]` = runner-up, `places[2]` = third.
- **`queueOf(P)`** — P's QUEUED rows in this tournament by their own `queue_order`, first one
  surviving cooldown revalidation (`isGameEligible`).
- **`dispositionOf(P)`** — `picker_dispositions` row: `none` | `forfeit` | `nominate(N)` |
  `auto` *(new — "roll the dice")*.

### Place cascade

Places are consulted in order through a single advancing pointer:

| Place | May be given a pick window? | Queue consulted? | Disposition honored? |
|---|---|---|---|
| 1st (winner) | yes (winner window) | yes | yes |
| 2nd (runner-up) | yes (runner-up window) | yes — **used immediately, no window** | yes |
| 3rd | **no** | yes | no — queue only |
| none left | — | — | auto-pick |

### Main flow

```
onSlotComplete:
  W = places[0]
  if no W            -> auto-pick / admin-wait (unchanged)
  announce W's win   -- ALWAYS, including on forfeit
  resolve(W, place=0)
```

```
resolve(P, place, depth, visited):
  if P in visited or depth > 5      -> CYCLE: treat as forfeit by P
  switch dispositionOf(P):
    none        -> queueOf(P) ? ACTIVATE(queueOf(P))            // instant
                              : WINDOW(P)                        // timeout -> advance
    auto        -> AUTO_PICK
    forfeit     -> advance to next unconsulted place
    nominate(N) -> resolve(N, place, depth+1, visited + P)
```

```
advance(nextPlace):
  place 1 (runner-up): honor disposition; queue -> instant; else WINDOW
  place 2 (third):     queue -> instant; else AUTO_PICK      (no window, no disposition)
  beyond:              AUTO_PICK
```

Timeout transitions (`TimeoutManager`) follow the same table: a winner window expiring
advances to runner-up (queue-first), a runner-up window expiring advances to third
(queue only), then auto-pick.

### Worked examples (owner's cases)

| Case | Result |
|---|---|
| W has queue | W's front game activates instantly. No window. |
| W queue empty | W gets winner window → timeout → runner-up |
| Runner-up reached, has queue | activates instantly — **no window** |
| Runner-up reached, no queue | runner-up window → timeout → third's queue → else auto-pick |
| W forfeits | congrats to W + "forfeited their pick — it passes to *Y*" → runner-up |
| W forfeits, runner-up forfeits | both forfeits named → third's queue → else auto-pick |
| W rolls the dice | congrats to W + Arcaid auto-picks immediately |
| W nominates N, N has no disposition | N's queue → instant, else N gets winner window |
| W nominates N, N forfeits, N ≠ runner-up | → actual runner-up |
| W nominates N, N forfeits, N = runner-up | **see OPEN Q1** |
| W nominates N, N nominates M | honor M's disposition (recurse, cycle-guarded) |

---

## 4. Decisions taken without asking (stated, reversible)

**4.1 Nomination cycles.** A→B→A, or any ring, has no inferable answer. Guarded with a
visited-set + depth cap of 5; on trip, the last nominee is treated as a **forfeit**, so the
place cascade continues rather than dead-ending in auto-pick.

**4.2 Third place ignores dispositions.** Third never receives a pick window, so
`nominate`/`forfeit`/`auto` have nothing to act on. Only their queue is read.

**4.3 Unattributed players are skipped in the cascade.** A place held by an iScored-only name
with no Discord identity (exactly ChalataLove's synced row) cannot be DM'd, cannot hold a
window, and has no queue. Such a place is skipped and the pointer advances. Places are also
deduplicated by resolved identity first, so one human holding two rows (§6) cannot be their
own runner-up.

**4.4 `auto` when the tournament has `auto_pick = 0`.** *(live case: "Big Tourney Energy")*
Roll-the-dice is an explicit player instruction, but the tournament forbids auto-picking. The
instruction loses: falls through to the normal admin-wait path, same as an expired chain today.

**4.5 Dynasty block also blocks the winner's queue.** `allow_dynasty = 0` currently blocks the
winner's "use-my-queue" path; that stays true under the new model — a dynasty-blocked winner
does not get their queued game activated either. (Inert on prod: every tournament is
`allow_dynasty = 1`.)

**4.6 Chained dispositions are read, not consumed.** Only the actual winner's disposition is
consumed (§ OPEN Q2). Walking through a nominee's or runner-up's disposition does not burn it —
otherwise one person winning could clear three other people's settings.

---

## 5. RESOLVED (owner, 2026-08-17)

**Q1 — "nominee forfeits and was the runner-up" → UNIFIED.**
No exception. A forfeit always advances the pointer to the next unconsulted place; third's
queue is always checked before auto-pick. The stated auto-pick shortcut is dropped.

**Q2 — disposition lifetime → SPLIT.**
- `nominate` is **one-shot**: consumed (deleted) when it fires. Nominating a specific person
  is a decision about one round.
- `forfeit` and `auto` are **standing**: they persist until the player changes or clears them.
  They are stances about how the player wants to play.

Implementation: `PickDispositionService.consume` deletes only when
`disposition === 'nominate'`; otherwise it reads and leaves the row in place. Chained
lookups (§4.6) never consume regardless of type.

---

## 5b. What shipped

| Area | Change |
|---|---|
| `src/engine/pickResolution.ts` | **NEW** — the single cascade implementation. `resolvePick()` walks the place table; `startPlaceIndex` lets the timeout chain re-enter it lower down. |
| `src/utils/submissionAttribution.ts` | **NEW** `resolveLeaderboardPlaces()` — finishing order as PLACES: `orphaned_at IS NULL`, deduped by resolved identity, unattributed rows skipped, limit counts places not rows. |
| `TournamentEngine.queueGame` | `queue_order` allocated per `(tournament, picker)`, not per tournament. |
| `TournamentEngine.processSlotMaintenance` | Queue-head selection replaced by the cascade. Gate flags + max-slots + duplicate-placeholder guards hoisted ABOVE it, so a maintenance re-run cannot fire a one-shot twice. Orphan-placeholder sweep no longer deletes a *live* placeholder belonging to another slot. |
| `TournamentEngine.resolveNextPicker` | **REMOVED** — superseded by `resolvePick`. Its dynasty check survives as `isDynastyBlocked`; `nextEligibleQueuedFor` and `labelForPlayer` are new and public so `TimeoutManager` shares them. |
| `TimeoutManager.pivotToRunnerUp` | Hand-rolled runner-up lookup replaced by the shared cascade. Resumes BELOW whoever timed out (a winner who nominated the runner-up no longer hands that person a second window). |
| `TimeoutManager.pivotToThirdPlaceQueue` | **NEW** — a runner-up window expiring now consults third's queue before auto-pick. |
| `TimeoutManager.activateQueuedIntoSlot` | **NEW** — fills a picker placeholder from a player's queue (iScored create-or-unlock, then delete the consumed queued row). |
| `PickDispositionService` | `'auto'` added. `consume()` deletes only `nominate`; `forfeit`/`auto` persist. |
| Migration 149 | Table rebuild to widen the `disposition` CHECK constraint (SQLite cannot ALTER a CHECK). |
| Migration 150 | Re-bases `queue_order` per player, preserving each player's relative order. Repairs the live duplicate positions caused by the reorder bug. |
| `PUT /:roomId/queue/reorder` | Renumbers within the caller's own per-player space; unmentioned games of theirs are appended rather than left colliding. |
| Surfaces | `'auto'` ("Roll the dice") on the Zod schema, `/nominate-picker`, and the Picks page. Lifetime copy corrected everywhere to the split rule. |
| Tests | `src/__tests__/pick-delegation-cascade.test.ts` — 28 cases. Backend 1843 pass, admin-ui 846 pass. |

Migration 150 was dry-run against a read-only copy of prod before landing: ChalataLove's
`2,3,4` rebases to `1,2,3` and the other player's deliberate `1,2,3,4` reorder is preserved
exactly, with the 1..N-per-queue invariant holding across all 3 live queues.

## 5c. The OTHER half of the Blackbelt incident: a resurrected deleted score

Found 2026-08-17 after the owner relayed ChalataLove's account ("I never entered that score in
iScored"). He was right, and the audit log + `arcaid.log` prove the whole sequence:

| time | event |
|---|---|
| 00:23:38.076 | ChalataLove submits **3,588,843,950** in Arcaid — a typo, one digit too many |
| 00:23:38.309 | **Arcaid syncs it out to iScored** (this is why he never typed it there) |
| 00:24:42 | He deletes it in Arcaid. `community_scores#194`, `global_scores`, `score_history#262` all cascade; tombstone written; audit row 113 records it. **Nothing removes it from iScored.** |
| 00:25:54 | He submits the correct **358,884,390** |
| every ~5s for 2h36m | `ScoreSyncPoller` honours the tombstone and correctly refuses to re-import |
| **03:00:03** | Deactivation calls `finalSyncScoresForGame`, which had **no tombstone check** — re-imports 3,588,843,950 |
| 03:00:05 | Winner resolved as ChalataLove, on a score he had deleted |

**Not a race.** The poller behaved correctly for two and a half hours; one code path simply
never learned about tombstones. `ScoreSyncPoller.pollOneAccount` loaded
`deleted_score_suppressions`; `TournamentEngine.finalSyncScoresForGame` did not.

**Consequence for the tournament result:** with the phantom score gone, the real Blackbelt 2018
board is soggybacon **723,234,440** first, ChalataLove **358,884,390** second. **soggybacon
actually won** — and `Magic Castle`, which activated, was soggybacon's queued pick. The two
defects cancelled: the announcement named the wrong winner, and then the FIFO bug handed the
slot to the person who genuinely deserved it.

**Fixed here:** `finalSyncScoresForGame` now loads the same suppression map and applies the
same `score <= suppressed` skip, matching on both the raw and alias-resolved name. Two
regressions in `iscored-provenance.test.ts` pin it: the deleted score stays out, and a
genuinely higher later score still flows through.

**Deeper fix, NOT in this build:** deleting a score in Arcaid should delete it on iScored too,
so it cannot linger and keep re-presenting itself. ADR 0011 assumed iScored has no per-score
delete API; that premise is wrong — iScored exposes per-score `deleteScore`/`editScore` with a
`data-topscoreid` handle. Tombstones are a workaround for a problem we can now actually solve.
→ ROADMAP.

## 6. Adjacent finding (not in this build)

ChalataLove holds **two identities** on the same leaderboard: six web scores under Discord ID
`1344833957509861438`, and one iScored-synced row under synthetic `iscored:ChalataLove`.
`user_mappings` is empty for them — Discord login alone never writes an alias. The leaderboard
partitions on those two IDs, rendering the same name twice (1st and 3rd).

The two scores are the same score with a dropped digit — `3,588,843,950` on iScored vs
`358,884,390` typed into Arcaid. The final sync then overwrote the score on the existing
web-submitted `submissions` row while **retaining that row's photo and timestamp**, so the
winning row's proof photo documents a different number than the row displays.

Owner has asked for a claim/link/verify flow covering this. Note it partially reverses
ADR 0016 P2, which hard-blocks `source='sync'` from the Global Scoreboard. Separate arc.
