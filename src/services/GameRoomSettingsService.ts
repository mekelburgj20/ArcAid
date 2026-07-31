import { getDatabase } from '../database/database.js';
import { OrphanService } from './OrphanService.js';
import {
    decryptSecret,
    encryptSecret,
    isEncrypted,
    isEncryptedKey,
    isMask,
} from '../utils/secrets.js';

// Settings that trigger side-effects on change. Kept explicit so new settings must
// opt in deliberately.
const REQUIRE_LOGIN_KEY = 'REQUIRE_DISCORD_LOGIN';
// v2.39.0 — approval rooms (JOIN_POLICY='open'|'approval', read directly by
// RoomAccessService.getJoinPolicy via GameRoomSettingsService.get). As of
// v2.41.0 this key has no flip side-effect in THIS file: the room-level
// Global Scoreboard fan-out gate that used to fire on this flip (plus its
// opt-in escape-hatch toggle) was removed entirely — per-submission
// excludeFromGlobal now governs fan-out uniformly for open and approval
// rooms alike. View gating (roomVisibilityGate) is unrelated and unaffected.

async function invalidateLeaderboardCaches(_gameRoomId: string): Promise<void> {
    // After an orphan flip, regeneration must happen across room + global caches so
    // orphaned rows vanish / return on next read. Both services only expose a broad
    // invalidate — acceptable because flips are admin-initiated and infrequent.
    try {
        const { LeaderboardService } = await import('./LeaderboardService.js');
        await LeaderboardService.invalidateAll();
    } catch { /* best-effort */ }
    try {
        const { GlobalLeaderboardService } = await import('./GlobalLeaderboardService.js');
        await GlobalLeaderboardService.invalidateAll();
    } catch { /* best-effort */ }
}

function decodeValue(key: string, stored: string): string {
    if (!isEncryptedKey(key)) return stored;
    if (isEncrypted(stored)) return decryptSecret(stored);
    // Legacy plaintext row (before startup migration ran). Returned as-is so
    // callers don't break during the migration window.
    return stored;
}

/**
 * Per-room key/value settings. Transparent encryption for keys listed in
 * `ENCRYPTED_SETTING_KEYS` — callers see and write plaintext; on-disk is
 * ciphertext. Empty-string writes on `saveMany`/`set` delete the row so admin
 * UI "clear field" actions persist.
 */
export class GameRoomSettingsService {
    static async get(gameRoomId: string, key: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
        if (!row) return null;
        return decodeValue(key, row.value);
    }

    static async getAll(gameRoomId: string): Promise<Record<string, string>> {
        const db = await getDatabase();
        const rows = await db.all(
            'SELECT key, value FROM game_room_settings WHERE game_room_id = ?',
            gameRoomId
        );
        return rows.reduce((acc: Record<string, string>, row: any) => {
            acc[row.key] = decodeValue(row.key, row.value);
            return acc;
        }, {});
    }

    static async set(gameRoomId: string, key: string, value: string): Promise<void> {
        // Empty value → delete so clearing a field via admin UI persists.
        if (value === '') {
            await GameRoomSettingsService.delete(gameRoomId, key);
            return;
        }
        // Mask sentinel → no-op (secret unchanged).
        if (isMask(value)) return;

        const db = await getDatabase();
        // Capture previous value BEFORE the write so flip logic can diff.
        const prev = (key === REQUIRE_LOGIN_KEY)
            ? await GameRoomSettingsService.get(gameRoomId, key)
            : null;

        const storedValue = isEncryptedKey(key) ? encryptSecret(value) : value;
        await db.run(
            'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
            gameRoomId, key, storedValue
        );
        if (key === REQUIRE_LOGIN_KEY) {
            await OrphanService.handleRequireLoginFlip(gameRoomId, prev, value);
            await invalidateLeaderboardCaches(gameRoomId);
        }
        // v2.56.0 — the ENABLE_GAME_PICK_AWARD branch that used to bust the
        // PickAwardGate cache here is gone with the room-level gate. The gate
        // now resolves off `tournaments.winner_picks` alone, and
        // TournamentService already invalidates on create/update/delete.
    }

    static async saveMany(gameRoomId: string, settings: Record<string, string>): Promise<void> {
        const db = await getDatabase();
        // Capture previous REQUIRE_LOGIN value before any writes so flip
        // semantics are correct even if the bulk save also touches other keys.
        const prevRequireLogin = REQUIRE_LOGIN_KEY in settings
            ? await GameRoomSettingsService.get(gameRoomId, REQUIRE_LOGIN_KEY)
            : null;

        for (const [key, value] of Object.entries(settings)) {
            // Mask sentinel → user did not change this secret; skip.
            if (isMask(value)) continue;

            // Empty value → delete (so admin UI "clear field" persists).
            if (value === '') {
                await db.run(
                    'DELETE FROM game_room_settings WHERE game_room_id = ? AND key = ?',
                    gameRoomId, key,
                );
                continue;
            }

            const storedValue = isEncryptedKey(key) ? encryptSecret(value) : value;
            await db.run(
                'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
                gameRoomId, key, storedValue
            );
        }

        if (REQUIRE_LOGIN_KEY in settings && !isMask(settings[REQUIRE_LOGIN_KEY]!)) {
            await OrphanService.handleRequireLoginFlip(gameRoomId, prevRequireLogin, settings[REQUIRE_LOGIN_KEY]!);
            await invalidateLeaderboardCaches(gameRoomId);
        }
    }

    static async delete(gameRoomId: string, key: string): Promise<void> {
        const db = await getDatabase();
        const prev = (key === REQUIRE_LOGIN_KEY)
            ? await GameRoomSettingsService.get(gameRoomId, key)
            : null;
        await db.run(
            'DELETE FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
        if (key === REQUIRE_LOGIN_KEY && (prev === 'true' || prev === 'discord')) {
            // Deleting REQUIRE_DISCORD_LOGIN is equivalent to turning it off.
            await OrphanService.handleRequireLoginFlip(gameRoomId, prev, 'false');
            await invalidateLeaderboardCaches(gameRoomId);
        }
    }
}
