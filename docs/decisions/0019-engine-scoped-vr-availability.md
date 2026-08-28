# ADR 0019 — Engine-scoped VR availability

**Status:** Accepted (2026-08-27)
**Amends:** ADR 0016 (engine + device score provenance) — the *provenance* model is untouched; this
changes only how the `vr_headset` device is matched on the **availability** (game-eligibility) axis.
ADR 0009's orthogonality principle survives unchanged.

## Context

On the 2026-08-27 Weekly Grind - VR rotation aftermath, the owner found **Banzai Run** queueable for
a VR-only tournament. The tournament requires `engines.required = [zaccaria, fx_classic, star_wars,
fx]` AND `devices.required = [vr_headset]`. Banzai Run passed both:

- Its `platforms` include `fx` — true: it exists in **flat** Pinball FX (PC/console, via the Steam
  import). It satisfies the engine axis.
- Its `features` include `vr` — also true: a **VPX VR-room mod** exists (via VPS). It satisfies the
  device axis (`DEVICE_AVAILABILITY_FEATURES.vr_headset = ['vr']`).

The two facts come from **different products**. Banzai Run is not in Pinball FX VR, but the model
pools availability facts into two flat sets and evaluates the axes independently, so "has FX
somewhere" × "has VR somewhere" admits a combination that exists nowhere. An id-anchored audit of the
live VR pick list (280 games) found **10 confirmed false positives** of this class: Banzai Run,
Black Knight 2000, Earthshaker, Godzilla (Sega 1998), Jurassic Park, South Park, Swords of Fury,
The Machine - Bride of Pin-bot, Tomb Raider (Original 2025), Whirlwind.

Two findings sharpened the design:

1. **The VPS `VR` tag means "has a VR Room" — an environment, not availability** (owner
   clarification, 2026-08-27). *Every* VPX table is playable in a VR headset; without a VR room the
   player just gets the cabinet in a black void. So per-table `vr` on VPX rows is meaningless as an
   availability discriminator — **VPX is VR-capable as an engine, wholesale**.
2. **FX is the opposite shape**: only the tables in the Pinball FX VR catalogue (curated,
   `src/services/fxVrPackContents.ts` — Zen ships no API) are VR-playable. VR capability is
   **per-table** there.

ADR 0016 P1 deliberately dissolved the `*_vr` platform ids into `engine + generic 'vr' feature` and
did "not try to distinguish PCVR from standalone." That stays correct for **score provenance** (what
device produced a score). It is wrong for **availability matching** the moment a tournament requires
an engine *and* a headset, because the fold discarded the only fact that answers "VR *of which
engine*?"

Name-based repair is not viable: the audit itself mis-credited "Godzilla" (Sega 1998) via the name
variant of Zen's "Godzilla Pinball" — adjacent names, different games. Evidence must be id-anchored
on catalogue rows.

## Decision

**VR availability is an engine property with two modes, plus per-table evidence where the mode
demands it.**

1. **`ENGINE_VR_AVAILABILITY`** — a new map in `src/utils/scoreProvenance.ts` (mirrored
   byte-identically in the FE copy, parity-test-extended), `engineId → 'always' | 'per_table' |
   'never'`:

   | engine | mode | rationale |
   |---|---|---|
   | `vpx` | `always` | owner ruling — every table renders in VR, room or not |
   | `fp` | `always` | owner ruling 2026-08-27 (Q2) — BAM provides the same wholesale VR capability |
   | `star_wars` | `always` | the product is a VR app (canonical legacy id is `star_wars_pinball_vr`) |
   | `zaccaria` | `always` | owner ruling 2026-08-27 (Q1) — every table is available via the Zaccaria VR Steam app |
   | `fx` | `per_table` | evidence = curated FX VR catalogue → feature `fx_vr` |
   | `fx_classic` | `per_table` | evidence = feature `fx_classic_vr`; curated 2026-08-27 (Q3) — 9 tables, see below |
   | everything else | `never` | `atgames_native`, consoles, `real`, … |

