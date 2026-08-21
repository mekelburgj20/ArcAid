# Contract: Catalogue engines phase (ADR 0016 — final gap)

Implements ADR 0016's catalogue section (`docs/decisions/0016-engine-device-score-provenance.md`
§"Catalogue describes engines, not devices", ~lines 50–95 — read it in full first):
`global_games.platforms` becomes an **engine list**; device compatibility derives from the
engine→device compat map; per-game availability facts (AtGames availability, manual install, BAM
requirement, VR edition) live in `features`. This kills the last structural source of
unknown-engine scores: an AtGames-only game currently derives no engine, so its submissions
auto-lock to Unspecified.

Recon inventory date: 2026-07-31 (fresh, verified against code). **P2's lesson applies: re-sweep
every inventory below before relying on it; if reality disagrees with a list here, STOP and
report — the risk assessment is wrong, not reality.**

---

## 0. Hazards, stated plainly

These are the ways this phase silently breaks production. Each maps to a mandated step below.

- **H-A. Four engine ids are NOT keys in `LEGACY_PLATFORM_MAP`:** `fx_classic`, `fx_midnight`,
  `star_wars`, `atgames_native` (only their legacy spellings are). The moment a catalogue row
  stores them: `enginesFromLegacyPlatforms` yields `['unknown']` → picker auto-locks Unspecified
  (the exact bug this phase kills, reproduced for three engines), and
  `legacyPlatformsForEngine('fx_classic')` returns a set NOT containing `fx_classic` → eligibility
  matches zero rows. **Taxonomy first, data second (Section 1).**
- **H-B. `normalizePlatform` alias trap:** `PLATFORM_ALIASES['fx'] = 'pinball_fx'` in the OLD
  taxonomy (`platformMapping.ts`), and two runtime paths run CATALOGUE values through it
  (`GET /:roomId/platforms/available` rooms.ts~344, `GET /api/submit/platforms` global.ts~1615).
  An engine id `fx` gets silently re-legacied to `pinball_fx` before rules/pickers see it.
- **H-C. Device-axis `required` rules go vacuous.** `passesplatformRules` evaluates
  `devices.required` against the catalogue list today, and legacy `required:['atgames']` (lifted to
  the device axis by P2's shim) is the single most common production rule. Once `atgames`/`vpxs`
  leave `platforms`, `legacyPlatformsForDevice('atgames')` matches nothing → **every such
  tournament admits zero games.** Section 4 defines the replacement semantics.
- **H-D. Exact-match filter drift:** `GlobalGameService.search` filters by raw
  `includes(p)` (no folding); `GlobalLeaderboardService.buildCatalogueFilters` folds via
  `equivalentLegacyPlatforms`. They already disagree; both must resolve engine ids after this phase.
- **H-E. Ordering artifacts:** `GameLibrary.tsx` sorts on the raw JSON string; `GlobalGameCard`
  uses `platforms[0]` as primary chip; autopick paths take `MIN(platforms)` over a name-group.
  Collapsing lists reorders all three — decide and state the primary-order rule.
- **H-F. `upsert` union re-pollutes:** `GlobalGameService.upsert` union-merges platforms on
  update, so a migration alone is UNDONE by the next importer run. **Importer changes and the
  migration land in the same release.**
- **H-G. Room tags share the namespace:** every union site flattens catalogue ids ∪ free-form
  `room_game_tags` into one array. Tags stay free-form; the lift already keeps unknown tokens
  verbatim on the engine axis. No tag migration — but no code may assume the effective list is
  all-canonical.
- **H-H. `pc` exists in BOTH the engine and device namespaces.** Never cross-look-up; the
  taxonomy file header already warns.

## 1. Taxonomy prerequisites (before any data or importer change)

In `src/utils/scoreProvenance.ts` + byte-identical FE mirror + parity test:

- Add **identity mappings** to `LEGACY_PLATFORM_MAP` for every canonical engine id not already a
  key (at minimum `fx_classic`, `fx_midnight`, `star_wars`, `atgames_native` — sweep
  `CANONICAL_ENGINES` and assert in a test that EVERY canonical engine id is a key mapping to
  itself + `unknown` device, except ids whose key already exists). This makes engine-id catalogue
  rows first-class citizens of every existing read path BEFORE the data moves — and it is
  backward-compatible while the data is still legacy.
- `legacyPlatformsForEngine(e)` / `legacyPlatformsForDevice(d)` (in `platformRules.ts`) must
  include the canonical id itself in every expansion set (this falls out of the identity mappings
  — lock it with a test anyway).
- Kill H-B: the two paths that pass catalogue values through the OLD `normalizePlatform` must stop
  re-legacying engine ids — either fold through a provenance-aware normalizer or pass engine ids
  through untouched. State which you did.
- The parity test's invariants (every legacy mapping targets a canonical engine/device AND the
  pair is compat-valid) must stay green — extend, never weaken.

This section is its own commit, ships green with the catalogue still legacy. Everything after
builds on it.

## 2. Target shape and the fold table

