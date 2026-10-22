# ADR 0029 — Limited attempts: N game starts per player per table, witnessed by Castcade

**Status:** accepted (owner ruling 2026-10-22) · **Ships:** v2.167.0 · **Castcade half:** castcade `WORK.md` (contract below)

## Context

A tournament today lets a player submit as many games as they like; the board keeps the best. The owner
wants a second shape: every player gets `N` attempts at a table and that is it. The obvious hole is the
player who sees a bad game coming and quits before it ends so it "never happened". Castcade's in-game
hook (castcade ADR 0001, Phase 3 live mode) sees every game start on the player's PC, so Arcaid can
count starts rather than finishes.

Owner ruling, verbatim in intent: *every game start, no matter how soon it ends or why, is an attempt;
when limited attempts are on, players are required to use Castcade.*

## Decision

### The setting

`tournaments.max_attempts INTEGER NULL` (migration 186). NULL = unlimited, today's behaviour. A positive
integer = each player gets that many attempts on **each `games` row** of the tournament (each rotation
table, each event round). It is independent of `integrity_mode`; a limited tournament may be Open or
Sanctioned. The create/update API carries it like `integrity_mode`: omitted on update = unchanged.

### Only Castcade scores land on a limited board

When `max_attempts` is set on the tournament a game belongs to:

- The three web submit routes, the legacy community route, the OAuth draft commit and Discord
  `/submit-score` refuse with `409 { code: 'ATTEMPTS_WITNESS_ONLY' }` and the message *"This tournament
  limits attempts per table; scores come from Castcade only."* The check sits beside the
  `checkEventSubmission` call at every site, as one helper `checkAttemptLimitSubmission`, so a new
  submit path has one more call to copy, not a rule to rediscover.
- `ScoreSyncPoller` skips the game (WARN once per game per process). `AtGamesEventSyncService` refuses
  a pull for a limited tournament. Neither source can know about game starts.
- A **cabinet** counts at REPORT time (owner ruling 2026-10-22, superseding the first draft's
  "cabinets are refused"). It has no live start call, so each game report IS the attempt, keyed
  `(device, 'cab:' + started)`: idempotent (the cabinet replays up to 7 days of records; a replay
  returns the same row), never `late` (cabinet reports are after the fact by design), numbered by the
  count of the player's existing non-void rows on the game (report order; out-of-order edge cases are
  accepted for v1), and bound in the same insert: within the limit the row is `scored`, past it
  `over_limit` and the score is refused. A report's `restarts=N` (ball-one restarts the launcher
  recorded before this game in the same sitting, each an abandoned start) first inserts N rows keyed
  `cab:<started>:r<i>` (note `restart`), counted or over_limit by the running count. **Cabinet 1.0.4**
  also reports games it detected but cannot score (abandoned at zero, or under 20 s) on
  `/witness/attempt` with `key=cab:<started>`, `ended` and `reason=no_score|short_game` (stored in
  `note`); that is the same key its score report uses, so one start is one row whichever arrives
  first. A no-ROM table's **exit sample** (`reason=exit_sample`, one reading per sitting) cannot be
  counted and is refused, reason `exit_sample`. A refused cabinet score falls through to the Global
  Scoreboard as a Sanctioned refusal does and is answered `no_match` (its vocabulary); a landed one is
  answered `ingested` with `attempt`, like a desktop.

### Attempts are counted at game START, over the wire

New device-token endpoint, same auth, limiter and bare 401 as `/witness/score`:

```
GET /api/witness/attempt
  device, token            as /witness/score
  table, rom, slug         the same three names the score call sends
  vps_game, vps_table      optional, the companion's identity (matching prefers vps_game as the score does)
  started                  epoch seconds, device clock, the moment the game started
  key                      opaque string, unique per device per game start; the SAME value rides
                           on the later score call as `attempt=<key>`
  players                  optional, informational
→ 200 { ok, status, game, attempt, of, remaining, late }
  status: 'counted'     a slot was used (attempt = 1-based number, remaining = of − attempt)
          'over_limit'  no slot left; the start is recorded anyway (attempt = of + k)
          'unlimited'   the matched game's tournament has no limit; nothing recorded
          'no_match'    no open game of the player's matched (same meaning as on the score call)
```

Matching is **the score call's matching**, extracted into `VpxScoreIngestService.match(...)` and used by
both, so an attempt and its score can never land on different games: routing by designation or
participation, `vps_game` first then the device's names, the window, the device-exclusion rule, the
round-beats-rotation tie-break, ambiguity = `no_match`.

The call is **idempotent on `(device_id, key)`**: a resend returns the stored answer. A start whose
report reaches the server more than `ATTEMPT_LATE_SEC` (120) after `started` is still counted, with
`late = 1`. Late starts exist so that "unplug the network, play, reconnect only if it went well" costs
the attempt and yields nothing: see the score rule below.

### The score binds to its attempt

The score call carries `attempt=<key>`. In `VpxScoreIngestService.ingest`, after the target is chosen
and before the suppression and Sanctioned checks, when the target's tournament has `max_attempts`:

