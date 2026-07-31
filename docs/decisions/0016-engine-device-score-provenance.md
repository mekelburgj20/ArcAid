# ADR 0016 — Engine + Device score provenance

**Status:** Accepted (2026-07-30)
**Supersedes:** ADR 0006 (score platform stratification) in full; ADR 0009 (orthogonal tournament
platform rules) in part — its *orthogonality principle* survives and is extended, its single-namespace
rule shape does not.

## Context

Every score row carries one `platform` string. That field is being asked to answer two different
questions at once:

- **What produced this score?** (Visual Pinball X, Pinball FX, Zaccaria, a real machine.) This is what
  determines whether two scores are comparable.
- **What did it run on?** (a PC, an AtGames Legends cabinet, a Quest headset, the machine itself.)
  This is provenance.

Those coincide often enough that one field worked — until AtGames. An AtGames cabinet runs Zen
titles, Zaccaria titles, AtGames-native (Magic Pixel) tables, **and** VPX tables. `atgames` as a
"platform" therefore says nothing about comparability, and a leaderboard that mixes an AtGames-VPX
score with an AtGames-FX score is comparing different games.

The conflation is not new; AtGames merely made it undeniable. Several canonical ids already encode
both axes: `pinball_fx_vr` is the FX engine on a VR device, `zaccaria_vr` likewise,
`star_wars_pinball_vr` additionally encodes a single product, and `vpxs` / `vpxs_manual` are the VPX
engine on standalone hardware (`vpxs_manual` also encoding an install method). VR even has its own
*group* in the backend taxonomy — a device masquerading as a platform class.

There is also a live data-quality consequence: the submission form asks one question ("what platform?")
against a list mixing engines and devices, so players answer different axes. Production data shows
exactly that — `ATGAMES` (57 rows) alongside `vpx` (16), plus case-split duplicates (`VPX`/`vpx`,
`VPXS`/`vpxs`) and 25–30 NULLs, across ~120 total score rows.

Two further forcing factors:
- The product is **pre-GA**; all current scores are beta data.
- The first production community (RTX Discord) is **AtGames-first**, so the ambiguous case will
  dominate real usage rather than being a corner case.

## Decision

**Split score provenance into two fields: `engine` and `device`.**

- **`engine`** — the software (or physical machine) that produced the score. **This alone determines
  comparability**, and it alone drives leaderboard grouping and the fidelity categories.
- **`device`** — the hardware it ran on. Provenance and flavour; displayed, filterable, and usable in
  tournament rules, but never a comparability boundary.

### Engine taxonomy

| Engine | Absorbs |
|---|---|
| `real` | real machines |
| `vpx` | `vpx`, `vpxs`, `vpxs_manual` |
| `vp9` | `vp9` |
| `fp` | `fp`, `bam` |
| `fx` | `pinball_fx` |
| `fx_classic` | `pinball_fx_classic`, `pinball_fx_classic_vr` |
| `fx_midnight` | `pinball_fx_midnight` |
| `zaccaria` | `zaccaria`, `zaccaria_vr` |
| `star_wars` | `star_wars_pinball_vr` |
| `atgames_native` | AtGames-native (Magic Pixel) tables |
| console/arcade ids | video games — unchanged |

**VPX Standalone is the VPX engine.** Its tables are ports of VPX tables with graphical concessions
for slower GPUs; physics and rulesets are unchanged, so scores are comparable. `vpxs_manual` differs
only by install effort, which is a catalogue property, not a property of a score.

**BAM is not an engine.** It entered the taxonomy through `VPS_FORMAT_MAP` because the Virtual Pinball
Spreadsheet emits "BAM" as a table format. "This table requires BAM" belongs on the game-availability
axis, like "requires manual install". On the score axis a BAM table is the `fp` engine.

### Device taxonomy

`pc` · `atgames` (with the existing 8 cabinet variants as sub-values) · `vr_headset` · `real_cabinet`
· `standalone_other` (Raspberry Pi / Android / Steam Deck VPX Standalone targets) · `console` ·
`arcade_cabinet`

The VR ids dissolve: FX-on-Quest is `engine=fx, device=vr_headset` — the same game, on a headset.

### Fidelity categories derive from engine only

`Real` (`real`) · `Simulation` (`vpx`, `vp9`, `fp`) · `Arcade-style` (`fx`, `fx_classic`,
`fx_midnight`, `zaccaria`, `star_wars`, `atgames_native`). Video-game engines sit outside this axis.

This is what dissolves the AtGames problem: an AtGames cabinet running a VPX table is a **Simulation**
score that happens to carry an `atgames` device tag, and it groups with PC-VPX scores where it belongs.

### Catalogue describes engines, not devices

`global_games.platforms` becomes an engine list. A table is authored *for* an engine; any device
capable of running that engine can run any of its tables. Device compatibility is expressed once, as
an engine→device compatibility map, rather than per game.

### Tournament rules gain a second axis

`platform_rules` becomes engine rules **and** device rules, each keeping ADR 0009's orthogonality:

- `requiredEngines` — game-level eligibility (does the game exist on this engine?)
- `excludedEngines` — submission-level filter
- `requiredDevices` / `excludedDevices` — submission-level only (a *game* has no device)

