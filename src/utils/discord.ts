import { REST, Routes, EmbedBuilder } from 'discord.js';
import { logError } from './logger.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { isDiscordUserId, isGoogleUserId } from './identityProvider.js';
import { trackBackground } from './backgroundTasks.js';
import { DISCORD_ANNOUNCE_ROUTES_KEY, parseAnnounceRoutes, parseTournamentAnnounceRoutes, type AnnounceKind } from './discordAnnounceRoutes.js';

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

/** Discord channel types that take a POST (thread), never a bare message: GuildForum, GuildMedia. */
const FORUM_CHANNEL_TYPES: ReadonlySet<number> = new Set([15, 16]);

export function isForumChannelType(type: number | null | undefined): boolean {
    return typeof type === 'number' && FORUM_CHANNEL_TYPES.has(type);
}

/** Discord's cap on a thread (forum post) name. */
export const FORUM_POST_NAME_MAX = 100;

/**
 * A forum post title from message text: the first non-empty line, with
 * mentions, timestamps and bold/underline/strike markers removed (a thread
 * name renders raw - a `<@id>` would show as a bare snowflake), trimmed to
 * Discord's 100-char cap.
 */
export function forumPostName(text: string): string {
    const firstLine = text.split('\n').find(l => l.trim() !== '') ?? '';
    const cleaned = firstLine
        .replace(/<@[!&]?\d+>/g, '')
        .replace(/<#\d+>/g, '')
        .replace(/<t:\d+(?::\w)?>/g, '')
        .replace(/\*\*|__|~~/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\u2014\u2013:,.-]+/, '')
        .trim();
    return (cleaned || 'Arcaid announcement').slice(0, FORUM_POST_NAME_MAX);
}

/**
 * Optional gateway-cache lookup, registered by `DiscordClient` at
 * construction so this module never imports the client (and tests that never
 * build one never load it). Returns null when the gateway does not know.
 */
let gatewayChannelTypeLookup: ((channelId: string) => number | null) | null = null;
export function registerGatewayChannelTypeLookup(fn: ((channelId: string) => number | null) | null): void {
    gatewayChannelTypeLookup = fn;
}

const channelTypeCache = new Map<string, number>();

/** Tests only. */
export function _resetChannelTypeCacheForTests(): void {
    channelTypeCache.clear();
}

/**
 * A channel's Discord type (v2.221.0, E8): the gateway cache when the bot is
 * connected, else `GET /channels/:id`. Cached per process (a channel never
 * changes type); a failed lookup is not cached and returns null, which every
 * sender treats as an ordinary text channel - the pre-E8 behaviour.
 */
export async function getChannelType(channelId: string): Promise<number | null> {
    const cached = channelTypeCache.get(channelId);
    if (cached !== undefined) return cached;
    let type: number | null = null;
    try {
        type = gatewayChannelTypeLookup?.(channelId) ?? null;
    } catch {
        type = null;
    }
    if (type === null) {
        const token = process.env.DISCORD_BOT_TOKEN;
        if (token) {
            try {
                const rest = new REST({ version: '10' }).setToken(token);
                const ch = await rest.get(Routes.channel(channelId)) as { type?: unknown } | null;
                if (typeof ch?.type === 'number') type = ch.type;
            } catch {
                type = null;
            }
        }
    }
    if (type !== null) channelTypeCache.set(channelId, type);
    return type;
}

/**
 * What a successful channel send created (v2.225.0, E13). `threadId` is set
 * only when the target was a forum and the send became a NEW post (the
 * thread's id; its starter message shares that id). Existing callers ignore
 * the result; a failed send returns nothing.
 */
export interface ChannelSendResult {
    threadId: string | null;
    messageId: string | null;
}

