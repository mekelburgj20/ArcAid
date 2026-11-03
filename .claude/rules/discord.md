---
paths:
  - "src/discord/**/*.ts"
  - "src/utils/discord*.ts"
  - "src/services/Callout*.ts"
  - "src/services/Notification*.ts"
  - "src/services/LobbyFeed*.ts"
  - "src/services/Friends*.ts"
  - "src/services/PickAlert*.ts"
  - "admin-ui/src/components/DiscordCommandPolicy.tsx"
---
# Discord bot, slash commands, announcements, notifications — rules

Loads when you touch the Discord client/commands, Discord utils, chat responses (callouts), notifications, lobby feed or friends. Cross-cutting invariants live in the root CLAUDE.md; this file is the detail for this domain.

## OAuth and credentials
- **Discord OAuth state encoding.** `__super__` → super-admin login, `player:<slug>` → public-page player login, bare slug → room admin login. Scope must be `identify` only — `guilds.members.read` causes 400s on the authorize redirect.
- **Per-room Discord/iScored credentials** live in `game_room_settings`: `DISCORD_GUILD_ID`, `DISCORD_ANNOUNCE_CHANNEL_ID`, `ISCORED_USERNAME`, `ISCORED_PASSWORD`, `ISCORED_GAMEROOM`, plus `DISCORD_ENABLED` / `ISCORED_ENABLED` toggles. The bot token + Discord client ID/secret stay global.

## Guild-scoped slash commands
- **Slash commands are guild-scoped (v2.120.1).** Reads (`/list-active`, `/list-scores`, `/list-winners`, `/view-queue`, `/view-stats`) and the tournament-id admin commands (`/run-cleanup`, `/nominate-picker`, `/pause-pick`) resolve `resolveGuildReadScope(interaction.guildId)` in `src/utils/discordRoomFilter.ts` — rooms whose `DISCORD_GUILD_ID` is the invoking server, minus Discord-off/suspended rooms, and minus approval rooms the invoking Discord user is not a member or admin of. Legacy env-guild fallback covers settingless rooms; no link or DM → ephemeral not-linked reply, nothing shown.
  - Signatures: `resolveGuildReadScope(guildId, userId)` / `validateDiscordWriteTarget(roomId, guildId, userId)` (v2.212.0). `GuildReadScope.notMemberOf` lets a command say "join the room" instead of "nothing to show". An omitted userId excludes, so every new caller must pass `interaction.user.id`.
- **Writes resolve their room via `discordWriteTarget.ts`.** **Any new command that reads or mutates room data must go through one of those two** — a bare `FROM tournaments`/`FROM games` in a command is a cross-room leak. Known residue: `StatsService.getGameStats`/`getPlayerStats` and the five tournament/game autocompletes are still cross-room (queued).

## Per-room slash-command policy (v2.217.0, E7)
- **`game_room_settings.DISCORD_COMMAND_POLICY`** (JSON `{version, defaults{channelIds, roleIds}, commands{name: {enabled, channelIds, roleIds}}}`, edited instant-save in Room Settings -> Discord -> Slash commands, `components/DiscordCommandPolicy.tsx`) turns commands off or locks them to Discord channels/roles.
- **Inheritance.** Absent/malformed key = everything allowed; an unlisted command is on and uses `defaults`; a command's NON-EMPTY list replaces the default list; empty = any; ANY listed role passes.
- **Read only through `parseCommandPolicy`** (`src/utils/discordCommandPolicy.ts`); the settings POST re-serializes the value through it.
- **`commandPolicyBlockReason(guildId, userId, commandName, channelId, memberRoleIds)` is the ONE gate.** `DiscordClient`'s InteractionCreate calls it for chat-input commands (after `guildInteractionBlockReason`, ephemeral refusal) AND autocomplete (`respond([])`). A guild linked to several rooms allows a command when ANY non-excluded room allows it; any error ALLOWS (fail-open).
- **A new interaction entry point (buttons, modals, context menus) must call it too.**
- Arcaid Chat Responses (`callouts.ts`) is deliberately outside it (own channel allowlist). Refusal copy names roles via `listGuildRoles`, never ids.