**`platforms` = engines** (JSON array of canonical engine ids, lowercase).
**Availability facts = `features`** (existing precedent: the 8 AtGames cabinet variants already
live there; migration 101 established the platforms→features move pattern).

The fold, applied identically by the migration (Section 3) and by every importer (Section 5):

| Legacy catalogue id | → engine | → feature (availability fact) |
|---|---|---|
| `real` | `real` | — |
| `vpx` | `vpx` | — |
| `vpxs` | `vpx` | `vpxs` (runs standalone / AtGames-capable) |
| `vpxs_manual` | `vpx` | `vpxs_manual` (manual install) |
| `vp9` | `vp9` | — |
| `fp` | `fp` | — |
| `bam` | `fp` | `bam` (requires BAM) |
| `pinball_fx` | `fx` | — |
| `pinball_fx_vr` | `fx` | `vr` (VR edition exists) |
| `pinball_fx_classic` | `fx_classic` | — |
| `pinball_fx_classic_vr` | `fx_classic` | `vr` |
| `pinball_fx_midnight` | `fx_midnight` | — |
| `star_wars_pinball_vr` | `star_wars` | `vr` |
| `zaccaria` | `zaccaria` | — |
| `zaccaria_vr` | `zaccaria` | `vr` |
| `atgames` | `atgames_native` | `atgames` (available on AtGames) |
| console/arcade/pc ids | unchanged (same id is the engine) | — |
| junk (`fx2`, unmapped strings) | drop from platforms, **log every dropped token + row** | — |

**⚠ FLAGGED PRODUCT CALL #1 (defensible, reversible, made by the orchestrator 2026-07-31):**
AtGames-sheet games get engine **`atgames_native`**. Rationale: a game on that sheet runs on the
AtGames machine's own software; `atgames_native` is the ADR's engine for exactly that, and it ends
the unknown auto-lock. Known imprecision: Zen/FarSight-ported titles arguably carry their porter's
engine — the sheet's column-A fill color knows the studio but the CSV export path doesn't read
colors (ROADMAP "Studio attribution" item). If the product owner overrules, the change is one
importer line + one fold-table row. Do not build color parsing in this phase.

Dedup after folding (several legacy ids collapse to one engine). Preserve first-seen order with
engines ordered by the source list's first occurrence — and state the resulting primary-chip rule
(H-E). `features` additions are union-merged, lowercase, deduped.

## 3. Migration (claim the next free number; recon says 129 — verify)

Template: `platformTaxonomyExpansion.ts` 083/085/089 + migration 101 (the platforms→features
move) + 128 (handler module, halt-loudly, per-count logging, BEGIN/COMMIT/ROLLBACK).

- First step: **fresh distribution count** — log distinct platform ids + row counts before
  touching anything (the only existing snapshot is April 2026 and predates four importers).
- Apply the Section 2 fold to every `global_games` row. Write only changed rows. Log per-id
  transform counts and every dropped junk token with its row id.
