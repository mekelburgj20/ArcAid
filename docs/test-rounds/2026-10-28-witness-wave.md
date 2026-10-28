# Owner test round — the Witness wave (2.186.0 → 2.190.0, 2026-10-28)

Five releases shipped in one orchestrated session without hardware testing. Each was unit-tested and the whole
stack passed both suites (backend 228 files / 3248 tests, admin-ui 161 files / 1510 tests) before merging, but
none has been exercised with a real cabinet, a real Castcade desktop or a real event. This is the one test
round that covers all five. Log every finding in `WORK.md` (tag `WAVE 2026-10-28`); log, don't fix.

| Version | Item | What shipped | PR |
|---|---|---|---|
| 2.186.0 | W19 | Check-in lobby copy follows the device type (cabinet tile vs Castcade "close VPX"); one dot per device on multi-device rows | #404 |
| 2.187.0 | W5 | Room Admin → **Witness devices**: live view of members' paired devices + event lobby counts | #405 |
| 2.188.0 | W45 | `GET /api/witness/attempt-start`: the device presses "Start attempts" | #406 |
| 2.189.0 | W49 | "Quit on ball N" chip from the companion's `quit` / `quit_ball` | #407 |
| 2.190.0 | W22 | Event-round witness verdicts on the room board + game page; prevent-mode ranking there too | #408 |

## Setup (once)

- A room you admin, with ONE player account that has BOTH a cabinet (Witness 1.0.5+) and a Castcade desktop
  paired, both set to **All my rooms**; a second player with one device.
- An **event** tournament in that room (format Event, `witness_flag_mode` left at the default *prevent*,
  check-in required) with one round on a ROM table the cabinet scores per game (e.g. Medieval Madness).
- A **rotation** tournament with **Limited attempts = 2** and **Start attempts required** ON, one table ACTIVE
  (e.g. Bad Cats), and the desktop pointed at All my rooms.
- A Castcade companion build that sends `quit` / `quit_ball` (the release after 0.2.17) for W49; any build for
  the rest. W45's companion button does not exist yet — call the route by hand (see below).

## 1. W19 — lobby wording per device (2.186.0)

Open the event page while check-in is open, and the host Rounds panel's participant list.

1. Neither device has checked in → the two-device player's row shows two amber dots; hover reads
   "Cabinet: Open the Witness tile" and "PC: Close VPX to check in".
2. Close VPX on the PC, wait ≤ 2 min → the row turns **Ready**, the PC dot goes green, the cabinet dot stays amber.
3. Open a table on the PC after it checked in → the PC dot reads "PC: Exit the table".
4. Stop Castcade for > 5 min → "PC: Castcade not responding".
5. A desktop-only player with no check-in: the pill itself reads **Close VPX to check in**; a cabinet-only player
   reads **Open the Witness tile**.
6. The host Rounds panel shows the same words and dots.

## 2. W5 — room admin's live device view (2.187.0)

Room Admin → **Witness devices** (`/<room>/admin/witness`).

1. Every paired device of a member is listed: player name (never an id), Cabinet / PC, Online / Not responding /
   Unknown (a cabinet that has never sent a heartbeat), last check-in, the table open now, "Sends scores to"
   (the same words as the player's own "Your scores go to") and the target line.
2. Open a table on the cabinet → within 20 s (or Refresh) it moves to the top with the table name and "since HH:MM".
3. Point one device at another room → its routing line turns amber and says so.
4. With the event in its check-in window: the event block shows Ready / Exit the table / Not checked in /
   Not responding / No device counts and the compact roster; counts move as players check in or open tables.
5. Start round 1 → the event block disappears. Log in as an admin of ANOTHER room → the page shows an error (403).

Known: the routing words are in the player's voice ("Your cabinet sends its scores here.") — say if that reads
wrong on a runner page.

## 3. W45 — the device presses "Start attempts" (2.188.0)

With the Limited-attempts rotation above and the desktop device's id + token (Account Settings → Witness devices;
the token is the one the companion holds — never paste it anywhere public):

1. Before pressing: the companion's heartbeat line ends "… · ATTEMPTS NOT STARTED".
2. `GET https://arcaid.app/api/witness/attempt-start?device=<id>&token=<token>` → `status:"started"`, one row with
   `alreadyStarted:false`, `sendingTo` ending "· 2 OF 2 ATTEMPTS LEFT"; the game page's Start-attempts state
   shows it as already started.
3. Call it again → same `startedTs`, `alreadyStarted:true`.
4. Play a game that STARTS after the press → attempt 1 of 2 is counted and the score is on the board. A game that
   started before the press is still refused as not started.
5. Turn "Start attempts required" off (or set the device to Global Scoreboard only) and call again →
   `nothing_to_start`. Call with `&table=Taxi` (not up) → `no_match`.

Hand the wire contract (`docs/vpx-desktop-witness-plan.md`, §4 "Wire contract: pressing Start attempts from the
device") to the castcade session so the companion gets the button (castcade item for W45 / ArcAid W27.4).

## 4. W49 — "Quit on ball N" (2.189.0)

Companion ≥ the release after 0.2.17, desktop pointed at a tournament.

1. Start a game on a VPX table and quit it on ball 2 → the score posts as usual (`ingested`, or `global` if it
   matched no tournament). On the game page the row shows a grey **Quit on ball 2** chip beside the provenance /
   integrity chips; the tooltip says it still counts and still used its attempt. A machine that does not report
   the ball (Stern SAM) shows **Quit**.
2. Play a game to game over → no chip.
3. In the Limited-attempts tournament, quit a game, then press Start for the next → the quit used one attempt
   (attempts line "1 OF 2 ATTEMPTS LEFT"), the next start is attempt 2.
4. Admin → Integrity panel: the quit row shows "Quit on ball 2" under its verdict chip; the verdict is unchanged.
5. An older companion that sends no `quit` → no chip, nothing else changes.

## 5. W22 — event-round verdicts on the room board and game page (2.190.0)

Event in **prevent** mode. The two-device player opens the table BEFORE the round starts and finishes that game
inside the round (geared up), then plays a clean game; the second player posts a clean score between the two.

1. **Event page**: unchanged — the geared-up score sits under the round, struck through, "Not counted: started
   before the round opened".
2. **Room scoreboard card** (every card style) and the **kiosk**: the geared-up score is ABSENT, the player's
   clean score holds their place, the other player ranks correctly, no warning mark (nothing flagged ranks).
3. **Game page, Leaderboard tab**: the same order as the event standings; ✓ beside witnessed rows, grey
   "unwitnessed" on a witness score with no evidence; a "Not counted: started before the round opened" line
   under the board with the score struck through; expanding that player's history shows ⚠ on the geared-up
   score; **All-Time High and Record Holder do not show it**.
4. Switch the tournament to **flag** mode and press **Re-verify** → the card, kiosk and game page now RANK the
   geared-up score with ⚠ on its row; the "Not counted" line is gone; All-Time High may become that score again;
   the event page ranks it with ⚠ too. Switch back to prevent + Re-verify → step 2/3 again.
5. A rotation game in the same room looks exactly as before (no badges, no "Not counted").

Known gaps (W52): Discord `/list-scores` and the chat responses still rank the cached rows for an event round; the
game page's "Recent results", Top Players and average score are untouched; an engine tab on an event round
filters the round's CHOSEN rows only.
