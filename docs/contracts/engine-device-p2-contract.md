# Contract: Engine + Device — Phase 2 (tournament rules + iScored provenance integrity)

Implements **ADR 0016** (`docs/decisions/0016-engine-device-score-provenance.md` — read it in full
first). P1 (v2.53.0) shipped the taxonomy + writes; P3 (v2.58.0) moved reads onto engine/device; P4
(v2.59.0) shipped per-category cards. **P2 is the last and riskiest phase**: it moves *tournament
rules* onto the two axes, and it closes the iScored data-integrity hole those cards exposed.

Work the sections **in order**. Section 1 is a structural prerequisite — doing 2–4 first means making
the same change in ten places and hoping.

---

## 0. The hazard, stated plainly

**Inventory corrected 2026-07-31** during Section 1 implementation. An earlier revision of this table
listed 10 sites, of which one (`database/database.ts:1429`) is in fact a migration, and it omitted
`services/ScoreProvenanceService.ts` — the P1 submission authority, and the single highest-consequence
reader of the blob — plus the two migration parses in `platformTaxonomyExpansion.ts`. Verified counts:

**10 RUNTIME parse sites** — all route through `parseTournamentRules`. Every one swallowed malformed
JSON into "no rules":

| File | Line | Gates |
|---|---|---|
| `discord/commands/pickgame.ts` | 62 | autocomplete choice list |
| `discord/commands/activategame.ts` | 81 | admin activation |
| `engine/TournamentEngine.ts` | 1462 | `autoPickAndActivate` eligibility |
| `engine/TimeoutManager.ts` | 311 | `fallbackToAutoSelection` eligibility |
| `api/routes/global.ts` | 1652 | `GET /api/submit/platforms` picker |
| `api/routes/rooms.ts` | 520 | game-availability catalogue filter |
| `api/routes/rooms.ts` | 770 | web `pick-game` gate |
| `api/routes/rooms.ts` | 777 | its rejection message — **re-parsed the same row as 770** |
| `api/routes/rooms.ts` | 2912 | admin `activate-game` gate |
| `services/ScoreProvenanceService.ts` | 219 (via `:70`, `:108`) | **every** server-side submission validation |

**3 MIGRATION parses — deliberately EXEMPT**, left as raw `JSON.parse` with a comment at each. A
migration is a frozen transform of the shape that existed when it was written; routing it through a
parser that will start lifting shapes in Section 2 would change what it persists:

| File | Line | Migration |
|---|---|---|
| `database/database.ts` | 1429 | 101 — strips dead sub-cabinet entries |
| `database/migrations/platformTaxonomyExpansion.ts` | 109 | 083 — platform rename |
| `database/migrations/platformTaxonomyExpansion.ts` | 349 | 089 — alias fold |

"No rules" means **a tournament that restricts nothing**. A shape change that trips any one of the
runtime sites degrades that path to wide-open, silently, in production. That is why Section 1 comes
first.

---

## 1. Centralise the parse (do this before anything else)

Add one parser — `parseTournamentRules(row)` in `src/utils/platformRules.ts` — and route **all 10
runtime sites** (see the corrected table above; the 3 migration parses stay raw) through it.
Requirements:

- On malformed JSON it **logs a warning naming the tournament id** and then returns the empty-rules
  value. Degrading is still the right behaviour; degrading *invisibly* is not.
- `rooms.ts:770` and `:777` must parse once and share the result. Two parses of one row is how the
  two lines drift apart.
- No behaviour change in this section. Land it as its own commit so the diff for Sections 2–4 is
  legible — a reviewer must be able to see the rule-shape change without ten call-site edits on top.

A test per site is **mandatory** — for each of the 10, assert the rules it resolves actually gate the
behaviour that site controls. Without this, a site silently degraded to wide-open looks identical to a
site working correctly.

---

## 2. Rule shape on two axes

Current shape is flat over the legacy platform namespace:
`{ required: string[], excluded: string[], restrictedText?: string }`.

New shape carries both axes, each keeping ADR 0009's orthogonal semantics:

```
{
  engines: { required: string[], excluded: string[] },
  devices: { required: string[], excluded: string[] },
  restrictedText?: string
}
```

Semantics are unchanged and must stay unchanged — this phase changes the *namespace*, not the rules:

- **`required` → game-level eligibility only.** Does the game have at least one of these? Decides
  which games qualify. Does **not** restrict who can submit.
- **`excluded` → submission-level filter only.** Strips options from the picker and is re-validated
  server-side. Does **not** affect eligibility.

Both `passesplatformRules` and `resolveSubmittablePlatforms` evaluate each axis independently and
combine with AND: a score must satisfy the engine rules *and* the device rules.

### The shim is mandatory, not optional

~200 live rooms have tournaments whose stored rules are in the flat legacy shape. **Do not migrate the
rows and do not clean-break.** `parseTournamentRules` detects the legacy shape and lifts it into the
new one at read time via `LEGACY_PLATFORM_MAP`, mapping each legacy platform id to its engine and/or
device. Writes emit the new shape. A row is upgraded only when an admin next saves that tournament.

Where a legacy id maps to *both* axes (e.g. `vpxs` → engine `vpx` + device `atgames`), the lift must
put it on both — dropping the device half would quietly widen an existing restriction.

**State in your report which legacy ids lift to which axes.** That mapping is the part most likely to
be subtly wrong, and it is invisible in the diff.

### Admin UI

