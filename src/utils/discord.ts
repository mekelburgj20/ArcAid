import { REST, Routes, EmbedBuilder } from 'discord.js';
import { logError } from './logger.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { isDiscordUserId, isGoogleUserId } from './identityProvider.js';
import { trackBackground } from './backgroundTasks.js';

/** Embed accent colors keyed by tournament tag or type. */
const TAG_COLORS: Record<string, number> = {
    // By tag
    'DG':      0xFFD700,  // gold
    'WG-VPXS': 0x00BFFF,  // sky blue
    'WG-VR':   0xAA00FF,  // purple
    'MG':      0x00FF88,  // green
    // By generic type (fallback)
    'daily':   0xFFD700,
    'weekly':  0x00BFFF,
    'monthly': 0xAA00FF,
    'custom':  0x00FF88,
};

/** Returns the embed color for a tournament type/tag string. */
export function getTournamentColor(type?: string | null): number {
    if (!type) return 0x888888;
    const upper = type.toUpperCase();
    return TAG_COLORS[upper] ?? TAG_COLORS[type] ?? 0x888888;
}

/**
 * Sends a plain-text message to a Discord channel via the REST API.
 * Safe to call from engine classes that don't have access to the Client instance.
 */
export async function sendChannelMessage(channelId: string, content: string): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord message: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.post(Routes.channelMessages(channelId), { body: { content } });
    } catch (err) {
        logError(`Failed to send message to channel ${channelId}:`, err);
    }
}

/**
 * Discord API error codes meaning "this user cannot receive your DM", as
 * opposed to a transient transport problem. Used to decide whether a failed
 * send should raise the Section-4 nudge (Discord HQ arc, v2.72.0).
 *
 *   50007 Cannot send messages to this user — the canonical case: no shared
 *         guild, or a shared guild with "Allow direct messages from server
 *         members" switched off, or the user blocked the bot.
 *   50013 Missing Permissions — the same condition surfaces this way on some
 *         DM-channel paths.
 *
 * A rate limit, a 500, or a network blip is NOT in this set: those mean "try
 * again later", and nudging the user to fix their privacy settings over a
 * transient outage would be a lie.
 */
const CANNOT_DM_CODES: ReadonlySet<number> = new Set([50007, 50013]);

/** True when `err` is a Discord rejection meaning the user is un-DM-able. */
export function isCannotDmError(err: unknown): boolean {
    const code = (err as { code?: unknown; rawError?: { code?: unknown } })?.code
        ?? (err as { rawError?: { code?: unknown } })?.rawError?.code;
    return typeof code === 'number' && CANNOT_DM_CODES.has(code);
}

/**
 * Sends a direct message to a Discord user via the REST API.
 * Creates a DM channel first, then sends the message.
 * Returns true if sent, false on failure (silent — does not throw).
 *
 * THE SWALLOW IS LOAD-BEARING and must stay: callers are score submissions,
 * tournament rotations and cron maintenance, none of which may fail because a
 * player closed their DMs. (Note for future readers: `NotificationService` is
 * often described as the place that swallows DM failures — it isn't. The
 * try/catch that actually eats them is right here, and `notify()` only ever
 * sees the boolean.)
 *
 * v2.72.0 adds the nudge side-effects around that swallow — an un-DM-able
 * rejection raises a flag the web app surfaces once (`DmNudgeService`), and a
 * success clears any flag already standing. Both are fire-and-forget and
 * tracked via `trackBackground`, so the return value and timing are unchanged
 * and a nudge-write failure can't break the caller either.
 *
 * `context.type` lets `NotificationService` name the notification that failed;
 * every other caller may omit it.
 */
