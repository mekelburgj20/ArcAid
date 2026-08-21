# Sprint 2 — Merge-reversal data model spec

**Scope:** docs + service skeleton only. No runtime changes. Outputs load-bearing decisions for Sprint 11.

**Decisions locked in this sprint** (from plan Q2/Q3):
- **Q2 → (a) Parallel system.** Existing `merge-player` at `src/api/routes/rooms.ts:2075-2180` stays, renamed in UI to "Sync-alias rename". New anonymous-identity merge flow is restricted to rows where `submitted_by_user_id IS NULL` (the Sprint 1 column). The two paths solve different problems and share zero code.
- **Q3 → new `/:slug/admin/identity` page.** Dedicated surface for merge queue, preview, reversal, and audit chain.

---

## 1. The two merge systems, side by side

| Dimension                     | Sync-alias rename (existing)             | Anonymous-identity merge (new, Sprint 11)                                  |
|-------------------------------|-------------------------------------------|-----------------------------------------------------------------------------|
| Trigger                       | Admin corrects an iScored username typo  | Anonymous submitter claims a score after OAuth, OR admin reconciles       |
| Scope filter                  | `iscored_username = ?` match             | `submitted_by_user_id IS NULL AND anonymous_identity_id = ?`              |
| Tables touched                | `submissions`, `scores`, `community_scores`, `score_history`, `user_mappings`, `player_aliases` | `submissions`, `community_scores`, `score_history`, `global_scores` (4 rows × `submitted_by_user_id` + `merged_from_anonymous_identity_id`) |
| Destructive?                  | Yes — on username conflict, the loser row is DELETEd | No — sets attribution fields; original `submitted_by_anonymous_name` PRESERVED |
| Reversible?                   | No                                        | Yes — `reverseMerge()` walks `merge_records.score_ids_snapshot`           |
| Audit row                     | None                                      | `merge_records` row with admin, timestamps, snapshot, optional reason     |
| Alias written                 | `player_aliases` INSERT                  | None (no iScored-side rename involved)                                    |
| Cache invalidation            | `LeaderboardService.invalidateAll()` + `RankingService.invalidateAll()` | Same (identical downstream) |
| Failure mode if misapplied    | Score loss, no recovery                   | Record exists; reversal reattributes without collision                    |

**Rule of thumb:** if the change is "this iScored username should be spelled differently," use sync-alias rename. If the change is "this anon submitter turns out to be a real Discord user," use identity merge.

The two paths will NEVER touch the same rows because identity merge filters on `submitted_by_user_id IS NULL` and sync-alias rename doesn't read that column at all. A row that has `submitted_by_user_id` set is, by definition, already claimed and cannot be identity-merged.

---

## 2. `merge_records` field-by-field spec

Schema already created in migration `053_merge_records` (Sprint 1). This spec locks the semantics of each field so Sprint 11 implementation has no ambiguity.

| Column                             | Type       | Nullable | Meaning                                                                                                          |
|------------------------------------|------------|----------|------------------------------------------------------------------------------------------------------------------|
| `id`                               | INTEGER PK | no       | Surrogate; referenced by `merged_from_anonymous_identity_id` on the 4 score tables                              |
| `anonymous_identity_id`            | INTEGER FK | no       | FK → `anonymous_identities.id`. On reversal, that row flips back to `status='active'`.                          |
| `target_discord_user_id`           | TEXT       | no       | The real Discord user the scores are being attributed to. Must exist in `user_mappings` at merge time.          |
| `admin_discord_user_id`            | TEXT       | no       | The admin who approved the merge. Required for audit chain. Players self-claiming still produces an admin-sourced row via auto-approval when eligible — see §4.2. |
| `created_at`                       | TIMESTAMP  | no       | DEFAULT CURRENT_TIMESTAMP. Merge moment.                                                                         |
| `reversed_at`                      | TIMESTAMP  | yes      | NULL until reversed. Set once and never cleared (re-merging produces a new record).                             |
| `reversal_admin_id`                | TEXT       | yes      | Admin who reversed. NULL iff `reversed_at` NULL.                                                                 |
| `score_ids_snapshot`               | TEXT (JSON)| no       | Canonical shape below (§2.1). The authoritative list of rows the merge TOUCHED — used verbatim on reversal.     |
| `reason`                           | TEXT       | yes      | Free-text, optional. Surfaced in audit chain + activity log.                                                     |

