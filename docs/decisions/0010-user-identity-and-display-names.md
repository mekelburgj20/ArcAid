---
status: accepted
date: 2026-04-28
deciders: mekelburgj
supersedes:
superseded-by:
---

# User identity layer: `user_mappings` (many-to-one aliases) + `user_profiles` (chosen display name)

## Context

Through v2.7.x ArcAid had three player-identity concepts wired into different parts of the system:

- `user_mappings(discord_user_id PK, iscored_username NOT NULL, avatar_hash)` — strict 1:1 between a Discord user and *one* iScored alias. Used by `ScoreSyncPoller` to attribute incoming iScored scores to a Discord user; also held the avatar cache.
- `iscored_username` on every score row — the displayed alias. The leaderboard `PARTITION BY LOWER(iscored_username)` made this the de-facto identity for ranking purposes.
- `room_members.display_name` / `anon_room_claims.display_name` — per-room first-claim policy; orthogonal to the iScored alias.

Three problems surfaced in production:

**1. Identity-merge had no forward attribution.** `MergeService.recordMerge` retrofitted historical rows under a Discord user but never wrote `user_mappings`, so the next iScored sync of "PBW2023" continued landing as `iscored:PBW2023` (synthetic-anon). Admins had to repeat the merge after every score, or fix mappings via direct SQL.

**2. Users couldn't have more than one iScored alias.** A real-world player who sometimes submits as "PBW2023" and sometimes as "pinball-wizard-2023" (both their submissions; iScored treats them as separate identities) couldn't be unified — `user_mappings.discord_user_id` was the PK, so each Discord user held at most one alias. The `/map-user` command reflected this with `ON CONFLICT(discord_user_id) DO UPDATE`: setting a new alias erased the old one.

**3. There was no user-chosen display name.** Players were displayed under whichever iScored alias produced the row. A Discord user named "PinballWizard2023" who happened to submit on iScored as "PBW2023" had no way to render uniformly across surfaces. iScored's own canonicalization picks the highest-scoring case variant, which doesn't even align with what the user called themselves.