function idOf(res: unknown): string | null {
    const id = (res as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' ? id : null;
}

/**
 * Sends a plain-text message to a Discord channel via the REST API.
 * Safe to call from engine classes that don't have access to the Client instance.
 *
 * `opts.threadName` overrides the forum post title (default: the first line
 * via `forumPostName`); `opts.noMentions` sends `allowed_mentions: {parse: []}`
 * so text taken from player names can never ping anyone.
 */
/**
 * G14 (ADR 0037) - a post the bot could not make is a `problem` row in the
 * activity log of the room(s) using that channel. Lazy import: this module is
 * loaded by nearly everything. Never throws.
 */
function logBotPostFailure(channelId: string, err: unknown, what: string): void {
    trackBackground(import('../services/ActivityLogService.js')
        .then(({ ActivityLogService }) => ActivityLogService.recordBotPostFailure(channelId, err, what))
        .catch(() => { /* best effort */ }));
}

export async function sendChannelMessage(
    channelId: string,
    content: string,
    opts?: { threadName?: string; noMentions?: boolean },
): Promise<ChannelSendResult | void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord message: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    const message: Record<string, unknown> = { content };
    if (opts?.noMentions) message.allowed_mentions = { parse: [] };
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        // v2.221.0 (E8): a forum takes no bare message - the send becomes a
        // new post titled with the content's first line.
        if (isForumChannelType(await getChannelType(channelId))) {
            const thread = await rest.post(Routes.threads(channelId), {
                body: { name: opts?.threadName ? forumPostName(opts.threadName) : forumPostName(content), message },
            });
            const threadId = idOf(thread);
            return { threadId, messageId: threadId };
        }
        const sent = await rest.post(Routes.channelMessages(channelId), { body: message });
        return { threadId: null, messageId: idOf(sent) };
    } catch (err) {
        logError(`Failed to send message to channel ${channelId}:`, err);
        logBotPostFailure(channelId, err, 'post a message');
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
 *
 * `pingUserIds` (v2.155.7) repeats those users' mentions in the message
 * CONTENT with an explicit `allowed_mentions`, so they are notified and the
 * mention renders on every client. A mention that lives only inside the embed
 * does neither — see `resolveUserMention`, which supplies the ids.
 */
export async function sendChannelEmbed(
    channelId: string,
    embed: EmbedBuilder,
    opts?: { pingUserIds?: string[] },
): Promise<ChannelSendResult | void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord embed: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    const pingUserIds = Array.from(new Set((opts?.pingUserIds ?? []).filter(Boolean)));
    const body: Record<string, unknown> = { embeds: [embed.toJSON()] };
    if (pingUserIds.length > 0) {
        body.content = pingUserIds.map(id => `<@${id}>`).join(' ');
        body.allowed_mentions = { users: pingUserIds };
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        // v2.221.0 (E8): a forum takes no bare message - the embed becomes
        // the starter message of a new post titled with the embed title.
        if (isForumChannelType(await getChannelType(channelId))) {
            const json = embed.toJSON();
            const thread = await rest.post(Routes.threads(channelId), {
                body: { name: forumPostName(json.title || json.description || ''), message: body },
            });
            const threadId = idOf(thread);
            return { threadId, messageId: threadId };
        }
        const sent = await rest.post(Routes.channelMessages(channelId), { body });
        return { threadId: null, messageId: idOf(sent) };
    } catch (err) {
        logError(`Failed to send embed to channel ${channelId}:`, err);
        logBotPostFailure(channelId, err, 'post an announcement');
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
 * How to refer to a player in channel copy (v2.155.7).
 *
 * `text` goes into the embed; `pingIds` goes to `sendChannelEmbed`'s
 * `pingUserIds`, which repeats the mention in the message CONTENT. Both
 * halves are needed, because a `<@id>` that appears ONLY inside an embed
 * (a) never notifies anyone — Discord pings on content mentions alone — and
 * (b) renders as the raw snowflake on any client that hasn't cached the user
 * (the owner's phone, RTX_Pinball Daily Grind, 2026-09-07: PeteG had logged
 * in seconds before the rotation). A content mention ships the user object in
 * the message's `mentions[]`, so it renders everywhere and buzzes the person
 * it addresses.
 *
 * Returns no ping for non-Discord identities and for rooms that have turned
 * `DISCORD_MENTIONS_ENABLED` off — the same two cases where `text` is a
 * plain bold name.
 */
export async function resolveUserMention(
    userId: string,
    fallbackName: string,
    gameRoomId?: string | null,
): Promise<{ text: string; pingIds: string[] }> {
    // Non-Discord identities (e.g. `google:<sub>`) can never be mentioned —
    // always fall back to the plain-bold-name branch.
    if (!isDiscordUserId(userId)) {
        return { text: `**${fallbackName}**`, pingIds: [] };
    }
    if (gameRoomId) {
        const setting = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_MENTIONS_ENABLED');
        if (setting === 'false') {
            return { text: `**${fallbackName}**`, pingIds: [] };
        }
    }
    return { text: `<@${userId}>`, pingIds: [userId] };
}

/**
 * Returns a Discord mention `<@userId>` if mentions are enabled for the room,
 * otherwise returns the fallback display name (plain text, no ping).
 *
 * Prefer `resolveUserMention` for anything that goes into an embed — this
 * text-only form cannot make the mention ping (see there).
 */
export async function formatUserMention(userId: string, fallbackName: string, gameRoomId?: string | null): Promise<string> {
    return (await resolveUserMention(userId, fallbackName, gameRoomId)).text;
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
 * room should target. The ONE resolver. Precedence (first hit wins):
 *
 *   1. room Discord off (DISCORD_ENABLED=false) → null;
 *   2. the tournament's per-kind route for `kind`
 *      (`tournaments.discord_announce_routes`, v2.226.0 E16, read through
 *      `parseTournamentAnnounceRoutes`): `'none'` → null, a snowflake → it;
 *   3. the tournament's catch-all `discord_channel_id`: `'none'` → null
 *      (v2.140.0), a snowflake → it;
 *   4. the room's `DISCORD_ANNOUNCE_ROUTES` route for `kind` (v2.221.0, E8);
 *      for `scores` with no route, the room's `tournament` route;
 *   5. per-room `DISCORD_ANNOUNCEMENT_CHANNEL_ID`;
 *   6. `process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID`;
 *   7. null.
 *
 * `tournamentRoutes` is the RAW `discord_announce_routes` column value; absent
 * or null behaves exactly like the 3-arg form.
 */
/** Stored in `tournaments.discord_channel_id` to mean "announce nowhere". */
export const ANNOUNCE_NONE = 'none';

export async function resolveAnnouncementChannelId(
    gameRoomId: string | null | undefined,
    tournamentChannelId: string | null | undefined,
    kind: AnnounceKind = 'tournament',
    tournamentRoutes?: string | null,
): Promise<string | null> {
    if (!(await isDiscordEnabledForRoom(gameRoomId))) return null;
    // v2.226.0 (E16) — the tournament's per-kind override is the narrowest scope.
    const perKind = parseTournamentAnnounceRoutes(tournamentRoutes)[kind];
    if (perKind === ANNOUNCE_NONE) return null;
    if (perKind) return perKind;
    // v2.140.0 — 'none' is the per-tournament "don't announce" sentinel. It
    // exists because an EMPTY channel id means "fall back to the room's
    // announcement channel", so before this there was no way to run a quiet
    // tournament in a room that has one (an owner's AtGames test event posted
    // into the live Daily Grind channel, 2026-08-25). A sentinel in the same
    // column — rather than a new flag — means every caller that already
    // resolves through here inherits the behaviour.
    if (tournamentChannelId === ANNOUNCE_NONE) return null;
    // The narrower scope wins: a tournament with its own channel ignores the
    // room's per-kind routes; one on "Room default" is what routes apply to.
    if (tournamentChannelId) return tournamentChannelId;
    if (gameRoomId) {
        const roomRoutes = parseAnnounceRoutes(await GameRoomSettingsService.get(gameRoomId, DISCORD_ANNOUNCE_ROUTES_KEY));
        // Top-score posts ride the Tournament posts route unless given their own.
        const route = roomRoutes[kind] ?? (kind === 'scores' ? roomRoutes.tournament : null);
        if (route) return route;
        const perRoom = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID');
        if (perRoom) return perRoom;
    }
    return process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID ?? null;
}
