import { randomUUID } from 'crypto';
import { logWarn } from './logger.js';
import type { AtGamesCreds } from '../services/AtGamesPrivateClient.js';

/**
 * Per-room AtGames credential resolution (P7 — AtGames event score sync).
 *
 * Modelled on `iscoredCreds.ts`, with two deliberate differences:
 *
 * 1. **There is no env fallback.** iScored has one because a single-room
 *    install predates rooms; AtGames arrived after multi-tenancy, and a
 *    server-wide AtGames account would sign every room's polling in as one
 *    person. Room settings or nothing.
 * 2. **Partial config is treated as OFF, loudly.** Same rule as iScored: an
 *    email with no password must never silently half-enable a poller.
 *
 * The password is in `ENCRYPTED_SETTING_KEYS`, so `GameRoomSettingsService`
 * decrypts it on read and it is never stored in the clear (ADR 0003).
 */

/**
 * The `game_room_settings` keys AtGames credential resolution depends on.
 * Exported so a batched multi-room read and the single-room read can never
 * drift onto different key sets.
 */
export const ATGAMES_CRED_KEYS = [
    'ATGAMES_ENABLED',
    'ATGAMES_EMAIL',
    'ATGAMES_PASSWORD',
    'ATGAMES_DEVICE_FP',
] as const;

/**
 * Resolves AtGames creds from an already-read settings map.
 *
 * Pure apart from the `fp` mint below, so the batched path and the single-room
 * path share one rule. Returns null when AtGames is off, unconfigured, or
 * half-configured.
 */
export function resolveAtGamesCredsFromSettings(
    roomId: string,
    settings: Record<string, string>,
): AtGamesCreds | null {
    if (settings.ATGAMES_ENABLED === 'false') return null;

    const email = (settings.ATGAMES_EMAIL || '').trim();
    const password = settings.ATGAMES_PASSWORD || '';

    if (!email && !password) return null;
    if (!email || !password) {
        logWarn(
            `AtGames: room ${roomId} has partial credentials (${email ? 'no password' : 'no email'}) — ` +
            `treating AtGames as disabled for this room`,
        );
        return null;
    }

    // `fp` is a device fingerprint AtGames expects to be stable per client, not
    // a secret. A missing one is minted here and persisted by the caller
    // (`getAtGamesCredsForRoom`); a fresh uuid on every call would make every
    // request look like a new device.
    const deviceFp = (settings.ATGAMES_DEVICE_FP || '').trim();
    return { email, password, deviceFp: deviceFp || randomUUID() };
}

/**
 * Resolves AtGames creds for one room, persisting a minted device fingerprint.
 *
 * The persist is why this is async and separate from the pure resolver above:
 * the `fp` must survive a restart, or AtGames sees a brand-new device on every
 * boot. Writing it is idempotent and happens at most once per room.
 */
export async function getAtGamesCredsForRoom(
    roomId: string | undefined | null,
): Promise<AtGamesCreds | null> {
    if (!roomId) return null;

    // Avoid an import cycle — GameRoomSettingsService imports nothing from here.
    const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
    const byRoom = await GameRoomSettingsService.getManyForRooms([roomId], [...ATGAMES_CRED_KEYS]);
    const settings = byRoom.get(roomId) ?? {};

    const creds = resolveAtGamesCredsFromSettings(roomId, settings);
    if (!creds) return null;

    if (!settings.ATGAMES_DEVICE_FP) {
        try {
            await GameRoomSettingsService.set(roomId, 'ATGAMES_DEVICE_FP', creds.deviceFp);
        } catch (err) {
            // A fingerprint that fails to persist is a cosmetic problem for
            // AtGames, not a reason to refuse to poll.
            logWarn(`AtGames: could not persist a device fingerprint for room ${roomId}`, err);
        }
    }
    return creds;
}