| attempt row for `(device, key)` | result |
|---|---|
| `counted`, not late | the score is written; the row becomes `scored` with `score_history_id`, `score`, `ended_ts` |
| `counted`, late | refused, reason `late` |
| `over_limit` | refused, reason `over_limit` |
| `void` | refused, reason `void` |
| `scored` already | the ordinary duplicate path (a resend of the same score dedups; a different score on a used key is refused, reason `reused`) |
| none | a row is created now as `unreported` (counts as an attempt, `late = 1`) and the score is refused, reason `unreported`; the player is told "no game start was reported for this score — import this table in Castcade so live mode can count attempts" (a table played in Castcade's basic mode can only ever produce unreported starts) |

A refusal is wired exactly like a Sanctioned refusal: trail outcome `attempt_refused` with the reason,
Global Scoreboard fall-through when the device allows it, and the desktop is answered `not_sanctioned`
with `reasons[]` (the companion already shows those). An accepted score's answer gains
`attempt: { n, of, remaining }`.

Scores are **never** deleted or re-ranked by this rule after they land; the board is still best-of.

### Storage

```
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id TEXT NOT NULL, game_id TEXT NOT NULL, game_room_id TEXT,
  canonical_user_id TEXT NOT NULL, device_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,            -- 1-based order of this player's starts on this game, void rows excluded at read
  status TEXT NOT NULL,                   -- counted | over_limit | scored | void | unreported
  started_ts INTEGER NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')),
  late INTEGER NOT NULL DEFAULT 0,
  ended_ts INTEGER, score INTEGER, score_history_id INTEGER,
  players INTEGER, table_name TEXT, rom TEXT,
  voided_by TEXT, voided_at TEXT, note TEXT
);
CREATE UNIQUE INDEX idx_attempts_key ON attempts(device_id, attempt_key);
CREATE INDEX idx_attempts_game_user ON attempts(game_id, canonical_user_id);
CREATE INDEX idx_attempts_tournament ON attempts(tournament_id, received_at);
```

No FKs (same doctrine as `witness_evidence`: the trail outlives what it describes). The counting query
is `COUNT(*) WHERE game_id = ? AND canonical_user_id = ? AND status <> 'void'`; the limit is checked and
the row inserted in one transaction so two simultaneous starts cannot both be attempt 5 of 5.

### Reads and admin

- The public `GET /rooms/:roomId/tournaments/:id/integrity` read gains `maxAttempts` and
  `attempts: { [gameId]: { [canonicalUserId]: used } }` (void rows excluded). The game page shows a
  banner ("Limited to N attempts per player · scores come from Castcade live mode", plus "You have k left" for a
  logged-in viewer) and "n of N attempts" beside each player's name.
- Room admin: `GET /:roomId/admin/tournaments/:id/attempts?gameId=` lists rows with names resolved
  through `resolveUserLabels` (never a raw id); `POST /:roomId/admin/tournaments/:id/attempts/:attemptId/void`
  sets `void` on a `counted`, `over_limit` or `unreported` row (audited). A `scored` row cannot be
  voided: voiding never removes a score; delete the score instead, which leaves the attempt used.
- The tournament form gets a "Limited attempts" number field (blank = unlimited) with the one-line
  consequence spelled out. The Integrity panel gets an "Attempts" table per game with the void action.

### Castcade's half (the contract)

1. At **game start**, call `/witness/attempt` at once with a fresh `key` (journal session id + the
   start's `t` is fine). Originals: the hook's `game_start` event. ROM tables: the first NVRAM delta
   that shows a new game (the detector's "ball 1 of a new game"). The call must not wait for ball 1 to
   end: a start that is never reported is a free retry, and that is the hole this feature closes.
2. Show the answer: "Attempt 3 of 5", "No attempts left: this score will not count", or nothing when
   `unlimited`. On the overlay when live mode has one.
3. Send `attempt=<key>` on the score call for that game. Send the score even after `over_limit`; the
   server records the refusal for the runner.
4. The queue still applies when offline; the server marks a late start and refuses its score, so the
   companion should say "offline: this attempt will not count" rather than hide it.

## Consequences

- "N attempts" means N **scored** attempts with Castcade running. Practice with the companion off is
  invisible, as it is on any other platform, and cannot be prevented without a resident monitor.
- A player whose companion crashes mid-game loses the attempt (the start was counted, no score comes).
  That is the correct side to err on, and the admin void exists for the honest cases.
- Two-player games count as an attempt for the paired account (the start happened); the companion
  skips their score anyway.
- Cabinets count at report time, which leaves two holes: a zero-score or sub-20 s quit is not reported
  by a cabinet older than 1.0.4 (from 1.0.4 it is reported as an attempt with no score), and a
  launcher record can be deleted from the stick before the Witness reads it (the record's signature
  prevents forging, not deletion).
- Sealed-bid (A10) and Strikes (A12) compose with this: attempts bound the inputs, those decide what
  the board shows.
