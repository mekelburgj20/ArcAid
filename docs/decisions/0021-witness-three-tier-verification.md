# ADR 0021 — Arcaid Witness: three tiers of verification

**Status:** Accepted (2026-08-29)
**Builds on:** ADR 0020 (Witness verify-join) — the session join is unchanged and remains tier 1.
ADR 0017's trust model ("a badge, never a gate") is reaffirmed, not relaxed.

## Context

ADR 0020 shipped ONE way to verify an AtGames-sourced score: join it to a witness observation on
`exit_ts ≈ created_at` and ask whether the table was launched after the round opened. That works,
and it is the strongest evidence available — but it only fires when the cabinet produced a session
observation for that exact score, which in practice means the resident detector was running, saw
both ends of the session, and reported them.

Hardware rounds 4 and 4b (2026-08-29) changed what the cabinet can offer:

- **A resident "beacon" survives on 6.x firmware.** It ran unbroken across two back-to-back table
  sessions and past a reopen of the tile app, so live observation on the big cabinets is real, not
  aspirational.
- **Some evidence only exists retroactively.** VPX journals its own sessions to the stick
  (`vpx-sessions.json`); Zen leaves per-table save writes; arcade titles leave staging touches. A
  witness that reads those AFTER the fact can reconstruct sessions the beacon missed — a cabinet
  that was offline, an app that was closed, a build installed mid-event.
- **A launch signal is not always available, but "the app is open" always is.** The tile app knows
  when a player opened it, and these cabinets **run one thing at a time**.

That last fact is the one this ADR turns into evidence.

## Decision

**Verification has three tiers. All three produce the same verdict vocabulary; the tier is carried
alongside so a host can see what the badge rests on.**

### Tier 1 — session join (unchanged)

Exactly ADR 0020: `exit_ts ≈ created_at` within `JOIN_TOLERANCE_SEC` (120), then
`launch_ts >= roundStart − LAUNCH_GRACE_SEC` (15) ⇒ `verified`, earlier ⇒ `flagged`. The verdict now
carries `method: 'session'`.

### Tier 2 — round-start check-in attestation (new)

**Opening the Witness on the cabinet proves no game spans that moment.** These cabinets run one
application at a time: if the Witness is in the foreground at time *T*, no table is mid-session at
*T*. So for any score that EXITED after a check-in that happened at or after the round opened:

> the table was launched after *T*, and *T* ≥ roundStart − grace, therefore the table was launched
> inside the round window.

That is the whole proof, and it closes the same gear-up gap tier 1 closes — using a signal the
cabinet can always produce, even when no launch signal is available for that engine.

The rule, evaluated only for scores tier 1 could not resolve:

| condition | verdict |
|---|---|
| a check-in exists with `roundStart − LAUNCH_GRACE_SEC ≤ server_ts ≤ score.created_at` | `verified`, `method: 'checkin'` |
| otherwise | `unwitnessed` (unchanged) |

Three deliberate properties:

- **Tier 2 can never produce `flagged`.** A check-in is an alibi, never an accusation. If it is
  missing, or too early, the score simply stays `unwitnessed` — the neutral default. Nothing about a
  player who never opened the app becomes a mark against them.
- **Tier 2 never overrides tier 1.** A row already `flagged` by a real observed session is not
  revisited. Evidence of a table launched before the round is stronger than evidence that the
  cabinet was free at some earlier instant.
- **A check-in from before `roundStart − grace` proves nothing** and is ignored. The cabinet could
  have been idle then and busy with a geared-up table by the time the round opened.

Check-in verdicts carry **no duration**. A check-in dates the play; it does not measure it.

### Why the check-in timestamp is the SERVER's

`witness_checkins.server_ts` is stamped when the request arrives. The device is not asked for a time
and would not be believed if it offered one.

This is not paranoia bolted on — it is what makes tier 2 mean anything. Tier 1 can afford to use the
device's clock precisely because that clock has to AGREE with AtGames' independent timestamp; drift
produces no match, never a false pass (ADR 0020). A check-in has no second clock to be checked
against. If the device chose its own timestamp, the attestation would reduce to "the cabinet says it
was idle when it says it was idle" — a self-report with no evidential content at all.

