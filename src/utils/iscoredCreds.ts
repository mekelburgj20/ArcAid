import { logWarn } from './logger.js';
import { IScoredApiClient } from '../engine/IScoredApiClient.js';

export interface IScoredCreds {
    username: string;
    password: string;
    publicUrl: string;
    gameroomName: string;
    /** Tracks whether creds came from the per-room settings or the env fallback. */
    source: 'room' | 'env';
}

/**
 * Resolves iScored credentials for a given room. Precedence:
 *
 * 1. If the room has `ISCORED_ENABLED=false`, returns null (iScored disabled).
 * 2. If all three per-room creds (`ISCORED_USERNAME`, `ISCORED_PASSWORD`,
 *    `ISCORED_PUBLIC_URL`) are set, uses them.
 * 3. If none of the per-room creds are set, falls back to the env values.
 * 4. If some but not all per-room creds are set, returns null and logs a warning
 *    — partial config is treated as disabled to avoid silently mixing a
 *    per-room username with env credentials.
 *
 * Callers without a roomId use env only.
 */
export async function getIScoredCredsForRoom(
    roomId: string | undefined | null,
): Promise<IScoredCreds | null> {
    if (roomId) {
        // Avoid import cycle — GameRoomSettingsService imports nothing from here.
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        const settingsByRoom = await GameRoomSettingsService.getManyForRooms([roomId], [...ISCORED_CRED_KEYS]);
        return resolveCredsFromSettings(roomId, settingsByRoom.get(roomId) ?? {});
    }
    return envCreds();
}

/**
 * The `game_room_settings` keys iScored credential resolution depends on.
 * Exported so the batched path and the single-room path can never read a
 * different key set.
 */
export const ISCORED_CRED_KEYS = [
    'ISCORED_ENABLED',
    'ISCORED_USERNAME',
    'ISCORED_PASSWORD',
    'ISCORED_PUBLIC_URL',
] as const;

/**
 * Batched multi-room resolution — v2.74.0 (S24.2).
 *
 * `ScoreSyncPoller` resolves creds for EVERY room on every tick (default 10s).
 * Doing that through `getIScoredCredsForRoom` cost ≥4 uncached settings reads
 * per room per tick, paid even for `ISCORED_ENABLED=false` rooms whose answer
 * is always null. This is one query for all rooms and all four keys, then the
 * SAME `resolveCredsFromSettings` rule per room — the precedence logic is
 * shared, not forked, so the batched path cannot drift from the single path.
 *
 * Returns a map with an entry only for rooms that resolved to real creds.
 */
export async function getIScoredCredsForRooms(
    roomIds: string[],
): Promise<Map<string, IScoredCreds>> {
    const out = new Map<string, IScoredCreds>();
    if (roomIds.length === 0) return out;

    const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
    const settingsByRoom = await GameRoomSettingsService.getManyForRooms(roomIds, [...ISCORED_CRED_KEYS]);
    for (const roomId of roomIds) {
        const creds = resolveCredsFromSettings(roomId, settingsByRoom.get(roomId) ?? {});
        if (creds) out.set(roomId, creds);
    }
    return out;
}

/**
 * The precedence rule from this module's doc comment, applied to one room's
 * already-loaded settings. Pure apart from the env fallback and the warnings.
 */
function resolveCredsFromSettings(
    roomId: string,
    settings: Record<string, string>,
): IScoredCreds | null {
    const enabled = (settings['ISCORED_ENABLED'] ?? null) !== 'false';
    if (!enabled) return null;

    const u = settings['ISCORED_USERNAME'] ?? null;
    const p = settings['ISCORED_PASSWORD'] ?? null;
    const url = settings['ISCORED_PUBLIC_URL'] ?? null;

    const anyPerRoom = !!(u || p || url);
    const allPerRoom = !!(u && p && url);

    if (allPerRoom) {
        const gameroomName = IScoredApiClient.parseGameroomName(url!);
        if (!gameroomName) {
            logWarn(`iScored creds for room ${roomId}: ISCORED_PUBLIC_URL is set but gameroom name could not be parsed. Treating as disabled.`);
            return null;
        }
        return {
            username: u!,
            password: p!,
            publicUrl: url!,
            gameroomName,
            source: 'room',
        };
    }

    if (anyPerRoom) {
        logWarn(`iScored creds for room ${roomId}: partial per-room config (missing one of USERNAME/PASSWORD/PUBLIC_URL). Treating as disabled — set all three or clear all three.`);
        return null;
    }
    // Fall through to env — room has no per-room creds.
    return envCreds();
}

