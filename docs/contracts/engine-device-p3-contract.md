# Contract: Engine + Device — Phase 3 (read paths + fidelity categories) — v2.58.0

Implements **ADR 0016** (`docs/decisions/0016-engine-device-score-provenance.md` — read it first, in
full). Phase 1 (v2.53.0) shipped the taxonomy, migration 125 and every **write** path. Reads still use
the legacy `platform` column, which writers maintain in parallel. **P3 moves reads onto engine/device
and introduces the fidelity categories.** P4 (per-category cards on the Global Scoreboard) follows and
is the user's original request.

## Phase boundary

**In:** read paths, leaderboard filtering, `distinctPlatforms` → engine/device equivalents, fidelity
categories, and per-score display of engine + device.
**Out — do not build or stub:** tournament rule shape and its 11 parse sites (**P2** — rules keep
using the legacy flat namespace this phase; do not touch `platform_rules`), and the per-category card
grouping on the Global Scoreboard (**P4**).

**Do not drop the `platform` column.** Tournament rules still read it until P2. Writers keep deriving
it. This phase makes reads *prefer* engine/device; it does not remove the legacy path.

## 1. Fidelity categories

Per ADR 0016, category derives from **engine alone** — never device. `scoreProvenance.ts` already
carries the category on each engine; expose a small helper (BE + FE mirror, covered by the existing
parity test) rather than re-deriving at call sites.

- `real` → **Real**
- `vpx`, `vp9`, `fp` → **Simulation**
- `fx`, `fx_classic`, `fx_midnight`, `zaccaria`, `star_wars`, `atgames_native` → **Arcade-Style**
- video-game engines → outside the fidelity axis entirely
- `unknown` → **no category**. It must render as uncategorised, never bucketed into one. 63 of ~120
  prod rows are `unknown`/`atgames` (the irreducible AtGames ambiguity) — silently filing those into
  Simulation or Arcade-Style would be a lie the data can't support.

**Naming, already decided with the user:** the pinball fidelity band is **"Arcade-Style"**, and the
existing platform group `Arcade & Video` is renamed **"Video Games"** — because `arcade` is a live
platform id for arcade video cabinets and the collision is real, not cosmetic.

## 2. Read paths

### `LeaderboardService`
- `getForGameByPlatform` (~line 157) filters with `UPPER(platform) = UPPER(?)` — **a raw string
  compare with no alias folding**, while `getDistinctPlatforms` (~214) *does* fold via
  `normalizePlatform`. A tab can therefore be labelled from folded data and then query for a value
  that matches zero rows. Replace with engine (and optional device) filtering off the new columns.
  Keep a legacy fallback for rows whose engine is `unknown` **only** if removing it would hide
  existing scores — say which you chose and why.
- `getDistinctPlatforms` → return distinct **engines** (and devices) present, so the tab strip is
  built from the same field the filter queries. This closes the label/query mismatch by construction.

### `GlobalLeaderboardService`
- Entry shape already carries `platform`; add `engine` and `device`. Keep `platform` for now
  (P2 still needs it) but stop deriving display from it.
- The catalogue `platforms` filter (`gg.platforms LIKE ?`) is **substring matching on raw JSON** —
  `LIKE '%vpx%'` also matches `vpxs`. Fix it while you are here (exact match against the parsed array,
  or a delimiter-safe pattern). This is a live over-matching bug, not a refactor.

### `RoomScoresService`
Selects `platform` in its CTE but never projects it, so room-card previews show no platform at all.
Project engine/device so those cards can display provenance like every other surface.

### Route surface
`/leaderboard/:gameId?platform=X` — add `?engine=` and `?device=`. **Keep `?platform=` working** as a
deprecated alias mapped through `LEGACY_PLATFORM_MAP` (bookmarks and the Discord/OG links exist). Say
in the response which fields are authoritative.

## 3. Display

Everywhere a score currently shows one platform tag, show **engine** prominently and **device** as
secondary — a score is "VPX" *on* "AtGames", and conflating them is what ADR 0016 exists to end.
Surfaces: `GlobalGameCard`, `GlobalHeroCard`, `GameDetail` (rows + tab strip), `GlobalGameDetail`
(rows + column), `GameQuickView`, `GameInfoModal`.

- `unknown` engine renders as **"Unspecified"**, not blank and not omitted — a score whose provenance
  we genuinely don't know should say so rather than looking like a rendering bug.
- Device `unknown` is simply omitted (no secondary tag) rather than shown as "Unspecified" twice.
- Keep the tags legible on art: reuse the existing semi-opaque `--sb-pill-*` treatment.
- All colours via tokens; light mode must work.

## 4. Explicitly NOT in this phase
`TournamentForm`, `platform_rules`, `passesplatformRules`, `resolveSubmittablePlatforms`,
`ensureProvenanceAllowed`'s rule evaluation, and the `/api/submit/platforms` picker keep their current
behaviour. Touching them is P2 and drags in the 11-parse-site hazard.

## Tests

- Category derivation: each engine maps to the documented band; `unknown` yields **no** category;
  device never affects category (assert with the same engine across several devices).
- `getDistinctPlatforms` and the filter agree — a value returned by the former always matches rows
  through the latter (this is the alias-folding bug; assert it directly).
- `LIKE '%vpx%'` no longer matches `vpxs` in the catalogue filter.
- `?platform=` legacy alias still resolves; `?engine=`/`?device=` filter correctly.
- Anonymous payload shape stays additive only.
- Display: `unknown` engine renders "Unspecified"; `unknown` device renders no secondary tag.
- Baselines stay green: backend **887**, admin-ui **233**.

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD) · **no commit/branch/push**.

## Visual verification

Extend `tmp/global-scoreboard-harness.js`. Capture to `tmp/global-scoreboard-shots/`:
`provenance-desktop-dark.png`, `provenance-desktop-light.png` (1440×900) — fixtures must include a
`vpx`+`atgames` score, an `unknown` engine score, and a `real` score so all three display states are
visible in one shot.

## Blockers policy

STOP and report if removing the legacy `platform` read from any path would hide existing prod rows, or
if a display surface has no room for a secondary device tag without a layout change. Do not expand into
P2 or P4.