export async function sendDirectMessage(
    userId: string,
    content: string,
    context?: { type?: string },
): Promise<boolean> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord DM: DISCORD_BOT_TOKEN is not set.');
        return false;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const channel = await rest.post(Routes.userChannels(), {
            body: { recipient_id: userId },
        }) as { id: string };
        await rest.post(Routes.channelMessages(channel.id), { body: { content } });
        trackBackground(
            import('../services/DmNudgeService.js')
                .then(m => m.DmNudgeService.clear(userId))
                .catch(() => {}),
        );
        return true;
    } catch (err) {
        logError(`Failed to send DM to user ${userId}:`, err);
        if (isCannotDmError(err)) {
            trackBackground(
                import('../services/DmNudgeService.js')
                    .then(m => m.DmNudgeService.record(userId, 'send_failed', context?.type))
                    .catch(() => {}),
            );
        }
        return false;
    }
}

export interface ResolvedDiscordMember {
    id: string;
    /** global_name ?? username for a searched match; null when the input was
     *  already a numeric ID (no lookup performed, so no name to report). */
    displayName: string | null;
}

/**
 * Resolves a Discord username to a guild member (ID + display name) by
 * searching guild members. Accepts a numeric ID (returned as-is, no lookup)
 * or a username/handle (searched in the guild). Returns null if not found.
 */
export async function resolveDiscordMember(input: string, guildId?: string): Promise<ResolvedDiscordMember | null> {
    // If it's already a numeric ID, return as-is
    if (isDiscordUserId(input)) return { id: input, displayName: null };

    // A `google:<sub>` id has no Discord identity to resolve — it feeds
    // Discord-channel operations (mentions, guild lookups), so return null
    // rather than wasting a guild-member-search REST call on a string that
    // can never match a Discord username.
    if (isGoogleUserId(input)) return null;

    // Strip leading @ if present
    const username = input.replace(/^@/, '');

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || !guildId) return null;

    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const results = await rest.get(Routes.guildMembersSearch(guildId), {
            query: new URLSearchParams({ query: username, limit: '5' }),
        }) as Array<{ user: { id: string; username: string; global_name?: string } }>;

        // Exact match on username or global_name (case-insensitive)
        const lower = username.toLowerCase();
        const match = results.find(m =>
            m.user.username.toLowerCase() === lower ||
            (m.user.global_name && m.user.global_name.toLowerCase() === lower)
        );
        return match ? { id: match.user.id, displayName: match.user.global_name ?? match.user.username } : null;
    } catch (err) {
        logError(`Failed to resolve Discord username "${input}" in guild ${guildId}:`, err);
        return null;
    }
}

/**
 * Resolves a Discord username to a user ID by searching guild members.
 * Accepts a numeric ID (returned as-is) or a username/handle (searched in the guild).
 * Returns the numeric user ID or null if not found.
 */
export async function resolveDiscordUserId(input: string, guildId?: string): Promise<string | null> {
    return (await resolveDiscordMember(input, guildId))?.id ?? null;
}

/**
 * Sends a rich embed to a Discord channel via the REST API.
 */
export async function sendChannelEmbed(channelId: string, embed: EmbedBuilder): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord embed: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.post(Routes.channelMessages(channelId), {
            body: { embeds: [embed.toJSON()] },
        });
    } catch (err) {
        logError(`Failed to send embed to channel ${channelId}:`, err);
    }
}

export interface DiscordUserFetch {
    username: string;
    globalName: string | null;
    avatar: string | null;
}

/**
 * One uncached `GET /users/:id` — the whole user object a profile hydration
 * needs (v2.127.0). `fetchAvatarHash` and `fetchDiscordUserInfo` each fetch the
 * same endpoint for one field apiece; `UserProfileService.hydrateFromDiscord`
 * wants both the avatar and the name, and paying two REST calls for one row
 * would double the rate-limit cost of the nightly refresh sweep.
 *
 * Deliberately uncached (unlike `fetchDiscordUserInfo`): hydration is already
 * gated on a 24h `avatar_fetched_at` stamp, and the nightly sweep exists
 * precisely to get FRESH values.
 *
 * Returns null for non-Discord ids (`google:<sub>` has no Discord user), for a
 * missing bot token, and on any REST failure.
 */
