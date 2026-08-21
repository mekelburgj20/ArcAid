# v2.82.0 — My Stats v1 (Identity arc Phase 3)

Contract: ROADMAP.md "Identity & membership arc" Phase 3 (line ~84). Decisions FINAL: entry from account/user menu ONLY (no global-nav item); scope selector `All | <member rooms>` with NO separate Global scope (direct-Global bests appear in All with a "Global" provenance chip); Personal Bests reuse + 2-3 overview counts; identity = token id expanded via identity links + user_mappings aliases; unlinked room display names deliberately excluded (beta-acceptable); tournament stats stay room-scoped.

Branch: `my-stats-v282`. No migration. Two sequential workstreams; owner screenshot review of the page BEFORE merge (standing practice).

## Planner decisions

1. **New shared `IdentityCandidateService.forUser(tokenId)`** in src/services → `{ canonicalKey, ids, aliases, playerKeys }`:
   - `ids` = `BanService.expandIdentityCandidates(tokenId)` (the declared single source of truth for link-graph expansion — BanService.ts:108-140).
   - `aliases` = one query: `SELECT iscored_username FROM user_mappings WHERE discord_user_id IN (<ids>)`.
   - `playerKeys` = ids ∪ aliases.map(a => `'iscored:' + a.toLowerCase()`).
   - `canonicalKey` = `IdentityLinkService.resolveCanonical(tokenId)` result (the Discord snowflake when linked, else the token id).
   - Do NOT refactor the two duplicated alias blocks in rooms.ts (269-295, 2007-2031) — noted as later cleanup, out of scope.
2. **Multi-key rank correctness (the recon-flagged trap):** never filter the bests query with `player_key IN (...)` — that would rank the same person once per alias and double-count them in `total_players`. Instead canonicalize INSIDE the query: keep the existing three-leg `player_key` expression (StatsService.ts:752), then `canonical_key = CASE WHEN player_key IN (<candidates>) THEN '<canonicalKey>' ELSE player_key END`, partition rank/COUNT by `canonical_key`, and filter the final select on `canonical_key = '<canonicalKey>'`. One person = one competitor, everyone else untouched. A regression test MUST cover: two aliases of the viewer on the same game → ONE row, `total_players` counts them once.
3. **Global leg = DIRECT Global submissions only** (`origin_game_room_id IS NULL` — fan-out copies of room scores carry the origin room id). Rationale: contract says "direct-Global bests appear in All"; including fan-out copies would duplicate every room best as a second row. Implementation agent must verify against `GlobalScoreService` (`create` vs `fanOutFromRoomSubmission`) which origin fields distinguish direct vs fan-out and report if the predicate needs adjusting. Global-leg identity/rank resolution mirrors `GlobalLeaderboardService.getViewerCardRanks` (GlobalLeaderboardService.ts:1175-1238): owner resolution `COALESCE(submitted_by_user_id, <user_mappings when player_id LIKE 'iscored:%'>, player_id)`, best-per-player per `global_game_id` (collapse categories), `deleted_at IS NULL AND orphaned_at IS NULL`, same CASE-canonicalization as decision 2.
4. **Overview counts (exactly 3):** games with a personal best (derived `personalBests.length`, scope-consistent), member rooms (`listRoomsForUser().length`, scope-independent), total scores submitted (`score_history` count over candidate playerKeys, `orphaned_at IS NULL`, room-filtered when scope=roomId; on scope=all ADD the direct-global `global_scores` count with the same identity predicate). Tournament stats deliberately absent (contract).
5. **`PersonalBestsSection` moves to `admin-ui/src/components/PersonalBestsSection.tsx`** (not forked): row type gains optional `source: 'room'|'global'`, `room_slug`, `room_name`, `global_game_id`; link target = room row → `/${room_slug}/games/${game_name}`, global row → `/games/${global_game_id}`, no-link fallback if neither; optional `rankHeader` prop (PlayerDetail keeps "Room Rank", My Stats uses "Rank"); "Global" provenance chip on global rows; PlayerDetail.tsx imports from the new location (its usage unchanged).
6. **Version 2.82.0.** No migration. Owner reviews page screenshots pre-merge.

