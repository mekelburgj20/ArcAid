---
status: accepted
date: 2026-07-12
deciders: mekelburgj
supersedes:
superseded-by:
---

# Manufacturer is the catalogue dedup discriminator; virtual-table IPDB links are references, not identity

## Context

The catalogue's 4-step dedup hierarchy (ADR 0004) treats a shared IPDB URL as a strong identity signal for pinball rows: step 3 of `GlobalGameService.resolveDedupCandidates` merges an incoming row into an existing one when both resolve to the same `ipdb.org/machine.cgi?id=N`. That was correct for its original case — the same physical machine imported from two sources (OPDB and VPS both describing *Cavaleiro Negro*).

The 2026-07-02 production duplicate review (60 groups, `CATALOGUE_DUP_REVIEW.md`) exposed the hole: **VPS carries IPDB links on tables that are not the machine.** Zen Studios' own digital originals (*Deadpool* (Zen Studios, 2014)), generic fan tables (manufacturer `Original`, incl. the `JP's …` naming convention), and tributes all ship with the IPDB id of the real machine that inspired them. The IPDB step happily merged those into the real machine's catalogue entry — a *virtual-only original* and a *physical Stern machine* collapsing into one identity, corrupting manufacturer/year/platforms for both.

The step-3 acceptance test at the time (`manufacturerYearAgree`) was NULL-tolerant: an empty manufacturer on either side passed. So the exact population most likely to carry a spurious IPDB link (missing or virtual-only manufacturer) was the population the guard waved through.

A second instance of the same disease: `upsert`'s UPDATE path uses `COALESCE(input, existing)` — input wins. Every VPS re-sync after the 2026-07-04 manual strip run could silently re-plant the stripped `ipdb_url` values onto the same virtual rows.

## Decision

**Same real manufacturer + shared IPDB = the same machine → merge** (real / vpx / fx are just platforms of one catalogue entry). **A virtual-only manufacturer (`Zen Studios`), a generic `Original` fan table, or a missing manufacturer = a different game** — its IPDB link only shares a theme, not an identity.

Three mechanisms enforce this (v2.21.0):

1. **Guard** — `resolveDedupCandidates`' IPDB step refuses the match when *either* side's manufacturer is virtual-only or missing (`isVirtualOnlyManufacturer`: `LOWER(manufacturer) IN ('zen studios','original')` or NULL/empty). The refusal falls through to the normalized-name step (which has its own concrete/loose tiers), mirroring the existing cross-type guard's shape. The shared walker means `upsert` and `findCandidates` both get it.
2. **Routing** — `upsert` normalizes its input at the single chokepoint every importer flows through: a virtual-only row's incoming `ipdb_url` moves to the new `based_on_ipdb_url` column (migration 109) and the identity field stays NULL. This also closes the COALESCE re-plant hole: the input's identity `ipdb_url` is null before the UPDATE is built. Deliberately placed in `upsert`, not per-importer — VPS's unconditional pass-through becomes harmless, and future importers can't reintroduce the bug.
3. **Audit** — `GET /admin/catalogue/dedup-audit` (super-admin, Catalogue admin page) reports the current-state disease: rows holding an identity `ipdb_url` with a virtual-only/missing manufacturer, plus groups of rows still sharing one IPDB id. State-based, so already-remediated rows never re-flag. `POST …/strip` moves a suspect's link to `based_on_ipdb_url` in-app (no prod shell needed).

**Source precedence for conflicting metadata** (policy, applied at review time; per-field source *storage* is deferred to the report-a-problem feature): real-machine manufacturer/year → **IPDB > VPS > OPDB** (IPDB is the curated historical authority; VPS tracks it; OPDB drifts more on year/manufacturer while remaining the external-ID/breadth backbone). External IDs → OPDB. Virtual/digital table metadata → VPS.

## Alternatives considered

- **Fix the VPS importer only.** Rejected: the corruption enters through `upsert`, and any other entry point (room contribution proposals, future importers) would reintroduce it. One chokepoint beats N call-site patches — the same reasoning as ADR 0013's watermark-over-invalidate-calls.
- **Drop virtual rows' IPDB links outright.** Rejected: the "based on" association has real product value (report-a-problem's "this year is from IPDB — dispute it there" flow, future cross-linking). A dedicated reference column preserves it without identity semantics.
- **Blocklist of known-bad IPDB ids.** Rejected: unbounded maintenance; the manufacturer predicate captures the class, not instances.
- **Treat NULL manufacturer as real (keep NULL-tolerance).** Rejected: the 2026-07 review showed missing-manufacturer rows are overwhelmingly fan/virtual content; a NULL-mfr row that genuinely is the machine still merges via the name step's loose tier.
