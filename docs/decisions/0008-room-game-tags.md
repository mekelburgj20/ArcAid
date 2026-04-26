---
status: accepted
date: 2026-04-26
deciders: mekelburgj
supersedes:
superseded-by:
---

# Per-room game tags via dedicated `room_game_tags` table

## Context

The user wants to bulk-tag a set of catalogue games with a per-room label
(e.g. "WMS" applied to all Williams machines in a specific room) so a
tournament can require that tag in its platform rules. Practical use case:
"create a tournament that picks only from games tagged WMS in this room".

There were three viable storage paths:

1. **Revive `game_room_game_library.custom_platforms`** — the column was
   originally added in v2.4.0 for exactly this purpose, then deprecated in
   step 2c (v2.6.0) because no UI ever shipped to populate it.
2. **Add tags directly to `global_games.platforms`** — quickest implementation
   but per-room semantics are lost: tagging in Room A would leak into Room B.
3. **A new dedicated table** keyed on `(game_room_id, global_game_id, tag)`.

The catalogue is variant-keyed: `global_games` rows distinguish e.g. four
"Carnival" variants (Bally 1948, Bally 1957, Sega 1971, Playmatic 1977).
Phase 1 of this work (v2.6.0+) made the FE library page render variants as
distinct rows; the user expects bulk-select to operate at variant
granularity. `game_room_game_library`'s composite PK is
`(game_room_id, game_name)` — name-level, which would conflate variants.

## Decision

Create a new table `room_game_tags(game_room_id, global_game_id, tag)` with
PK on the triple. Variant-level keying via `global_games.id`.

```sql
CREATE TABLE IF NOT EXISTS room_game_tags (
    game_room_id TEXT NOT NULL,
    global_game_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (game_room_id, global_game_id, tag)
);
CREATE INDEX idx_room_game_tags_room_tag ON room_game_tags(game_room_id, tag);
```

Tags are normalized lowercase + trimmed on write. Display falls through
`getPlatformDisplay` (uppercase fallback for ids not in the canonical
registry, so user-entered "wms" renders as "WMS" alongside curated
catalogue labels like "Visual Pinball X").

Read paths union catalogue platforms with room tags:

- `GET /:roomId/platforms/available` — catalogue distinct ∪ room distinct tags
- `ensurePlatformAllowed` (submission validation) — `gg.platforms` ∪ tags for
  any variant of that name in this room
- `GET /api/submit/platforms` — same union
- `GET /:roomId/game_library` — each row carries `room_tags: string[]` keyed
  on `global_game_id`

Write paths (per-room admin only):

- `POST /:roomId/games/:globalGameId/tags` — single add
- `DELETE /:roomId/games/:globalGameId/tags/:tag` — single remove
- `POST /:roomId/games/bulk-tag` — `{ globalGameIds: [...], tag }` (cap 500)
- `POST /:roomId/games/bulk-untag` — same shape

Tournament-rule matching for a submission keys on `gameName`, so the room-tag
lookup unions tags across all variants of a name. If any Carnival variant in
the room is tagged "WMS", any Carnival submission satisfies a `required: ["WMS"]`
rule. Pragmatic for the typical use case (manufacturer-driven bulk tagging,
where all variants of a name share a manufacturer).

## Consequences

- **Easier:** variant-level granularity matches the FE row model. Tagging
  is a separate dimension from the catalogue's shared platforms, so no
  cross-room leakage. Users can express room-specific groupings ("our weekly
  Williams night") without polluting the global catalogue.
- **Easier:** decoupled from the surviving `game_room_game_library` style
  overlay. When that table is eventually re-keyed to `global_game_id` (per
  the v2.6.0 deviation note), this table is unaffected.
- **Harder:** two related tables instead of one. Could be unified with
  `game_room_game_library` once the latter is re-keyed; out of scope here.
- **Locked out:** name-level tagging (e.g. "tag every variant of Carnival
  in one click"). Mitigation: bulk-select all visible Carnival rows from
  the manufacturer-filtered library, then bulk-tag.

## Alternatives Considered

- **Revive `game_room_game_library.custom_platforms`.** Rejected — name-level
  granularity confuses the variant-row UI shipped in v2.6.0+; revival un-does
  the step 2c cleanup we just shipped.
- **Tags column on `global_games`.** Rejected — tags are inherently per-room,
  not catalogue-level. Storing them globally would either leak between rooms
  or require a JSON object keyed by room id (awkward to query).
- **Reuse `tournaments.platform_rules` to point at gameName lists.** Rejected
  — that flips the data model from "tag-then-filter" to "list games per
  tournament", which loses the bulk-management UX entirely.
