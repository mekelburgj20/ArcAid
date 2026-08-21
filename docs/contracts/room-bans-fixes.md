# Fix round: room bans — adversarial review findings (v2.49.0, branch room-bans)

Working tree has the implementation + landing polish (uncommitted). Apply all items.
Findings 1–2 are merge blockers.

## 1. HIGH — room ban must NOT block reporting that room (moderation-escalation suppression)

`POST /global/rooms/:roomId/report` (`global.ts` ~1768) has `:roomId` = the **reported** room, not
an acting context, but `requireNotBanned` now auto-reads `req.params.roomId` → a room admin can ban
a user to block them from escalating that room to super-admins. Violates settled decision 5.

**Fix:** add an explicit `requireNotBannedGlobal` middleware (calls `isIdentityBanned(discordId)`
with NO room) in `middleware.ts` and use it on that route. Do NOT solve this by renaming the param
— the next room-shaped global route would rediscover the trap. Add a comment on the new middleware
explaining exactly this. Audit the other `requireNotBanned` mounts one more time for the same
shape (review found this is the only one; confirm). Test: room-banned user CAN still report the
room that banned them; globally-banned user CANNOT.

## 2. HIGH — room bans are not audited (code comment + CHANGELOG claim otherwise)

`auditLog` is mounted app-wide BEFORE routers set `req.user`, so it early-returns and audits
NOTHING on router routes — already documented at `global.ts` ~449-451. The new rooms.ts comment
claiming auto-audit is false.

**Fix:** explicit `AuditService.log` calls in both new POST handlers (ban + lift), mirroring
`global.ts` ~463 (action names consistent with existing conventions — check what the global ban
route or nearest room-admin write uses). Delete the false comment. Correct the CHANGELOG bullet.
Add a test asserting an audit row lands for a room ban. Do NOT refactor the global `auditLog`
mount in this PR — instead add a ROADMAP note that `auditMiddleware` is a global no-op and
explicit logging is the de facto doctrine (worth a dedicated cleanup later).

## 3. MEDIUM — guards must use the same identity expansion as enforcement

Target guards check `IN (raw, canonical)` but enforcement expands the full link graph, so a
super admin or room admin holding a `google:*` grant can be banned out of a room (reachable:
`POST /:roomId/admins/discord` accepts a pasted google id; `createLink` never normalizes
`super_admins`).

**Fix:** extract the candidate expansion from `BanService.computeIsIdentityBanned` into a public
`BanService.expandIdentityCandidates(providerUserId): Promise<string[]>` and use it in BOTH the
super-admin and room-admin target guards (and reuse it internally so there's one source of truth).
Tests: banning a snowflake whose linked google alias holds the room-admin row → 403; same for a
super_admins row keyed on a google id.

## 4. MEDIUM — pending join requests must not re-admit a banned user

`JoinRequestService.approve` has no ban check and the ban route leaves pending rows.

**Fix:** in the ban handler, deny pending join requests for the candidate set in that room
(`UPDATE join_requests SET status='denied' ...` — match the service's existing column/status
conventions rather than raw SQL if a service method fits). ALSO add a defensive
`isIdentityBanned(row.user_id, roomId)` check at the top of `approve()` → 4xx with a clear message.
Test: request → ban → approve attempt fails and no `room_members` row appears.

## 5. MEDIUM — ban insert + membership strip must be atomic and idempotent

Two sequential awaits; a `removeMember` throw leaves a committed ban + a 500 the admin retries →
duplicate active bans.

**Fix:** wrap the ban insert + membership strip + join-request denial (item 4) in one
transaction (`getDatabase()` is in scope). Combine with item 6's pre-flight so a retry is safe.

## 6. MEDIUM — duplicate active bans

No guard against a second active ban for the same (identity, room) → Banned list shows the user
twice and one Unban appears to fail.

**Fix:** pre-flight check for an existing ACTIVE room ban over the candidate set (item 3's helper)
→ 409 `{ error: 'That player is already banned from this room.' }`. Apply the same pre-flight to
the room-lift path's assumptions. Do NOT add a partial unique index (the global path shares this
gap; keep the change surgical). Test: double-ban → 409, single active row.

## 7. MEDIUM — banned users must disappear from the members list (both room policies)

`getOpenRoster` derives from `score_history`, so `removeMember` is a no-op in open rooms; the FE
only optimistically hides the row → on reload the banned user is in BOTH the Players list and the
Banned section with a live Ban button. Contradicts the confirm dialog's own copy.

**Fix:** filter active room bans out of the roster response **server-side** in `RoomRosterService`
(both open + approval paths). Also hide/disable the FE Ban button for anyone already in the Banned
list (belt and braces). Test: open-policy room, banned user absent from the roster response.

## 8. LOW — gate the new admin ban routes with `requireNotBanned`

Every other admin write in rooms.ts has it; a globally-banned room admin can currently still
issue/lift room bans. Add it to both new POST routes (and the GET if that matches sibling
conventions — check).

## 9. LOW — route the new FE calls through `lib/api.ts`

`RoomMembers.tsx` uses three raw `fetch()` calls with hand-built auth headers (CLAUDE.md doctrine:
all HTTP goes through `lib/api.ts`; consequence here = no 401 auto-refresh). Convert them.

## 10. LOW — admin-entry-point + unlinked-Google admins never see the Ban UI

Detection reads only `arcaid_player_token`, so a room admin who logged in at `/:slug/admin` (token
under the admin key) sees the public page. **Fix:** also consider the admin token when deciding
whether to show admin affordances (read whichever key the admin layouts use — do not invent new
auth; this stays cosmetic, server gating is unchanged and correct).

## 11. NIT — split migration 122 into two entries

Two statements in one `exec`: on a DB where the column exists but the migration row doesn't, the
ALTER throws, the swallowing catch skips the `CREATE INDEX`, and it's marked applied → permanently
missing index. Split into `122_user_bans_room_scope` (ALTER) and `123_user_bans_room_index`
(CREATE INDEX IF NOT EXISTS). **Next free becomes 124.**

## 12. NIT — clean up room bans when a room is deleted

`GameRoomService.delete`: delete `user_bans WHERE game_room_id = ?` (pseudo-FK, no cascade
possible) so bans don't orphan invisibly.

## Explicitly NOT in scope
- Refactoring/removing the global `auditLog` mount (ROADMAP note only, per item 2).
- Partial unique index on `user_bans`.
- `fetchDiscordUserInfo` cache eviction / batching (bounded by admin count; review says fine).
- `super_admins` normalization in `createLink`.

## Gates
Root build · admin-ui build · full BE (782 + new) + FE (146) suites green · CRLF numstat check
(LandingPage.tsx diff must stay intact) · NO commit/branch/push.

Blockers policy: contradiction with the code → stop and report, don't guess.