`TournamentForm`'s platform section becomes two controls — engines and devices — each with its
Must/Not-allowed pair. Keep the existing plain-language labels ("Must be available on" / "Not allowed
on"); they tested well and the semantics behind them have not changed.

---

## 3. iScored provenance

Decided with the user: **iScored scores sync for tournament games only, are classified where the data
supports it, and never reach the Global Scoreboard.**

### 3a. Tournament-only — already true, needs a lock

`ScoreSyncPoller.findLocalGameForIscoredId` already uses `JOIN tournaments t ON t.id = g.tournament_id`
— an INNER JOIN, so pinned games (`tournament_id IS NULL`) can never be matched. **Nothing to build.**
Add a test asserting a pinned game with an `iscored_id` is not matched, so this cannot regress into a
LEFT JOIN later.

### 3b. No inference, ever — synced scores are always `unknown`

Decided by the product owner 2026-07-31, superseding an earlier design in which provenance was
derived from tournament rules: **do not attempt to determine or infer where an iScored score was
played.** iScored is a migration stopgap, not a long-term integration; building inference machinery on
top of it invests in a path the product intends to retire. A player who wants a score on the Global
Scoreboard enters it in Arcaid.

Concretely:

- Both iScored import paths stamp `engine = 'unknown'`, `device = 'unknown'` unconditionally.
- **Stop reading `tournaments.iscored_default_engine` / `_device`.** Remove them from
  `ScoreSyncPoller.findLocalGameForIscoredId` (~332–333) **and** from `TournamentEngine` (~214, ~313,
  ~422–423, ~463–464, ~948–949). Leave the columns in place — SQLite drops need a table rebuild and
  these are inert once unread — but leave a comment at the migration that added them
  (`engineDeviceProvenance.ts:76-77`) recording that they are vestigial and why.
- No admin UI, no per-tournament default, no backfill action. Do not build them.
- Leave `iscored_default_platform` alone; it stays derived.

**There are two import paths and both matter.** `ScoreSyncPoller` (continuous) and
`TournamentEngine.finalSyncScoresForGame` (final sync on deactivate/delete, ~line 415) each pull from
iScored. Only the poller fans out to global today; the final-sync path already does not. Do not
"fix" the final-sync path by adding a fan-out.

### 3c. No global fan-out from sync — enforce at the service

Two changes, both needed:

- Remove the `GlobalScoreService.fanOutFromRoomSubmission` call and its `emitScoreNewGlobal` at
  `ScoreSyncPoller.ts:483`.
- **Add a `source` parameter to `fanOutFromRoomSubmission` and have it reject `'sync'`.** Removing the
  call alone is a change a future caller can undo by accident; the invariant belongs where it cannot
  be bypassed. This is the load-bearing half — do not skip it because the call is already gone.

The exclusion is **unconditional** and, given 3b, has no edge cases left: nothing about a synced score
can ever qualify it for the global board.

### 3d. Clean up the rows already there

Add a migration (claim the next free number in `database.ts`). **Order matters: run it after 3b's
derivation is in place**, so rows the new logic can classify are re-stamped rather than deleted.

Two cleanups, one migration:

1. **Sync-origin rows in `global_scores`.** 6 `score_history` rows have `source='sync'`.
   `global_scores` has **no `source` column**, so sync-origin global rows can only be identified by
   matching `(game, username, score)` against sync-origin history. Delete them, so 3d's invariant is
   true from day one rather than "true going forward".
2. **All remaining unknown-engine scores** — across `score_history`, `submissions`,
   `community_scores` and `global_scores`. The product owner confirmed (2026-07-31) that ArcAid is
   pre-GA with no scores worth preserving: *"There are no 'real scores' in Arcaid yet… You can wipe
   whatever score you want without consequence."* This supersedes the earlier plan to keep the
   AtGames rows on ambiguity grounds.

Report the row count deleted per table.

**The pre-GA licence covers score data only.** It is not licence to bypass the delete discipline in
`database.ts`: FK enforcement is ON, and the known NO-ACTION refs (`submissions`/`score_history`
`.game_id`, `global_scores.global_game_id` / `origin_game_room_id`) still need unlinking or ordered
deletion per ADR 0005. A wipe that trips a constraint mid-migration on a real deploy is a worse
outcome than the untidy data it was cleaning.

---

## 4. Consequences to state in the report

**Rooms that run everything through iScored contribute nothing to the Global Scoreboard.** That
follows directly from 3c and is intended — iScored is a stopgap during migration, and a player who
wants a score to count globally enters it in Arcaid. It is still a real product effect and the report
must say so plainly rather than let a room owner discover it.

**The Global Scoreboard's "Unspecified" card probably stops rendering — do not delete it.** P4 built
it to hold the 38 `unknown` global scores. After 3d wipes those and 3c keeps synced scores out, the
only remaining source of an `unknown` global row is a web submission, and engine is required at the
API boundary. So the bucket likely goes empty in practice.

Keep it, keep its tests, and keep the coverage invariant asserting every score has a card. It is now a
safety net rather than a live surface — and removing a safety net because it is currently unused is
exactly how P4's silent-disappearance bug would come back. **Room-level** surfaces still render
Unspecified for real, since synced scores keep landing in `score_history`.

---

## Tests

- **Per-site rule resolution — one test for each of the 10 parse sites.** Non-negotiable.
- Malformed `platform_rules` logs a warning and degrades to empty rules (assert the log, not just the
  value — invisible degradation is the specific failure mode).
- Legacy flat rules lift correctly: a legacy id mapping to both axes restricts both.
- A legacy-shaped row and its lifted equivalent gate identically (same games eligible, same picker).
- Axes combine with AND; `required` never filters the picker; `excluded` never affects eligibility.
- Synced scores are **always** `unknown`/`unknown` — assert for **both** import paths
  (`ScoreSyncPoller` and `TournamentEngine.finalSyncScoresForGame`), including for a tournament whose
  rules permit exactly one engine. That last case is the one that would regress if someone
  reintroduces inference thinking it an improvement.
- Pinned game with an `iscored_id` is not matched by the poller.
- `fanOutFromRoomSubmission` rejects `source: 'sync'` — assert at the service, not via the poller.
- A synced score creates `submissions` + `score_history` rows and **no** `global_scores` row.
- Baselines stay green: backend **951**, admin-ui **263** (verified on `main` at time of writing).

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD) · **no commit/branch/push**.

## Blockers policy

STOP and report if: the parse-site sweep turns up **more than the 10 sites listed** (the inventory is
wrong and the risk assessment with it); any legacy platform id has no defensible lift to the two axes;
or the shim cannot make a legacy row gate identically to its lifted form. Do not redesign the
Must/Not-allowed semantics — ADR 0009 stands. Do not touch scores' `platform` column.