- Do NOT touch `room_game_tags`, `tournaments.platform_rules` (P2's shim owns rules),
  `game_room_game_library.custom_platforms` (dead, verified), or score tables' `platform` column.
- Idempotent: the fold must be a fixed point (folding an already-folded row changes nothing).
  Assert with a test that runs it twice.
- Cache-bust `leaderboard_cache` + `global_leaderboard_cache` if any card-visible field changes
  (platform chips ship in cached card rows — they do; bust both, precedent 086/088/127).

## 4. Readers — the semantics that must hold afterwards

- **Engine-axis `required`/`excluded`:** direct membership against the catalogue's engine list
  (∪ room tags, verbatim-token behavior for unknowns unchanged). The legacy-expansion machinery
  (`legacyPlatformsForEngine` etc.) stays — room tags and unmigrated callers still produce legacy
  tokens — but engine ids now match first-class (Section 1).
- **Device-axis `required` (H-C — ⚠ FLAGGED PRODUCT CALL #2, orchestrator 2026-07-31):** a
  device-required rule gates a game via **per-game availability ∪ engine-compat**: device `atgames`
  matches a game iff its features contain `atgames`/`vpxs` (explicit availability) OR any of its
  engines lists `atgames` in `ENGINE_DEVICE_COMPAT`... **NO — too wide.** `ENGINE_DEVICE_COMPAT` is
  deliberately permissive (vpx→atgames is compat-true for every VPX table, which would make
  `required:[atgames]` admit ALL VPX games — a behavior change from today, where only
  `vpxs`-tagged games match). **Ruling: device-required matches on explicit availability ONLY:**
  device `atgames` ⇔ features ∋ {`atgames`, `vpxs`} (or legacy tokens still present pre-migration);
  device `vr_headset` ⇔ features ∋ `vr` (or legacy `*_vr` tokens); `real_cabinet` ⇔ engine `real`;
  `pc`/`console`/`arcade_cabinet` ⇔ the corresponding engine-category membership. This preserves
  today's effective gating for the dominant `required:['atgames']` rule exactly. Spell out YOUR
  final device→match table in the report and lock each row with a test comparing pre/post-migration
  gating on a fixture catalogue.
- **`resolveSubmittablePlatforms` / submit pickers:** post-migration the "platforms" flowing to
  `enginesFromLegacyPlatforms` are engine ids (identity-mapped) ∪ availability has moved to
  features — `ScoreProvenanceService.resolve*` must also read `features` and pass them to
  `devicesForEngineAndPlatforms` (or a successor) so device options still narrow by availability
  (an AtGames-only game offers the atgames device; a plain VPX game offers what compat allows).
  Assert: AtGames-only game → engine picker shows AtGames Native (NOT locked Unspecified) —
  this is the phase's acceptance test.
- **Both catalogue filter paths (H-D)** resolve a requested id (legacy or engine) to the same
  match set: fold the request through the same table. Unify or share the helper; state which.
- **`GET /api/submit/platforms`** and `ScoreProvenanceService` currently duplicate resolution
  logic — do NOT unify them in this phase (scope), but both must apply the same engine/features
  reading. One test asserting they agree on a fixture game.

## 5. Importers — all seven + upsert, same fold

Each importer emits engines + features per Section 2 (via ONE shared helper — e.g.
`foldCatalogueplatforms(legacyIds) → {engines, features}` in `scoreProvenance.ts`, so the migration
and every importer cannot drift):
VPS (`VPS_FORMAT_MAP` output folds; unmapped tableFormats: keep current verbatim-lowercase
behavior but through the fold's junk logging), Wizard (auto → `vpx`+`vpxs`; manual →
`vpx`+`vpxs_manual`; `reconcileWizardPlatformTags` rewritten to reconcile the FEATURES pair and
strip stale `vpxs*` from platforms), OPDB (`real`, unchanged shape), IGDB (console ids are engines
already — fold is identity), Steam Pinball (curated map ids fold: `pinball_fx_classic`→`fx_classic`
etc.), FX VR (`fx` + feature `vr`), AtGames (`atgames_native` + feature `atgames` + existing
cabinet variants). `GlobalGameService.upsert`'s union stays but unions ENGINE lists now;
`submit_to_global` (rooms.ts raw INSERT) and admin `update` (W9/W11) fold inbound values so
legacy ids from stale clients upgrade rather than pollute.

## 6. FE

- Engine chips render via the provenance display helpers (`getEngineDisplay` / short labels) —
  `GlobalGameCard`, `GlobalHeroCard`, `GameInfoModal` (already labeled "Engines"), `GameQuickView`,
  `GlobalGameDetail`, `GameLibrary` chips. Features surface ONLY where cabinet variants already do
  (no new UI for `vr`/`bam`/`vpxs_manual` beyond existing features display — out of scope).
- `GameLibrary` sort: sort on the first engine's display label, not the raw JSON string.
- **FE sibling of H-B (found during Section 1, 2026-08-01):** `admin-ui/src/lib/platforms.ts`
  `normalizePlatformList` also aliases `'fx' → 'pinball_fx'` and is called from
  `GameLibrary.tsx` (~86, ~716, ~755) — the library list, its platform filter, and tag matching
  would re-legacy engine ids client-side. Apply the same isCanonicalEngine-passthrough fix there
  (FE has `isCanonicalEngine` via the scoreProvenance mirror).
- `GlobalScoreboard`'s filter chips (`PLATFORM_GROUPS` from the old `lib/platforms.ts`): map the
  chip values through the fold when sending `?platforms=`, or re-key the chips to engines — state
  which; the BE accepts both post-H-D anyway.
- Admin raw-id surfaces (`GlobalCatalogue`, `CatalogueApproval`) may stay raw (super-admin tools).

## 7. Tests

- Every canonical engine id is a `LEGACY_PLATFORM_MAP` key (Section 1) and round-trips through
  `enginesFromLegacyPlatforms` to itself.
- Fold table: every row of Section 2's table asserted; fold is idempotent; junk logs.
- Migration: fixture with every legacy id → assert resulting engines+features; run twice → no-op;
  count logs.
- Pre/post gating equivalence: for each device→match rule (Section 4) a legacy-catalogue fixture
  and its folded equivalent admit the SAME games under the SAME tournament rules — this is the
  phase's analogue of P2's "legacy row gates identically" test.
- AtGames-only game: engine picker offers AtGames Native, submission records `atgames_native`,
  NOT unknown.
- Each importer: emits folded shape (unit-level, mock source data).
- Parity test green; FE mirror byte-identical below header.
- Baselines: verify current backend/admin-ui counts on the branch BEFORE starting and keep green.

## Gates

Root build · admin-ui build · full BE+FE vitest · CRLF per touched file · migration tested against
a COPY of a realistic DB if available (never the live file) · no push (orchestrator ships).

## Blockers policy

STOP and report if: any inventory above mismatches the code; any legacy id lacks a defensible
fold row; the device→match table cannot reproduce today's gating for `required:['atgames']`;
or the parity test has to be weakened. Product calls #1 and #2 are made-and-flagged — implement
as written unless the product owner overrules before you start.
