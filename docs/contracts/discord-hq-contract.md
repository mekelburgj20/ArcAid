# Contract: Global Arcaid Discord server + web notification settings

Product decision (owner, 2026-08-01): the owner's existing test server converts to the **global
Arcaid community server** ("Arcaid HQ"). Its job: give every Arcaid player a shared guild with the
bot so Discord DMs work even when their room has no Discord integration (Discord's hard rule: a
bot can DM a user only while they share ≥1 server). Web push remains the zero-friction
alternative and is always presented alongside — joining Discord is an option, never a toll.

Verified platform facts (2026-08-01 discussion):
- Bot needs NO special permissions in the guild — DM capability comes from mutual membership.
- The `guilds.join` OAuth scope lets the bot ADD a consenting user to a guild server-side
  (`PUT /guilds/{guild.id}/members/{user.id}` with the user's OAuth access token; bot must be a
  guild member with CREATE_INSTANT_INVITE permission). This enables one-click join from Arcaid.
- Even with a shared guild, a user whose "Allow direct messages from server members" privacy
  setting is off for that server cannot be DM'd (API error 50007). Detect, never promise.
- LOGIN stays `identify`-only (hard-learned: extra scopes on the login authorize broke it).
  `guilds.join` is requested ONLY in a separate explicit connect flow.

## Sections in order

### 1. Config + deliverability primitive

- Global setting `GLOBAL_DISCORD_GUILD_ID` (not encrypted — a guild id isn't a secret). Unset →
  every feature below is inert (ships safe).
- `DiscordReachabilityService.canDm(discordUserId)` → `{ reachable: boolean, via: 'global' |
  'room_guild' | null }`: true if the user is a member of the global guild OR any
  Discord-integrated room guild the bot is in. Implementation: `guild.members.fetch(userId)`
  against the global guild + the distinct room guild ids (cache positive results ~10 min,
  negative ~1 min; a members-intent fetch per check is fine at Arcaid's scale but must not run
  per-page-load uncached). Uses the existing `getDiscordClient()` accessor; degrades to
  `reachable: false, via: null` when the gateway is down (with the health card already showing
  gateway state).

### 2. Web notification settings page (closes the chicken-and-egg)

Discord notification prefs currently live ONLY in the `/arcaid-notifications` Discord command —
unreachable for exactly the players this arc serves. Add a **Notifications** section to the web
Account Settings (where the S15 webPush toggle lives):

- Two channel blocks side by side:
  - **Browser push** — existing per-device toggle + the per-type opt-ins for the types in
    `WEB_PUSH_TYPES` (now incl. turnToPick as of v2.70.0).
  - **Discord DMs** — the five notification types (same prefs JSON the Discord command writes —
    one storage, two surfaces; recon `notification_prefs` on `user_preferences` and reuse) plus a
    live deliverability status line driven by `canDm`:
    - reachable via room guild → "✅ Enabled (you share <room's server>)"
    - reachable via global → "✅ Enabled (Arcaid community server)"
    - not reachable → "⚠️ Discord can only deliver DMs if you share a server with the Arcaid
      bot." + the Section 3 join button + "or use browser notifications instead".
- `GET /api/me/notification-settings` + `PUT` (requireDiscordUser), shipping prefs + the
  reachability verdict. The Discord command keeps working unchanged (same underlying prefs).

### 3. One-click join ("Connect Discord notifications")

- New OAuth flow, SEPARATE from login: `GET /api/auth/discord/connect-notifications` →
  authorize URL with scopes `identify guilds.join` (state carries a dedicated marker — extend
  the existing state-encoding conventions in auth.ts; recon `__super__`/`player:` precedents).
  Callback: verify identity matches the logged-in user, then `PUT
  /guilds/{GLOBAL_DISCORD_GUILD_ID}/members/{userId}` with the access token. Success → redirect
  back to the notifications settings with a success flash; the reachability line flips to ✅.
- Failure paths, each with honest copy: user already a member (treat as success — the PUT is
  idempotent-ish, 204 vs 201; handle both), user declined consent, guild full/banned (surface
  Discord's error), `GLOBAL_DISCORD_GUILD_ID` unset (the button never rendered anyway).
- Also render a plain **invite-link fallback** (`GLOBAL_DISCORD_INVITE_URL` global setting,
  optional) for users who prefer joining manually — and it's the only path shown if the bot
  lacks CREATE_INSTANT_INVITE in the guild (document the requirement in the setting's help text
  instead of failing at PUT time: recon whether the PUT actually requires that permission and
  state findings).
- The bot token needs no new gateway intents for the PUT (it's REST); `guild.members.fetch`
  for reachability needs the SERVER MEMBERS intent — verify it's already enabled for the bot
  (the identity system fetches members today via /map-user flows; confirm) and flag in the
  report if the Discord developer portal needs a toggle.

### 4. Failure-driven nudge

- When a DM send fails with 50007 (or any "cannot DM" class), record `{ userId, failedAt,
  type }` in a small table or on `user_preferences` (pick one; state it). The web layout (for
  that logged-in user) shows a one-time dismissible banner: "We tried to send you a Discord
  notification but couldn't. Join the Arcaid community server or check your Discord privacy
  settings — or switch to browser notifications." Links to Section 2's page. Clear the flag on
  the next successful DM or on dismissal.
- NotificationService already swallows DM failures silently — the hook point is its catch;
  recon the exact shape and keep the swallow (a failed DM must never break the caller).

### 5. Onboarding surfaces (copy + placement, no new machinery)

- After Discord OAuth login in a room WITHOUT Discord integration: a one-time, dismissible
  toast/banner pointing at notification settings ("Want score + pick notifications? Set them up
  once — works for every room.").
- The pick-prompt DM path (v2.69) and tournamentWin: when the winner is NOT reachable, the
  system already can't DM them — that's precisely when the Section 4 nudge state gets set even
  without an attempted send (a known-unreachable opted-in user = pre-failed). Implement as: at
  notify() time, if type is DM-routed and canDm is false, set the nudge flag instead of
  attempting.
- "Data from RetroAchievements"-style footer credit NOT needed here; this is first-party.

## Explicitly out of scope
- No community/moderation features, no channel structure automation, no announcements pipeline
  (the server can be a single read-only channel — owner's call, outside the codebase).
- No changes to room-level Discord integration or the login OAuth scopes.
- Web push VAPID/host-allowlist items stay on their ROADMAP line.

## Tests
canDm verdicts (global member / room-guild member / neither / gateway down) · settings GET/PUT
round-trip + both-surface pref parity (command-written prefs render on web and vice versa) ·
connect flow state validation + identity-mismatch rejection + already-member idempotency ·
50007 → nudge flag → banner renders → clears on dismiss · known-unreachable short-circuit sets
nudge without a send attempt · `GLOBAL_DISCORD_GUILD_ID` unset → no button, no reachability
claims, everything inert.

## Gates
Root + admin-ui builds · full BE+FE vitest · CRLF · no push · no version/CHANGELOG (orchestrator).
Verify baselines on branch first. Blockers: recon contradicting the platform facts above
(especially the members-intent and CREATE_INSTANT_INVITE questions) → report, don't guess;
any change that would touch the LOGIN oauth scopes → hard stop.

## Operator runbook (for the owner, when this ships)
1. Convert the test server; keep/create the bot's membership there.
2. Set `GLOBAL_DISCORD_GUILD_ID` (+ optionally `GLOBAL_DISCORD_INVITE_URL`) in Global Settings.
3. If the report flags the SERVER MEMBERS intent: enable it in the Discord developer portal.
4. Field-test: a player in a Discord-less room connects via the one-click flow → gets a pick DM.