2. **New per-table availability features** `fx_vr` and `fx_classic_vr`. `FxVrImportService` writes
   `fx_vr` for every FX VR table it tags and `fx_classic_vr` for every FX Classic VR table (both
   loops, idempotent re-sync populates existing rows). The generic `vr` feature is **kept but
   demoted to informational** ("some VR room/edition exists") — it stops driving `vr_headset`
   required-matching except as the legacy fallback below.

3. **Matching rule** (in `deviceMatchesGame`/`passesplatformRules`; only the `vr_headset`
   REQUIRED-device path changes — all other devices, and the entire `excluded` axis, are untouched):
   - When the tournament requires engines: `vr_headset` is satisfied iff **some required engine E is
     on the game AND (mode[E] = 'always' OR the game carries feature `<E>_vr`)**.
   - When no engine is required: satisfied iff any engine on the game qualifies as above; a game
     with no engine-scoped signal at all falls back to the generic `vr` feature (legacy rows keep
     working).
   - The game-availability SQL pre-filter stays deliberately permissive (it is documented as a
     superset; `passesplatformRules` is the authority) — no SQL surgery.

4. **No schema migration.** `features` is already a JSON array; the change is importer output + the
   matching rule + one owner click of "Sync FX VR" post-deploy to stamp `fx_vr` on the 42 FX VR
   tables and `fx_classic_vr` (+ `manufacturer`) on the 9 FX Classic VR tables.

## Consequences

- The Weekly Grind - VR pick list drops the 10 false positives and keeps the 42 FX VR tables plus
  the Zaccaria/Star Wars/Future Pinball sets, plus the 9 curated Pinball FX Classic VR tables.
- A pure-VPX VR tournament (`engines.required=[vpx]` + `vr_headset`) admits **all** VPX tables —
  correct per the owner's clarification, and previously wrong (it admitted only VR-room tables).
- Engine-less `vr_headset` tournaments behave at least as broadly as before (legacy `vr` fallback).
- The `vr` feature's meaning narrows to "FYI, a VR room/edition exists"; nothing else reads it for
  eligibility.

## Alternatives rejected

- **Per-tournament manual game denylist** — works for one week, rots as catalogues evolve, adds
  standing admin toil (owner declined).
- **Matching through `ENGINE_DEVICE_COMPAT`** — deliberately permissive; would admit every VPX table
  to AtGames-only tournaments (ADR 0016's own warning).
- **Name-matched auditing/repair** — the Godzilla (Sega) vs "Godzilla Pinball" (Zen) collision shows
  adjacent names are different games; evidence must live on catalogue rows.

## Owner answers (2026-08-27)

1. **Zaccaria:** confirmed `always` — the entire Zaccaria catalogue is available via the Zaccaria VR
   Steam app.
2. **Future Pinball:** confirmed `always` — BAM provides the same wholesale VR capability as VPX.
3. **FX2 VR (`fx_classic`):** worth curating. It is now called **Pinball FX Classic VR** (not "FX2
   VR"), a separate Zen product from Pinball FX VR. Owner-supplied Steam table list (9 tables,
   `tmp/fx-classic-vr-tables-draft.md` → `src/services/fxClassicVrPackContents.ts`):

   | Pack | Tables |
   |---|---|
   | Base / Season 1 Pack | CastleStorm, Wild West Rampage, BioLab, Paranormal, Earth Defense |
   | Universal Classics | Back to the Future Pinball, Jaws Pinball, E.T. Pinball (Universal-licensed Zen tables) |
   | The Walking Dead | The Walking Dead |

   Several of these collide by name with real machines or VPX recreations ("Back to the Future" is
   a Data East 1990 machine; "Jaws", "E.T.", "The Walking Dead" have real/VPX namesakes too) — every
   FX Classic VR importer entry stamps `manufacturer: 'Zen Studios'` specifically so
   `GlobalGameService.upsert`'s step-4 dedup (`manufacturerYearAgree`) refuses to merge onto one of
   those rows. `FxVrImportService.applyTags` runs both the FX VR and FX Classic VR loops under the
   same "Sync FX VR" admin click.
