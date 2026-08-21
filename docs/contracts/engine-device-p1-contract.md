# Contract: Engine + Device — Phase 1 (taxonomy, schema, write paths) — v2.53.0

Implements **ADR 0016** (`docs/decisions/0016-engine-device-score-provenance.md` — read it first, in
full; it supersedes ADR 0006 and partially supersedes 0009). Blast-radius facts referenced below were
verified against the code; re-verify line numbers, they drift.

## Phase boundary

**In:** the engine/device taxonomies, the compatibility map, migration 125, and **every write path**
that records score provenance — including the submission UI and Discord command.
**Out (later phases):** tournament rule shape and its 11 parse sites (P2); read paths, leaderboard
filtering, fidelity categories and display tags (P3); global-scoreboard category cards (P4).

Reads continue to use the existing `platform` column throughout P1 — **nothing visibly changes for
players except the submission form asking two questions instead of one.** Do not change any read path.

## 1. Taxonomy

New `src/utils/scoreProvenance.ts` (backend source of truth):

- `CANONICAL_ENGINES` — per ADR 0016's engine table, each `{ id, displayName, category }` where
  category ∈ `real | simulation | arcade_style | video`.
- `CANONICAL_DEVICES` — `pc`, `atgames`, `vr_headset`, `real_cabinet`, `standalone_other`, `console`,
  `arcade_cabinet`. Keep the 8 AtGames cabinet variants as sub-values of `atgames` (they already exist
  as `features` on `global_games` since migration 101 — reuse, don't reinvent).
- `ENGINE_DEVICE_COMPAT: Record<EngineId, DeviceId[]>` — which devices can run which engine. This
  drives both the submission picker and P2's tournament-rule validation. Author it from ADR 0016;
  where genuinely unsure, be permissive (a wrong restriction blocks a real score; a missing one only
  fails to help).
- `LEGACY_PLATFORM_MAP: Record<string, { engine: EngineId | 'unknown'; device: DeviceId | 'unknown' }>`
  covering every id in today's `CANONICAL_PLATFORMS` **plus the uppercase/alias variants present in
  prod** (`ATGAMES`, `VPX`, `VPXS` — normalize case first). Per ADR 0016: `atgames` → engine `unknown`,
  device `atgames`; `pinball_fx_vr` → `fx` + `vr_headset`; `vpxs`/`vpxs_manual` → `vpx` + `atgames`;
  `real` → `real` + `real_cabinet`; `vpx`/`vp9`/`fp`/`zaccaria`/etc → that engine + device `unknown`.
- `'unknown'` is a **first-class value, never NULL**, for both axes.

**FE mirror** `admin-ui/src/lib/scoreProvenance.ts` + **a parity test that fails on drift.** The
existing `platforms.ts` mirror has silently drifted to 22 of 53 aliases with no test; do not repeat
that. The test must assert engine ids, device ids, labels, and the compat map are identical across
BE/FE (import both, deep-compare) — this is a hard requirement of this contract.

## 2. Migration 125

Add to `submissions`, `score_history`, `community_scores`, `global_scores`, `submission_drafts`:
```
engine TEXT
device TEXT
```
Indexes mirroring today's platform indexes: `(game_id, engine)` etc. — match the existing naming
convention.

**Backfill** from the existing `platform` value via `LEGACY_PLATFORM_MAP`, case-normalized. Anything
unmapped → `'unknown'` for both. **Do not drop the `platform` column** — reads still use it until P3.

Follow the repo's inline-array migration convention; extract the handler to
`src/database/migrations/` if it exceeds a few statements (precedent: `platformTaxonomyExpansion.ts`).
Verify against a **copy of the prod DB**, not just a fresh one — per CLAUDE.md a fresh-DB boot does not
prove a migration safe. Expected prod shape: ~120 score rows, dominated by `ATGAMES` (57) and NULLs.

## 3. Write paths — all of them

Every path below must record engine + device. Where the value is unknown or not asked for, write
`'unknown'` explicitly, never NULL.

| Path | File | Note |
|---|---|---|
| `POST /:roomId/submit-score/:gameName` | `rooms.ts` ~1488 | Zod: add `engine` (required), `device` (required) |
| `POST /:roomId/freeplay-score` | `rooms.ts` ~1610 | same |
| `POST /:roomId/community-scores/:gameName` | `rooms.ts` ~1367 | same |
| `POST /api/global/scores` | `global.ts` ~1587 | currently inline-parsed, not Zod — move to a schema |
| submission-draft stage + **both** commit paths | `global.ts` ~678 / ~762 / ~933 | **Both commit paths currently skip `ensurePlatformAllowed` entirely** — add validation on commit; a stale draft must not write an incoherent pair |
| Discord `/submit-score` | `submitscore.ts` | two options; see §4 |
| iScored sync | `ScoreSyncPoller.ts` ~415, `TournamentEngine.ts` ~478 | no per-score provenance available — write `'unknown'`/`'unknown'` unless the tournament carries a default (see below) |
| `syncstate.ts` ×2, `admin.ts` ×2 | ~166/~273, ~1711/~1750 | **These four currently omit platform entirely.** Add engine/device as `'unknown'` rather than leaving the columns absent |

**Upsert consistency:** `ScoreSyncPoller` uses `COALESCE(excluded.platform, submissions.platform)`
(preserve) while `submitscore.ts` uses `platform = excluded.platform` (overwrite). Apply **one**
consistent rule to both new columns and state it in a comment: prefer COALESCE-preserve, so a re-sync
never blanks provenance a player supplied.

`tournaments.iscored_default_platform` → add `iscored_default_engine` / `iscored_default_device`.
Note it has **no admin UI today** and is therefore always NULL in practice; do not build the UI in P1,
but do not remove the column.

**`ensurePlatformAllowed`** (`rooms.ts` ~75-119) gains engine/device awareness. Critical: it currently
returns `null` to mean "allowed", so a partially-validated result passes. Restructure so an
unvalidated axis cannot fall through as success.

## 4. Submission UX — two questions, but not twice the work

The form must not feel like more work. Rules:

- **Engine first.** Options = the game's catalogue engines ∩ tournament-allowed (P2 will add rules;
  in P1 just the catalogue set). One option → locked read-only chip, as today. Zero → blocking message.