### 2.1 `score_ids_snapshot` shape

```json
{
  "submissions":      ["room-1-7-justin", "room-1-12-justin"],
  "community_scores": [42, 43, 57],
  "score_history":    [1011, 1012, 1013, 1014],
  "global_scores":    ["uuid-a", "uuid-b"],
  "frozen_tournament_ids_at_merge": ["tournament-uuid-5"]
}
```

- Keys are the 4 score tables. Values are arrays of primary keys (text for `submissions`/`global_scores`, integer for the other two).
- `frozen_tournament_ids_at_merge` captures the set of `submitted_during_tournament_id` values where the tournament had `status='completed'` at merge time. On reversal, rows pointing at any ID in this set **stay** at their post-merge attribution.
- Snapshot is written inside the same transaction as the UPDATE statements, so it exactly mirrors what was moved.
- Schema change is zero — JSON blob — so no migration needed beyond `053`.

### 2.2 Invariants (enforced at service layer, not DB)

1. `reversed_at IS NULL` or `reversal_admin_id IS NOT NULL` — you cannot reverse without naming the admin.
2. `merged_from_anonymous_identity_id` on score rows is immutable (already guarded by `SubmissionContextService.assertNotMutating()`). Merge/reverse are the only paths that mutate it, and they do so via direct SQL that the guard does not check — the guard protects against accidental UPDATEs elsewhere.
3. On reversal, `submitted_by_anonymous_name` on each score row is UNTOUCHED. That field captures who the submitter typed at submission time and never changes. This is the §15 "preserve original name" rule.
4. A reversed record can be re-merged, but that produces a brand-new `merge_records` row. The old one stays with `reversed_at` set. Audit chain is append-only.

---

## 3. Freeze rule — the tricky bit

**Plain English:** Once a tournament is `completed`, attribution on its scores is frozen at whatever it was when the tournament closed. Neither a merge nor a reversal can move those rows.

**Why it exists (§15):** Completed tournaments have podium winners, prize allocation, ranking groups. If a merge or reversal could retroactively reshuffle those scores, the historical record becomes unstable. Sprint 11's preview UI must show affected-but-frozen rows so admins know what will NOT move.

### 3.1 When merge runs

```
FOR EACH row matching (anonymous_identity → scope filter):
  IF row.submitted_during_tournament_id IS NULL
     OR tournaments[row.submitted_during_tournament_id].status != 'completed':
    UPDATE submitted_by_user_id = target_user_id
    UPDATE merged_from_anonymous_identity_id = merge_record.id
    PUSH row.id to snapshot[table]
  ELSE:
    # Frozen — do nothing. Row keeps submitted_by_user_id = NULL.
    # Optionally push to a snapshot.frozen_untouched[] for preview only (not used on reversal).
```

### 3.2 When reversal runs

```
FOR EACH row listed in snapshot[table]:
  IF row.submitted_during_tournament_id IN snapshot.frozen_tournament_ids_at_merge:
    # Tournament completed BETWEEN merge and reversal — freeze applies
    skip
  ELSE:
    UPDATE submitted_by_user_id = NULL
    UPDATE merged_from_anonymous_identity_id = NULL
```

**Edge case — tournament completes between merge and reversal:**
Snapshot captured the tournament IDs that were completed *at merge time*. On reversal, we recompute: any tournament currently `completed` that WASN'T in `frozen_tournament_ids_at_merge` is still frozen (it completed post-merge with the new attribution intact). Reversing it would corrupt its closing record.