## Announcements and mentions (v2.155.7)
- **`TournamentEngine.activateGame` announces NOTHING** (it runs inside three callers' transactions). Every INTERACTIVE activation — web `/pick-game`, Discord `/pick-game`, the admin page, `/activate-game` — calls `engine.announceGameActivated(...)` after COMMIT, fire-and-forget. The cron/queue/auto-pick paths keep their own richer embeds. A new interactive activation that skips the call is the silent-web-pick bug reborn (rtx_pinball Daily Grind, 2026-09-07).
- **A `<@id>` that lives only inside an embed neither pings nor renders reliably** (Discord notifies on content mentions only and resolves embed mentions from the viewer's local cache; a fresh login shows a raw snowflake). Anything that ADDRESSES a player uses `resolveUserMention` → `sendChannelEmbed(channelId, embed, { pingUserIds })`; anything that merely RECORDS a player (the Rotation `Winner:` line, "picked by" on the activation embed) uses a bold name. Never re-add a bare `<@id>` to an embed.
- **Every pick prompt names its tournament in the title AND body (v2.157.1)** — Pick Needed, Winner Timed Out, Pick Reminder, the nominee onboarding post and the Picks-page banner; several tournaments announce into one channel (bofgi, Weekly Grind VPXS, 2026-09-30). Locked by `pick-prompts-name-tournament.test.ts`.
- **Discord `/pick-game` placeholder fulfillment (v2.9.0).** The Discord command mirrors the web `/pick-game` route's three-branch flow: pending+full repurposes the placeholder (keeps `queue_order = NULL` so it stays at the front of the queue); open-slot drops any existing placeholder inside the activate transaction; no-pending+full queues normally.
- **Embed colors:** daily=gold(0xFFD700), weekly=blue(0x00BFFF), monthly=purple(0xAA00FF), custom=green(0x00FF88).
- **Discord ActionRow** holds max 5 buttons. Star-rating + Skip required splitting into multiple rows.

## "Arcaid Chat Responses" (internally still `callouts`, v2.123.0 → v2.125.0)
- **Storage.** `callouts` table (migrations 155/156: `category` ∈ `help|callouts|banter|easter_eggs`) edited via Admin → Settings → Arcaid Chat Responses (upload/replace/export JSON, inline editor, category filter); `CalloutService` caches in memory. The `callouts` table is the ONLY source of truth — the legacy `data/callouts.json` seed file was deleted 2026-08-23 (prod's list is newer/larger); `seedFromFileIfEmpty` still no-ops when the file is absent, so a fresh install starts with just the auto-seeded `help` rows. `ensureBuiltinHelpEntries()` seeds one `help` row per live `action` that has no row.
- **Per-room keys.** `CHAT_RESPONSES_ENABLED` (absent = off), `_CATEGORIES` (JSON array, absent → `["help","callouts"]`), `_CHANNEL_IDS` (JSON array, empty = any readable channel), `_COOLDOWN_SEC` (default 30; `help` never throttled). The room card saves these INSTANTLY (changed keys only, rollback on failure) — NOT via the Save bar (a staged-only toggle let the bot keep replying after the owner "turned it off"). Legacy `CALLOUTS_ENABLED`/`CALLOUTS_CHANNEL_ID` are migrated at boot then deleted.
- **Gate order in `src/discord/callouts.ts`:** DM → legacy `ENABLE_CALLOUTS='false'` → guild scope → room master → allowed channels → in-chat "Arcaid, shush/unmute" → per-user mute (`notification_prefs.chatResponses`) → filter to enabled categories BEFORE matching → match → per-channel cooldown → reply.
- **Live `action`s:** `active_games`, `picks_link`, `scores_link`, `how_to_submit`, `time_left` (cron-parser, tournament tz), `leaders`, `my_rank`, `pick_status`, `tournament_rules`, `how_to_claim`. Static responses may use `{room_name}`/`{room_url}`/`{picks_url}`/`{scores_url}`.

## Local bot container
- **The local `arcaid-bot` container IS a second production bot** if it runs — the repo `.env` holds the prod `DISCORD_BOT_TOKEN`. It re-registers the GLOBAL slash-command set from its stale build on every boot, races prod on every interaction (`DiscordAPIError[40060]`), and answers callouts from the local file (incident 2026-08-21). Its restart policy is `no`; never leave it up alongside prod, and prefer a separate dev bot application for local work.

## Lobby, social, notifications
- **Lobby feed** lives in `lobby_feed_events` (separate from `room_events` — 90-day retention vs 7, different query patterns). Cursor pagination via `created_at`. WebSocket channel `lobby:${roomId}`. `LobbyFeedGenerator.onScoreSubmitted` is hooked into all score submission paths via fire-and-forget dynamic imports. Lobby config (social links, pinned message, feed settings) stored as JSON in `game_room_settings` keys — no new tables.
- **Friends** use a unidirectional follow model. `FriendsService.getPlayersWhoFriended` is the reverse lookup driving targeted `friend_score` events.
- **`NotificationService.notify`** checks per-user opt-in prefs (`notification_prefs` JSON on `user_preferences`) + in-memory rate limit (5/user/hour). Seven types, all default-off: `tournamentWin`, `turnToPick`, `tournamentStarting`, `rankDethroned`, `friendScore`, `rotationReady`, `queueLow`. Managed via `/arcaid-notifications` Discord command.
  - `PREF_TYPE_KEYS` is the list — adding one means touching the prefs interface, `PREF_TYPE_KEYS`, `HIGH_VALUE_TYPES`/`WEB_PUSH_TYPES`/`PUSH_TITLES` if applicable, `getPrefsWithExplicit`'s defaults, the Discord `PREF_LABELS` + choice, and `AccountSettings.tsx`'s `NOTIF_TYPES`.
- **Milestones** use "exactly equals threshold" count queries — no separate tracking table.
