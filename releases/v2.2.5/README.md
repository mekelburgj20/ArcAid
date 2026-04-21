# ArcAid v2.2.5 — Auth-in-guest-rooms fix, pre-submit collision prompt, resolved-name prefill

**Released:** 2026-04-20
**Baseline:** v2.2.4 (commit `62af055b`)

Three follow-ups from v2.2.3 manual testing.

## 1. Logged-in users now attribute correctly in guest-allowed rooms

**Problem.** `conditionalRequireDiscordUser` middleware was written as
"either the room requires login (decode token and attach to req.user) or it
doesn't (return next without looking at the header)." That's wrong. A user
can be logged in *even when* the room doesn't require it — we still want
their submissions attributed to their Discord identity. Symptom surfaced in
v2.2.3 testing: `mekelburgj` logged in, submitted `999,999,999` on BSG
Pinball, score stored as `discord_user_id='COMMUNITY'`, `submitted_by_user_id=null`.
Fan-out gate (correctly) blocked it from global, avatar join failed, tournament
card showed the `?` silhouette.

**Fix.** Middleware always tries to decode the Bearer token when present.
It only *rejects* if the room requires login AND no valid token was provided.

```typescript
if (token) {
    const payload = verifyToken(token);
    if (payload?.discordId) req.user = payload;
}
if (required === 'true') {
    if (!req.user?.discordId) { res.status(401)...; return; }
}
next();
```

Pre-existing data with mis-attributed COMMUNITY rows is left as-is (test
data; re-submitting from a logged-in session after this ships will write
correctly). No retroactive re-attribution — that would require inferring
auth state from timestamps and risks the v2.0.1 avatar-leak.

## 2. Pre-submit name collision prompt

**Problem.** Previously the server auto-suffixed colliding names and
surfaced it *after the fact* via the success message ("Submitted as Chad_2
— 'Chad' is already in use"). Users flagged this as awkward — they want to
*choose* their fallback name, not be told what it became.

**Fix.**
- **New endpoint** `POST /:roomId/submit/name-check` returns
  `{ available: boolean, suggestion: string }`. When the name is free or
  already owned by the submitting claimant → `{ available: true, suggestion: <name> }`.
  When taken by another identity → `{ available: false, suggestion: <next free suffix> }`.
  Uses `RoomNameClaimService.checkAvailability` — a dry-run of the claim
  logic, zero persistence.
- **New service method** `RoomNameClaimService.checkAvailability(roomId, name, claimant)`
  — mirrors `resolveAndClaim`'s suffix loop but returns instead of persisting.
- **New `SubmissionSheet` phase** `nameCollisionPrompt` shows an editable
  input pre-filled with the server's suggestion. User can accept, edit and
  re-submit (check runs again with the edited name), or go back. If the
  edited name is *also* taken by someone else, the prompt refreshes with a
  new suggestion.

Flow integration:
- Authenticated submits and global submissions still go through `submitScoreNow`
  directly — for them, the server's auto-suffix path is still the right
  behavior (Discord users don't type names arbitrarily). But they now route
  through `runNameCheckThenSubmit` for completeness, so a Discord user typing
  a name owned by a different identity would get the same prompt.
- Anon submits: claim-prompt (v2.0.0 Discord-guild match) runs first. If no
  guild match, the room-level name-check runs. If there's a match, the
  collision prompt fires with the suggestion.

## 3. Resolved-name prefill

**Problem.** `localStorage.arcaid-player-name` was storing the *typed* name
on success, not the resolved one. So a user who submitted `Chad` and got
auto-suffixed to `Chad_2` would see the sheet prefill `Chad` next time,
causing the same collision again.

**Fix.** After a successful submit, `SubmissionSheet` stores
`responseData.displayName` (resolved) instead of the raw typed name, and
also calls `setPlayerName(resolvedName)` so the field in the currently-open
sheet reflects what was actually stored.

## Files touched

- `src/api/middleware.ts` — `conditionalRequireDiscordUser` always-decode-when-present
- `src/services/RoomNameClaimService.ts` — new `checkAvailability` dry-run method
- `src/api/routes/rooms.ts` — new `POST /:roomId/submit/name-check` endpoint
- `admin-ui/src/components/SubmissionSheet.tsx` — `nameCollisionPrompt` phase + UI, `runNameCheckThenSubmit`, `ensureAnonId` extracted helper, resolved-name prefill
- `package.json` + `admin-ui/package.json` — `2.2.4` → `2.2.5`

## Upgrade notes

Drop-in. No schema changes, no config changes.

## Rollback

Previous tag: `62af055b`. Safe — no data shape change.
