# ADR 0033 — Room membership is tournament entry; misses go to Global with a reason

**Status:** accepted (owner ruling 2026-10-25, from the Witness Weekend Showdown tester polls), §1–2 and the count-in-each consequence built v2.175.0 (WORK.md W37, closes W36); §3–4 built v2.178.0 (W38; Castcade's own Start button is W45); §5 W27, §6 W39 not yet built · **Amends:** the P9b routing in ADR 0022 / CLAUDE.md "WITNESS SCORE ROUTING"; ADR 0029 (limited attempts) · **Builds on:** ADR 0032

## Context

During Witness Weekend Showdown (2026-10-23/25) testers kept losing plays to the device target: a paired
device holds ONE target (Global / a room / a room + tournament), so pointing at one room silently dropped
events joined in another, and a rotation tournament counted only with an explicit designation. The owner put
the entry model to the testers as four Discord polls (2026-10-24). Results at decision time (3 voters, polls
still open): membership = in, 3/3 · limited attempts start counting on every play once in, 2/3 (1/3 "Start
attempts" first) · a missed play goes to Global and says why, 3/3 · private entry: any of the three methods,
host's choice, 3/3. In the follow-up thread TomatoGrass and ChalataLove argued that every extra step is one a
player can miss, and "I played and my score isn't there" loses a player for good; TomatoGrass proposed making
"Start attempts" an optional host setting rather than a rule. The owner adopted all of it.

## Decision

1. **Room membership is entry.** A member of a room is in every open tournament in that room whose rules
   they meet (check-in when the tournament requires it, the entry roster when it has one). No per-tournament
   Join. A device set to "Global Scoreboard only" is the opt-out (ADR 0032).
2. **The SAME "allowed in" test applies to typed scores and device scores.** Today the witness path ignores
   "check-in required" (W36); that ends.
3. **Limited attempts: every play that ends inside the window counts once you are in**, and uses an attempt.
   Plays before the window go to Global and use nothing, so warm-ups are safe without a step.
4. **"Start attempts" is an optional per-tournament host setting, off by default** (TomatoGrass). When on, a
   player's plays go to Global and use no attempt until they press "Start attempts" (web / phone / Castcade —
   a cabinet has no screen).
5. **A play that does not count goes to Global AND tells the player why** (not entered, not checked in, wrong
   table, outside the window, attempts used up, not sanctioned, not started). Never silently; never refused
   outright.
6. **Private entry is a tournament setting:** `Entry: Room members` (default) / `Invited players`. For an
   invited roster the host may enable any combination of: add players by name, an invite link/code players use
   themselves, players request and the host approves. A non-roster play falls through to other tournaments or
   Global, with the reason.

## Consequences

- The device target stops being the thing that admits a play: by default a device sends to every room its
  owner is a member of. Whether narrowing to one room / tournament survives as an option is a build-time
  choice (W37); it must never be needed to count.
- One play can now land in several tournaments at once (two tournaments running the same table in member
  rooms). The P9b rule "two matches is `no_match`, never a guess" is replaced by "count it in each" — and in
  limited attempts it uses an attempt in each. Manual submits already may do this (v2.155.3).
- A member who plays a table at home while that table is live in a room tournament is entered without a
  per-session act. That is the accepted cost; the Global-only opt-out and the post-game "where it went" reply
  (W27) are the defence. This reverses the P9b reasoning that a rotation tournament needs a designation.
- Reasons must be specific and shown at the device and on the web, which needs every ingest outcome traced
  (W29).
- Polls were still open with 3 voters; revisit if later votes split differently.

## Build-time rulings (2026-10-26, W37)

- **Narrowing survives as an option, never required.** The device picker offers All my rooms (default) ·
  Global Scoreboard only · one room · one tournament.
- **Every existing device was migrated to All my rooms** (migration 191). Old room / tournament choices were
  made because routing required them, and "Global Scoreboard only" had meant Global only for one day.
  Players are told by a one-time notice on Account Settings → Arcaid Witness devices.
- A play inside ONE tournament that matches two of its open games is still never guessed at: that
  tournament is skipped; the other tournaments still count it.
- The typed Throwdown path is unchanged (anyone with the link may submit); the one shared entry test
  (`entryAllowed`, `src/utils/tournamentEntry.ts`) is used by the room-event typed gate and the device path.

## Build-time rulings (2026-10-26, W38)

- **§3 was already true except for one case:** a Castcade play that STARTED before the window and ended
  inside it. Its start call matched no open game (so recorded nothing), and its score was refused as
  `unreported` while still using an attempt. It is now counted when its score arrives. Cabinets already
  counted at report time.
- **"Start attempts" is per table, per player** (`attempt_starts`, one row per player per games row), because
  attempts are per table. The first press is kept; pressing again cannot re-date it.
- **A game counts only if it BEGAN at or after the press.** Counting a game already under way when Start was
  pressed would let a player press it partway through a good game. No clock tolerance: the cost of a near
  miss is one warm-up game going to Global.
- **Check-in and Start attempts are independent.** Check-in is entry and closes when round 1 starts; Start
  attempts means "my warm-up is over" and can be pressed any time the table is open or upcoming. Checking in
  does not start attempts.
- **Where the button lives:** the game page (web and phone) now. Castcade's own button needs a device
  endpoint and companion UI, so it's a follow-up (W45). A cabinet has no screen; its "Sending to" line reads
  `ATTEMPTS NOT STARTED` until the player presses Start on a phone.
- **No new wire status.** A not-started play answers the companion `not_sanctioned` + reason on the score and
  `no_match` + reason on the start, and a cabinet `no_match`. Pre-W38 devices already understand all three.
