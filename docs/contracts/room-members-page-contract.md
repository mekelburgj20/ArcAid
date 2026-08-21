# Contract: room Members/Players page (v2.42.0)

New public room page listing a room's active users. PREREQ: branch off main AFTER v2.41.0 (player-governs-global) merges — verify package.json ≥ 2.41.0. No migration.

## Data model (binding — recon-verified)

- **Approval rooms (`JOIN_POLICY='approval'`)**: the roster = `room_members` rows (approved members: owner + admins + approved joiners). Owner and admins DO get `room_members` rows via their grant paths (`GameRoomService.create`, `AdminService.addRoomDiscordAdmin`). Trust `room_members` as "approved members" — do NOT UNION `game_room_admins` (the one identity-merge edge gap is not worth the complexity; note it).
- **Open rooms**: the roster = distinct IDENTIFIED score-posters, NOT `room_members` (its `source` is first-write-wins so unreliable, and it includes non-posting bookmarkers). Query:
  ```sql
  SELECT submitted_by_user_id AS userId,
         MIN(created_at) AS firstSeenAt, MAX(created_at) AS lastSeenAt, COUNT(*) AS scoreCount,
         (SELECT iscored_username FROM score_history sh2
           WHERE sh2.submitted_by_user_id = sh.submitted_by_user_id AND sh2.game_room_id = sh.game_room_id
           ORDER BY sh2.created_at DESC LIMIT 1) AS iscoredUsername
  FROM score_history sh
  WHERE game_room_id = ? AND submitted_by_user_id IS NOT NULL AND orphaned_at IS NULL
  GROUP BY submitted_by_user_id
  ```
  `submitted_by_user_id IS NOT NULL` is the exact "identified (non-guest)" filter (`normalizeSubmitterUserId` nulls ANON/SYSTEM/COMMUNITY/''). The correlated `iscoredUsername` gives a representative alias for the player-detail link.

- Both paths then batch-resolve display via `LEFT JOIN user_profiles up ON up.discord_user_id = <userId>`, selecting `display_name, username, avatar_hash, avatar_url`. Display name = `display_name ?? username ?? iscoredUsername ?? userId`. (For approval rooms, `room_members` rows key on `user_id`; also LEFT JOIN `user_mappings` for a representative `iscored_username` to feed the link, OR link by userId — see FE below.)

## D1 — Backend `GET /:roomId/members`

- New route in `rooms.ts`, registered AFTER the `roomVisibilityGate` mount (~:197) so it's automatically public for open rooms and members/admins/super-only for approval rooms (recon-confirmed). `requireAuth` NOT needed (the gate + public-for-open is the model — mirror how leaderboard/stats public reads are unauthenticated).
- Branch on the room's `JOIN_POLICY` (via `RoomAccessService.getJoinPolicy` / `GameRoomSettingsService`): approval → `room_members` roster query; open → `score_history` distinct-submitter query.
- Response: `[{ userId, displayName, username, iscoredUsername, avatarHash, avatarUrl, joinedAt?/firstSeenAt?, lastSeenAt?, scoreCount?, isOwner?, isAdmin? }]`. Include `scoreCount`/`lastSeenAt` for open rooms; `joinedAt` for approval rooms. For the owner/admin badges: LEFT JOIN `game_room_admins` (role) — cheap, gives `isAdmin`/`isOwner` (role='owner').
- Sort: `lastSeenAt DESC` (open) / `joined_at DESC` (approval) — recency, matching `listRoomsForUser` convention.
- N+1 vs batch: prefer a single query with the `user_profiles` JOIN (batch) over per-row lookups.

## D2 — FE page + nav

- New route `admin-ui/src/App.tsx`: `/:slug/members` → new `RoomMembers` page under `PublicLayout` (do NOT touch the existing `/:slug/players` → `/stats?view=players` redirect).
- New page `admin-ui/src/pages/RoomMembers.tsx`: fetch `GET /rooms/:roomId/members` (roomId from `useRoom()`), render a list of rows — each row: `PlayerAvatar` + name + secondary line (approval: "Member since <date>" + owner/admin badge; open: "<scoreCount> scores · last active <relative>"). Header/subtitle adapts: approval room → "Members" ("Approved members of this room"); open room → "Players" ("Everyone who's posted a score"). Use the room's `join_policy` (from portal/`useRoom` — check what's available; if `join_policy` isn't on RoomContext, the endpoint response can include the room's policy or a `mode` field so the page knows which label/columns to show).
- **Linking rows to player detail**: player-detail is `/:slug/players/:id` where `:id` = `iscored_username` (PlayerNameLink convention). Use each row's `iscoredUsername` for the link; if a row has no `iscoredUsername` (rare — an approval member who never posted and has no iScored alias), render the name WITHOUT a link (plain text) rather than a broken link. Reuse `PlayerAvatar` (ScoreboardComponents) for avatars; you MAY reuse `PlayerNameLink` only if you can supply its required `iscored_username` prop — otherwise a lightweight `<Link>`/`<span>` is fine.
- Nav: add a "Members"/"Players" item to `PublicLayout.tsx` navItems (~:120-129). Label can be static "Members" (simplest) or dynamic by policy — pick static "Players" if simpler and reads fine for both; note choice. Ensure it shows for approval-room MEMBERS (check the `isGated` flag gates only unauth/guest state, not members — for a member the page loads; for a guest on an approval room the gate 403s and the page shows the join screen, consistent with other room pages).
- Empty state: open room with no scores yet → "No players yet — be the first to post a score."; approval room → "No members yet."

## Constraints
- No migration. No new deps. Open rooms and approval rooms both covered per the data model above. All other room behavior untouched.
- "Arcaid" casing. Hygiene: no `git add -A`; version via Edit → **2.42.0**; no SW bump.
- Do NOT read `room_members` for open rooms (source-unreliable). Do NOT use `StatsService.getAllPlayerStats` (reads `submissions`, tournament-only — misses community/freeplay; documented doctrine gap).

## Tests
- BE: open room → distinct identified posters returned, guest/anon scores excluded, scoreCount correct; approval room → room_members roster returned; approval room + non-member requester → 403 (gate); open room → public (no auth). Owner/admin badge flags.
- FE: page renders both modes if the harness supports it cheaply (else the data-shape/label logic if extractable).
- Full suites green (backend + admin-ui + builds + docker compose build).

## Process
Implement, gates, version 2.42.0, no CHANGELOG edit, commit `feature:`, do NOT push/PR. Report: files, the label/link decisions, verbatim gates, SHAs, blockers. STOP on semantic conflicts (e.g. player-detail `:id` turns out NOT to be iscored_username — verify before wiring links).
