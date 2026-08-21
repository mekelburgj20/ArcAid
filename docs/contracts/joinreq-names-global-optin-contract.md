# Contract: join-request name resolution + private-room global opt-in (v2.40.0)

Two related fixes from live approval-room testing. Branch `joinreq-names-global-optin` off main (must be v2.39.1). Migration 117.

## D1 — Resolvable requester names (username fallback)

Problem: the Join Requests admin queue shows a raw ID (e.g. `247825058213396482`) because `user_profiles.display_name` is NULL for users who never chose a global display name, and login persists only the avatar — never the provider username. Avatar already resolves; only the name is missing.

- **Migration 117** (`117_user_profiles_username`): `ALTER TABLE user_profiles ADD COLUMN username TEXT`. Nullable, NOT unique (this is a display FALLBACK, distinct from the user-chosen unique `display_name`). Idempotent per house convention.
- **Persist at login** — in BOTH OAuth callbacks (`src/api/routes/auth.ts`), the `displayName = user.global_name || user.username` (Discord) / equivalent (Google `name || email-prefix`) is already computed. Extend the `user_profiles` upsert to ALSO write `username = <that value>` on every login (last-write-wins, keeps fresh). Do NOT touch `display_name`. Both the avatar-present and avatar-absent upsert branches must set username (INSERT … ON CONFLICT DO UPDATE SET username=excluded.username, or the existing upsert idiom — match what's there).
- **Persist at join-request time too** — in the `POST /me/rooms/:roomId/join-request` handler (find it in rooms.ts or global.ts), before/after creating the request, upsert `user_profiles.username` from `req.user!.username` (the JWT username claim). This guarantees a name even for a user who requested before this deploy IF they request again; for the ALREADY-pending row in the screenshot, the requester must re-authenticate once (login) OR the admin denies + they re-request — note this in the PR field-check (it's a one-time backfill gap, not a code issue).
- **Endpoint** — `GET /:roomId/admin/join-requests` (rooms.ts ~:3704-3719): add `username` to the `SELECT` from user_profiles and to the response object (`username: profile?.username ?? null`).
- **FE** — `admin-ui/src/pages/JoinRequests.tsx`: the rendered name becomes `displayName ?? username ?? userId` (add `username` to the request-row TS interface). Avatar rendering unchanged.

Scope note: the new `username` column is a general identity fallback; wiring it into the app-wide `playerName()` helper is a FUTURE improvement (ROADMAP note) — this release only consumes it in the join-requests queue.

## D2 — Private-room opt-in to the Global Scoreboard

Problem: approval (private) rooms are unconditionally excluded from global fan-out + scrubbed on flip. User wants an explicit opt-in so a private room CAN share its scores globally.

- **New per-room setting `SHARE_TO_GLOBAL`** (`'true'`|absent). Absent/anything-else = not shared (current behavior for approval rooms). Only consulted for approval-policy rooms; open rooms fan out unconditionally as today (setting ignored for them).
- **Fan-out gate** — `GlobalScoreService.fanOutFromRoomSubmission` (~:329): change the `if (getJoinPolicy === 'approval') return null` to also check the setting: skip fan-out only when `approval AND SHARE_TO_GLOBAL !== 'true'`. Read the setting fresh (no cache), same as the policy read.
- **Flip-to-approval scrub** — `JoinPolicyService.handlePolicyFlip` (open→approval): scrub the room's global footprint only when `SHARE_TO_GLOBAL !== 'true'`. If the room opted in, keep its rows on flip.
- **Toggle handler for `SHARE_TO_GLOBAL`** — in the settings-save path (`GameRoomSettingsService.set`/`saveMany`, mirroring how JOIN_POLICY flip is dispatched at ~:139), when `SHARE_TO_GLOBAL` changes on an approval-policy room:
  - OFF→ON: **back-fill fan-out** the room's existing scores into `global_scores` (reuse `fanOutFromRoomSubmission` per the room's `submissions`/`score_history` — idempotent; the fan-out path already de-dupes via its normalizeSubmitterUserId gate, verify it won't double-insert; if a clean back-fill helper doesn't exist, iterate the room's submissions and call the existing fan-out per row) + recalc the global leaderboard.
  - ON→OFF: scrub the room's `global_scores` rows (by `origin_game_room_id`) + recalc, same as the flip scrub. Extract a shared `scrubRoomFromGlobal(roomId)` helper if the flip path and this path can share it.
- **Settings UI** — `admin-ui/src/pages/Settings.tsx`: a `SHARE_TO_GLOBAL` checkbox/toggle hand-rendered near the JOIN_POLICY select, shown ONLY when JOIN_POLICY is `approval` (open rooms already share). Label: "Share scores to the Global Scoreboard (this room stays private otherwise)". Add to `DANGEROUS_KEYS` if the flip is consequential (it moves data) — implementer's call; at minimum a confirm on ON→OFF ("removes this room's scores from the Global Scoreboard").
- **Confirm the flip dialog copy** — the existing open→approval confirm says scores leave the Global Scoreboard; when `SHARE_TO_GLOBAL` is on, that's no longer true — adjust the confirm text to be conditional, or state "unless you've enabled Share to Global Scoreboard".

### D2 security boundary (MUST verify — this is the private-room leak line)
A globally-shared private-room score appears on `/scoreboard` with player name + game. Verify this does NOT create a clickable path INTO the gated room:
- Global scoreboard game links target the GLOBAL game page (`/games/:globalGameId`), not `/:slug/games/:name` — confirm. If any global entry deep-links into the room-scoped (gated) surface, that's a leak — the link must go to the global game/player page, or be non-clickable for the private room.
- Player-name links from the global scoreboard must NOT deep-link into the private room's player page. Confirm the target is a global/room-agnostic page or the room's own gate handles it.
- The score row itself (name/score/game) IS the intended shared data — that's fine. Only room-scoped navigation must stay gated.
Document the findings in the report. If a deep-link into the gated room exists, gate it or point it elsewhere.

## Constraints
- Migration 117 only, idempotent. No new deps. "Arcaid" casing.
- Open rooms: byte-identical fan-out behavior. Non-opted-in approval rooms: identical to v2.39.x (excluded + scrubbed).
- Hygiene: no `git add -A`; version via Edit → **2.40.0**; no SW bump.

## Tests
- D1: login persists username (both providers); join-requests endpoint returns username; FE renders displayName ?? username ?? userId (unit if extractable).
- D2: fan-out gated by SHARE_TO_GLOBAL for approval rooms (off→skip, on→fan); open rooms unaffected; flip open→approval with opt-in ON keeps global rows, OFF scrubs; SHARE_TO_GLOBAL ON→OFF scrubs + OFF→ON back-fills; back-fill idempotent (no dup rows on double-toggle).
- Full suites green (backend + admin-ui + builds + docker compose build).

## Process
Implement, gates, version 2.40.0, no CHANGELOG edit, commit `feature:` in logical chunks, do NOT push/PR. Report: files, D2 security-boundary findings (link targets), decisions, verbatim gates, SHAs, blockers. STOP on semantic conflicts (migration/CHECK surprises, fan-out dedup hazards) — escalation beats guessing, as prior rounds proved.
