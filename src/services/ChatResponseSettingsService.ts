import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { logInfo, logError } from '../utils/logger.js';
import {
    CALLOUT_CATEGORIES,
    CalloutAction,
    CalloutCategory,
    CalloutEntry,
    DEFAULT_ENABLED_CATEGORIES,
    MAX_CALLOUT_ENTRIES,
    calloutCategoryOf,
    calloutEntryKey,
    isCalloutAction,
    isCalloutCategory,
} from '../utils/callouts.js';
import { CalloutService } from './CalloutService.js';

/**
 * Per-room configuration for Arcaid Chat Responses (v2.125.0).
 *
 * Four keys replace v2.123.0's two. The old pair was a boolean plus a single
 * pinned channel; rooms asked for finer control than "all of it, here" — which
 * kinds of reply, in which channels, how often.
 */

/** Master switch. ABSENT MEANS OFF — replying in someone's server is opt-in. */
export const CHAT_RESPONSES_ENABLED_KEY = 'CHAT_RESPONSES_ENABLED';
/** JSON array of `CalloutCategory`. Absent = `DEFAULT_ENABLED_CATEGORIES`. */
export const CHAT_RESPONSES_CATEGORIES_KEY = 'CHAT_RESPONSES_CATEGORIES';
/** JSON array of channel ids. Absent OR EMPTY = any channel the bot can read. */
export const CHAT_RESPONSES_CHANNELS_KEY = 'CHAT_RESPONSES_CHANNEL_IDS';
/** Seconds between non-`help` replies in one channel. Absent = 30. */
export const CHAT_RESPONSES_COOLDOWN_KEY = 'CHAT_RESPONSES_COOLDOWN_SEC';
/**
 * The room's one-by-one choices: `{"version":1,"only":{"help":["action:active_games"]}}`.
 * A category ABSENT from `only` answers with everything in it, responses added
 * later included (the behaviour before this key existed). A category PRESENT
 * answers with exactly the listed `calloutEntryKey`s, so a response the super
 * admin adds later stays off until the room ticks it. Read only through
 * `parseChatSelection`; the settings POST re-serializes through
 * `serializeChatSelection`.
 */
export const CHAT_RESPONSES_SELECTION_KEY = 'CHAT_RESPONSES_SELECTION';

/** v2.123.0 keys. Read for ONE release, then deleted by the boot migration. */
export const LEGACY_CALLOUTS_ENABLED_KEY = 'CALLOUTS_ENABLED';
export const LEGACY_CALLOUTS_CHANNEL_KEY = 'CALLOUTS_CHANNEL_ID';

export const DEFAULT_COOLDOWN_SEC = 30;

/** Every key the gate needs, for one batched `getManyForRooms` per message. */
export const CHAT_RESPONSE_SETTING_KEYS = [
    CHAT_RESPONSES_ENABLED_KEY,
    CHAT_RESPONSES_CATEGORIES_KEY,
    CHAT_RESPONSES_CHANNELS_KEY,
    CHAT_RESPONSES_COOLDOWN_KEY,
    CHAT_RESPONSES_SELECTION_KEY,
    LEGACY_CALLOUTS_ENABLED_KEY,
    LEGACY_CALLOUTS_CHANNEL_KEY,
];

/** Per category, the only response keys that answer. A missing category = all. */
export type ChatSelection = Map<CalloutCategory, Set<string>>;

/** One room's resolved configuration. */
export interface RoomChatResponseConfig {
    enabled: boolean;
    categories: Set<CalloutCategory>;
    /** Empty = unrestricted. Never null, so callers test `.length`, not null. */
    channelIds: string[];
    cooldownSec: number;
    /** One-by-one choices inside an enabled category. Empty map = no narrowing. */
    only: ChatSelection;
}

/**
 * Parses a stored JSON array, tolerating anything. A hand-edited or truncated
 * value degrades to an empty list — which for categories means "fall back to
 * the default set" and for channels means "unrestricted", both of which are the
 * pre-configuration behaviour rather than a hard failure.
 */
function parseStringArray(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((v): v is string => typeof v === 'string')
            .map(v => v.trim()).filter(Boolean);
    } catch {
        // Also accept a bare comma-separated list — the settings UI writes JSON,
        // but a hand-set row is easier to fix than to diagnose.
        return raw.split(',').map(v => v.trim()).filter(Boolean);
    }
}

export function parseCategories(raw: string | undefined): Set<CalloutCategory> {
    const values = parseStringArray(raw).filter(isCalloutCategory);
    // An explicitly EMPTY array is meaningful: the room turned every category
    // off. Only an absent value falls back to the defaults.
    if (values.length === 0 && !raw) return new Set(DEFAULT_ENABLED_CATEGORIES);
    return new Set(values);
}