The user (this site's operator) explicitly compared the desired UX to Discord's own model: a Discord ID is permanent, but each user picks a globally-unique **display name** that all messaging surfaces use, while username/handle stays as the underlying identifier. ArcAid should mirror that — the iScored alias is the underlying handle (allowing many per user), the user-chosen `display_name` is the rendered identity.

## Decision

Four coupled changes, shipped together as v2.8.0:

### 1. `user_mappings` becomes many-to-one

```sql
CREATE TABLE user_mappings (
    discord_user_id  TEXT NOT NULL,
    iscored_username TEXT NOT NULL,
    avatar_hash      TEXT,                 -- deprecated; phased out, see §2
    created_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(iscored_username COLLATE NOCASE)
);
CREATE INDEX idx_user_mappings_discord ON user_mappings(discord_user_id);
```

One Discord user can hold many iScored aliases. The UNIQUE on `iscored_username` (case-insensitive) keeps each alias bound to at most one Discord user — a name belongs to one human. Migration **095** rebuilds the table, refusing to run if existing rows already collide case-only on the same username.

All five UPSERT call sites switch from `ON CONFLICT(discord_user_id) DO UPDATE SET iscored_username = excluded.iscored_username` to `ON CONFLICT(iscored_username) DO NOTHING`:

- `src/api/routes/auth.ts` — Discord OAuth callback (now writes avatar to `user_profiles`)
- `src/api/routes/global.ts:1054` — global-page display-name save
- `src/discord/commands/mapuser.ts` — additive-only; errors if name owned by different user
- `src/discord/commands/submitscore.ts:182` — auto-map on first submit
- `src/engine/IdentityManager.ts:73` — backfill helper (currently dead code; updated for consistency)

### 2. `user_profiles` is canonical for display_name + avatar_hash

```sql
CREATE TABLE user_profiles (
    discord_user_id    TEXT PRIMARY KEY,
    display_name       TEXT,
    avatar_hash        TEXT,
    avatar_fetched_at  TEXT,
    created_at         TEXT DEFAULT (datetime('now')),
    updated_at         TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_user_profiles_display_name
    ON user_profiles(LOWER(display_name)) WHERE display_name IS NOT NULL;
```

One row per Discord user. `display_name` is globally unique case-insensitively (partial unique index excludes NULL so users can leave it unset). The avatar cache moves here from `user_mappings.avatar_hash` so it stays single-row per user — no denormalization risk when a user has multiple aliases.

`UserProfileService` (new) owns validation:

- Length 2–32, character class `[\p{L}\p{N}_\-. ]+` (Unicode letters/numbers + `_`/`-`/`.`/space).
- Display-name uniqueness vs **other users'** `user_profiles.display_name` and **other users'** `user_mappings.iscored_username` (both case-insensitive). A user MAY pick one of their *own* iScored aliases as their display name.
- Throws `DISPLAY_NAME_TAKEN` with a structured `reason` (`too_short` / `too_long` / `invalid_chars` / `taken_display` / `taken_alias`) so the FE renders targeted copy.

`auth.ts` Discord OAuth callback writes avatar_hash to `user_profiles` going forward; the `user_mappings.avatar_hash` column is left in place for one release as a safety net, then dropped (see ROADMAP). All leaderboard reads pull avatar from `user_profiles` via the resolved Discord ID.

### 3. Display resolution rule: `display_name ?? iscored_username`

Everywhere a player name renders for a row that has Discord linkage:

```
displayName = profile.display_name ?? row.iscored_username
```

The FE has a centralized helper, `playerName(entry)`, exported from `admin-ui/src/components/ScoreboardComponents.tsx`. Every leaderboard / scoreboard / stats / friends component uses it for the displayed string and for the avatar `username` prop. **Match/key/route logic stays on `iscored_username`** — the row's stable identifier doesn't change, only its rendering does:

- `key={entry.iscored_username}` for React keys
- `expandedPlayer === entry.iscored_username` for state matching
- `to={\`/${slug}/players/${encodeURIComponent(entry.iscored_username)}\`}` for URL routes
- `viewerUsername === entry.iscored_username` for "is this me" highlighting

Discord-side rendering (`LobbyFeedGenerator`, `TournamentEngine` winner embeds, picker-assigned ticker, friend-score DMs, dethrone DMs) calls `UserProfileService.getDisplayName(discordUserId)` once per event and substitutes into the message text.

### 4. Leaderboard partition rule

Every per-game ranking query uses:

```sql
ROW_NUMBER() OVER (
    PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
    ORDER BY score DESC, created_at ASC
)
```

Discord-attributed rows (those with `submitted_by_user_id` set) collapse by user ID — multiple aliases for the same Discord user count as one player per game. Pure-anon rows still partition per-name (using the `'iscored:'` prefix to prevent collision with a real Discord ID literal, which is purely numeric).

The same partition lives in: `LeaderboardService.recalculate` and `getForGameByPlatform`, `GlobalLeaderboardService.recalculate` + cross-game top-N, `RankingService.calculateOverallRankings`, `StatsService.getOverallStats`/`getAllPlayerStats`/`getRoomOverview`, plus `/api/global/recent-scores`.

Each query LEFT JOINs `user_mappings` for the `iscored:*` synthetic-id fallback (so iScored-synced rows for known users still resolve), then LEFT JOINs `user_profiles` keyed on `COALESCE(submitted_by_user_id, um.discord_user_id)` to pick up `display_name` + `avatar_hash`.

### 5. Forward attribution + reverse cleanup at merge

`MergeService.recordMerge` writes `user_mappings(discord_user_id, iscored_username)` inside the transaction with a pre-flight `MAPPING_CONFLICT` check against name ownership. After commit, a best-effort `fetchAvatarHash` (Discord REST `GET /users/{id}`) seeds `user_profiles.avatar_hash` if not already set.

`reverseMerge` undoes both:

- DELETE the `user_mappings` row scoped by `(discord_user_id, iscored_username)` so other aliases of the same Discord user remain intact.
- Re-anonymize any rows that landed under the auto-mapping rule between merge and reversal: `WHERE LOWER(iscored_username) = LOWER(?) AND submitted_by_user_id = ? AND merged_from_anonymous_identity_id IS NULL`. The four tables differ on the column name for the synthetic-anon ID — `submissions`/`community_scores`/`score_history` use `discord_user_id`, `global_scores` uses `player_id`. Loop handles both.

`MergeService.previewMerge`'s tournament freeze gate derives a "completed at" timestamp from `MAX(games.end_date) WHERE status='COMPLETED'` since `tournaments.end_date` doesn't exist (rotations don't end at the rotation level — only individual `games` slots do).

## Consequences

- **Easier:** A merged Discord user immediately captures future iScored scores under the merged nickname without admin re-intervention. The `/account/settings` page lets users self-rebrand without writes to score history. Avatars cache once per user instead of per-alias-row.
- **Easier:** Multi-alias players (common in households where one Discord user submits on iScored under two different names) get a unified leaderboard row + a single profile view aggregating both. Match/key/route logic stays simple — only rendering changes.
- **Easier:** The Discord-style identity model is familiar to users; "display name" and "username" carry the same connotations as on Discord itself.
- **Harder:** The `MergeService.recordMerge` mapping pre-check runs *outside* the transaction so the admin gets a clean `MAPPING_CONFLICT` error instead of a UNIQUE-constraint blow-up. Two admins racing to merge the same name into different users could still hit the constraint inside the txn — the rollback is correct but the error message is less polished. Tightening this is on the ROADMAP.
- **Harder:** `/map-user` no longer "replaces" — admins who want to swap a user's mapping must first remove the old alias, but no `/unmap-user` companion command shipped. Direct DB edit is the workaround until that lands. Documented in CHANGELOG; admins flagged at deploy.
- **Harder:** Two `display_name` columns now exist with different semantics — `user_profiles.display_name` (global, user-chosen) vs `room_members.display_name` (per-room first-claim). Future readers must internalize that the merge writes the former, never the latter; room-scoped first-claim policy is unchanged.
- **Locked out:** The display name cannot be made room-scoped (per-room overrides) without superseding this ADR. Today the chosen name renders globally — same name across `/scoreboard`, every room scoreboard, every Discord embed. If room-specific personas turn out to be a real need, a new field on `room_members` would be additive but the resolution rule needs updating across every render site.

## Alternatives Considered

- **Keep `user_mappings` 1:1; force users to pick a single canonical iScored name.** Rejected — iScored has no concept of "your one true name", and forcing users to consolidate breaks the natural workflow of submitting under whichever name they typed at the cabinet. The Discord-style "many handles, one display" model fits real usage.
- **Collapse leaderboards fully — one row per Discord user, no per-alias rows even on profile pages.** Rejected — leaderboards are competitive surfaces where each name is its own contender. A user who deliberately uses two aliases (e.g. one for VPX, one for AtGames) gets two shots; collapsing them to one row would erase that distinction. Profile pages aggregate (showing all aliases as the same player); leaderboards stay per-alias on tournament boards but collapse-by-user at the partition level when the same Discord user holds multiple aliases for one game.
- **One row per alias on every surface (no collapse anywhere).** Rejected — defeats the "Discord-style identity" goal. A user with two aliases would render twice on every leaderboard with a different name in each row. The 4 worked examples in the user's session log made it clear they wanted unification.
- **Keep `avatar_hash` on `user_mappings` (denormalized).** Rejected — stale-on-refresh problem. When the user updates their Discord avatar, `auth.ts` would have to UPDATE all rows for that user; missing one leaves a row pointing at a stale hash and the FE renders a 404. Single-row `user_profiles` makes this trivially correct.
- **Per-room display name override.** Considered for completeness, deferred. Today's `room_members.display_name` is per-room first-claim policy (different concept). If a real "I want to be 'Pinball Wizard' in room A but 'PBW' in room B" use case emerges, add a new column rather than overload first-claim semantics.
- **DM the user at merge time** ("an admin linked X to your account, set your display name at /account/settings"). Deferred — not architectural; rolled to ROADMAP as a UX nicety.

## Notes

- iScored is case-insensitive at the player-identity level — when a user submits as "PBW2023" then later as "pbw2023", iScored treats both as the same player and canonicalizes display to the casing of the highest-scoring submission. ArcAid mirrors this with `UNIQUE(iscored_username COLLATE NOCASE)` and `LOWER()` lookups everywhere. Per-score display reads `iscored_username` from the score row (already normalized by iScored at submission); `user_mappings` stores whichever case was first written and is only used for attribution lookup, not display.
- ADR 0007 (library = global catalogue) and this ADR together complete the v2.x identity layer: the catalogue resolves *which game* a score belongs to; this ADR resolves *which player*. ADR 0006 (score platform stratification) is the third leg — *which platform variant* the score was submitted from.
- The reference memory `reference_iscored_case_insensitive.md` (in user-scoped agent memory, not project-tracked) captures the iScored canonicalization behavior in case future contributors hit the same case-sensitivity edge case before reading this ADR.
