import { logError } from '../utils/logger.js';
import { CalloutService } from '../services/CalloutService.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GuildReadScope, resolveGuildReadScope } from '../utils/discordRoomFilter.js';
import { applyCalloutPlaceholders, isCalloutAction, matchCallout } from '../utils/callouts.js';
import { loadCalloutRooms, renderCalloutAction, roomContextFor } from './calloutActions.js';

/** Per-room opt-in for callout replies. Absent === OFF (see the gate below). */
export const CALLOUTS_ENABLED_KEY = 'CALLOUTS_ENABLED';
/** Optional per-room channel restriction. Absent === any readable channel. */
export const CALLOUTS_CHANNEL_KEY = 'CALLOUTS_CHANNEL_ID';

/**
 * The subset of discord.js' `Message` this handler needs. Declared
 * structurally so the gate is unit-testable without a gateway connection —
 * a real `Message` satisfies it.
 */
export interface CalloutMessageLike {
    author: { bot: boolean };
    guildId: string | null;
    channelId: string;
    content: string;
    reply: (content: string) => Promise<unknown>;
}

/**
 * The rooms a reply may speak for: those in the guild's read scope that opted
 * in AND accept this channel. Order follows the scope, so `[0]` is the room
 * links and `{placeholder}` substitution resolve against.
 */
export interface CalloutScope {
    scope: GuildReadScope;
    roomIds: string[];
}

/**
 * Decides whether a guild may receive callout replies, in which channel, and
 * on behalf of which rooms.
 *
 * Gate order (cheapest and most-often-false first — this runs per message):
 *   1. DMs are out. `resolveGuildReadScope` returns null for them anyway, but
 *      short-circuiting here keeps a DM off the DB entirely.
 *   2. Legacy master switch: `ENABLE_CALLOUTS='false'` silences everything,
 *      everywhere. DEPRECATED — kept for one release as an escape hatch for
 *      deployments that had the env var set; note the polarity flip, absence
 *      no longer means "off", the per-room opt-in does.
 *   3. `resolveGuildReadScope(guildId)` — the same guild→rooms resolver the
 *      read slash-commands use, so a Discord-disabled / approval-gated /
 *      suspended room can never trigger a reply either.
 *   4. A room in scope must have `CALLOUTS_ENABLED === 'true'`. ABSENT MEANS
 *      OFF: replying in someone else's server is a social choice, so it is
 *      opt-in, unlike most room toggles here.
 *   5. If that room pins `CALLOUTS_CHANNEL_ID`, the message must be in it.
 *      Rooms without the key accept any channel.
 *
 * Returns null when nothing may reply; otherwise the permitting rooms, which
 * become the scope the live-data actions answer for.
 */
export async function resolveCalloutScope(
    guildId: string | null,
    channelId: string,
): Promise<CalloutScope | null> {
    if (!guildId) return null;
    if (process.env.ENABLE_CALLOUTS === 'false') return null;

    const scope = await resolveGuildReadScope(guildId);
    if (!scope || scope.roomIds.length === 0) return null;

    const settings = await GameRoomSettingsService.getManyForRooms(
        scope.roomIds,
        [CALLOUTS_ENABLED_KEY, CALLOUTS_CHANNEL_KEY],
    );

    const permitting: string[] = [];
    for (const roomId of scope.roomIds) {
        const bucket = settings.get(roomId);
        if (!bucket || bucket[CALLOUTS_ENABLED_KEY] !== 'true') continue;
        const pinned = (bucket[CALLOUTS_CHANNEL_KEY] || '').trim();
        if (pinned && pinned !== channelId) continue;
        permitting.push(roomId);
    }
    if (permitting.length === 0) return null;

    // The action responders read through the same guild-scope filter the read
    // slash-commands use, narrowed to the rooms that actually opted in.
    return { scope: { roomIds: permitting, legacyEnv: scope.legacyEnv }, roomIds: permitting };
}

/** Back-compat boolean form of the gate. */
export async function calloutsAllowedForMessage(
    guildId: string | null,
    channelId: string,
): Promise<boolean> {
    return (await resolveCalloutScope(guildId, channelId)) !== null;
}

/**
 * MessageCreate entry point. Returns true iff a callout was sent — the return
 * value exists for tests; `DiscordClient` ignores it.
 *
 * Never throws: a failure here must not take down the gateway listener.
 */
export async function handleCalloutMessage(message: CalloutMessageLike): Promise<boolean> {
    try {
        if (message.author?.bot) return false;

        const allowed = await resolveCalloutScope(message.guildId, message.channelId);
        if (!allowed) return false;

        const entries = await CalloutService.getEnabledCached();
        if (entries.length === 0) return false;

        const hit = matchCallout(message.content, entries);
        if (!hit) return false;

        // Rooms are loaded only AFTER a match — an ordinary chat message must
        // not cost a room lookup.
        const rooms = await loadCalloutRooms(allowed.roomIds);

        // An `action` wins over static responses: the entry exists because a
        // fixed string cannot answer the question.
        if (isCalloutAction(hit.entry.action)) {
            const rendered = await renderCalloutAction(hit.entry.action, allowed.scope, rooms);
            if (!rendered) return false;
            await message.reply(rendered);
            return true;
        }

        if (hit.response === null) return false;
        await message.reply(applyCalloutPlaceholders(hit.response, roomContextFor(rooms)));
        return true;
    } catch (err) {
        logError('[callouts] Failed to handle message:', err);
        return false;
    }
}
