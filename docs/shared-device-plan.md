# Shared Witness devices — several players on one cabinet (W131)

Status: design, 2026-11-27. Nothing is built. Owner rulings 2026-11-27 are in ADR 0045 and section 2.
Origin: owner 2026-11-27 — families with one AtGames cabinet and several people playing on it.

Names marked **(new)** do not exist yet. Every other name was checked in the code on 2026-11-27. Each
phase gets its own implementation contract when it is claimed; this file is the design those contracts
follow.

---

## 1. The problem

A Witness device belongs to ONE Arcaid account: `witness_devices.atgames_unique_id` is the primary key and
`canonical_user_id` is its single owner. `WitnessService.assertPairingAllowed` refuses a second account
(`DEVICE_CONFLICT`). Every device report (score, attempt, check-in, observation) takes its player from
`WitnessService.authenticateDevice` → `canonical_user_id`. So in a household every Witness play lands on
whoever paired the cabinet.

The need: several accounts on one device, a "who's playing" switch on the cabinet and on arcaid.app, every
game credited to the player of its session, and a way to put right a play credited to the wrong person
(she left it on her name; he played).

## 2. Owner rulings (2026-11-27)

1. **Moving a play to another player is not an edit.** The 2026-10-25 ruling (a machine-reported score's
   VALUE is never edited) stands: the number never changes, only whose it is.
2. **Both players agree to every move.** Either may start it (the one credited: "Not me"; the one who
   played: "That was me"); the other accepts. Nobody, a device owner included, moves a play alone.
3. **Refused in Sanctioned and Limited-attempts tournaments** (the `isSelfCorrectionLocked` rule) and
   once the card is locked. A host can still delete there.
4. **AtGames-native scores are out** of this version (section 9).
5. **The feature switches on only for device builds that send the clock offset** (section 5); older
   builds behave exactly as today.
6. **Every player on a device sees every play made on it** while they were on it, and who it went to.

Defaults chosen in this design, owner may change: co-owners (section 3); a move request expires after
7 days; a play can be moved once; a request is accepted or declined as a whole.

## 3. Owners and players

