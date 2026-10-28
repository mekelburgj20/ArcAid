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

---

# Wave 2 — 2.191.0 → 2.194.0 (same day, same session)

| Version | Item | What shipped | PR |
|---|---|---|---|
| 2.191.0 | W51 W53 W35 | Attempts line / device press apply the VR exclusion; quit chip on history rows and in "Where your plays went"; re-pair keeps the target (proved by test, no code change) | #409 |
| 2.192.0 | W52 | Event-round standings inside `getForGame`: Discord `/list-scores`, the rank reply, chat answers, game-page avg / unique players / Top Players / Recent results all follow the standings | #410 |
| 2.193.0 | W12 | `global_game_roms` from the VPS sync, public `GET /api/witness/roms`, ROM match tier before the name fallback | #411 |
| 2.194.0 | W24 W30 | Room Admin dashboard shows events as rounds; event page / banner / invite / Discord posts lead with the tournament and show the room beneath | #412 |

## 6. W51 / W53 / W35 (2.191.0)

1. **W51:** in a Limited-attempts tournament whose rules exclude `vr_headset`, call `attempt-start` (section 3) with
   `&play_device=vr_headset` → `nothing_to_start`; with `&play_device=pc` → `started`. The cabinet heartbeat line is
   unchanged (the cabinet sends no play device).
2. **W53:** on a game page with a quit Castcade score, expand that player's history → the "Quit on ball N" chip sits
   on that row too. Account Settings → "Where your plays went" shows the same chip on that play.
3. **W35:** Account Settings → a paired device → set a room designation → Unpair → pair again with the SAME account
   → the designation is still there.

## 7. W52 (2.192.0)

Same fixture as section 5 (a prevent event with a geared-up score).

1. Discord `/list-scores` on the round: the clean leader is #1, the geared-up score is absent.
2. `/submit-score` a new score on that round: "You are #N of M" counts against the standings.
3. Ask the bot who is leading and your rank: answers match the board.
4. Game page → Player Stats: Top Players is not headed by the geared-up score; average and player count exclude it.
5. After the round finishes: "Recent results" names the standings' winner. Flip the event to flag mode + Re-verify →
   the geared-up score comes back in every one of these places.

## 8. W12 (2.193.0)

1. **Once after deploy:** Admin → Catalogue → **Sync VPS** (fills the ROM map; until then `/api/witness/roms` has
   `count: 0`).
2. Open `https://arcaid.app/api/witness/roms`: `mm_109c` → Medieval Madness; a ROM shared by several games (e.g.
   `fpwr2_l2`) shows `ambiguous: true` with its candidates. Reload with the returned ETag → 304.
3. Play a cabinet table whose launcher display name differs from the room's card name but whose ROM is in VPS → the
   score lands on the card instead of going to Global. Watch item: a launcher that stamps a WRONG but valid ROM would
   now steer the play to that ROM's game if the room runs it (same semantics as `vps_game`).

## 9. W24 / W30 (2.194.0)

1. **Dashboard:** Room Admin → Dashboard while an event round is live: the card names the round's game, shows "Live",
   "Round N is live until <time>" in the room zone, the Players count and the leader (never a prevented score).
   Before the event: "Check-in open" / "Upcoming" with "Round 1 opens …". A round-less event reads "No round
   scheduled". A rotation card looks exactly as before.
2. **Event page:** `/<slug>/events/<id>` shows the room name as a small link above the event title; a
   `/throwdown/<code>` page does not.
3. **Banner:** on a room page with an upcoming or live event, the banner's first line is the event name, the second
   "in <Room> · Round N starts in …".
4. **Discord:** when a round goes live / results post / the event finishes, the embed title is unchanged and the
   footer ends "· in <Room name>".
