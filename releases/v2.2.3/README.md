# ArcAid v2.2.3 — First-claim-wins: tokens claim names, not the reverse

**Released:** 2026-04-19
**Baseline:** v2.2.2 (commit `91044739`)

## Problem

Testing `Bob_2` / `Bob_3` submissions from the browser that had already
claimed `Bob` was silently collapsing them back to `Bob`:

- User typed `Bob_2` → `RoomNameClaimService.resolveAndClaim` checked
  `anon_room_claims` by `anon_token` → found the pre-existing `Bob` claim →
  returned `Bob` via the idempotent short-circuit.
- Score got stored as `Bob` in `submissions`/`score_history`.
- Leaderboard grouped by lower-cased name → all of `Bob`, `Bob_2`, `Bob_3`
  went into the `bob` group, scores summed visually onto one row.

The idempotency was meant to prevent the SAME user re-submitting `Bob`
from getting suffixed just because someone else claimed `Bob` too — the
token proves ownership. But I implemented it as "one name per token forever"
instead of "this token owns these specific names," which broke the natural
UX of typing a different name.

## Fix

Revised semantics:

> The anon-token proves which **specific names** you've already claimed,
> not a fixed pin to a single name.

`resolveAndClaim` now walks a suffix loop that accepts the candidate if
*either* the name is free *or* the submitting claimant already owns it.
If owned by someone else → bump the suffix. Same rule for Discord users:
they can rotate their per-room display name if they want.

### Schema

Migration **066** rebuilds `anon_room_claims` with PK
`(anon_token, room_id, display_name)`. One token can now hold multiple
name claims per room. The unique index on `(room_id, LOWER(display_name))`
is preserved — names still can't collide across identities.

### Code

- `RoomNameClaimService.resolveAndClaim` — idempotent short-circuit removed; new suffix loop driven by `findClaimOwner`
- `RoomNameClaimService.findClaimOwner` — new helper, returns the (kind, id) of whoever owns a name in a room, or null
- `RoomNameClaimService.isOwnedByClaimant` — private helper for the suffix loop's "is this mine already?" check
- `RoomNameClaimService.isNameClaimed` — kept as a thin wrapper around `findClaimOwner` for any existing callers

### Behavior change matrix

| Before | After |
|---|---|
| Same browser, typed `Bob` twice → both rows land under `Bob` | unchanged |
| Same browser, typed `Bob` then `Bob_2` → second silently stored as `Bob` | second now stored as `Bob_2` |
| Different browser, typed `Bob` (already claimed) → suffix to `Bob_2` | unchanged |
| Discord user re-logged in, typed different display name | previously stuck with first claim; now rotates |

## Files touched

- `src/database/database.ts` — migration 066
- `src/services/RoomNameClaimService.ts` — new suffix loop + `findClaimOwner`
- `package.json` + `admin-ui/package.json` — `2.2.2` → `2.2.3`

## Upgrade notes

Drop-in. Migration 066 rebuilds the `anon_room_claims` table — existing rows
are preserved; the PK change is transparent.

## Rollback

Previous tag: `91044739`. Migration 066's rebuild is technically reversible
(new PK is a superset of the old one — every old row still satisfies the old
PK), but rolling back the schema isn't strictly necessary; the new service
code works fine with both PK shapes.