- **A device owner** controls the DEVICE: unpair, auto-update and test builds, the log pull (the logs hold
  everyone's plays), adding and removing players, and who is playing when nobody chose. Owning a device
  gives no power over anyone's scores (ruling 2).
- **Co-owners, equal rights.** Any owner can promote a player to owner. An owner cannot remove another
  owner, only step down; a real dispute goes to support. Any owner can unpair (re-pairing needs someone at
  the cabinet). The account that first paired has no special standing.
- **Adding a player:** an owner, at Account Settings → Arcaid Witness devices → the device → Add a player,
  makes an invite link; the player signs in and accepts. The pairing code stays one per device and
  `DEVICE_CONFLICT` still refuses a second pairing. The invite page says that the other players will see
  this player's plays on the device (ruling 6).
- **Caps.** `MAX_ACTIVE_DEVICES_PER_USER` / `MAX_NEW_DEVICES_PER_DAY` keep counting the account that
  paired; being added counts toward nothing. A device holds at most `MAX_PLAYERS_PER_DEVICE` **(new)**
  (proposed 6).
- **Leaving.** A player leaves, or an owner removes a player who is not an owner; their past plays stay
  theirs. Unpair ends every membership.

### Data

- `witness_devices` stays one row per device (token, model, version, update switches, heartbeat).
- `witness_device_players` **(new)** — `device_id`, `canonical_user_id`, `role` (`owner` | `player`),
  `slot` (short id the device sends, never a user id), `added_at`, `removed_at`, `added_by`.
  Migration creates an `owner` row for every live device from `canonical_user_id`.
- **Routing moves to the player row**: `target_room_id`, `target_tournament_id`, `global_only`,
  `global_fallback`. Each player belongs to different rooms, so where scores go is each player's choice.
  `deviceRoutesTo` (`src/utils/witnessRouting.ts`) is unchanged; `WitnessService.getDeviceTarget` takes
  the player. `audit_log` `witness_target_change` names the player.
- `witness_devices.default_player` **(new)** — who plays when no session is open; defaults to the
  pairing account. `canonical_user_id` keeps meaning "the account that paired" for the caps.

## 4. Who's playing

- `witness_play_sessions` **(new)** — `id`, `device_id`, `canonical_user_id`, `started_at`, `ended_at`
  (SERVER clock), `started_by`, `started_via` (`cabinet` | `web`). One open session per device (partial
  unique index on `device_id WHERE ended_at IS NULL`); a switch closes one and opens the next in one
  transaction and writes an activity row.
- **No open session = the device's default player.**
- **Switch on the web:** a "Playing as" control per device in Account Settings and on the
  "Your scores go to" line on room pages (`WitnessScoresGoTo.tsx`). Any player on the device can switch.
- **Switch on the cabinet:** a player picker on the Witness tile. The cabinet runs one thing at a time,
  so a tile switch always falls between sittings.
- **Shown everywhere a device speaks:** the tile, the check-in response (`sendingTo` gains `player`), the
  heartbeat response, the welcome line (`cabinetAccountFor`).

## 5. Which player a play belongs to

**The play belongs to the player whose session was open when the GAME STARTED, on the server's clock.**

Device timestamps can be hours wrong (about 40 h seen at power-on, 2026-11-03), and reports can arrive
long after the game (end-of-table reports, retries, catch-up after a re-pair). So the device reports its
clock offset and the server converts.

### The device's clock offset

- The heartbeat response (and the check-in, tile and pair responses) carries `now`, the server's unix
  seconds (built W131.2; the tile already had it).
- The device computes `offset = now − (t_send + t_recv) / 2` and stores it with the MONOTONIC
  clock at that moment.
- It watches `wall − monotonic`; a change of more than a few seconds is a wall-clock jump (the clock
  synced) and starts a new **segment**. A segment lives inside one boot (the cabinet tracks its boot id
  since 1.0.9).
- Every score, attempt and observation report carries `clock_offset` for the segment its device
  timestamp falls in (the segment is the device's own bookkeeping; the server never needs it, built
  W131.2). An offset measured AFTER the game is valid for it when no jump came between (a cabinet that
  boots offline, plays, then syncs).
- The device never rewrites a timestamp: the launcher's record is signed (W72), and the stored raw value
  is the evidence.
- **A second source:** the LU launcher already logs its own offset against a server ("clock is 39h55m
  behind the server", W58), and the LU record proposal v1 asks for `clock_offset_sec` / `ntp_synced` in
  the signed record (`docs/Arcaid Witness - LU - Record Proposal v1.md`). If LU ships it, the server
  prefers the signed offset for that game and cross-checks the Witness's.

### The rule, in order

1. `player=<slot>` sent by the device — the player the device held at game start. Wins when the slot was
   on the device then.
2. The session open at `started_ts + clock_offset`.
3. Neither (offset missing): the session open when the report arrived, stored `attribution = 'fallback'`
   **(new)** and marked on the plays list. With ruling 5 this only happens to a supported build that has
   not yet synced in that boot.

`witness_evidence.attribution` **(new)**: `device` | `session` | `fallback`, plus the session id.

The corrected time is used for ATTRIBUTION ONLY. Verdicts (✓ / ⚠), check-in tiers and the attempt-key
window keep reading the raw device times; moving them onto corrected times would change stored verdicts
and the meaning of Re-verify (W128 territory) and is its own decision.

### Where the player replaces the device owner

Each of these reads `device.canonical_user_id` today and must read the play's player:

- `WitnessService.recordVpxScore`, `recordAttempt`, `recordObservation`, the check-in
  (`witness_checkins.canonical_user_id`) — resolved once per report, passed down.
- **Verify join (decided in W131.2):** observations and check-ins store the play's player, and
  `WitnessVerifyService` ALSO matches them by any device the score's identity is or was on. A session
  and a check-in are facts about the cabinet, so they count for every player on it. This keeps the ✓ on
  an AtGames-native score (credited to the family's AtGames account, not the session) and means a moved
  play needs no observation move (section 6 step 4 falls away).
- `AttemptService.startsFor` and the attempt rows; Practice pauses are already per player.
- `ActivityLogService.recordForDevice` / `roomsForDevice` — rooms of the play's player.
- `WitnessEvidenceService.recentPlaysForUser` — unchanged per player; the device list is new (section 7).

## 6. Moving a play

### Requests

- `witness_play_moves` **(new)** — `id`, `device_id`, `from_user_id`, `to_user_id`, `initiated_by`,
  `status` (`pending` | `accepted` | `declined` | `expired` | `failed`), `created_at`, `decided_at`,
  `reason`; `witness_play_move_items` **(new)** — one row per play (the trail row ids).
- **Either side starts it.** The player credited: "Not me — move to…". The player who played: "That was
  me". The request goes to the other side, who sees it in Account Settings with a count and gets a
  notification.
- **The play stays where it is until accepted.** Boards never show a play in limbo.
- **Preview at request, checked again at accept.** The request shows where the play would count for the
  receiver (the ingest's own `match`, dry run); acceptance runs the real landing, because rooms, rosters
  and windows can change in between.
- **Refused** (at request and at accept): the play landed on, or would land on, a Sanctioned or
  Limited-attempts board (`isSelfCorrectionLocked`); a board it is on is locked; the receiver was not on
  the device when the game was played; the play was already moved once; a pending request already holds
  it. Global-only plays can be moved for 30 days after the game.
- **Expiry:** 7 days unanswered, or as soon as a card it sits on locks.
- **Batch:** one request may hold a run of plays (the usual case: a whole evening on the wrong name). It
  is accepted or declined as a whole; the sender can send a smaller one.

### What accepting does

Never an `UPDATE` of the player on the row. The move reuses the reinstate precedent (W68) and the A24
ruling:

1. Remove the play from the giver through the delete path (`ScoreHistoryService.deleteEvent`), with an
   `auto_score_suppressions` tombstone keyed on the giver (`owner_key`), so a cabinet replay cannot bring
   it back for the giver and nothing blocks the receiver.
2. Remove the giver's Global row; void the giver's attempt row.
3. Land the play for the receiver from its trail row (`witness_evidence`) through
   `VpxScoreIngestService.match` → `writeBoardRow`, with the receiver's routing, entry, roster and
   attempt checks, as if the receiver's device had reported it. Where nothing takes it: the receiver's
   Global row (respecting `share_to_global`), else the plays list says why (`missReason`).
4. Nothing to move for the ✓: since W131.2 the verify join credits a device's observations and
   check-ins to everyone on it.
5. One transaction where the store allows; a failure marks the request `failed` and leaves the play
   with the giver.

To check when built: that `deleteEvent` rewrites the giver's `submissions` best for a `vpx` row (the
rotation close crowns its winner from `submissions` alone, W93); that leaderboard caches drop.

**Already posted:** a Discord announcement made under the giver stays; the move posts nothing.

### Records

- An activity row in every room the play left or reached (`ActivityLogService.record`), for request,
  accept, decline, expiry.
- `audit_log` on accept.
- Both players' plays lists say "Moved from Alice (both agreed, 2026-11-27)".

### Notifications

A new type, `witness_play_move` **(new)**: `PREF_TYPE_KEYS`, the prefs interface,
`getPrefsWithExplicit` defaults, the Discord `PREF_LABELS` and `AccountSettings.tsx`'s `NOTIF_TYPES`
(the root CLAUDE.md invariant).

## 7. The pages

- **Account Settings → Arcaid Witness devices → the device:** players (owners marked), Add a player,
  Playing as, and **Plays on this device**: every play while you were on it, grouped by sitting, with who
  it went to, where it counted, the session that decided it (and who started that session, from the cabinet
  or the web), fallback marked. Each play: "Not me" (yours) or "That was me" (someone else's). Tick several
  to move a run.
- **Requests:** incoming with Accept / Decline and the preview; outgoing with Cancel.
- Words: **move**, not swap (nothing is traded). "Bob says 4 plays are his." "Alice says 4 plays are
  yours."
- The Arcaid look (ADR 0042, `admin-ui.md` "Style guide").

## 8. The devices

- **The wire contract (server side built W131.2, v2.287.0).** All additive and optional:
  - `now` (server unix seconds) on `/witness/pair`, `/witness/heartbeat`, `/witness/checkin`,
    `/witness/tile`, `/witness/players`, `/witness/play-as`.
  - `playingAs` (a cabinet-safe label) and `playerSlot` (8 hex) on heartbeat, check-in, tile, players
    and play-as, ONLY while more than one person is on the device: who the SERVER says is playing. A
    device adopts `playerSlot` as the player it holds; with neither field it is not shared.
  - Send `clock_offset=<seconds>` (device time + offset = server time) on every call, and
    `player=<slot>` on `/witness/report`, `/witness/score`, `/witness/attempt`, `/witness/attempt-start`
    (the slot held at the game's START). Malformed values are ignored, never a 400.
  - `GET /witness/players` → `playerCount`, `player<N>Slot`, `player<N>Name`, `player<N>Playing`
    (`"1"` / `"0"`); `GET /witness/play-as?slot=<slot>` switches (400 `NO_SUCH_PLAYER`).
- **Cabinet (arcaid-witness):** the player picker on the tile (`/witness/players`, `/witness/play-as`);
  the offset with monotonic segments; `player` and `clock_offset` as above; show "Playing as". A signed
  release (ADR 0040).
- **Castcade:** the same fields and a "Playing as" picker in the companion. Its game-start attempt call
  is live, so it rarely needs the offset. The ask goes in castcade `docs/arcaid-side-changes.md`.
- **Ruling 5 (built W131.2):** a device takes a second player once any of its calls has carried a valid
  `clock_offset` (`witness_devices.clock_offset_at`), whatever its version. Until then Add a player is
  refused `DEVICE_NOT_READY`.

## 9. Not in this design

- **AtGames-native scores.** They arrive by the AtGames sync, credited to the AtGames account
  (`atgames:<id>`), and nothing binds them to a device (a check-in cannot, `witness.md`). If AtGames lets
  each person sign in on the cabinet, that side is already solved; nobody has checked.
- **Two-player games.** The launcher gives Player 1 only; P2 is not recorded.
- **Players without an Arcaid sign-in** (children). Families will ask. A player managed by a parent,
  without Discord or Google, changes the identity model and may raise a privacy question for minors.
- **Corrected time in verdicts** (section 5).

## 10. Phases

| Item | What |
|---|---|
| W131.1 | Players, co-owners, invites, routing per player, migration of every device to an owner row |
| W131.2 | Sessions, Playing as (web + device API), `now`, attribution, the player through every device path and the verify join; gated per build. Also, left by W131.1: `witness_devices.default_player`, then lift `PAIRING_ACCOUNT` (the pairing account may leave once plays follow the session); refuse `createInvite` / `acceptInvite` on a build that does not send the clock offset (ruling 5); `WitnessAdminViewService` and `EventLobbyService.roster` list devices by `canonical_user_id` and must list them by player |
| W131.3 | Admin UI: players, Playing as, Plays on this device (`WitnessDevicePeople`, `WitnessDevicePlays`, `GET /me/witness/devices/:id/plays`), the invite page `/witness-invite/:code`, the runner's device cards keyed on `deviceId` + `userId`. Done in v2.288.0. Left for W131.7: the Playing as switch on the room page's "Your scores go to" line (§4) |
| W131.4 | Move requests: request / accept / decline / expire, the landing, notifications, activity |
| W131.5 | Cabinet release: picker, clock offset, `player` |
| W131.6 | Castcade: the same fields and picker (castcade ask) |

W131.1 → W131.2 → (W131.3, W131.5, W131.6) → W131.4. Claim migration numbers when a phase is claimed.
