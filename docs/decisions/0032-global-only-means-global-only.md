# ADR 0032 — A device set to "Global Scoreboard only" sends to the Global Scoreboard only

**Status:** accepted (owner ruling 2026-10-24), built v2.174.0 (WORK.md W26) · **Amends:** the P9b routing in ADR 0022 / CLAUDE.md "WITNESS SCORE ROUTING"

## Context

A paired device carries one target (Account Settings → Arcaid Witness devices): Global Scoreboard only,
a room, or a room plus one tournament. Since v2.152.0 (P9b) an UNdesignated device still routes to the
event rounds of events its owner is a participant of (`VpxScoreIngestService.inScope`), on the reasoning
that checking in is itself consent. The option is labelled "Global Scoreboard only", so the label and the
behaviour disagree. During Witness Weekend Showdown (2026-10-23/24) this made the routing hard to explain
to testers, and it is the only reason Krobs's undesignated desktop scores reached the event.

## Decision

- "Global Scoreboard only" means exactly that: no room, rotation or event board receives the play.
- The wider question of how a play enters tournaments (room membership as consent, entry rosters,
  limited-attempts "Start attempts") is OPEN and tracked as W25; this ADR settles only the label's meaning.

## Consequences

- Ship after Witness Weekend Showdown ends: players relying on the fallback (undesignated devices of event
  participants) must be re-pointed or told first, or their event scores go to Global silently.
- If W25 lands on "room membership is consent", "Global Scoreboard only" becomes the opt-out it is named as.

## Amendment 2026-10-25: Throwdowns (owner ruling, at build time)

A Throwdown has no room, so no device can be pointed at one; under the strict reading a device score could
never count in a Throwdown. The owner ruled that a Throwdown the player has JOINED stays reachable: joining
it from its link is the deliberate act a designation would otherwise supply. It is reachable from any device
that is not pinned to one tournament, including a room-pointed device (pre-v2.174.0 those could not reach a
Throwdown at all). Room events, rotations and pinned tournaments follow the decision above unchanged.

Built as one pure rule, `deviceRoutesTo` (`src/utils/witnessRouting.ts`), shared by score ingest and the
event check-in lobby, which now grades a device only when it routes to the event and otherwise shows
`not_routed` ("Device not sending here"). At ship time one player relied on the removed fallback (Krobs,
Castcade desktop, Witness Weekend Showdown, already finished), so nothing in flight was affected.