export async function fetchDiscordUser(discordUserId: string): Promise<DiscordUserFetch | null> {
    if (!isDiscordUserId(discordUserId)) return null;
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return null;
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const user = await rest.get(Routes.user(discordUserId)) as {
            username?: string; global_name?: string | null; avatar?: string | null;
        };
        if (!user?.username) return null;
        return {
            username: user.username,
            globalName: user.global_name ?? null,
            avatar: user.avatar ?? null,
        };
    } catch (err) {
        logError(`fetchDiscordUser: failed to fetch user ${discordUserId}:`, err);
        return null;
    }
}

/**
 * Best-effort fetch of a Discord user's current avatar hash. Returns null on
 * any failure (user left guild, bot lacks intent, REST error). Caller decides
 * whether the failure is fatal — for caching it usually isn't.
 *
 * Thin wrapper over `fetchDiscordUser` since v2.127.0 — same single REST call,
 * one field of it. Kept as its own export because several callers only ever
 * want the hash.
 */
export async function fetchAvatarHash(discordUserId: string): Promise<string | null> {
    // Non-snowflake ids (e.g. `google:<sub>`) have no Discord user to fetch —
    // skip the doomed REST call entirely.
    return (await fetchDiscordUser(discordUserId))?.avatar ?? null;
}

export interface DiscordUserInfo {
    username: string;
    globalName: string | null;
}

/** In-memory cache for `fetchDiscordUserInfo` — 1h TTL, same idiom as
 *  BanService's TTL cache. Caches misses too (null), at the same TTL, so a
 *  bad/unknown id or a sustained Discord outage can't be re-fetched on every
 *  render of an admin-facing list. */
const discordUserInfoCache = new Map<string, { info: DiscordUserInfo | null; ts: number }>();
const DISCORD_USER_INFO_TTL_MS = 60 * 60 * 1000;

/**
 * Best-effort fetch of a Discord user's current username + global (display)
 * name — v2.49.0, name-resolution follow-up (docs/contracts/room-bans-contract.md
 * Workstream 2). Used as the last-resort fallback when a raw provider id has
 * no `user_profiles` row yet (the admin/user never logged into Arcaid), so an
 * admin-facing list can still show a human name instead of a bare snowflake.
 * Returns null on any failure or for non-Discord ids (e.g. `google:<sub>` —
 * those have no Discord user to fetch and render as a truncated raw id
 * client-side instead).
 */
export async function fetchDiscordUserInfo(discordUserId: string): Promise<DiscordUserInfo | null> {
    if (!isDiscordUserId(discordUserId)) return null;

    const cached = discordUserInfoCache.get(discordUserId);
    if (cached && Date.now() - cached.ts < DISCORD_USER_INFO_TTL_MS) return cached.info;

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return null;
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const user = await rest.get(Routes.user(discordUserId)) as { username?: string; global_name?: string | null };
        const info: DiscordUserInfo | null = user.username ? { username: user.username, globalName: user.global_name ?? null } : null;
        discordUserInfoCache.set(discordUserId, { info, ts: Date.now() });
        return info;
    } catch (err) {
        logError(`fetchDiscordUserInfo: failed to fetch user ${discordUserId}:`, err);
        discordUserInfoCache.set(discordUserId, { info: null, ts: Date.now() });
        return null;
    }
}

/**
 * Returns a Discord mention `<@userId>` if mentions are enabled for the room,
 * otherwise returns the fallback display name (plain text, no ping).
 */
export async function formatUserMention(userId: string, fallbackName: string, gameRoomId?: string | null): Promise<string> {
    // Non-Discord identities (e.g. `google:<sub>`) can never be mentioned —
    // always fall back to the plain-bold-name branch.
    if (!isDiscordUserId(userId)) {
        return `**${fallbackName}**`;
    }
    if (gameRoomId) {
        const setting = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_MENTIONS_ENABLED');
        if (setting === 'false') {
            return `**${fallbackName}**`;
        }
    }
    return `<@${userId}>`;
}

