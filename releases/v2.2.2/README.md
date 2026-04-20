# ArcAid v2.2.2 — iScored sync unified across all web submission paths

**Released:** 2026-04-19
**Baseline:** v2.2.1 (commit `0d831a84`)

Small patch closing a longstanding gap uncovered during v2.2.1 testing.

## Problem

Three web endpoints write scores to a room:

- `POST /:roomId/submit-score/:gameName` — Tournament card + Game Detail
- `POST /:roomId/freeplay-score` — Freeplay catalogue browser
- `POST /:roomId/community-scores/:gameName` — legacy community endpoint

Only the first one synced to iScored. Fine when iScored was the canonical
scoreboard and web submissions were rare, but broken now that the Freeplay
page is a primary submission surface. Symptom seen in v2.2.1 testing:
soggybacon submitted `1,458,067,290` via freeplay → never made it to
iScored → when iScored was queried for tournament winner resolution it
returned mekelburgj instead. (v2.2.1 separately fixed winner resolution to
read local DB first, but the sync gap is still worth closing — players who
use iScored's scoreboard as a second surface should see parity.)

## Fix

Extracted the fire-and-forget sync into a shared helper:

```
src/services/IScoredSubmitSync.ts
  export async function syncScoreToIScored(opts: {
      roomId, gameName, username, score, persistentPhotoPath?
  })
```

Called from all three endpoints after the local write completes. Same guards:

- Game must exist with `status='ACTIVE'` and `iscored_id IS NOT NULL`
- iScored API preferred (`ISCORED_API_ENABLED !== 'false'`); Playwright fallback
  with photo support when the API is disabled
- Errors are logged and swallowed — submission flow is never blocked

Each call passes the **resolved** display name (post-`RoomNameClaimService`
auto-suffix), so `Bob_2` on ArcAid stays `Bob_2` on iScored. Previously the
tournament path was passing the raw typed name; that's fixed too.

## Files touched

- `src/services/IScoredSubmitSync.ts` — **new** (~85 lines)
- `src/api/routes/rooms.ts` —
  - `/submit-score/:gameName`: inline block removed, helper call added (uses `effectiveUsername`)
  - `/freeplay-score`: helper call added; `persistentPhotoPath` captured from the photo-persist block
  - `/community-scores/:gameName`: helper call added (no photo upload path, so no `persistentPhotoPath`)
- `package.json` + `admin-ui/package.json` — `2.2.1` → `2.2.2`

## Upgrade notes

Drop-in. No schema changes, no config changes.

## Rollback

Previous tag: `0d831a84`. Safe — no data shape change.
