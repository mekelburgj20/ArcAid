# ArcAid v2.2.1 — Winner-resolution local-first, iScored reject-handling, anon-winner claim flow

**Released:** 2026-04-19
**Baseline:** v2.2.0 (commit `ecdc3a03`)

Patch release addressing three distinct issues surfaced during v2.2.0 manual
testing.

## 1. Winner resolution: local DB first

**Problem.** `TournamentEngine.processSlotMaintenance` read the tournament
winner from iScored's API and only fell back to local DB if iScored returned
nothing. In guest-allowed rooms (`REQUIRE_DISCORD_LOGIN=false`), guest scores
are persisted locally and *also* fired at iScored best-effort. When iScored
rejects a score (magnitude, rate limiting, auth, …), the local DB has the
truth and iScored is stale. The bot would then announce whoever iScored had
on top — often a different player than the room's leaderboard showed.

Concrete case: guest `Bob` submitted a score of 99.9B on Twilight Zone.
iScored rejected it with a `200 OK` + `"Access Denied"` body. The bot still
asked iScored for the top scorer at maintenance time and announced
`mekelburgj` (1.23B), even though `Bob` was rank 1 on ArcAid's scoreboard.

**Fix.** Inverted the priority:

- Local DB (`submissions`) is the canonical source. It's the union of
  Discord-authenticated submissions, guest submissions, and iScored-synced
  submissions, so it covers every way a score can land.
- iScored is the fallback, used only when local DB has nothing (legacy rooms
  that never saw a web/Discord submission).
- iScored lock + `syncStyle` housekeeping still runs regardless — we need
  iScored locked on tournament end; we just don't need it for the winner.

## 2. iScored `submitScore` handles non-JSON rejections

**Problem.** `IScoredApiClient.submitScore` called `res.json()` directly on the
response. iScored occasionally returns `200 OK` with a plain-text body (seen:
`"Access Denied"`), which threw a raw `SyntaxError` that broke the
surrounding fire-and-forget sync pipeline.

**Fix.** Read response as text, try `JSON.parse`, and on failure throw a
clean `"iScored API submitScore rejected: <body>"` error. The caller (route
handler) catches and logs non-fatally. Rejected scores still don't appear on
iScored — that's iScored's decision — but the rejection no longer crashes
other things.

## 3. Anon-winner Discord message with claim guidance

**Problem.** When a guest wins a tournament, they have no
`user_mappings` entry → `winnerId` is null → the announcement used the name
as a `` `backtick-wrapped string` `` (correct: avoids broken `@mention`) but
offered no path forward. The winner couldn't use `/pick-game` (no Discord
link), and there was no message telling them how to claim.

**Fix.** When `winnerId` is null but `winnerIscoredName` is set, the
announcement now appends:

> *Is this you?* Log in with Discord on {scoreboard URL} to claim future
> scores. If your Discord name differs from `{name}`, ask an admin to merge
> identities. An admin will pick the next {game} in the meantime.

The existing flow (no picker slot for anon winners, moderator pick the next
game) was already correct — the announcement is what was missing.

## 4. GameDetail leaderboard React key collision

(Already shipped as `a368aaeb` — included in this release note for completeness.)

Anon leaderboard rows share `discord_user_id="SYSTEM"`, so the React
reconciler would de-dupe them. Composite `rank-username` key fixes it.

## 5. Prod data cleanup (not code)

- **61** legacy anon rows removed from `global_scores`. These fanned out
  before the v2.2.0 gate and were causing the Global Game Detail page to
  show a `?` silhouette for users whose Discord-authenticated scores were
  outranked by their own old anon submissions under the same name.
- **7** cached leaderboards flushed (`global_leaderboard_cache`).

## Files touched

- `src/engine/TournamentEngine.ts` — winner resolution inversion + anon-winner claim message
- `src/engine/IScoredApiClient.ts` — `submitScore` non-JSON handling
- `admin-ui/src/pages/GameDetail.tsx` — React key fix (shipped `a368aaeb`)
- `package.json` + `admin-ui/package.json` — `2.2.0` → `2.2.1`

## Upgrade notes

Drop-in. No schema changes.

## Rollback

Previous tag: `ecdc3a03`. Rolling back restores iScored-first winner
resolution and the raw-`SyntaxError` crash path; both were bugs, but rollback
is safe for the data plane (no schema changes, deleted global_scores rows
stay deleted — they were dup/anon test data anyway).
