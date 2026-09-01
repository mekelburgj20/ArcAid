# ADR 0022 — VPXS scores come from the launcher, and the game files its own observation

**Status:** Accepted (2026-08-31)
**Builds on:** ADR 0016 P2 (engine+device provenance), ADR 0020 (Witness verify-join), ADR 0021
(three-tier verification). The trust model — *a badge, never a gate* — is reaffirmed, not relaxed.

## Context

VPX on an AtGames cabinet runs under the third-party **vpx-standalone** launcher, not under AtGames'
own game system. The consequence is structural and permanent: **AtGames does not know these tables
exist.** They carry no `atgames_id`, they cannot be put in an AtGames private tournament, and no
AtGames board will ever hold a VPX score. Every other automatic score path Arcaid has — iScored
sync, AtGames event sync — reads somebody else's leaderboard. For VPXS there is no leaderboard to
read, so until now a VPXS tournament could only be scored by players typing their totals in.

The Witness round-4b signals run (FINDINGS-0q) and ChalataLove's evidence corpus (FINDINGS-0s,
2026-08-30) established that the launcher keeps machine-readable records **on the same USB partition
the Witness runs from**:

- `scoreserver/vpx-<table>-games.jsonl` — one signed record per completed game, with per-player
  scores, ball-by-ball timestamps, the game's own start and end, its duration, and why it ended.
  111 records across 49 tables in the corpus; a natural game-over writes one **98.7%** of the time
  for real machines, mid-session, without waiting for the table to exit.
- `vpx-sessions.json` — the session journal, with catalogue-grade display names.

So the data exists, it is local, and the process that can read it is already installed and paired.

## Decision

**The Witness reads the launcher's per-game records and reports them to Arcaid as scores, over a
device-authenticated `GET /api/witness/score`.** Five consequences are decided here.

### 1. `score_history.source = 'vpx'` — a fifth value, not a reused one

Not `'tournament'` (nobody submitted it; Arcaid never saw a player type anything), not `'atgames'`
(it never touched an AtGames board), not `'sync'` (that means iScored and forces
`engine`/`device` to `'unknown'` per ADR 0016 P2, while a VPX row knows its engine exactly), not
`'community'` (these land inside a tournament window and count for standings).

The trust model must be able to answer *how did this score reach us?* forever. A shared source value
erases that permanently, and this row's answer — *the launcher recorded it and our own process read
the record* — is different in kind from every other row on the board. Cost: a second
`score_history` rebuild (migration 172), on the same shared machinery as migration 167.

### 2. The GAME is filed as the witness observation — not the session

A VPX **sitting** routinely contains several games: the player launches a table once and plays four
games without leaving it. The session observation the resident detector produces therefore spans all
four, and its launch time precedes the round for every game after the first.

Verifying a VPX score against that session's launch would **flag every legitimate second, third and
fourth game** of a normal sitting — a false accusation, generated in bulk, by design. So on ingest
the game itself is written to `witness_observations` with `launch_ts` = the game's start and
`exit_ts` = the game's end.

That single choice means the ADR 0020 join needs no VPX-specific rule: the exit matches the score's
timestamp exactly, and the launch it compares against the round start is the **game's** launch.
Gear-up is caught at the granularity that actually matters, and the verify layer gains one line
(source eligibility), not a second code path.

### 3. Matching is by the game's END time, exactly like AtGames

Even though these records also carry the start, and refusing an early-started game at ingest would
be easy. We do not: ADR 0020/0021 settled that witness evidence is host-facing and never a gate. An
early start surfaces as `flagged`, where a human decides. The ingest layer stays a recorder, and two
sources on one board keep one definition of "inside the round".

### 4. Three names are offered; a guess is never made

The record's `rom` is a PinMAME id for real machines, free text for originals, and occasionally
simply wrong (`vpx-ratfink` reports `stest`). The session journal has the good name but is keyed by
that name, so joining the two files needs time-window correlation rather than a key. The device
therefore sends all three — journal name, `rom`, folder slug — and the server matches on the
catalogue normal form of any of them, plus a squashed form for slugs (`vpx-badcats` ⇒ `badcats`).

**Ambiguity is refused, not resolved.** Two open games matching one name returns `no_match`. An
event round beats a rotation game of the same name, because the round is the more specific claim
(it has a window this score fell inside); anything less clear-cut is left alone.