Rule: on reversal, a row stays put if EITHER
- its tournament was frozen at merge time (in the snapshot), OR
- its tournament is frozen at reversal time (fresh check).

Surface this in the reversal preview: "N rows will stay with the target user because their tournament closed after the merge."

### 3.3 Edge case — a row submitted post-merge under the target user

If, after the merge, the now-logged-in user submits a new score to the same game, that row has `submitted_by_user_id = target_user_id` but `merged_from_anonymous_identity_id = NULL`. It is NOT in the snapshot. Reversal ignores it. ✓ Correct — those are the user's own legitimate logged-in submissions, not merge artifacts.

---

## 4. Flows

### 4.1 Admin-initiated merge

1. Admin visits `/:slug/admin/identity`, sees list of anonymous identities from `anonymous_identities WHERE status='active' AND room_id = ?`.
2. Admin picks an identity, selects a target Discord user (typeahead from `user_mappings` for the room).
3. Admin clicks Preview → client calls `POST /api/rooms/:roomId/admin/merges/preview` with `{ anonymousIdentityId, targetUserId }`. Server runs the scope filter and returns `{ willMove: [...], frozenStay: [...], totalRows: N }` plus the tournament-completed list. No writes.
4. Admin reviews, optionally enters `reason`, clicks Confirm → `POST /api/rooms/:roomId/admin/merges` with `{ anonymousIdentityId, targetUserId, reason, previewTokenOrSnapshotHash }`.
5. Server re-runs the scope filter inside a transaction. **Bail-out rule:** if the set of rows changed between preview and confirm (new submissions arrived, tournament status flipped), server returns `409 Conflict` with the refreshed preview. Admin must re-preview.
6. On success: `merge_records` INSERT, 4-table UPDATEs, `anonymous_identities.status = 'merged'`, cache invalidation, activity log event, optional Discord DM to the target user ("A room admin attributed N old scores to your account. Review: <link>").

### 4.2 Player-initiated self-claim (from Sprint 10)

The OAuth return path in Sprint 10 detects a Discord-nickname collision against an anonymous identity. When the user clicks "Log in," the server auto-creates a `merge_records` row where `admin_discord_user_id = target_discord_user_id` (self-claim). No admin intervention; freeze rule still applies. This is the expected happy path for most claims — the explicit admin flow is the escape hatch.

### 4.3 Reversal

