# ADR 0027 — Integrity mode: Open play and Sanctioned play, and the one place evidence gates

**Status:** Accepted (2026-10-20)
**Builds on:** ADR 0016 (provenance is never inferred), ADR 0017/0020/0021 (a verdict is a badge, never a
gate), ADR 0022 (VPXS scores come from the launcher), ADR 0023 (every score reaches the Global Scoreboard).
**Mirrors:** Castcade ADR 0005 (https://github.com/mekelburgj20/castcade/blob/main/docs/decisions/0005-open-play-and-sanctioned-play.md)
and the design in castcade `docs/design/fairness-and-table-identity.md`. Mode names are the owner's working
names and may be renamed before the UI ships them.

## Context

Since Castcade 0.2.4/0.2.5 the desktop companion sends, with every witness score, what it measured on the
player's machine: the VPS game and table ids and the table file's hash (`vps_game`, `vps_table`,
`table_sha256`, `table_save_rev`), the settings in force (`ini`: physics set, difficulty override, slope,
nudge, and since 0.2.8 the accelerometer gain and the analog-tilt sensitivity), the ROM's machine
adjustments against the map's factory defaults (`adjustments`), and the VPX / VPinMAME builds with a
family and the cheat flag (`build`). Until this release the server ignored all of it.

Two facts from the owner's own rig (2026-10-19/20) shape the rules:

- The rig runs the **Panasony VR community builds** of VPX and a **VPinMAME nightly**. A "known build"
  rule that meant "official release only" would refuse the owner. Owner ruling 2026-10-19: the Panasony
  mod is allowed even in Sanctioned play.
- The owner plays with **tilt sensitivity 10** (VPX scale 0–1000, higher tilts sooner, default 400), which
  makes the table nearly impossible to tilt with an accelerometer controller. 0.2.8 caught it on a Tales
  from the Crypt game the same day. The owner asked for a runner-set minimum (provisional 300).

The question this ADR settles: **what may that evidence do?** ArcAid's doctrine since ADR 0017 is that a
verdict is a host-facing badge and never filters a board or changes a rank. The owner also wants a mode
in which a tournament can genuinely require a named table and stock conditions.

## Decision

1. **A tournament has an `integrity_mode`: `open` (default, every existing tournament) or `sanctioned`.**
   `tournaments.integrity_mode` + `tournaments.sanctioned_rules` (JSON, partial; `normalizeSanctionedRules`
   fills defaults and clamps), migration 184. Saved through the ordinary tournament create/update; an edit
   that omits the fields leaves them unchanged, so a form that predates them cannot reset a Sanctioned
   tournament to Open.

2. **Sanctioned play names the table per game** — `games.required_vps_table_id` (+ `required_rom`,
   `required_fingerprint` for Castcade F4) — and applies a rule set the runner tunes: `require_named_table`,
   `require_stock_physics`, `require_factory_adjustments` + `adjustments_allowed` (default `['Free Play']`),
   `require_known_build` + `allow_nightly_builds` (default on) + `blessed_build_hashes`,
   `min_tilt_sensitivity` (default 300), `max_accel_gain` (default 150 = VPX's default),
   `require_nudge_filter` (default off). The cheat flag is refused unconditionally. **"Known build" is an
   allow-list, never "official only":** `official` and `panasony` pass, `nightly` passes behind the toggle,
   `unknown` passes only with a blessed hash.

3. **The rules are evaluated for every witness score that matches a tournament, in both modes, and the
   verdict is stored** (`witness_evidence`, one row per witness score the ingest saw, every outcome, keyed to
   the `score_history` / `global_scores` row it produced; no FKs, the trail outlives what it describes). In
   Open play the verdict is a badge for the runner and a public verdict map for the board. The evaluation
   is a pure function (`evaluateSanctioned`) so the companion's preflight (F5), the ingest and the review
   page give the same answer for the same evidence.

4. **The ONE gate: the auto-ingest into a tournament in Sanctioned play.** A `flagged` verdict there means
   the score is not written to that tournament's board. The device is answered `not_sanctioned` with the
   reasons (a cabinet, which has no screen for reasons and no evidence to send, is told `no_match`, a status
   its contract already knows), and the play **falls through to the player's Global record** exactly as an
   unmatched score does (ADR 0023 is not weakened: the opt-out stays the player's). Nothing else gates:
   room boards never filter or re-rank, a typed score carries no evidence and is never touched, and an
   Open-play tournament never refuses.

5. **Matching prefers the VPS game id.** `vps_game` → `global_games.vps_id` → that catalogue row's names
   (and any `games.global_game_id` pointing at it) are tried before the device's own names; the name match
   remains the fallback so every pre-0.2.4 companion and every cabinet keeps working.

6. **Absence is not a verdict.** No adjustments map for the ROM (291 of 383 maps) is *unverifiable*, skipped,
   never failed. No evidence at all (a cabinet, an older companion) fails Sanctioned play as one line, "no
   evidence came with this score", because Sanctioned play is by construction a companion-evidence mode.

## Consequences

- **Easier:** a runner can run a tournament where the table, the physics and the nudge settings are what
  they said, with a per-score review of why each witness score passed or was held out. Open-play runners
  get the same review for free and can switch modes when they trust it.
- **Easier:** the companion can show "will count / will not count, because …" before ball one (Castcade F5)
  from the same function and the same rules.
- **Harder:** a Sanctioned tournament excludes cabinet Witness players and hand-typed scores from its
  auto-ingest by design; the runner must say so when they choose the mode. The UI (next PR) must make the
  mode's cost visible before it is switched on.
- **Harder:** the evidence is measured on the player's machine from files the player owns, and VPX's own
  in-game menus can change difficulty and (on the Panasony build) nudge settings in memory without touching
  a file. The verdict is the best evidence available, not anti-cheat; Castcade's Phase 3 hook reads the live
  values from inside VPX and the accelerometer trace to narrow that (fairness design §5a).
- **Locked out:** a verdict that filters a room board, re-ranks, or refuses a score in Open play. A "known
  build" rule that reads "official only". Treating a missing adjustments map as factory.

## Alternatives considered

- **Gate everywhere Sanctioned evidence fails** (room boards too) — rejected: ADR 0017/0020/0021's doctrine
  exists because most players have no device and a missing observation must never read as suspicion; the
  room board is the host's, the badge is the signal.
- **A new tournament `format` ("strict")** — rejected: integrity is orthogonal to rotation / event / season
  / Throwdown; a Throwdown in Sanctioned play is a sensible thing to want.
- **A per-room mode** — rejected: the same room runs a casual weekly and a stream-night final; the rules are
  the tournament's.
- **Refuse scores with no evidence in Open play too, or require the companion for all VPX scores** —
  rejected: it would end cabinet Witness ingest and every typed score on the day it shipped.