/**
 * Returns true when Discord announcements + actions should happen for the
 * given room. Controlled by the per-room `DISCORD_ENABLED` toggle (default
 * true). A `null`/`undefined` roomId is treated as enabled — keeps legacy
 * single-room flows working.
 */
export async function isDiscordEnabledForRoom(gameRoomId?: string | null): Promise<boolean> {
    if (!gameRoomId) return true;
    const raw = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_ENABLED');
    return raw !== 'false';
}

/**
 * S22 Phase 2 (v2.44.0, M1 fix) — combined guild-level interaction gate.
 * `guildId` maps to zero or more rooms via `DISCORD_GUILD_ID` in
 * `game_room_settings`. Refuses (returns the ephemeral reply text) when:
 *   1. ANY mapped room is suspended — suspension blocks everyone (design
 *      decision #2), so it's checked first and independently of the
 *      Discord-enabled check below (a suspended-but-Discord-enabled room
 *      must still be refused).
 *   2. otherwise, when NONE of the mapped rooms have Discord enabled
 *      (pre-existing behavior, unchanged).
 * Returns `null` to allow the interaction through (no mapped room, or at
 * least one mapped room is active + enabled).
 *
 * Extracted from `DiscordClient.ts`'s `InteractionCreate` handler so this
 * gate is unit-testable without a discord.js gateway/interaction mock.
 */
export async function guildInteractionBlockReason(guildId: string): Promise<string | null> {
    const { getDatabase } = await import('../database/database.js');
    const db = await getDatabase();
    const rows = await db.all(
        `SELECT game_room_id FROM game_room_settings WHERE key = 'DISCORD_GUILD_ID' AND value = ?`,
        guildId,
    ) as Array<{ game_room_id: string }>;
    if (rows.length === 0) return null;

    const roomIds = rows.map(r => r.game_room_id);
    const placeholders = roomIds.map(() => '?').join(', ');
    const suspendedRows = await db.all(
        `SELECT id FROM game_rooms WHERE id IN (${placeholders}) AND suspended_at IS NOT NULL`,
        ...roomIds,
    );
    if (suspendedRows.length > 0) {
        return 'This room has been suspended pending review.';
    }

    const anyEnabled = await Promise.all(roomIds.map(id => isDiscordEnabledForRoom(id)))
        .then(results => results.some(Boolean));
    if (!anyEnabled) {
        return 'Arcaid is not connected to this Discord server.';
    }
    return null;
}

/**
 * Resolves the Discord channel that announcements for a tournament in this
 * room should target. Precedence: tournament-specific channel → per-room
 * `DISCORD_ANNOUNCEMENT_CHANNEL_ID` → env fallback. Returns `null` when the
 * room has DISCORD_ENABLED=false or no channel can be resolved.
 */
/** Stored in `tournaments.discord_channel_id` to mean "announce nowhere". */
export const ANNOUNCE_NONE = 'none';

export async function resolveAnnouncementChannelId(
    gameRoomId: string | null | undefined,
    tournamentChannelId: string | null | undefined,
): Promise<string | null> {
    if (!(await isDiscordEnabledForRoom(gameRoomId))) return null;
    // v2.140.0 — 'none' is the per-tournament "don't announce" sentinel. It
    // exists because an EMPTY channel id means "fall back to the room's
    // announcement channel", so before this there was no way to run a quiet
    // tournament in a room that has one (an owner's AtGames test event posted
    // into the live Daily Grind channel, 2026-08-25). A sentinel in the same
    // column — rather than a new flag — means every caller that already
    // resolves through here inherits the behaviour.
    if (tournamentChannelId === ANNOUNCE_NONE) return null;
    if (tournamentChannelId) return tournamentChannelId;
    if (gameRoomId) {
        const perRoom = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID');
        if (perRoom) return perRoom;
    }
    return process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID ?? null;
}