function envCreds(): IScoredCreds | null {
    const u = process.env.ISCORED_USERNAME;
    const p = process.env.ISCORED_PASSWORD;
    const url = process.env.ISCORED_PUBLIC_URL;
    if (!u || !p || !url) return null;
    const gameroomName = IScoredApiClient.parseGameroomName(url);
    if (!gameroomName) return null;
    return { username: u, password: p, publicUrl: url, gameroomName, source: 'env' };
}

/**
 * One entry per distinct iScored ACCOUNT across every game room, keyed the same
 * way `ScoreSyncPoller.poll` keys its per-tick grouping (`${gameroomName}::${publicUrl}`)
 * so "an account" means the same thing in both places. Rooms sharing credentials
 * collapse into a single entry carrying all their room ids.
 *
 * Added for the nightly iScored snapshot sweep (v2.117.0). The poller keeps its
 * own inline grouping for now — deliberately NOT refactored onto this helper in
 * the same change.
 */
export async function getIScoredAccounts(): Promise<Array<{
    key: string;
    creds: IScoredCreds;
    roomIds: string[];
}>> {
    const { getDatabase } = await import('../database/database.js');
    const db = await getDatabase();
    const rooms = (await db.all('SELECT id FROM game_rooms')) as Array<{ id: string }>;
    const credsByRoom = await getIScoredCredsForRooms(rooms.map((r) => r.id));

    const accounts = new Map<string, { key: string; creds: IScoredCreds; roomIds: string[] }>();
    for (const room of rooms) {
        const creds = credsByRoom.get(room.id);
        if (!creds) continue;
        const key = `${creds.gameroomName}::${creds.publicUrl}`;
        if (!accounts.has(key)) accounts.set(key, { key, creds, roomIds: [] });
        accounts.get(key)!.roomIds.push(room.id);
    }
    return Array.from(accounts.values());
}

/**
 * Per-room kill-switch for iScored game DELETES (`ISCORED_ALLOW_DELETE`).
 *
 * Motivation: a room may bridge Arcaid to an iScored board it does not own
 * outright. The board's owner needs certainty that Arcaid can never REMOVE a
 * game from it — not through a tournament cleanup rule, not through an admin
 * button, not through reconcile. Everything reversible/additive (lock, unlock,
 * hide, unhide, create, submit, reorder) stays allowed; only `deleteGame` is
 * gated.
 *
 * Semantics: absent or any value other than the literal string `'false'` means
 * deletes are allowed — same default-on-when-absent rule the other room flags
 * use (`ISCORED_ENABLED`, `DISCORD_ENABLED`). A null/undefined roomId (the
 * env-fallback callers that have no room context) resolves to allowed, so
 * back-compat is preserved.
 *
 * NOT encrypted — it is a policy flag, not a secret.
 */
export async function iscoredDeletesAllowed(
    gameRoomId: string | null | undefined,
): Promise<boolean> {
    if (!gameRoomId) return true;
    const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
    const raw = await GameRoomSettingsService.get(gameRoomId, 'ISCORED_ALLOW_DELETE');
    return raw !== 'false';
}

/**
 * The 409 body every admin route returns when a delete is refused by the
 * kill-switch. One constant so the message an admin sees is identical
 * wherever the refusal happens.
 */
export const ISCORED_DELETES_DISABLED_MESSAGE =
    'iScored deletes are disabled for this room (Room Settings → iScored → Allow Arcaid to delete games on iScored).';
