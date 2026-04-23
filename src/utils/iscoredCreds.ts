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
        const enabled = (await GameRoomSettingsService.get(roomId, 'ISCORED_ENABLED')) !== 'false';
        if (!enabled) return null;

        const [u, p, url] = await Promise.all([
            GameRoomSettingsService.get(roomId, 'ISCORED_USERNAME'),
            GameRoomSettingsService.get(roomId, 'ISCORED_PASSWORD'),
            GameRoomSettingsService.get(roomId, 'ISCORED_PUBLIC_URL'),
        ]);

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
    }

    const u = process.env.ISCORED_USERNAME;
    const p = process.env.ISCORED_PASSWORD;
    const url = process.env.ISCORED_PUBLIC_URL;
    if (!u || !p || !url) return null;
    const gameroomName = IScoredApiClient.parseGameroomName(url);
    if (!gameroomName) return null;
    return { username: u, password: p, publicUrl: url, gameroomName, source: 'env' };
}
