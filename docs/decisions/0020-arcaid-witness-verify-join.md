# ADR 0020 — Arcaid Witness: verify-join on exit ≈ created

**Status:** Accepted (2026-08-28)
**Builds on:** ADR 0017 (Live Event format) — the trust model here is ADR 0017's, extended with a
second, better-evidenced signal. ADR 0016's provenance taxonomy is untouched.

## Context

### The hole exit-to-submit leaves

An AtGames cabinet posts a score to AtGames' board **when the player exits the table**. P7 (v2.138.0)
made Arcaid read that board and enforce each Live Event round's window against AtGames' own
timestamp. What that proves is exactly one thing: *the score landed inside the window.*

It does not prove the game was **played** inside the window. A player can launch a table well before
a round opens, hold a ball (or simply sit on a high score in progress), and exit once the round is
live — the score then arrives, correctly stamped, inside the window. This is "gear-up", and it is
the one attack the round clock cannot see.

Two facts closed off the easy answers:

1. **AtGames does not filter it either** (owner-tested on hardware, 2026-08-25): a game started
   before the window and exited inside it is accepted onto their board. So there is no upstream
   check to lean on.
2. **`min_elapsed_sec` cannot help.** It measures the gap between the round opening and the score
   arriving — the exact quantity a geared-up player maximises rather than minimises. It catches the
   opposite abuse (a score that arrives implausibly fast) and by ADR 0017's own rule it is a badge,
   not a rejection.

Play duration was, in P7's words, *"unknowable until P8's on-device witness."*

### What the witness reports (v2.142.0, summarised)

Arcaid Witness is a small app that runs on the cabinet. It reads the launch and exit times of table
sessions from the device's own log and reports them to Arcaid. The shape is dictated by the
platform: **the AtGames SDK offers no POST**, so a report is a synchronous **GET**, and the auth
model had to survive living in a query string:

- **Device-scoped tokens.** A logged-in player mints a short-lived, single-use **pairing code** and
  types it into the app; the app redeems it (GET) and receives a token bound to its
  `ATGAMES_UNIQUE_ID` — stable, hardware-derived, per-device.
- **Hashed at rest.** `witness_devices.token_hash` is a SHA-256; the plaintext token exists only on
  the device. A wrong token gets a bare 401 that never says whether the device or the token was
  wrong.
- **A cabinet cannot be hijacked** onto a second Arcaid account (`DEVICE_CONFLICT`), and re-pairing
  by the same owner rotates the token.
- **Reports are idempotent** — `(device, table, launch)` is UNIQUE, because the app may retry a GET
  it never saw answered.

`witness_observations` stores `(atgames_unique_id, canonical_user_id, table_name, launch_ts,
exit_ts, duration_sec)`, launch/exit as **epoch seconds from the device's clock**. Until this ADR,
nothing read them.

## Decision

**Join each AtGames-sourced score on a round board to a witness observation by
`exit_ts ≈ created_at`, and render the result as a per-score badge.**

### The join key, and why it doubles as a clock check

Exit-to-submit means AtGames' timestamp and the cabinet's `exit_ts` describe the **same instant**,
observed by two independent clocks. Matching on it is therefore both the natural key and a free
consistency check: a cabinet whose clock has drifted produces no match, which reads as
`unwitnessed` — neutral — rather than as a false `verified`. There is no way for clock drift to
manufacture a verification.

