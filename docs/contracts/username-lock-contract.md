# Contract: username lock + identity-resolved reads (v2.54.0)

Re-implementation of **PR #130** onto current main. That PR was authored against a pre-v2.50.0
baseline (798 backend tests) and has since collided with four shipped releases — most sharply with
ADR 0016 Phase 1 (v2.53.0), which rewrote the same submit handlers, schemas, and submission form.

**Reference diff: `tmp/pr130-reference.diff`** (the full PR #130 patch, saved locally). Treat it as a
**specification and a source of prose/comments to reuse — not as a patch to apply.** Several hunks no
longer have anchors.

Do NOT `git apply` it. Do not check out or rebase `username-lock`.

## The bug being fixed

Field report: a Discord-logged-in user typed a fake name ("Chode_Farmer") into the submit modal and
saw **their real name on the leaderboard card but the fake name on the ticker and All Score History**.
A second tester with no global display name set saw the fake name everywhere.

Root cause: leaderboards partition by `submitted_by_user_id` and join `user_profiles`, while the
history and community reads shipped raw `iscored_username` with no identity join. Separately, the
community Best Scores board grouped by raw typed name, letting one user hold ranks 1–10 under
different names.

## Product decision (from #130, keep it)

**Renames happen in Account Settings, not in the score modal.** An authenticated submitter's posted
`username` is discarded and resolved server-side. Guests are unchanged — free-text name plus
first-claim-wins stays, and a missing guest name still 400s.

## Work

### 1. `UserProfileService.resolveSubmitName` — port near-verbatim
No Phase 1 overlap. Take the implementation and its doc comment from the reference diff as-is.
Resolution order: already-claimed name in scope (`room_members.display_name` for room scope, first
`user_mappings` alias for global) → `user_profiles.display_name` → JWT `username` claim →
`discordUserId`. Room paths still route through `RoomNameClaimService.resolveAndClaim`, so a
first-time claimant whose canonical name is taken in that room still gets the `_N` suffix.

### 2. Identity-resolved reads — port near-verbatim
`ScoreHistoryService` (`getGameHistory`, `getGameSubmissions`, `getPlayerGameHistory`) and
`CommunityScoreService` (`getGameHistory`, `getRecentActivity`) ship `display_name` via the standard
`user_mappings` → `user_profiles` join documented in CLAUDE.md. The FE already renders the fallback —
only the columns were missing.

`CommunityScoreService.getGameLeaderboard` collapses by the three-leg identity key: one rank per user
(best-score row's alias via `ROW_NUMBER`), `times_played`/`last_played` aggregated across aliases, new
`player_key` field for the FE row key.

⚠️ Phase 1 modified `CommunityScoreService`'s **write** path (engine/device). Reads are untouched, but
re-read the file as it exists now rather than assuming the reference diff's line numbers.

### 3. Collision points — these need judgement, not merge resolution

**`src/api/schemas.ts`** — #130 makes `username` optional on the three room submit schemas. Phase 1
spread `scoreProvenanceFields` (engine + device, required) into all four. Both must hold: `username`
optional, engine/device required. Verify all four schemas end up correct, including
`GlobalScoreSubmissionSchema`.

**`src/api/routes/rooms.ts`** — the three submit handlers (`/submit-score`, `/freeplay-score`,
`/community-scores`) now open with `ensureProvenanceAllowed` returning a discriminated union
(`ok: true` carries `engine`, `device`, `platform`). Add name resolution alongside it. Do not
reintroduce any "null means allowed" pattern.

**`src/api/routes/global.ts` — `POST /global/scores`** — #130's hunk will NOT apply. It was written
when this route parsed the body inline; Phase 1 replaced that with `GlobalScoreSubmissionSchema`.
Re-express the intent inside the Zod world: the `displayName` body field is ignored entirely, and the
`user_mappings` alias claim can only ever register a **canonical** name (pre-lock, any typed name
became a permanent alias of the account). Drop the old 409 "name taken" — with no name field it's a
dead end; a foreign-owned resolved name simply skips the alias write, which is cosmetic since
partitioning is by user id.

**`admin-ui/src/components/SubmissionSheet.tsx`** — the real design interaction. The form must now
carry **both** #130's read-only "Playing as {name}" chip (with a link to Account Settings) for
authenticated viewers **and** Phase 1's engine + device pickers. Guest flow keeps the free-text name
field plus engine/device. Suggested order: name (chip or input) → engine → device. The pre-submit
name-collision prompt is skipped for authed users (the server suffixes; the success card shows the
final name). Keep Phase 1's device memory (`arcaid_last_device`) working.

**`admin-ui/src/pages/GameDetail.tsx`** — port #130's change; no Phase 1 overlap.

### 4. Out of scope — preserve as ROADMAP entries (#130 did)
- `POST /submission-drafts/:stateParam/commit` still commits under the guest-typed draft name after
  the OAuth handoff — entangled with the self-claim merge sweep; needs its own design decision.
- Guest multi-name collapse (identity unknown; admin merge remains the remedy).

## Tests
- Port #130's four `resolveSubmitName` tests; extend for the global scope path.
- An authenticated submit ignores a posted `username` and records the resolved name — one test per
  route (3 room routes + global).
- Guest submit is unchanged: free-text name honoured, missing name still 400s.
- History and community reads ship `display_name`; the community leaderboard yields one row per user
  across multiple aliases.
- Engine/device still validate and record on all four routes (Phase 1 regression guard).
- Baselines stay green: backend **843**, admin-ui **193**.

## Gates
Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD) · **no commit/branch/push**.

Version → 2.54.0 (#130's `package.json` hunk says 2.50.0 — that version shipped; ignore it).

## Blockers policy
STOP and report if a #130 change cannot be expressed against current code without altering its intent
— that's a design question, not something to improvise. Do not touch tournament rules or read paths
beyond those named above (engine/device P2/P3 scope).
