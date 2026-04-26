---
status: accepted
date: 2026-04-21
deciders: Justin Mekelburg
supersedes:
superseded-by:
---

# Catalogue identity is `(name, type, manufacturer, year)` for pinball

## Context

`global_games` is the cross-room catalogue: every game (pinball machine, arcade title, or console game) has exactly one row, and `games`/`game_library`/`game_room_game_library`/`global_scores` link to it via `global_game_id`. Identity resolution must agree across catalogue sources (VPS, OPDB, IGDB, Wizard, manual entry) so that:

- A room admin importing the same game from two sources doesn't end up with two scoreboard cards for it.
- A user submitting a score for "Attack from Mars" in a manual entry merges with the rich VPS-imported row.
- A source re-indexing its own database (VPS occasionally reissues `vps_id` values) doesn't fork the catalogue.

The naive single-key approach failed in the v2.4.0 → v2.4.15 saga:

- **`UNIQUE(LOWER(name), type)`** (migration 068, the original v2.4.0 index) rejected legitimate same-name pinballs from different manufacturers — Stern Batman 2008 vs Data East Batman 1991, Williams Hot Tip 1977 vs the homebrew remake, etc. 115 import errors on the first Wizard run.
- **External-ID-only resolution** (`opdb_id` / `vps_id` / `igdb_id`) failed when VPS re-registered an entry with a new `vps_id`. Step 1 of the dedup hierarchy missed; step 4's name-based fallback excluded the row via the Frankenstein-prevention guard (`hasExternalIdConflict`); UPSERT fell through to INSERT and collided on the unique index.
- **Normalized-name-only resolution** matched too aggressively. `normalizeGameName` strips edition suffixes ("LE", "Pro"), manufacturer parentheticals, and punctuation — so "Transformers (Pro)" and "Transformers Pro" collapse to the same key, but so do unrelated entries that share a normalized first word.

The recurring import-error post-mortems all pointed at the same shape: pinball machines have a **canonical physical identity** that the catalogue must encode, even when external IDs disagree.

## Decision

The canonical identity for a pinball catalogue row is the tuple `(name, type, manufacturer, year)`. Two rows are the same machine iff all four agree (case-insensitive on name + manufacturer; year as integer). The schema enforces this with a composite UNIQUE INDEX:

```sql
CREATE UNIQUE INDEX idx_global_games_identity ON global_games (
    LOWER(name),
    type,
    LOWER(COALESCE(manufacturer, '')),
    COALESCE(year, 0)
);
```

(Migration 080. The `COALESCE` wrappers ensure NULL/NULL collisions still reject — two rows with NULL mfg + NULL year + same name+type can't coexist.)

`GlobalGameService.upsert` resolves identity via a 4-step hierarchy:

1. **External ID match** — `opdb_id` / `vps_id` / `igdb_id`. Authoritative when the IDs agree, with a cross-type guard that refuses to merge a pinball row into a video-game row (or vice versa).
2. **IPDB URL cross-reference** — pinball-only. Walks `tableFiles` / `b2sFiles` to extract the IPDB machine ID and matches against `ipdb_url LIKE '%id=N'`. Confirmed only when manufacturer + year also agree (NULL-tolerant).
3. **(Reserved.)**
4. **Normalized-name match.** `findByNormalizedName` does a full-table scan + JS-side `normalizeGameName` compare (no SQL `LIKE` prefilter — punctuation broke it; v2.4.12). Step 4 is two-tier:
   - **Concrete**: candidates with non-null mfg + year on both sides, exact match. These are *the same canonical machine*; multiple concrete matches break ties by richest-row (most external IDs, oldest `created_at`).
   - **Loose**: NULL-tolerant `manufacturerYearAgree` for thin-row merges. Fallback when no concrete match exists, with the same richest-row tie-breaker for multi-loose.

Step 4 concrete-path filters against the **full `nameMatches` set, not `nonConflicting`**. The Frankenstein-prevention guard (`hasExternalIdConflict`) is correctly conservative when canonical identity is *not* yet established — i.e., the loose path. But when `(name, mfg, year)` already agree, that's the same physical machine; a divergent external ID just means the source re-indexed itself. The COALESCE-based UPDATE adopts the new authoritative external ID:

```sql
UPDATE global_games SET
    vps_id = COALESCE(?, vps_id),
    opdb_id = COALESCE(?, opdb_id),
    igdb_id = COALESCE(?, igdb_id),
    -- ...
    WHERE id = ?
```

Stale IDs get replaced; missing IDs get filled.

### Key files

- `src/services/GlobalGameService.ts` — `upsert`, `findByNormalizedName`, `manufacturerYearAgree`, `hasExternalIdConflict`
- `src/utils/catalogueUtils.ts` — `normalizeGameName`
- `src/database/database.ts` — migrations 068 (initial index), 080 (composite identity index), 082 (post-tightening thin-dup re-merge)
- `src/database/migrations/catalogueUnification.ts` — backfill + dedup migrations
- `src/__tests__/catalogueIdentityIndex.test.ts` — coexistence, tie-breakers, NULL-collision, apostrophes, vps_id drift

## Consequences

- **Easier:** Same-name variants from different manufacturers coexist as separate rows by design (Stern Batman 2008 + Data East Batman 1991). Source re-indexing (VPS issuing new `vps_id`s) merges cleanly into the existing canonical row instead of forking the catalogue. Thin backfill rows (NULL/NULL) merge with rich rows as soon as a sourced import provides the canonical metadata.
- **Harder:** Imports without manufacturer or year (homebrew tables with no parens in the name, pre-2010 catalogue entries, Mystery Award test data) fall back to the loose path and rely on richest-row tie-breaking. The richest-row heuristic is correct in practice but is *not* schema-enforced — two zero-richness rows could in principle merge in arbitrary order. We accept this because the tie-breaker is logged and reversible via the catalogue admin UI.
- **Locked out:** A flat `(LOWER(name), type)` unique constraint is permanently off the table. Any future "make all names unique" requirement must supersede this ADR and either (a) introduce a normalized-name dedup pass that admins explicitly trigger, or (b) re-key around external IDs.

## Alternatives Considered

- **`UNIQUE(LOWER(name), type)` (the original v2.4.0 index)** — Rejected after Wizard import surfaced 115 same-name/different-mfg pinballs that the schema couldn't represent. Migration 080 dropped this index and replaced it with the composite.
- **External-ID-only identity (no name-based dedup at all).** Rejected. Sources don't all carry the same external IDs (VPS rows often lack `opdb_id`; manual entries lack everything). And re-indexing on the source side breaks identity.
- **Normalized name as the only identity.** Rejected. Aggressive normalization (`Pro` / `LE` / `Premium` stripped) collapses unrelated rows. Conservative normalization fails to catch real duplicates (`Transformers (Pro)` vs `Transformers Pro`).
- **Identity resolution at read time (no UNIQUE index, dedup only via UPDATE-or-INSERT logic).** Rejected. Without a database-enforced uniqueness invariant, race conditions during concurrent imports could create duplicates the dedup logic was supposed to prevent. The composite UNIQUE INDEX closes that race.
- **Hand-curated canonical IDs (admins assign a permanent UUID at first import, all subsequent imports merge into it).** Rejected for v2.4.0 — the admin UI cost is too high and the heuristic dedup gets us 99% of the way there. Could be added on top of this ADR if the heuristics ever fall short.
