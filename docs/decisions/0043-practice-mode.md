---
status: accepted
date: 2026-11-24
deciders: owner (rulings 2026-11-24)
supersedes:
superseded-by:
---

# Practice mode: a player pauses their own attempts, and a pause only looks forward

Amends ADR 0029 (Limited attempts). Built in v2.266.0 (W126).

## Context

In a Limited-attempts tournament every game START on the table uses an attempt (ADR 0029). The owner
asked for a way to pause that, so a week-long tournament still leaves room to practice, with an optional
number of practice games ("a zero value means unlimited"), and with practice plays not counting toward
the tournament.

Who the gap was for:

- **A cabinet player had no way to practice the tournament table.** The cabinet replays up to seven days
  of launcher records, so every play of that table became an attempt, even one made with the Witness
  closed.
- **A desktop player could already practice invisibly** by closing Castcade (ADR 0029, "Consequences").
  For them Practice mode adds an honest, visible way to do it; the allowance binds only players who
  leave Castcade running.
- **An unofficial pause already existed:** pointing a device at "Global Scoreboard only". The device
  target is read when the report arrives, so it could be switched mid-game. Not tested; noted because the
  rule below does not have that hole.

`require_attempt_start` (ADR 0033 §4) already gives practice BEFORE the first attempt. Practice mode is
the same idea between attempts.

## Decision

Owner rulings, 2026-11-24:

1. **Each player pauses their own attempts**, on one table (`games` row), like Start attempts. Not a
   host switch for the whole tournament.
2. **The allowance counts per player per table for the table's whole run**, however many times the
   player pauses. A per-pause allowance would be unlimited in practice.
3. **When the allowance is used up, the pause ends and the next game is an attempt.**
4. **The press is on the web only** in this version (the scoreboard card and the game page). Devices
   show the state.
5. **No host "count this practice play"** in this version: it would make the host the judge of "I meant
   that one".
6. **Off by default**, for existing and new tournaments.
7. **Offered on any limited tournament**, events included.

### The rule

**A play is practice when its game STARTED while the player's pause was open on that table. A pause only
looks forward.**

`attempt_pauses` (migration 223) holds one row per pause: `paused_ts` and `resumed_ts` are the SERVER's
clock at the press, never backdated and never edited; at most one open pause per player per table. So:

- a game already running when Pause is pressed stays an attempt (a bad game cannot be turned into
  practice);
- a practice game still running when Resume is pressed stays practice (a good one cannot be turned into
  an attempt).

### The setting

`tournaments.practice_games`: NULL = players cannot pause, 0 = unlimited practice games, 1 to 999 = that
many per player per table. Omitted on an update = unchanged, like the other integrity fields. Parsed only
by `normalizePracticeGames`.

### A practice game is an `attempts` row

Status `practice`, decided in the SAME statement that decides `counted` / `over_limit`
(`AttemptService.insertAtomic`): the start is inside a pause, the tournament offers practice, and the
allowance is not used up. Deciding it with the count makes the allowance exact: two simultaneous starts
cannot both be the last practice game, and the start after the last one is an attempt.

- It uses no slot: `practice` is not in `USED_STATUS_SQL`.
- It is numbered in its own sequence (practice 1, 2, 3).
- It beats a forced `unreported`: a start nobody reported, inside a pause, is practice.
- A ball-one restart inside a pause is a practice game (a start is a start, as in ADR 0029).
- The pause row is closed (`ended_by = 'cap'`) when the last practice game starts, so the page shows
  "attempts counting" before the next game. The rule does not depend on that row closing.

### When the decision is made

Always against the play's OWN start time (the device's clock), as `playIsStarted` does for Start
attempts, and once:

- **Desktop:** when the start call (`/witness/attempt`) arrives, the row is written with the decision.
  The later score binds to that row and is never re-decided.
- **Cabinet:** the report comes after the game; the same test runs then.

The moment a call ARRIVED is deliberately not used. Testing a live start at the server's clock was built
first and removed in review: a start call held back for a minute (network unplugged) until the player
saw the game going badly and pressed Pause would have been filed as practice. With the play's own time,
a game that began before the press is an attempt whenever its call arrives. The cost is the one Start
attempts already has: a device whose clock is wrong by more than the gap between a press and the next
game start files that game on the wrong side of the press.

### Where a practice play goes

Nowhere in the tournament: no attempt, no board row. It is refused with reason `practice` on the path a
`not_started` play takes, so it falls through to the Global Scoreboard (ADR 0023) and writes a trail row.
Its activity row is `witness_practice`, severity `info`. The `attempts` row keeps the score.

### The wire

No new status. `/witness/attempt` answers `no_match` with a `reason` and an additive
`practice: { n, of, remaining }` (`of` 0 = unlimited, `remaining` then null). A start that used an attempt
in another tournament (the same table, not paused there) is answered as that attempt.
`/witness/score` answers a desktop `not_sanctioned` with the reason, a cabinet `no_match`.

### What the player and the host see

- Player: "Pause to practice" and, while paused, an amber "Practice mode: games you start now use no
  attempt and do not count" with "Resume attempts", on the scoreboard card and the game page; the card's
  badge reads "Practice mode"; one amber line on every room page names the paused tables.
- Cabinet, with no cabinet release: the "Sending to" line reads `PRACTICE MODE` and the tile card reads
  `practice` (both strings come from the server).
- Host: the two fields on the tournament form; practice rows and "In practice mode now" on the Integrity
  panel's Attempts section; pause, resume and "practice games used up" on Room Admin, Activity. Voiding a
  practice row gives the practice game back.

## Consequences

- **Forgetting to resume is the cost of this design.** Real games are filed as practice and nobody can
  convert them (ruling 5). The paused state is therefore shown everywhere a player looks before playing.
  W126.2 holds the host action if this bites.
- **Forgetting to pause** burns an attempt; the host's existing void covers it.
- **A device with a wrong clock** (a cabinet after a power cut, a PC that is off by more than a few
  seconds) can file a play on the wrong side of a press, the same exposure the game-window test and
  Start attempts already have.
- **Practice scores are public on the Global Scoreboard.** A practice score above a player's tournament
  best is visible there.
- **The allowance edge inside one cabinet report:** with one practice game left, a report of two restarts
  and a game makes the first restart practice and the rest attempts.
- **Plays before Start attempts are unchanged** and do not count against the allowance. Pause is offered
  only once attempts are counting, and not once they are all used (an over-the-limit play stays
  reinstatable only as an over-limit row).
- **Castcade shows nothing at the start of a practice game until it reads the `practice` field** (W126.1);
  it shows the refusal's reason at the score.
- Not built: a device-side press (W126.3), a host pause for everyone, a host ending a player's pause.
