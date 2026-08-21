import { logError } from '../utils/logger.js';
import { CalloutService } from '../services/CalloutService.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { NotificationService } from '../services/NotificationService.js';
import { GuildReadScope, resolveGuildReadScope } from '../utils/discordRoomFilter.js';
import {
    CalloutCategory,
    applyCalloutPlaceholders,
    calloutCategoryOf,
    filterByCategories,
    isCalloutAction,
    matchCallout,
} from '../utils/callouts.js';
import {
    CHAT_RESPONSE_SETTING_KEYS,
    RoomChatResponseConfig,
    resolveRoomChatConfig,
} from '../services/ChatResponseSettingsService.js';
import { loadCalloutRooms, renderCalloutAction, roomContextFor } from './calloutActions.js';

/**
 * Arcaid Chat Responses — the MessageCreate gate.
 *
 * Internal identifiers stay `callout*`; the user-facing name is "Arcaid Chat
 * Responses" (v2.125.0). See `src/utils/callouts.ts` for why.
 */

/**
 * DEPRECATED v2.123.0 per-room keys, re-exported so existing importers keep
 * compiling through the rename. `ChatResponseSettingsService` owns the live
 * keys; these two are read for ONE more release and then deleted by the boot
 * migration.
 */
export const CALLOUTS_ENABLED_KEY = 'CALLOUTS_ENABLED';
export const CALLOUTS_CHANNEL_KEY = 'CALLOUTS_CHANNEL_ID';

/**
 * The subset of discord.js' `Message` this handler needs. Declared
 * structurally so the gate is unit-testable without a gateway connection —
 * a real `Message` satisfies it.
 */
export interface CalloutMessageLike {
    author: { bot: boolean; id?: string };
    guildId: string | null;
    channelId: string;
    content: string;
    /**
     * discord.js' `MessageMentions`. Only `.has(botUserId)` is called, and only
     * by the in-chat mute toggle; a message-like without it simply can't reach
     * that path via a mention (the "arcaid …" prefix still works).
     */
    mentions?: { has: (target: any) => boolean };
    /** The gateway client, read solely for the bot's own user id. */
    client?: { user?: { id: string } | null };
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
    /** Per-room config, keyed by room id, for the category + cooldown checks. */
    configs: Map<string, RoomChatResponseConfig>;
    /** Union of every permitting room's enabled categories. */
    categories: Set<CalloutCategory>;
}

/**
 * Per-channel throttle for the FUN categories.
 *
 * Keyed `guildId:channelId` and held in memory: a missed throttle after a
 * restart is a single extra reply, which is not worth a table. `help` answers
 * deliberately bypass this — somebody asking "how long left" twice in a minute
 * wants an answer twice, and rate-limiting the useful half of the feature to
 * protect a channel from jokes would be the wrong trade.
 */
const channelCooldowns = new Map<string, number>();

/** Categories the cooldown applies to. `help` is the deliberate omission. */
const COOLDOWN_CATEGORIES: ReadonlySet<CalloutCategory> = new Set<CalloutCategory>([
    'callouts', 'banter', 'easter_eggs',
]);

/** Test seam — drops the throttle so a suite isn't order-dependent. */
export function resetCalloutCooldowns(): void {
    channelCooldowns.clear();
}

/**
 * Decides whether a guild may receive chat responses, in which channel, on
 * behalf of which rooms, and for which categories.
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
 *   4. A room in scope must have its MASTER switch on. ABSENT MEANS OFF:
 *      replying in someone else's server is a social choice, so it is opt-in,
 *      unlike most room toggles here.
 *   5. If that room lists allowed channels, the message must be in one of
 *      them. An empty/absent list accepts any channel the bot can read.
 *
 * The CATEGORY and COOLDOWN checks are deliberately NOT here: they depend on
 * which entry matched, which isn't known until after the matcher runs.
 *
 * Returns null when nothing may reply.
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
        CHAT_RESPONSE_SETTING_KEYS,
    );

    const permitting: string[] = [];
    const configs = new Map<string, RoomChatResponseConfig>();
    const categories = new Set<CalloutCategory>();
    for (const roomId of scope.roomIds) {
        const config = resolveRoomChatConfig(settings.get(roomId));
        if (!config.enabled) continue;
        if (config.channelIds.length > 0 && !config.channelIds.includes(channelId)) continue;
        permitting.push(roomId);
        configs.set(roomId, config);
        for (const category of config.categories) categories.add(category);
    }
    if (permitting.length === 0) return null;

    // The action responders read through the same guild-scope filter the read
    // slash-commands use, narrowed to the rooms that actually opted in.
    return {
        scope: { roomIds: permitting, legacyEnv: scope.legacyEnv },
        roomIds: permitting,
        configs,
        categories,
    };
}

/** Back-compat boolean form of the gate. */
export async function calloutsAllowedForMessage(
    guildId: string | null,
    channelId: string,
): Promise<boolean> {
    return (await resolveCalloutScope(guildId, channelId)) !== null;
}

/** Reply sent when someone mutes the bot in chat. */
export const CHAT_MUTE_CONFIRMATION =
    "Okay — I'll stop replying to your messages. "
    + "Say 'Arcaid, unmute' (or /arcaid-notifications) to turn me back on.";
/** Reply sent when they turn it back on. */
export const CHAT_UNMUTE_CONFIRMATION = "I'm back.";

const MUTE_WORDS = ['shush', 'quiet', 'mute'];
const UNMUTE_WORDS = ['unmute', 'speak', 'talk to me'];