1. Admin opens a merge record from `/:slug/admin/identity` audit list. Preview renders:
   - Scores that WILL return to anonymous (green).
   - Scores that will STAY with the target because their tournament is frozen (grey, with tooltip explaining "this tournament closed on <date>, 30 days after the merge").
   - Post-merge logged-in scores that the merge never touched (not shown — they're not part of this record).
2. Admin confirms, enters optional reason → `POST /api/rooms/:roomId/admin/merges/:mergeId/reverse`.
3. Server walks the snapshot, applies the freeze check, UPDATEs rows back, sets `reversed_at` + `reversal_admin_id`, flips `anonymous_identities.status = 'active'`, cache invalidation, activity log entry, optional DM.

### 4.4 No time limit on reversal

Per §15. A merge from 6 months ago can be reversed today. The freeze rule is the safety net — the longer a merge sits, the more tournaments will have completed under its attribution, the more rows the reversal will leave in place.

---

## 5. Reversal UI wireframe

Page: `/:slug/admin/identity`

```
┌──────────────────────────────────────────────────────────────────────┐
│  Identity Management                    [Pending claims (3)] [Audit] │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ▼ Pending Claims (3)                                                │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  "TheWizard"  — 14 scores, last seen 2 days ago                │ │
│  │   Potential match: @thewizard#1234 (nickname: TheWizard)       │ │
│  │   [Preview merge →]                              [Ignore]       │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ▼ Audit chain                                         [Filter ▾]    │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  2026-04-03  admin @justin  →  merged "Anon42" → @realJustin   │ │
│  │  Reason: "nickname match confirmed via DM"                      │ │
│  │  12 scores moved · [View] [Reverse]                             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  2026-03-28  admin @justin  →  merged "ghost" → @keithV (REVERSED 2026-04-01) │ │
│  │  [View] [Audit chain ↓]                                         │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

Reversal confirmation modal:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Reverse merge: "Anon42" → @realJustin                          [X]  │
├──────────────────────────────────────────────────────────────────────┤
│  This merge happened 14 days ago. Reversing will:                    │
│                                                                      │
│  ✓ Return 9 scores to anonymous "Anon42"                             │
│    • 6 submissions, 3 community scores                               │
│                                                                      │
│  ⚠ Leave 3 scores with @realJustin (their tournament has closed)     │
│    • Weekly Pinball #47 (closed 2026-04-02): 2 scores                │
│    • Daily Grind #112 (closed 2026-04-04): 1 score                   │
│                                                                      │
│  Reason (optional): [_____________________________________]          │
│                                                                      │
│                                  [Cancel]  [Reverse merge]           │
└──────────────────────────────────────────────────────────────────────┘
```

**Styling:** Tailwind, no new components beyond `DataTable` + `NeonButton`. Themed per room admin theme.

---

## 6. API surface (for Sprint 11)

All live under `/api/rooms/:roomId/admin/*` and require `requireAuth + requireRoomAccess`.

```
GET   /admin/identity/queue               → active anonymous identities with match hints
GET   /admin/identity/audit?limit=50      → merge_records for this room, most-recent first
POST  /admin/identity/preview             → { anonymousIdentityId, targetUserId } → preview bundle (no write)
POST  /admin/identity/merge               → { anonymousIdentityId, targetUserId, reason?, previewHash } → { mergeId }
POST  /admin/identity/:mergeId/reverse    → { reason? } → { reversed: true, refrozen: N }
GET   /admin/identity/:mergeId            → single record with snapshot detail for audit drill-down
```

The `previewHash` is a stable hash of the preview response body. Server computes it on preview, returns it. On merge confirm, client sends it back. If the preview would now produce a different hash, server returns 409. This is the "bail out if state drifted" mechanism without requiring optimistic locking on every row.

---

## 7. Out of scope for Sprint 11

- Cross-room merges. An anonymous identity is room-scoped (`anonymous_identities.room_id`). A claim can't pull scores from other rooms. If the same nickname is anon in multiple rooms, each one needs its own merge.
- Auto-merge on login. Sprint 10 handles the explicit prompt; Sprint 11 is admin tooling and audit. No "silently attribute everything matching my nickname" flow.
- Rolling up `merge_records` into a single identity view across time. The audit chain is a linear record list; "show me everyone who's ever been merged into @justin" is a future feature if needed.
- Modifying `submitted_by_anonymous_name` or `submitted_from_room_id`. These are immutable per Sprint 1 invariants. The only mutable context field via merge is `submitted_by_user_id` + `merged_from_anonymous_identity_id`.

---

## 8. Review checklist for Sprint 11 sign-off

When Sprint 11 ships, verify against this doc:

- [ ] `MergeService.recordMerge()` writes a `merge_records` row whose `score_ids_snapshot` exactly matches the UPDATE'd rows (integration test).
- [ ] Freeze rule honored both directions (merge and reverse).
- [ ] Preview → confirm bailout on state drift (409).
- [ ] Reversal preview shows frozen rows distinctly.
- [ ] Self-claim from OAuth creates a `merge_records` row with `admin_discord_user_id == target_discord_user_id`.
- [ ] Sync-alias rename (existing `merge-player` route) still works on non-anonymous rows. UI label changed to "Sync-alias rename."
- [ ] `anonymous_identities.status` transitions: active → merged (on merge), merged → active (on reversal).
- [ ] Leaderboard + Ranking caches invalidated on both paths.
- [ ] `SubmissionContextService.assertNotMutating()` does NOT fire on merge/reverse (direct SQL bypass is intentional; guard is for accidental elsewhere).
- [ ] Activity log entries for both actions, with admin, timestamps, counts.
