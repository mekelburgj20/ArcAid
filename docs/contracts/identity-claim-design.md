# Claiming iScored names, verifying scores, and letting them reach the global board

Owner ask, 2026-08-17. Design brief — NOT yet built.
Prompted by the ChalataLove double-entry found during the pick-delegation investigation.

---

## 0. The thing to fix first: self-claim is currently unguarded

`/map-user` (`src/discord/commands/mapuser.ts:36`) requires Administrator **only when mapping
someone else**. Mapping *yourself* is unguarded:

```ts
// Optional: Add admin check if mapping *other* users
if (targetUser.id !== interaction.user.id) { ...admin check... }
```

So **any Discord user in the guild can claim any unclaimed iScored username**, with no
name-similarity check and no approval. The only rejection is if the name is already mapped to
a *different* Discord user.

That is not cosmetic. `user_mappings` feeds `resolveSubmissionPlayerId`, the leaderboard
partition key, `IdentityCandidateService.playerKeys`, and — after this session's work — the
**pick cascade**. Claiming a name absorbs that name's scores into your identity for ranking,
stats, and now for who is offered the next pick.

The owner's instinct ("claims that don't near-match should need mod approval") closes exactly
this hole. It should ship as a security fix in its own right, ahead of the rest.

---

## 1. What already exists ("I think we had this mechanism before")

Half-true. The parts exist; they are not connected, and the claim part is unguarded.

| Piece | What it does today | Gap for this ask |
|---|---|---|
| `user_mappings` | iScored name → Discord user. Many-to-one; UNIQUE (case-insensitive) on the name. | No provenance, no approval state, no record of *how* the claim happened. |
| `/map-user` | Self-service claim of any unclaimed name; admin only to map others. | **No similarity check, no approval — see §0.** |
| `MergeService` | Merges rows onto an account, with a snapshot + full reversal. | Scoped to **anonymous** rows (`submitted_by_user_id IS NULL AND submitted_by_anonymous_name = ?`). Synced rows carry `iscored:<name>`, so they are out of scope. |
| Admin sync-alias rename (`MergeService.previewRename`) | Admin renames a sync alias across a room's rows. | Admin-driven repair tool, not a player claim flow. |
| `score_history.verified_at` / `verified_by` + `POST /:roomId/score-history/:id/verify` | A mod marks a score verified; `is_verified` already surfaces on leaderboards. | **Mod-only by design** — see §4 open question 1. No player-submitted photo path. Verification has no effect on global fan-out. |
| `GlobalScoreService.fanOutFromRoomSubmission` | Hard-rejects `source='sync'` (ADR 0016 P2 §3c). | This is the contract the ask amends. |
| `JoinRequestService` | Approval queue with auto-approve, audit rows, degrade-to-manual. | The right shape to copy for claim approval. |
| `RoomNameClaimService` | First-claim-wins *room display names*. | Different axis — room naming, not iScored identity. |
| `IdentityLinkService` / `IdentityCandidateService` | Expand a user to all their ids + aliases. | Read-side only. |

**Doctrine to respect:** `IdentityLinkService`'s comment is explicit that login-identity links
(Discord ↔ Google) and iScored game-handle aliases are two unrelated axes that must never be
conflated. A claim flow lives on the *alias* axis only.

---

## 2. Proposed shape

### P1 — Guarded self-claim (security fix, ship alone, small)

`POST /api/rooms/:roomId/identity/claims` — a logged-in player claims an unclaimed iScored name.

Resolution:
- **Near-match** to any name the claimant already answers to (their display name, room name,
  existing aliases) → **auto-approve**, write `user_mappings`, audit it.