### 5. Player 1 only, and only real games

A multiplayer record is skipped whole. The cabinet knows one paired account and the launcher stamps
its own account on every row (FINDINGS-0s), so attributing player 2's ball to the stick's owner is a
wrong answer dressed as a feature. Records under 20 seconds are dropped, as is the launcher's
continuation artifact (a short trailing record that begins the instant the previous game ended and
repeats its total — observed in the corpus as an 8-second "game" scoring 879 immediately after a
151-second game scoring 877).

## Consequences

- **A VPXS tournament can now score itself.** This is the first Arcaid score path with no
  leaderboard behind it and no human in it.
- **Scope is bounded by membership and by openness.** Candidates are the player's rooms' ACTIVE
  rotation games and the rounds of events they are in. Pinned boards are deliberately excluded: they
  have no window, so an auto-ingest into one would be an unbounded write triggered by ordinary play
  at home.
- **An unmatched score is a normal outcome.** The endpoint answers `200 {status:'no_match'}` — never
  a 401 — so a player playing something untracked cannot put the cabinet into a retry loop.
- **Trust is honest about its limits.** These are launcher-recorded, not display-witnessed. The
  records carry Ed25519 signatures we cannot verify (no public key — FINDINGS-0s §7), and root is
  free on these cabinets. This is evidence for social and stream enforcement, exactly like every
  other witness signal, and the same badge-never-gate rule governs it.
- **`accountName` in the launcher's own files is never used for identity.** Attribution is the
  paired device's canonical account, full stop.

---

## Addendum (2026-09-01) — routing: the player says where their scores go

**Status:** Accepted. Shipped in v2.152.0, one day after the original decision.

### The gap this closes

The original design matched a score to a game by name and window, scoped to the player's rooms. That
leaves one case genuinely unresolvable: **the same table open in two tournaments of one room.** No
amount of information in a score record can distinguish them, so the ingest refused — which meant a
silent loss for the player. It also left a consent question open: a rotation tournament runs for
days, so ordinary play at home would enter somebody into a competition they never opted into for
that session.

### The decision

**Each paired cabinet carries its own designation**, set by its owner in Account Settings: a room,
and optionally one tournament in it. Per *cabinet* rather than per player, because a player can own
two and keep them in different rooms.

**The designation NARROWS the candidate set; it never routes past the matching.** Name and window
still decide, and two survivors is still refused rather than guessed. Its job is to remove ambiguity
the record itself cannot resolve — not to force a score somewhere it does not belong.

    designated room (+ optional tournament)  ->  only that scope's games
    undesignated                             ->  event rounds of events the player JOINED
    anything left over                       ->  the Global Scoreboard

### Why undesignated still counts event rounds, but not rotation games

Joining an event is a deliberate act about one specific, time-boxed competition. That *is* the
consent a designation would otherwise supply, so requiring both would be ceremony. A rotation
tournament has no equivalent act — which is exactly why it needs the designation.

### Why the leftovers go to the Global Scoreboard rather than nowhere

So that pairing a cabinet is worth doing on its own. A player who configures nothing can fire up any
table and have it count towards their personal record; the designation is then an upgrade, not a
prerequisite. It also means the fallback path is exercised constantly rather than being a rarely
trodden branch.

This does **not** relax ADR 0016 P2, which bars iScored-*synced* scores from the Global Scoreboard.
That bar exists because a synced score's provenance is unknowable and would pollute
engine-comparable boards. A witness score's provenance is exact — engine `vpx`, device `atgames`,
read by our own process from a cabinet paired to a real linked account — so it qualifies on the
merits the ADR actually names. (The parallel question for AtGames-sourced scores, currently kept off
Global as a product call, is deliberately left open here.)

### Two constraints worth stating plainly

- **`global_scores.global_game_id` is NOT NULL.** A table the catalogue does not know cannot be
  recorded globally; that is reported with its reason, never papered over by inventing a catalogue
  row from a launcher's free-text name. Same-named machines are told apart using the
  manufacturer/year parenthetical the session journal already carries.
- **A stale designation is the failure mode this design must survive.** Three defences: a finished
  tournament reads as *absent* rather than needing a cleanup job; games of inactive tournaments are
  not candidates at all; and the check-in response carries a `sendingTo` line the cabinet prints on
  its status screen, so a wrong setting is seen before the round rather than after it.