This is why **`created_at` on `source='atgames'` rows now carries AtGames' own timestamp** rather
than `CURRENT_TIMESTAMP` (`ScoreHistoryService.log`'s new `createdAt` parameter). Before v2.145.0
those rows were stamped with the host's "Pull scores" click, which is a fact about the host's
afternoon: it made `elapsed_sec` on the round board meaningless and left this join nothing real to
join on. The dedup predicate (`isDuplicate`) deliberately does **not** consider `created_at`, so
re-pulls still recognise rows ingested before the change.

### Verdicts and constants

Per score (`WitnessVerifyService.verdictsForRound`, batched — one observation query per board):

| verdict | when |
|---|---|
| `verified` | an observation matched, and `launch_ts >= roundStart - LAUNCH_GRACE_SEC` |
| `flagged` | an observation matched, and the table was launched **before** the round opened |
| `unwitnessed` | no observation matched |
| *(no verdict — `null`)* | the row is not AtGames-sourced, or carries no timestamp |

- **`JOIN_TOLERANCE_SEC = 120`.** The true gap between exit and AtGames' stamp is upload latency;
  two minutes covers that plus modest NTP drift, and is narrow enough that two sessions of one table
  rarely both fit. When they do, the **nearest exit wins**.
- **`LAUNCH_GRACE_SEC = 15`.** Seconds of pre-start launch are two machines disagreeing about the
  time. **Minutes** early is gear-up — that distinction is the entire verdict.

Identity resolves through `IdentityLinkService` (canonical + `expandCandidates`), the same
expansion `EventResultService.loadParticipantSet` uses, so a cabinet paired under a Google identity
matches a score attributed to the linked Discord account. Synthetic keys (`iscored:*`, an unlinked
`atgames:*`) own no devices and fall out as `unwitnessed` **with no special-casing** — the general
rule already produces the right answer.

### `table_name` is informational, never matched

The witness reports the **engine-internal** table id (`aerobatics`); the catalogue and the round
carry a display name. These are different namespaces with no mapping, and none is being invented:
a wrong guess would silently downgrade legitimate scores every time it missed. The observed name is
surfaced so a host can eyeball it, and plays no part in the verdict.

### Standings carry one boolean

`EventStandingRow.witnessFlagged` is true when **any** counted round score was `flagged`. Only
`flagged` propagates — `unwitnessed` must never accumulate into a mark against a player who simply
never paired a cabinet. A boolean is identity-stable, so it freezes into `event_result` without
violating that blob's "identity-stable rows only" doctrine; blobs frozen before v2.145.0 carry no
such key and every reader treats it as false.

## Trust model

**This is a badge, never a gate.** No verdict rejects a score, filters a board, or changes a rank —
the same rule ADR 0017 set for `min_elapsed_sec`, and for the same reason: Arcaid is guessing at
something it cannot fully see, and a guess must not be allowed to take a result away from a player.

- It **catches casual gear-up**, which is the realistic abuse: a player who launches early and exits
  into the window now leaves a visible trace.
- It is **a receipt for social/stream enforcement**. The host sees "launched before the round
  opened" and decides; the tournament's rules and its people do the enforcing.
- It is **not tamper-proof anti-cheat**. Root is free on these cabinets, and the app reports what it
  is told to report. Anyone determined enough to falsify a report can. Building the feature as
  though it were proof would be worse than not building it, because a host would trust the wrong
  thing.
- **`unwitnessed` is never penalised.** Most players have no paired cabinet, and pairing is opt-in;
  a neutral default is the only honest rendering. It is styled as quiet grey text on the board — not
  as a warning.

## Consequences

- **Every ingest path that stamps somebody else's timestamp must pass `createdAt`.** A new
  cabinet-sourced sync that forgets it silently reintroduces the "the score arrived when the host
  clicked" bug, and its scores can never be witness-verified.
- **A new verdict status is a three-place change**: `WitnessVerifyService`, `EventScoreRow`, and the
  `WitnessBadge` renderer in `admin-ui/src/pages/EventDetail.tsx` (the one component that renders
  round-board rows — a Throwdown reaches it too, but has no AtGames sync, so its verdicts are always
  null).
- The verdicts are computed at READ time, not stored. There is no witness cache to invalidate, and a
  device paired *after* an event can retroactively verify scores it observed, which is the desired
  behaviour.
- `witness_observations` is now load-bearing for a user-visible badge; it was inert before. Its
  retention (currently unbounded) becomes a question the moment observation volume matters.
