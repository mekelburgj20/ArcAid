# Contract: per-player global fan-out governs uniformly (remove room-level gate) — v2.41.0

Reverses the room-level global-share control (v2.39.0 approval fan-out block + v2.40.0 `SHARE_TO_GLOBAL` toggle) in favor of the PRE-EXISTING per-submission `excludeFromGlobal` control, which already works for room submissions. Net simplification (mostly deletion). Branch `player-governs-global` off main (must be v2.40.0). NO migration.

## Context (verified)
The per-submission opt-out already works end-to-end for room scores: `SubmissionSheet.tsx` sends `excludeGlobal` on tournament + freeplay submits; `rooms.ts` submit-score (~:1447/1492) + freeplay-score (~:1567/1621) read it → `CommunityScoreService` → `GlobalScoreService.fanOutFromRoomSubmission(excludeFromGlobal)`. Default = post to global. The ONLY thing blocking private-room members from this is the room-level `join_policy==='approval'` + `SHARE_TO_GLOBAL` skip inside `fanOutFromRoomSubmission`.

## D1 — Remove the room-level fan-out gate

`src/services/GlobalScoreService.ts`:
- In `fanOutFromRoomSubmission` (~:385-400): DELETE the approval-policy + `SHARE_TO_GLOBAL` skip block. Fan-out is again governed ONLY by the pre-existing gates: guest early-return (`normalizeSubmitterUserId` null → return null — KEEP) and the `excludeFromGlobal` flag (KEEP — it already records the row with the flag / skips the public row per existing logic). Approval-room member scores now fan out by default, honoring their per-submission opt-out, identically to open rooms.
- DELETE now-unused helpers added for SHARE_TO_GLOBAL: `scrubRoomFromGlobal`, `backfillRoomToGlobal`, and the `PRIVACY_SCRUB_SENTINELS` constant (grep to confirm no other caller remains after the JoinPolicyService/GameRoomSettingsService edits below).

`src/services/JoinPolicyService.ts`:
- `handlePolicyFlip`: DELETE the open→approval global-scrub call. If that was the method's only body, reduce it to a no-op or remove the method + its call site in the settings-save path cleanly (verify nothing else depends on it — the join_requests/gate logic does not).

`src/services/GameRoomSettingsService.ts`:
- DELETE `handleShareToGlobalFlip` and its dispatch from `set`/`saveMany`/`delete` (~:139-185 region). Leave the `JOIN_POLICY` handling intact EXCEPT its now-removed scrub side-effect.

`admin-ui/src/pages/Settings.tsx`:
- REMOVE the `SHARE_TO_GLOBAL` toggle/control, its `DANGEROUS_KEYS` entry, and revert the flip-to-approval confirm copy to its pre-v2.40.0 wording (the approval flip no longer removes scores from the Global Scoreboard, so the confirm must NOT claim it does — state only the view-gating consequence: "This room becomes invisible to non-members until approved").

Grep the whole tree for `SHARE_TO_GLOBAL` after edits — zero references should remain (BE + FE).

## D2 — Verify (and lock in) approval-room submit is member-gated

The user requires: only approved members can submit scores to an approval room. This should already hold — the `roomVisibilityGate` covers the submit endpoints (`submit-score`, `freeplay-score`, `community-scores` are all `/:roomId/...` registered below the gate mount). Verify by reading the mount order, then add a test: a non-member (guest AND a logged-in non-member) POST to `/:roomId/submit-score` (and freeplay) on an approval room → 403; a member → allowed. If (unexpectedly) a submit path is NOT gated, STOP and report as a blocker with the exact route — do not silently add ad-hoc gating.

## D3 — No code (guidance captured in PR/field-check only)
Private-room discovery is the existing `is_public` ("list on landing page") flag, orthogonal to `join_policy`. An `is_public=1` approval room already appears in `GET /api/rooms` (counts stripped per the v2.39.0 MAJOR-1 fix — KEEP that; don't un-strip). No code change; the PR field-check notes: to list a private room, enable "list on landing page"; entry stays gated by approval.

## Constraints
- No migration (SHARE_TO_GLOBAL is a settings KV key; removing the code just makes any stored value inert — acceptable, note it). No new deps.
- Open rooms: byte-identical. Approval rooms: scores now fan out by default per-submission (the intended change); all OTHER approval gating (view gate, join queue, WS, OG, Discord command exclusion, /api/rooms count strip) UNCHANGED.
- Note in the report: rooms whose global rows were previously scrubbed by the (now-removed) flip/toggle will NOT auto-refan — their future submissions fan normally; old scrubbed rows stay off global unless re-submitted. Acceptable/forward-looking.
- "Arcaid" casing. Hygiene: no `git add -A`; version via Edit → **2.41.0**; no SW bump.

## Tests
- fanOutFromRoomSubmission: approval-room member submission fans out by default; with `excludeFromGlobal` set → does NOT fan (row recorded excluded); guest → no fan; open room unchanged.
- D2 submit-gating test (above).
- Remove/replace the v2.40.0 SHARE_TO_GLOBAL tests (`joinreq-names-global-optin.test.ts` D2 cases) — the behavior they asserted is gone; keep the D1 username tests. Ensure the suite reflects the new model, not the old.
- Full suites green (backend + admin-ui + builds + docker compose build).

## Process
Implement, gates, version 2.41.0, no CHANGELOG edit, commit `feature:` (or `refactor:`) in logical chunks, do NOT push/PR. Report: files, the D2 submit-gating verification result (gated already? y/n + evidence), decisions, verbatim gates, SHAs, blockers. STOP on semantic conflicts (e.g. a submit path found ungated, or scrub/backfill still referenced somewhere).