- **Otherwise** → a **pending claim** row for mod review. Nothing moves until approved.
- **Already mapped to someone else** → reject outright (today's behavior, kept).

`/map-user` self-service is routed through the same service so there is one gate, not two.
Admin-mapping-others stays as-is.

New table `identity_claims(id, game_room_id, claimant_user_id, iscored_username,
status, resolved_by, resolved_at, created_at)` — mirrors the join-request queue.

### P2 — Duplicate-name prompt at submit time

At submit, if the name being used matches an existing **unclaimed** iScored identity carrying
scores in that room, prompt: *"There are already scores here under ChalataLove, synced from
iScored. Is that you?"* → offers the P1 claim. This is the owner's "next score submit should
prompt them to claim".

Cheap read: one lookup for an `iscored:<name>` identity with rows in the room and no
`user_mappings` entry.

### P3 — Photo-verified promotion to the global board

Today a synced score can never reach `/scoreboard`. Proposed: it can, if **both** hold —
1. the score's iScored name is **claimed** by the viewer (P1), and
2. that specific score row carries **photo evidence** and is verified.

Mechanism: the claimant re-submits the score with a photo against the existing
`score_history` row → sets `verified_at` → the row becomes fan-out eligible.

**This amends ADR 0016 P2 §3c.** The current rule is a deliberate, absolute bar with the
enforcement point in `fanOutFromRoomSubmission` and a comment saying it must survive a future
caller re-adding a sync path. Amending it needs a new ADR, not a quiet `if`. The replacement
rule must stay expressible at that same single enforcement point.

Note also ADR 0016 §3b: synced scores are stamped `engine='unknown'`/`device='unknown'` with
**no inference, ever**. The global board's provenance tags assume real values, so a promoted
score needs the claimant to supply engine + device at verification time — otherwise the global
board gains rows it cannot describe.

### P1b — Auto-match sources and the alias cap (owner, 2026-08-17)

A user may hold **at most 3** iScored aliases, managed from their Arcaid account settings.

A claim **auto-approves** when the requested iScored username matches — **case-insensitively,
and by nothing else** (§4 Q2: separators and spaces are NOT normalized) — any of:

1. their **Arcaid username**;
2. their **Arcaid display name** (`user_profiles.display_name`);
3. an **iScored alias they already hold** (`user_mappings`, so alias 2 and 3 can ride in on
   alias 1);
4. their **linked Discord username**;
5. their **linked Google account username** — local-part only, i.e. everything before `@`, so
   `chalatalove@gmail.com` matches `ChalataLove`. Never match on the domain.

Sources 4 and 5 read through `IdentityLinkService` / `BanService.expandIdentityCandidates`,
which is already the declared single source of truth for the login-identity link graph — do
not re-derive it. Note the standing doctrine that login links and game-handle aliases are
separate axes: this reads the link graph to *decide* a claim, and still writes the result to
`user_mappings` only.

Anything else → mod queue (P4).

### P1c — Fan-out requires the room to require photos (owner, 2026-08-17)

A room that does **not** set `REQUIRE_SCORE_PHOTO` may not fan out to the Global Scoreboard at
all — not just for claimed iScored scores, for **any** score. Photo evidence is the price of
admission to the public board.

Enforcement belongs at the existing single chokepoint,
`GlobalScoreService.fanOutFromRoomSubmission`, beside the `source='sync'` rejection.

**Live impact: none today, verified 2026-08-17.** The only room currently feeding the Global
Scoreboard is `rtx_pinball` (all 35 `global_scores` rows), it already has
`REQUIRE_SCORE_PHOTO = 'true'`, and all 35 rows already carry a photo. The other four rooms
have the setting unset and contribute nothing. So this lands inert and only constrains future
rooms.

**Still to decide:** whether existing `global_scores` rows from a room that later turns the
setting OFF are removed, hidden, or grandfathered. Recommend grandfathering — the score was
legitimately earned under the rules in force at the time, and retroactive deletion is the kind
of thing that erodes trust in the board.

### P4 — Mod review queue

Room-admin page listing pending claims: claimant, requested name, that name's score count in
the room, and why it wasn't auto-approved. Approve / deny, both audited.

---

## 3. Sequencing

Revised after the Q2 ruling. Exact-match-only means most real claims land in the queue, so the
review UI is no longer a follow-up — it is part of the first shippable unit.

1. **P1 + P4 together**, as the security fix. The guard is worthless if pending claims have
   nowhere to be resolved, and with case-only matching that is the common path, not the rare
   one. Closes §0.
2. **P2** — cheap once P1 exists, and it is what actually surfaces the flow to players.
3. **P3** last — the only piece needing an ADR amendment (0016 P2 §3c) plus an answer on
   engine/device provenance for a promoted score (§2 P3) and on the mismatched-photo case (Q4).

---

## 4. RESOLVED (owner, 2026-08-17)

**Q1 — no mod gate. The claimant's own photo is enough.** SETTLED, and the owner's premise was
verified against the code before accepting it:

- **No score anywhere is mod-gated before publication.** Web submissions land on the
  leaderboard immediately; `REQUIRE_SCORE_PHOTO` (`rooms.ts:265`, `:2254`) can require a photo
  to *exist*, but nothing inspects it. The whole system is self-reported honour system.
- **Photos are public.** `ScorePhotoModal` opens from the scoreboard row body and from
  `GameQuickView` — any viewer can inspect the evidence.
- **Reporting already exists.** `POST /:roomId/score-history/:historyId/report` and its global
  sibling `POST /api/global/scores/:scoreId/report` write to `score_reports` (migration 134,
  with a `score_source` discriminator). Login-required and rate-limited.
- `verified_at` is therefore an **optional after-the-fact badge**, never a gate — which is why
  requiring it for promotion would have made claimed-and-photographed scores *stricter* than
  ordinary web submissions, for no reason.

So P3 requires: name claimed + photo attached. No mod in the loop. Mods act after the fact
through the existing report → unverify → delete path, exactly as they do for every other score.
The mod-only restriction on `POST .../verify` stays as-is for the *badge* — it is a different
thing from promotion and is not being loosened.

**Q2 — near match is CASE-INSENSITIVITY ONLY.** SETTLED. `ChalataLove` = `chalatalove`
auto-approves. Separators and spaces are **not** normalized: `Chalata_Love` and
`Chalata Love` go to the mod queue. This is the strictest of the three options considered, so
the mod queue (P4) has to exist before the manual path carries real volume — see §3 sequencing.

**Q3 — retroactive or forward-only?**
When a name is claimed, do that name's **existing** synced scores become promotable to global
once photo-verified, or only scores submitted after the claim? Retroactive is what the owner
seems to want (ChalataLove's Blackbelt score is exactly this case) but it means old rows can
appear on the global board dated in the past.

**Q5 — can we import the photo from iScored? Mostly no. Investigated 2026-08-17.**

- **The read API cannot give it to us.** `IScoredApiScore` is `{ name, date, rank, score }` —
  there is no image field, so `getGameScores` will never return a photo no matter what iScored
  stores.
- **iScored does accept photos on submit.** `IScoredClient.submitScore(gameId, username, score,
  photoPath?)` uploads one through the Playwright path, so iScored has somewhere to put an
  image and presumably renders it.
- **So a DOM scrape is the only candidate route**, and nothing in `scrapePublicScores` reads an
  image today. It would be new, fragile scraping against a layout we already log warnings about
  when it shifts (`IScoredClient.ts:300`).
- **Note the live counter-example.** For the ChalataLove score there was no iScored-side photo
  to fetch anyway: he entered the score in *Arcaid*, and Arcaid pushed the number to iScored.
  The photo only ever existed on the Arcaid side. That is likely the common shape for any room
  using Arcaid as the front end, which limits what an importer would actually recover.

Recommendation: do not build the scrape. For a claimed synced score, ask the claimant to attach
the photo — which is the P3 flow anyway.

**Q4 — the mismatched-photo case, found live.**
ChalataLove's winning row already carries a photo — but of the *lower* number: they typed
`358,884,390` into Arcaid and `3,588,843,950` into iScored, and the sync overwrote the score
while keeping the web row's photo. Under P3 that row would auto-qualify as "photo-verified"
while the photo does not show the score. Verification therefore cannot be a mere
"is photo_url non-null" check.