/**
 * Whether a message is addressed to the bot: an @mention of it, or a message
 * that simply STARTS with "arcaid" (how people actually talk to it — "Arcaid,
 * shush"). Anything else is ordinary chat, so "this bot is too quiet" from one
 * player never mutes them.
 */
function isAddressedToBot(message: CalloutMessageLike): boolean {
    const botId = message.client?.user?.id;
    if (botId && message.mentions?.has(botId)) return true;
    return /^\s*arcaid\b/i.test(message.content || '');
}

/**
 * The in-chat mute toggle (v2.125.0), the third way to set the same pref the
 * `/arcaid-notifications` command and Account Settings write.
 *
 * Runs BEFORE the entry matcher on purpose: no uploaded entry can shadow it by
 * happening to list "quiet" as a trigger, and it must answer a MUTED user
 * (otherwise "unmute" would be unreachable — the mute check would eat it). It
 * also bypasses the category gate and the cooldown, so it works in a room that
 * enabled only `help` and in a channel that has just used its throttle.
 *
 * It does NOT bypass the room's ALLOWED-CHANNELS list, because it runs after
 * `resolveCalloutScope`. That is deliberate: a room that confined the bot to
 * one channel does not want it answering elsewhere, and a person who wants out
 * still has `/arcaid-notifications` and Account Settings, neither of which
 * cares where they are standing.
 *
 * Returns true when it handled the message.
 */
async function handleMuteToggle(message: CalloutMessageLike): Promise<boolean> {
    const userId = message.author?.id;
    if (!userId) return false;
    if (!isAddressedToBot(message)) return false;

    const content = (message.content || '').toLowerCase();
    // Unmute wins the tie: "unmute" contains no mute word, but a message like
    // "stop being quiet, unmute" should turn the bot ON, not off.
    if (UNMUTE_WORDS.some(w => content.includes(w))) {
        await NotificationService.setChatResponsesEnabled(userId, true);
        await message.reply(CHAT_UNMUTE_CONFIRMATION);
        return true;
    }
    if (MUTE_WORDS.some(w => content.includes(w))) {
        await NotificationService.setChatResponsesEnabled(userId, false);
        await message.reply(CHAT_MUTE_CONFIRMATION);
        return true;
    }
    return false;
}

/**
 * MessageCreate entry point. Returns true iff a reply was sent — the return
 * value exists for tests; `DiscordClient` ignores it.
 *
 * Never throws: a failure here must not take down the gateway listener.
 */
export async function handleCalloutMessage(message: CalloutMessageLike): Promise<boolean> {
    try {
        if (message.author?.bot) return false;

        const allowed = await resolveCalloutScope(message.guildId, message.channelId);
        if (!allowed) return false;

        // Before everything else — see `handleMuteToggle`.
        if (await handleMuteToggle(message)) return true;

        // A muted user gets silence from here on. Checked after the toggle so
        // they can always talk their way back out of it.
        const authorId = message.author?.id;
        if (authorId && !(await NotificationService.chatResponsesEnabled(authorId))) return false;

        const entries = await CalloutService.getEnabledCached();
        if (entries.length === 0) return false;

        // Category filtering happens BEFORE matching, never after: an entry in
        // a disabled category must not be able to win first-match and silence
        // the enabled entry sitting behind it in the list.
        const eligible = filterByCategories(entries, allowed.categories);
        if (eligible.length === 0) return false;

        const hit = matchCallout(message.content, eligible);
        if (!hit) return false;

        const category = calloutCategoryOf(hit.entry);

        // Narrow to the rooms that enabled THIS category, so a two-room guild
        // where only one room wants banter answers as that room.
        const speakingFor = allowed.roomIds.filter(
            id => allowed.configs.get(id)?.categories.has(category),
        );
        if (speakingFor.length === 0) return false;

        // Per-channel throttle, fun categories only. The window comes from the
        // FIRST room the reply speaks for — the same room its links resolve
        // against, so one message never mixes two rooms' settings.
        const cooldownKey = `${message.guildId}:${message.channelId}`;
        const cooldownSec = allowed.configs.get(speakingFor[0]!)?.cooldownSec ?? 0;
        if (COOLDOWN_CATEGORIES.has(category) && cooldownSec > 0) {
            const last = channelCooldowns.get(cooldownKey);
            if (last !== undefined && Date.now() - last < cooldownSec * 1000) return false;
        }

        // Rooms are loaded only AFTER a match — an ordinary chat message must
        // not cost a room lookup.
        const rooms = await loadCalloutRooms(speakingFor);
        const scope: GuildReadScope = { roomIds: speakingFor, legacyEnv: allowed.scope.legacyEnv };

        // An `action` wins over static responses: the entry exists because a
        // fixed string cannot answer the question.
        if (isCalloutAction(hit.entry.action)) {
            const rendered = await renderCalloutAction(
                hit.entry.action, scope, rooms, { authorId },
            );
            if (!rendered) return false;
            await message.reply(rendered);
            if (COOLDOWN_CATEGORIES.has(category)) channelCooldowns.set(cooldownKey, Date.now());
            return true;
        }

        if (hit.response === null) return false;
        await message.reply(applyCalloutPlaceholders(hit.response, roomContextFor(rooms)));
        // Stamped only on a SENT reply — a suppressed or unanswerable match
        // must not start the clock and swallow the next real one.
        if (COOLDOWN_CATEGORIES.has(category)) channelCooldowns.set(cooldownKey, Date.now());
        return true;
    } catch (err) {
        logError('[chat-responses] Failed to handle message:', err);
        return false;
    }
}