"FX titles on AtGames devices only" = `requiredEngines: ['fx']` + `requiredDevices: ['atgames']`.

**Accepted limitation:** independent axes cannot express a disjunction such as "FX-on-AtGames *or*
VPX-on-PC". Explicit engine/device pairs would allow it at a substantial cost in config UI complexity.
Deferred until a real need appears.

### iScored-synced scores never reach the Global Scoreboard

*(Added 2026-07-31, when P4's per-category cards made the consequence visible.)*

iScored returns a name and a number and nothing else, so a synced score carries no provenance of its
own. Left alone this fragments a game's leaderboard for a reason that isn't real — an Unspecified card
sitting beside a real one, holding the same players on the same table. At the time of the decision 5
of 37 games with global scores were already split this way, and continuous sync would have made it
the normal state rather than the exception.

Three rules, decided with the product owner:

1. **Sync applies to tournament games only.** Already structurally true —
   `ScoreSyncPoller.findLocalGameForIscoredId` INNER JOINs `tournaments`, so pinned rows
   (`tournament_id IS NULL`) are unreachable. Locked by test rather than rebuilt.
2. **Classify where the data supports it, `unknown` otherwise.** Preference order: derive from the
   tournament's own engine rules where they permit exactly one engine (integrity comes from an
   enforced constraint, not a recollection); else an admin-declared per-tournament default
   (`tournaments.iscored_default_engine` / `_device`); else `unknown`. A declaration contradicting
   single-engine rules is rejected at save time — it is an error, not an override.
3. **Synced scores are excluded from `global_scores` unconditionally** — including those successfully
   classified under (2). Classification serves tournament rules and room-level display; it is not a
   route to the global board. Enforced inside `GlobalScoreService.fanOutFromRoomSubmission` (which
   rejects `source: 'sync'`) rather than only by removing the caller, so it cannot be undone by
   accident.

**Accepted cost:** rooms that run entirely through iScored contribute nothing to the Global
Scoreboard. This is consistent with iScored being the legacy/optional path and does push rooms toward
submitting through Arcaid directly, but it is a real product effect, not a side effect.

### No backfill — clean break

Deriving the split from existing data is **impossible for exactly the cases that motivate it**:
migration 085 only stamped a platform where a game had exactly one, so multi-surface titles are
already NULL; an `atgames` row could be any of four engines, and a `vpx` row could be PC or AtGames.

Given ~120 beta score rows, existing values map best-effort where unambiguous (`vpx`→`vpx`/unknown
device, `real`→`real`/`real_cabinet`, `pinball_fx_vr`→`fx`/`vr_headset`) and to `unknown` otherwise —
notably every `ATGAMES`/`atgames` row, whose engine is unknowable. `unknown` is a first-class value,
not a NULL: such scores render without a category and are excluded from engine-filtered leaderboards.

## Consequences

**Good**
- Comparability becomes a property of the data model rather than a convention nobody can enforce.
- Six conflated ids (`vpxs`, `vpxs_manual`, `pinball_fx_vr`, `pinball_fx_classic_vr`, `zaccaria_vr`,
  `star_wars_pinball_vr`) and the pseudo-group "VR" all decompose.
- The submission question becomes answerable — two unambiguous questions instead of one ambiguous one.
- Tournaments can express device restrictions, which was previously impossible.

**Costs and risks**
- `tournaments.platform_rules` is parsed at **11 independent sites**, each silently falling back to
  "no rules" on an unexpected shape. Changing the shape without updating every site makes tournaments
  quietly stop enforcing anything. Every site needs a test.
- Submission gains a second required question; the flow must not become tedious. Where a game has one
  possible engine, or an engine has one plausible device, the field is auto-filled and locked.
- An engine→device compatibility map is new authored data that must be maintained as hardware appears.
- Leaderboard caches embed provenance in serialized JSON and must be busted (precedent: migrations
  086, 088).
- `unknown` provenance is permanently unresolvable for existing AtGames rows.

**Pre-existing defects to fix in the same work** (all found while mapping this, all would otherwise be
duplicated across two fields): Discord `/submit-score` resolves a different valid set than the web
(it never unions room tags); the `?platform=` leaderboard filter compares raw strings while
`distinctPlatforms` alias-folds, so a tab can match zero rows; `gg.platforms LIKE '%vpx%'` also matches
`vpxs`; four writers (`syncstate.ts` ×2, `admin.ts` ×2) drop platform entirely; two draft-commit paths
never re-validate; and the FE alias mirror has drifted to 22 of 53 entries with no parity test.

## Alternatives rejected

- **Engine-qualified ids** (`atgames_vpx`, `atgames_fx`, …) — consistent with how `pinball_fx_vr`
  already works, and cheap. Rejected because it multiplies combinatorially with every hardware×engine
  pair, and preserves the conflation that caused this.
- **AtGames as a fourth fidelity category** — zero data change, but separates AtGames-VPX scores from
  the PC-VPX scores they are genuinely comparable to.
- **Deferring until post-GA** — the ambiguity compounds with every score written, and the first
  production community is the one that generates the ambiguous case.
