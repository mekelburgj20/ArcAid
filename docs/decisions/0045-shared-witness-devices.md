---
status: accepted
date: 2026-11-27
deciders: owner (rulings 2026-11-27)
supersedes:
superseded-by:
---

# Shared Witness devices: a play belongs to who was playing when it started, and moves only by agreement

Not built (W131). Design: `docs/shared-device-plan.md`.

## Context

A Witness device belongs to one Arcaid account, and every play on it is credited to that account. A family
with one cabinet and several players can't use the Witness without crediting everyone's games to the
person who paired it. The owner asked for several accounts on one device, a "who's playing" switch on the
cabinet and on arcaid.app, and a way to put right a play credited to the wrong person.

Two existing rules press on it. The owner ruled on 2026-10-25 that a machine-reported score is never
edited by anyone. And device timestamps can be hours wrong while reports arrive late, so neither the
device's clock nor the time a report arrives can decide whose session a game was in.

## Decision

1. **A device has owners and players.** Owners manage the device (unpair, updates, logs, the player list,
   the default player); co-owners have equal rights and cannot remove each other. Owning a device gives no
   power over anyone's scores. Each player has their own score routing.
2. **A play belongs to the player whose session was open when the game started, on the server's clock.**
   The device reports its clock offset (measured against `server_now`, anchored to its monotonic clock and
   broken into segments at wall-clock jumps) and never rewrites a timestamp. A player the device names
   explicitly wins; a play with no offset is credited to the session open when the report arrived and is
   marked as such.
3. **The corrected time is for attribution only.** Verdicts, check-in tiers and attempt windows keep
   reading raw device times.
4. **Moving a play to another player is not an edit.** The 2026-10-25 ruling stands: the value never
   changes.
5. **Both players agree to every move.** Either may start it; the other accepts. No one moves a play
   alone, a device owner included.
6. **No moves on Sanctioned or Limited-attempts boards** (where the play is or would land), nor on a
   locked card. Choosing the player after seeing the score would let a household pool attempts.
7. **A move is a removal plus a fresh landing** for the receiver through the ingest's own checks, never an
   update of the row's player. The giver's copy is tombstoned so a replay can't bring it back.
8. **Every player on a device sees every play made on it** while they were on it.
9. **Only device builds that send the clock offset get the feature.** Older builds behave as today.
10. **AtGames-native scores are out of scope.** Nothing binds them to a device.

## Consequences

- Every device path that reads the device's account (score, attempt, check-in, observation, the verify
  join, the activity log) reads the play's player instead. The verify join matches on the player, so an
  observation must carry the play's player, and moves with the play, or the ✓ is lost.
- Two players who agree can still move an Open-play score to whoever gains most. Ruling 6 closes that in
  the formats where it matters; in Open play it was already possible by playing on someone else's name.
- A move cannot unsend a Discord announcement made under the first player.
- A cabinet release and a Castcade release are needed before any household can use it.
