import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { logInfo, logError } from '../utils/logger.js';
import {
    CALLOUT_CATEGORIES,
    CalloutCategory,
    DEFAULT_ENABLED_CATEGORIES,
    isCalloutCategory,
} from '../utils/callouts.js';

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
    LEGACY_CALLOUTS_ENABLED_KEY,
    LEGACY_CALLOUTS_CHANNEL_KEY,
];

/** One room's resolved configuration. */
export interface RoomChatResponseConfig {
    enabled: boolean;
    categories: Set<CalloutCategory>;
    /** Empty = unrestricted. Never null, so callers test `.length`, not null. */
    channelIds: string[];
    cooldownSec: number;
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
        };
    }

    if (bucket[LEGACY_CALLOUTS_ENABLED_KEY] !== 'true') return off;
    const legacyChannel = (bucket[LEGACY_CALLOUTS_CHANNEL_KEY] || '').trim();
    return {
        enabled: true,
        categories: new Set(CALLOUT_CATEGORIES),
        channelIds: legacyChannel ? [legacyChannel] : [],
        cooldownSec: DEFAULT_COOLDOWN_SEC,
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