/** Longest key kept: `trigger:` plus a 200-char trigger, with headroom. */
const MAX_SELECTION_KEY_LENGTH = 220;

/**
 * Parses `CHAT_RESPONSES_SELECTION`, tolerating anything: an absent or
 * unreadable value narrows nothing, which is the behaviour before the key
 * existed. A category whose list is present but EMPTY is a real answer
 * ("none of these"), not a fallback.
 */
export function parseChatSelection(raw: string | undefined): ChatSelection {
    const out: ChatSelection = new Map();
    if (!raw) return out;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return out; }
    const only = (parsed as { only?: unknown } | null)?.only;
    if (typeof only !== 'object' || only === null || Array.isArray(only)) return out;
    for (const [category, keys] of Object.entries(only as Record<string, unknown>)) {
        if (!isCalloutCategory(category) || !Array.isArray(keys)) continue;
        const clean = keys
            .filter((k): k is string => typeof k === 'string')
            .map(k => k.trim())
            .filter(k => k.length > 0 && k.length <= MAX_SELECTION_KEY_LENGTH)
            .slice(0, MAX_CALLOUT_ENTRIES);
        out.set(category, new Set(clean));
    }
    return out;
}

/** The stored form. '' (which deletes the row) when nothing is narrowed. */
export function serializeChatSelection(raw: string | undefined): string {
    const selection = parseChatSelection(raw);
    if (selection.size === 0) return '';
    const only: Partial<Record<CalloutCategory, string[]>> = {};
    for (const category of CALLOUT_CATEGORIES) {
        const keys = selection.get(category);
        if (keys) only[category] = [...keys];
    }
    return JSON.stringify({ version: 1, only });
}

/**
 * THE one test of whether a room answers with an entry: its category is on,
 * and the room either never narrowed that category or ticked this response.
 * Applied BEFORE matching, like the category filter it extends, so a response
 * a room switched off can never win first-match and silence one it kept.
 */
export function roomAllowsEntry(config: RoomChatResponseConfig, entry: CalloutEntry): boolean {
    if (!config.enabled) return false;
    const category = calloutCategoryOf(entry);
    if (!config.categories.has(category)) return false;
    const only = config.only.get(category);
    return only === undefined || only.has(calloutEntryKey(entry));
}

/** One row of the room's checklist. */
export interface ChatResponseOption {
    key: string;
    category: CalloutCategory;
    /** The live answer it gives; null for a fixed reply. */
    action: CalloutAction | null;
    /** The words that set it off (exclusions left out). */
    triggers: string[];
    /** The first fixed reply, shortened; null for a live answer with none. */
    preview: string | null;
}

const PREVIEW_MAX = 160;

/**
 * The responses a room can choose between: every globally ENABLED entry, in
 * match order, rows that share a key folded into one. An entry the super admin
 * switched off is not offered, since ticking it would do nothing.
 */
export async function listChatResponseOptions(): Promise<ChatResponseOption[]> {
    const entries = await CalloutService.getEnabledCached();
    const byId = new Map<string, ChatResponseOption>();
    for (const entry of entries) {
        const action = isCalloutAction(entry.action) ? entry.action : null;
        const responses = entry.responses ?? [];
        if (!action && responses.length === 0) continue;
        const category = calloutCategoryOf(entry);
        const key = calloutEntryKey(entry);
        const triggers = entry.triggers.filter(t => !t.startsWith('!'));
        const existing = byId.get(`${category}|${key}`);
        if (existing) {
            for (const t of triggers) if (!existing.triggers.includes(t)) existing.triggers.push(t);
            continue;
        }
        const first = responses[0] ?? null;
        byId.set(`${category}|${key}`, {
            key, category, action, triggers: [...triggers],
            preview: first && first.length > PREVIEW_MAX ? `${first.slice(0, PREVIEW_MAX)}…` : first,
        });
    }
    return [...byId.values()];
}

export function parseCooldownSec(raw: string | undefined): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_COOLDOWN_SEC;
    return Math.floor(n);
}

/**
 * Resolves one room's config from an already-fetched settings bucket.
 *
 * The v2.123.0 keys are the fallback for ONE release: a room whose settings
 * were written after the boot migration ran (or whose migration failed) keeps
 * working. `CALLOUTS_ENABLED='true'` with no new key means the room said yes to
 * everything, so it gets all four categories — the same interpretation the boot
 * migration writes. Remove the legacy branch (and the last two entries of
 * `CHAT_RESPONSE_SETTING_KEYS`) once every deployment has booted on v2.125.0.
 */