## WS1 — Backend

- `src/services/IdentityCandidateService.ts` (decision 1) with doc comment referencing the BanService precedent.
- `StatsService`: new PUBLIC `getPersonalBestsForIdentities(candidates: {playerKeys, canonicalKey}, gameRoomId?)` implementing decision 2 on the v2.75.1 doctrine query (keep the `(game_room_id, LOWER(game_name))` keying + `insertHistoryScore`-shape compatibility + LIMIT 1000 + the doctrine comment). Rows now ALSO carry `room_id`, `room_slug`, `room_name` (join `game_rooms`; suspended rooms excluded `suspended_at IS NULL`). The existing private `getPersonalBests` stays untouched (PlayerDetail path).
- New Global-bests query (decision 3) — in StatsService or GlobalLeaderboardService, wherever fits the file's doctrine; returns `{ game_name, global_game_id, best_score, rank, total_players, achieved_at }`.
- `GET /api/me/stats?scope=all|<roomId>` in global.ts `/me/*` cluster, `requireDiscordUser`, lazy-import idiom, 500-handler idiom. scope omitted → 'all'. scope=roomId → `RoomMembershipService.isMember(tokenId, roomId)` else 403 (leak guard for approval/suspended rooms). Response `{ scope, overview: {gamesWithBest, memberRooms, totalScores}, personalBests: [...] }`, bests ordered rank ASC then game_name (rooms leg) with global rows interleaved by the same ordering rule — keep deterministic; FE never re-sorts.
- Tests (template `api-me-rooms-join-leave.test.ts` + the `insertHistoryScore` prod-shape fixture from `s13-achievements.test.ts` — NEVER `createTestSubmission` for score_history reads): 401 tokenless; single-identity happy path; **multi-alias collapse regression** (decision 2); linked-google token (snowflake id) and unlinked `google:*` token; scope=roomId member vs non-member 403; global leg direct-only (fan-out row excluded); suspended-room rows excluded; overview counts.

## WS2 — Frontend

- Move + extend `PersonalBestsSection` (decision 5) + update its test file (link-vs-no-link rows, chip render).
- `admin-ui/src/pages/MyStats.tsx` on the `MyRooms.tsx` skeleton: logged-out branch with LoginButtons + the return-path login idiom (CHECK how MyRooms' `loginWithDiscord('__myrooms__', '/my-rooms')` sentinel works in auth.ts / LoginButtons and mirror it for `/my-stats`; if the BE whitelists sentinel slugs, add the new one — report what you find); nav header idiom; fetch `/api/me/stats` + `/api/me/rooms` with `useAuthHeaders()`; scope selector `All | <room name pills or select>` from memberships; 3 overview count tiles (RoomOverview/stat-tile idiom); `PersonalBestsSection` with search + "Global" chips.
- `App.tsx`: static import + `<Route path="/my-stats" element={<ViewerAuthProvider><MyStats /></ViewerAuthProvider>} />` registered with the other global routes BEFORE `/:slug`.
- `UserMenu.tsx`: "My Stats" item (lucide `ChartColumn`/`BarChart3`) between My Rooms and All Game Rooms, `menuItemClass`, `role="menuitem"` (roving focus picks it up automatically). Unconditional.
- Tests: MyStats page (MyRooms.test template — logged-out branch, fetch mocks, scope switch), UserMenu item presence+navigation (PublicLayout.test pattern), moved-component tests.
- **Screenshot loop (mandatory pre-merge):** harness per `tmp/dashboard-icon-harness.js` pattern; mock a multi-room user with room + global bests (long names, 15-digit scores), shots at 1280 + 390 into `tmp/my-stats-shots/`; kill preview servers after.

## Release mechanics

v2.82.0 bump + CHANGELOG; full suites (backend baseline 1462, admin-ui 467); root/admin-ui/docker builds; CRLF checks; owner screenshot approval → PR → merge → deploy watch → prod-verify (`/api/version`, tokenless `/api/me/stats` → 401); ROADMAP contract marked Phase 3 shipped; marker #35.
