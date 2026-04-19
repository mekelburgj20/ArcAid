# ArcAid v2.2.0 — First-claim-wins identity, global fan-out gate, login-by-default for new rooms

**Released:** 2026-04-19
**Baseline:** v2.1.0 (commit `bb469395`)

A coordinated identity-correctness release. Three changes that together close
the "anonymous nickname can absorb a logged-in user's leaderboard row" gap
that v2.1.0's tournament-window scoring exposed.

## Background

Two unrelated facts had been quietly compounding:

- `submissions` and `score_history` group by `LOWER(iscored_username)`. Anyone
  typing the same nickname becomes the same row on the leaderboard.
- v2.0.1 correctly refused to paint a Discord avatar on a row with no
  `discord_user_id` — preventing avatar leakage onto guest scores.

Result, as caught in v2.1.0 manual testing: a guest could submit a higher
score under a Discord-mapped name (e.g. "MekelburgJ") and the leaderboard
row would silently flip from the real account's avatar to a `?` silhouette.
Two different real humans sharing a typed nickname (Bob Smith vs. Bob Jones)
was the same kind of bug — they'd merge into one leaderboard entry with
no way to tell whose score was which.

The honest answer to that ambiguity is that you can't disambiguate two
unrelated humans with the same display name without a second factor. So
v2.2.0 picks a tradeoff that doesn't pretend otherwise.

## 1. Global fan-out gate — guests never reach the Global Leaderboard

Single line, but the most consequential change in the release.

`GlobalScoreService.fanOutFromRoomSubmission()` now early-returns when the
submission's `playerId` normalizes to `null` — i.e., when it's an `ANON`,
`COMMUNITY`, `SYSTEM`, or empty sentinel rather than a real Discord ID.
Means **every row on the Global Leaderboard is guaranteed to have an
immutable Discord ID behind it**. No collision between two anonymous "Bob"s
can ever land there. iScored sync rows still pass through because they
carry their `iscored:*` synthetic IDs, which represent real iScored users.

Room admins can still allow guest submissions in their rooms. Those scores
just stay in the room.

## 2. First-claim-wins identity (`RoomNameClaimService`)

A new service plus two backing tables resolve the multi-Bob collision at
submission time, before the score row is written.

**Rule:** the first identity to use a name in a room owns it. Later arrivals
get auto-suffixed (`Bob`, `Bob_2`, `Bob_3`, …).

**Two claim kinds:**

- **Discord:** stored on `room_members.display_name`. Keyed on the
  immutable `discord_user_id`.
- **Anon:** stored on `anon_room_claims`. Keyed on the localStorage UUID
  (`arcaid_anon_id`) the SubmissionSheet now always sends as the
  `x-user-id` header. Same browser/session sees the same suffix on every
  re-submit; a different browser collides and gets a fresh suffix.

**Idempotent for the same claimant.** Re-submitting under the same name
returns the same resolved name — no escalating suffix.

**Sessionless callers** (curl, Discord embeds, anything without an anon
token) are tolerated: the resolved name is returned but no claim row is
written, so they don't get name-stickiness across sessions.

**The submission response carries the resolution back to the frontend.**
When the requested name was suffixed, `SubmissionSheet` shows
*"Submitted as Bob_2 — 'Bob' is already in use in this room."* before
closing.

**Pre-v2.2.0 data is not retro-claimed.** Existing rooms full of legacy
submissions don't get their names protected by claim rows. The user's
stated stance is that this dataset will be scrubbed at GA. New
submissions from v2.2.0 forward go through the full resolution.

## 3. `REQUIRE_DISCORD_LOGIN` default flips to `true` for new rooms

`GameRoomService.create()` now writes
`REQUIRE_DISCORD_LOGIN='true'` into `game_room_settings` for every new room.
Safe-by-default identity. Walk-up web submissions to new rooms must
authenticate with Discord, which closes the entire collision surface for
those rooms.

**Existing rooms are unaffected.** Migration 065 is intentionally a no-op
on its body — flipping the value retroactively would orphan all their
anon scores via `OrphanService.handleRequireLoginFlip`. Admins of existing
rooms opt in via Settings when they're ready.

## SubmissionSheet polish

- **Always sends an anon-token.** Lazily generates and persists
  `arcaid_anon_id` on first submission instead of conditionally including
  the header. Required for first-claim-wins to work.
- **Suffix disclosure.** When the response indicates the name was
  auto-suffixed, the success message explains why and the modal stays open
  ~2.4s instead of 1.2s so the user has time to read it.
- **Guest-mode global nudge.** Replaces the "exclude from global" checkbox
  for unauthenticated submitters with a small panel: *"Submitting as a
  guest — this score posts to the room only. Log in with Discord to also
  include it on the global ArcAid leaderboard."* Respects existing
  `loginWithDiscord` plumbing.

## UserMenu z-index fix

`UserMenu.tsx` dropdown bumped from `z-30` → `z-50` so the menu wins over
game-card submit buttons (which sit at `z-20` but are inside cards whose
ancestor stacking contexts were squashing the menu's z-30). Matches the
z-index used by `GameInfoPopup`.

## Schema

- Migration **064** — adds `room_members.display_name` (TEXT, nullable)
  with a partial unique index `(room_id, LOWER(display_name)) WHERE display_name IS NOT NULL`.
  Creates the `anon_room_claims` table with PK `(anon_token, room_id)` and
  unique index `(room_id, LOWER(display_name))`. FK to `game_rooms` cascades.
- Migration **065** — no-op marker, documents the v2.2.0 default-flip event
  in the migration ledger without retroactively touching existing rooms.

## Files touched

- `src/services/GlobalScoreService.ts` — fan-out gate (one early-return,
  comment explaining why)
- `src/services/GameRoomService.ts` — default `REQUIRE_DISCORD_LOGIN=true`
- `src/services/RoomNameClaimService.ts` — **new** (first-claim-wins core)
- `src/services/CommunityScoreService.ts` — routes through
  `resolveAndClaim`, returns `displayName` + `suffixed` + `requested` so
  callers can surface the resolution to the user
- `src/api/routes/rooms.ts` — anon-token header plumbing on
  `/submit-score/:gameName` and `/freeplay-score`; both use the resolved
  name for downstream `submissions` upserts so the leaderboard groups
  cleanly
- `src/database/database.ts` — migrations 064 + 065
- `admin-ui/src/components/SubmissionSheet.tsx` — always-send anon-id, suffix
  message, guest-mode global-eligibility nudge
- `admin-ui/src/components/UserMenu.tsx` — `z-30` → `z-50`
- `package.json` + `admin-ui/package.json` — `2.1.0` → `2.2.0`

## Out of scope (deferred)

- **Discord `/submit-score` claim resolution.** The Discord bot path writes
  to `submissions` directly without going through `RoomNameClaimService`.
  Two Discord users with the same Discord nickname in the same room would
  still collide. Rare enough to defer; logged on the roadmap.
- **Backfilling claim rows for legacy submissions.** Pre-v2.2.0 data is
  test data per the owner's stated GA-scrub plan. If real data needs
  protection later, a one-shot script can iterate
  `submissions`/`community_scores`/`score_history` and seed claim rows.

## Upgrade notes

Drop-in. Migrations 064 + 065 run once on startup (DDL only — no data
mutations). No config changes. Existing rooms keep their current behavior.

## Rollback

Previous tag: `bb469395` (v2.1.0). The new columns and table stay populated
on rollback (harmless). Tournament/community submissions revert to pre-claim
behavior — collisions would resume but the stored data is internally
consistent in both directions.
