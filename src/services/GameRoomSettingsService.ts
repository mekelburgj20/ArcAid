import { getDatabase } from '../database/database.js';
import {
    decryptSecret,
    encryptSecret,
    isEncrypted,
    isEncryptedKey,
    isMask,
} from '../utils/secrets.js';

// v2.39.0 — approval rooms (JOIN_POLICY='open'|'approval', read directly by
// RoomAccessService.getJoinPolicy via GameRoomSettingsService.get). As of
// v2.41.0 this key has no flip side-effect in THIS file: the room-level
// Global Scoreboard fan-out gate that used to fire on this flip (plus its
// opt-in escape-hatch toggle) was removed entirely — per-submission
// excludeFromGlobal now governs fan-out uniformly for open and approval
// rooms alike. View gating (roomVisibilityGate) is unrelated and unaffected.

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

    /**
     * Batched multi-room, multi-key read — v2.74.0 (S24.2).
     *
     * One query for `(rooms × keys)` instead of one per key per room. Decoding
     * goes through the SAME `decodeValue` path as `get`/`getAll`, so encrypted
     * keys are decrypted identically and the `isEncryptedKey` allowlist stays
     * the single source of truth (never hand-roll decryption at a call site).
     *
     * Rooms with no matching rows are ABSENT from the map; callers treat that
     * as "no settings", which is what a per-key `get` returning null meant.
     *
     * Built for `ScoreSyncPoller`, which resolved iScored creds room-by-room on
     * every tick — ≥4 uncached `game_room_settings` reads per room, every 10s,
     * including for rooms with `ISCORED_ENABLED=false` that could never do
     * anything with them.
     */
    static async getManyForRooms(
        gameRoomIds: string[],
        keys: string[],
    ): Promise<Map<string, Record<string, string>>> {
        const out = new Map<string, Record<string, string>>();
        if (gameRoomIds.length === 0 || keys.length === 0) return out;

        const db = await getDatabase();
        const roomPh = gameRoomIds.map(() => '?').join(',');
        const keyPh = keys.map(() => '?').join(',');
        const rows = await db.all(
            `SELECT game_room_id, key, value FROM game_room_settings
             WHERE game_room_id IN (${roomPh}) AND key IN (${keyPh})`,
            ...gameRoomIds, ...keys,
        );
        for (const row of rows as Array<{ game_room_id: string; key: string; value: string }>) {
            let bucket = out.get(row.game_room_id);
            if (!bucket) { bucket = {}; out.set(row.game_room_id, bucket); }
            bucket[row.key] = decodeValue(row.key, row.value);
        }
        return out;
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
        const storedValue = isEncryptedKey(key) ? encryptSecret(value) : value;
        await db.run(
            'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
            gameRoomId, key, storedValue
        );
        // v2.56.0 — the ENABLE_GAME_PICK_AWARD branch that used to bust the
        // PickAwardGate cache here is gone with the room-level gate. The gate
        // now resolves off `tournaments.winner_picks` alone, and
        // TournamentService already invalidates on create/update/delete.
    }

    static async saveMany(gameRoomId: string, settings: Record<string, string>): Promise<void> {
        const db = await getDatabase();
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
    }

    static async delete(gameRoomId: string, key: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'DELETE FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
    }
}