- **Device second**, filtered by `ENGINE_DEVICE_COMPAT[engine]`. One compatible device → auto-select
  and lock. Changing engine re-filters device and clears an incompatible selection.
- Remember the player's last device choice (localStorage) and pre-select it when compatible — an
  AtGames player should not re-pick "AtGames" on every submission. This is the single most important
  detail for the AtGames-first community.
- Copy: "Played on" (engine) and "Device" — avoid the word "platform" entirely in new UI.

**Discord `/submit-score`**: add `engine` + `device` options **with autocomplete** (today platform has
none — users must type raw canonical ids, which is why it rejects and asks for a re-run). Auto-fill
each when only one option is valid.

**Fix while here:** Discord resolves the game's platforms from `global_games.platforms` only
(`submitscore.ts` ~189) and never unions `RoomGameTagsService`, which the web path does — so a
room-tagged platform is submittable on web and rejected in Discord. Union it, so both paths agree.

## 5. Tests

- **Parity test** BE↔FE taxonomy (hard requirement, §1).
- Migration 125 against a **prod DB copy**: every legacy value maps as ADR 0016 specifies; no NULLs in
  either new column afterwards; `ATGAMES` (any case) → engine `unknown` + device `atgames`.
- Every write path in §3 records both columns — including the four that currently drop platform.
- Draft commit with a stale/incoherent pair is rejected (both commit paths).
- Engine→device compat: submitting an impossible pair (e.g. `real` engine + `pc` device) is rejected.
- `'unknown'` round-trips and is never written as NULL.
- Discord and web resolve the **same** engine set for a room-tagged game (the divergence fix).
- Baselines stay green: backend 817, admin-ui 184.

## 6. Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD to prove re-indentation) ·
**no commit/branch/push**.

## Blockers policy

STOP and report rather than guessing if: the compat map needs a device not in ADR 0016, a write path
exists that isn't listed in §3, or a read path turns out to depend on `platform` in a way that breaks
when the column stops being the only source. Do NOT touch tournament rules (P2) or read paths (P3).
