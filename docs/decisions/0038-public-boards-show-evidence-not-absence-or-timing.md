# ADR 0038 — Public boards show evidence, not its absence and not round timing

**Status:** accepted (owner rulings 2026-11-09 and 2026-11-10), built as WORK.md A42 in v2.239.0

## Context

Two marks on the Live Event pages were meant as neutral facts but did not read that way to players.

1. **"unwitnessed."** `WitnessBadge` printed a grey "unwitnessed" beside every event score the Witness had
   no observation for (ADR 0020 §verdicts, ADR 0021: `unwitnessed` is the neutral default, never penalised).
   Of a round score in the ATGAMES_TEST_3 event that came in through the AtGames API, the owner wrote: "It
   looks like a derogatory note, and other players might assume it's cheating or bad." The Witness never
   delivers AtGames scores at all; it only vouches for timing. So the label described a missing
   corroboration that most players can never have (pairing is opt-in, most have no cabinet), and readers
   took it as an accusation.
2. **"+985:54."** The round board and the Discord "Round N results" post printed minutes:seconds since the
   round opened beside each score. The owner did not know what it meant either, and ruled: "The round
   times should be something the game room admin can see, not the general public. Not that it's private
   or should be kept secret, just that it's information no one cares about except the tournament runner."

## Decision

1. **The absence of evidence renders nothing.** Public integrity marks are ✓ (verified: session or
   check-in) and ⚠ (flagged: started before the round opened). `unwitnessed` stays a computed status
   (flag mode, the Integrity panel and the activity trail still use it) but has no public word. This is
   the rule the WITNESSED chip already followed (v2.155.0: "an unknown source renders nothing rather than
   an absence-of-badge that could be read as suspicion"), now applied to the Witness verdict too.
2. **Round timing is the runner's.** Time into the round appears only in Room Admin → Activity: the row
   line ("16h 25m into round 1"), the details panel (round, when it opened, the exact span) and the CSV
   (`round_time`). It is computed at READ from the round's `scheduled_start_at` (a Witness row from its
   `playedAt`, any other score row from its `created_at`), so it needs no column and older rows are timed
   too. The existing Player and Tournament filters are the runner's view of one player in one event.
3. **It is not a secret.** The event results API still carries `elapsed_sec` (the ⚡ mark needs it); the
   ruling is about what the page and the bot SHOW, not about access control.

## Not decided here

The ⚡ "posted unusually soon" mark (`min_elapsed_sec`, set by the host per event) and the ⚠️ it adds to
the Discord results post are still public. They only appear when a host opts in, which makes them a
host's statement rather than a default label; whether they move to the Activity log too is WORK.md A43.

## Consequences

- A score with no Witness evidence and no flag looks like any typed score, which is the intent.
- A runner auditing an event uses Room Admin → Activity, not the public board.
- A new public surface that wants to show a verdict draws ✓ / ⚠ only; a new surface that wants round
  timing belongs on an admin page.
- Code: `admin-ui/src/components/WitnessBadge.tsx`, `src/engine/EventScheduler.ts`
  (`announceRoundResults`), `src/services/ActivityLogService.ts` (`roundTimings`),
  `src/utils/activityPresentation.ts` (`roundTimeLabel`, `fmtSpan`). Rules: `witness.md`, `events.md`.
