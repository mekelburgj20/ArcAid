import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { logWarn } from './logger.js';

/**
 * Room default timezone — THE one precedence chain for interpreting a
 * TOURNAMENT time (rotation cron, scheduled cleanup cron, "rotates in…"
 * countdowns, the tournament-starting notifier):
 *
 *   1. the tournament's own stored zone (`cadence.timezone` / cleanup
 *      `rule.timezone`)
 *   2. the room's `ROOM_TIMEZONE` (`game_room_settings`)
 *   3. `process.env.BOT_TIMEZONE`
 *   4. `'America/Chicago'`
 *
 * "Default from the room, override per object" — nothing stored changes
 * meaning: an absent/empty room setting falls through to BOT_TIMEZONE exactly
 * as before, so no existing rotation moves. Housekeeping crons (backup,
 * prune, hydration, snapshot, event/season tick) stay on the server zone and
 * use `serverTimezone()` alone.
 *
 * Never hand-copy `process.env.BOT_TIMEZONE || 'America/Chicago'` at a
 * tournament site again — resolve through `resolveTimezone` /
 * `resolveTournamentTimezone`, batching the room lookup with
 * `roomTimezonesFor` wherever a loop runs.
 */

export const ROOM_TIMEZONE_KEY = 'ROOM_TIMEZONE';
export const DEFAULT_TIMEZONE = 'America/Chicago';

export function isValidTimeZone(tz: string): boolean {
    if (!tz) return false;
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** The server zone — step 3+4 of the chain. Housekeeping crons use this alone. */
export function serverTimezone(): string {
    return process.env.BOT_TIMEZONE || DEFAULT_TIMEZONE;
}

/** Room ids already warned about for an invalid stored zone (warn once per room). */
const warnedInvalid = new Set<string>();

function normalizeStored(roomId: string, raw: string | null | undefined): string | null {
    const value = (raw ?? '').trim();
    if (!value) return null;
    if (!isValidTimeZone(value)) {
        if (!warnedInvalid.has(roomId)) {
            warnedInvalid.add(roomId);
            logWarn(`[RoomTimezone] Room ${roomId} has an invalid ${ROOM_TIMEZONE_KEY} '${value}' — ignoring it and falling back to the server zone.`);
        }
        return null;
    }
    return value;
}

/** The room's `ROOM_TIMEZONE`, or null when absent, empty or not a valid IANA zone. */
export async function roomTimezone(roomId: string | null | undefined): Promise<string | null> {
    if (!roomId) return null;
    const raw = await GameRoomSettingsService.get(roomId, ROOM_TIMEZONE_KEY);
    return normalizeStored(roomId, raw);
}

/** Batched `roomTimezone` — one query. Rooms with no valid zone are absent from the map. */
export async function roomTimezonesFor(roomIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(roomIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const settings = await GameRoomSettingsService.getManyForRooms(ids, [ROOM_TIMEZONE_KEY]);
    for (const [roomId, bucket] of settings) {
        const tz = normalizeStored(roomId, bucket[ROOM_TIMEZONE_KEY]);
        if (tz) out.set(roomId, tz);
    }
    return out;
}

/** Pure precedence: object zone → room zone → BOT_TIMEZONE → America/Chicago. */
export function resolveTimezone(objectTz: string | null | undefined, roomTz: string | null | undefined): string {
    return objectTz || roomTz || serverTimezone();
}

/** `resolveTimezone` with the room zone looked up by id (single-room sites only). */
export async function resolveTournamentTimezone(
    objectTz: string | null | undefined,
    roomId: string | null | undefined,
): Promise<string> {
    return resolveTimezone(objectTz, await roomTimezone(roomId));
}