export function resolveRoomChatConfig(
    bucket: Record<string, string> | undefined,
): RoomChatResponseConfig {
    const off: RoomChatResponseConfig = {
        enabled: false, categories: new Set(), channelIds: [], cooldownSec: DEFAULT_COOLDOWN_SEC,
        only: new Map(),
    };
    if (!bucket) return off;

    const modern = bucket[CHAT_RESPONSES_ENABLED_KEY];
    if (modern !== undefined) {
        if (modern !== 'true') return off;
        return {
            enabled: true,
            categories: parseCategories(bucket[CHAT_RESPONSES_CATEGORIES_KEY]),
            channelIds: parseStringArray(bucket[CHAT_RESPONSES_CHANNELS_KEY]),
            cooldownSec: parseCooldownSec(bucket[CHAT_RESPONSES_COOLDOWN_KEY]),
            only: parseChatSelection(bucket[CHAT_RESPONSES_SELECTION_KEY]),
        };
    }

    if (bucket[LEGACY_CALLOUTS_ENABLED_KEY] !== 'true') return off;
    const legacyChannel = (bucket[LEGACY_CALLOUTS_CHANNEL_KEY] || '').trim();
    return {
        enabled: true,
        categories: new Set(CALLOUT_CATEGORIES),
        channelIds: legacyChannel ? [legacyChannel] : [],
        cooldownSec: DEFAULT_COOLDOWN_SEC,
        only: new Map(),
    };
}

/**
 * One-time boot migration from the v2.123.0 keys (idempotent).
 *
 * A room that had callouts ON had them on for EVERYTHING — there was no
 * category concept — so it gets all four rather than the two-category default a
 * fresh opt-in gets. Anything else would silently take away replies the room
 * was already receiving.
 *
 * Rooms that were OFF (absent or 'false') get no new rows: absent already means
 * off, and storing a 'false' would turn a clean room into a configured one.
 *
 * Skips any room that already has CHAT_RESPONSES_ENABLED — that is both the
 * idempotency guard and the "an admin already reconfigured this" guard, so a
 * second boot cannot clobber a hand-tuned category list.
 */
export async function migrateLegacyCalloutSettings(): Promise<number> {
    try {
        const db = await getDatabase();
        const rows = (await db.all(
            `SELECT game_room_id, key, value FROM game_room_settings WHERE key IN (?, ?, ?)`,
            CHAT_RESPONSES_ENABLED_KEY, LEGACY_CALLOUTS_ENABLED_KEY, LEGACY_CALLOUTS_CHANNEL_KEY,
        )) as Array<{ game_room_id: string; key: string; value: string }>;

        const byRoom = new Map<string, Record<string, string>>();
        for (const row of rows) {
            let bucket = byRoom.get(row.game_room_id);
            if (!bucket) { bucket = {}; byRoom.set(row.game_room_id, bucket); }
            bucket[row.key] = row.value;
        }

        let migrated = 0;
        for (const [roomId, bucket] of byRoom) {
            if (bucket[CHAT_RESPONSES_ENABLED_KEY] !== undefined) continue;

            if (bucket[LEGACY_CALLOUTS_ENABLED_KEY] === 'true') {
                const channel = (bucket[LEGACY_CALLOUTS_CHANNEL_KEY] || '').trim();
                await GameRoomSettingsService.set(roomId, CHAT_RESPONSES_ENABLED_KEY, 'true');
                await GameRoomSettingsService.set(
                    roomId, CHAT_RESPONSES_CATEGORIES_KEY, JSON.stringify([...CALLOUT_CATEGORIES]),
                );
                if (channel) {
                    await GameRoomSettingsService.set(
                        roomId, CHAT_RESPONSES_CHANNELS_KEY, JSON.stringify([channel]),
                    );
                }
                migrated++;
                logInfo(
                    `[chat-responses] Migrated room ${roomId} from CALLOUTS_* to CHAT_RESPONSES_*: `
                    + `all ${CALLOUT_CATEGORIES.length} categories enabled, `
                    + `${channel ? `channel pinned to ${channel}` : 'any channel'}.`,
                );
            }

            // The legacy rows go regardless of the room's answer — leaving a
            // 'false' behind would let the one-release fallback in
            // resolveRoomChatConfig keep reading a key the UI no longer edits.
            if (bucket[LEGACY_CALLOUTS_ENABLED_KEY] !== undefined) {
                await GameRoomSettingsService.delete(roomId, LEGACY_CALLOUTS_ENABLED_KEY);
            }
            if (bucket[LEGACY_CALLOUTS_CHANNEL_KEY] !== undefined) {
                await GameRoomSettingsService.delete(roomId, LEGACY_CALLOUTS_CHANNEL_KEY);
            }
        }
        return migrated;
    } catch (err) {
        logError('[chat-responses] Legacy CALLOUTS_* settings migration failed (non-fatal) —', err);
        return 0;
    }
}