### Tier 3 — retro-derived observations: same trust, tagged

Observations reconstructed from on-disk traces after the fact are trusted **exactly as** live ones
(owner ruling, 2026-08-29): they describe the same sessions, read from the same device, reported
over the same authenticated channel. Treating them as weaker would mean discarding real evidence for
a distinction that does not change what happened.

They are nonetheless **tagged**: `witness_observations.via` is `'live'` or `'retro'`, first-writer-
wins (the `ON CONFLICT` update deliberately does not overwrite it), and the verdict passes it
through. The tag costs one column and preserves a distinction that cannot be recovered later if the
question ever turns out to matter — while changing no verdict today.

### What a check-in cannot do: bind a score to a device

A check-in proves **the cabinet was idle**, for the cabinet the player paired. It cannot prove the
score in question came from THAT cabinet. AtGames' API exposes only a model code
(`AtGamesRanking.hardware`, e.g. a cabinet family), never a device identity — there is nothing to
match `ATGAMES_UNIQUE_ID` against.

So a player with two cabinets, or one playing on a friend's machine, could in principle check in on
one while a geared-up table sat on another. This is accepted rather than solved: it is a strictly
narrower hole than the one tier 2 closes, it requires deliberate setup rather than opportunism, and
the alternative — refusing the tier — would leave every such score `unwitnessed` and prove nothing
at all. The badge is evidence for a human, and this is a limit a host should know about; it is not a
reason to withhold the evidence.

## Trust model — reaffirmed

**Still a badge, never a gate.** No verdict from any tier rejects a score, filters a board, or
changes a rank. `unwitnessed` stays NEUTRAL and is still the common case — most players have no
paired cabinet, and pairing is opt-in. `flagged` remains a hint for a human, and the mechanism as a
whole remains evidence for social/stream enforcement, not tamper-proof anti-cheat: root is free on
these cabinets and the app reports what it is told to report.

Adding a second way to earn `verified` slightly widens what a determined faker could claim. That is
the correct trade for a badge: the cost of a false `verified` is a host trusting a score they should
have looked at, while the cost of withholding tier 2 is that honest players on engines with no
launch signal can never be verified at all.

## Re-run verification

Evidence arrives late. A cabinet that was offline all night uploads in the morning; a player links
their AtGames account the next day; a retro sweep runs after the event. Before this release every
one of those landed AFTER `event_result` was frozen and changed nothing — reported into the void.

`POST /api/rooms/:roomId/admin/tournaments/:tournamentId/reverify` (room admin) recomputes the
standings from today's `score_history` + observations + check-ins and re-freezes them. It reuses
`EventResultService.computeStandings` + `freeze` — the SAME pair `EventScheduler` uses at the
buzzer, so there is no second definition of what a result is — and it does **nothing else**:

- `event_finished_at` is preserved verbatim. The event finished when it finished.
- `is_active` is untouched, so the alias-link freeze gate keeps treating the event as completed.
- **Nothing is announced.** A second podium post to Discord hours later would read as a second
  event. The announce path is not on this route at all.

Room-less Throwdowns have no room-scoped admin surface, so they have no reverify action. Their
standings are single-round and computed at read time until they freeze; giving them one would mean
inventing a public route with a new authorization story, which is out of scope here.

## Consequences

- **`witness_checkins` is server-time-only, forever.** Any future path that writes a check-in must
  stamp it server-side; accepting a device time silently converts tier 2 into a self-report.
- **A new verdict tier is a four-place change**: `WitnessVerifyService`, `WitnessVerdict`,
  `EventScoreRow`'s consumer, and the `WitnessBadge` renderer in
  `admin-ui/src/pages/EventDetail.tsx`.
- **`via` must never gate anything** while the ruling stands. Code that filters on
  `via = 'live'` would quietly reintroduce a trust tier the owner rejected.
- Verdicts remain computed at READ time and are not cached; only the `witnessFlagged` boolean
  freezes into `event_result`, so re-verification is always just a recompute.
- `witness_checkins` grows one row per app open per cabinet. It is small and append-only, but it
  joins `witness_observations` on the list of tables whose retention becomes a question if witness
  volume ever matters.
